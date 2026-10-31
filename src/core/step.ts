import {
  MINUTE,
  claimKey,
  type Campaign,
  type CampaignId,
  type Channel,
  type ChannelId,
  type Drop,
  type DropId,
  type Millis,
  type Progress,
} from "./model.ts";
import {
  minable,
  plan,
  usableOn,
  wantedOn,
  watchlist,
  type PlanInput,
  type Rank,
  type Target,
} from "./plan.ts";
import { Command, readKey, readOfKey, type ChannelRead, type Event } from "./protocol.ts";
import { canEarn, channelCanEarn, isClaimable, wantedDrops, withReceived } from "./rules.ts";
import {
  CAMPAIGN_SKIP,
  CATALOG_INTERVAL,
  CATALOG_OPENING_GAP,
  CATALOG_RETRY,
  CLAIM_RECHECK,
  CURRENT_DROP_RECHECK,
  INVENTORY_INTERVAL,
  MAX_UNCONFIRMED_MINUTES,
  ONLINE_DELAY,
  STALL_AFTER,
  SUBSCRIBE_SETTLE,
  THROTTLE_FLOOR,
  VALIDATE_INTERVAL,
  WATCHLIST_LIMIT,
  WATCH_INTERVAL,
  discoverySettle,
  type ClaimIntent,
  type State,
  type Watching,
} from "./state.ts";

export interface Step {
  readonly state: State;
  readonly commands: ReadonlyArray<Command>;
}

type Handled = readonly [State, ReadonlyArray<Command>];

/**
 * The miner's decision function, over a ranking of what to mine. `step` is the miner's; the
 * simulator plants other rankings to prove its checks catch them.
 */
export const stepWith =
  (rank: Rank) =>
  (state: State, event: Event, now: Millis): Step => {
    if (state.auth === "needs-login" && event._tag !== "Started") return { state, commands: [] };
    const [handled, commands] = handle(state, event, now, rank);
    const [planned, watchCommands] = replan(settleDiscovery(handled, now), now, rank);
    const [ticking, tickCommands] = event._tag === "Tick" ? watchTick(planned, now) : [planned, []];
    const [claimed, claimCommands] = sendClaims(ticking, now);
    const [followed, subscribeCommands] = follow(claimed, now, rank);
    return {
      state: followed,
      commands: [
        ...commands,
        ...watchCommands,
        ...tickCommands,
        ...claimCommands,
        ...subscribeCommands,
      ],
    };
  };

/**
 * The miner's only decision function. Pure: the same state, event and time always give the same
 * result, so simulator seeds replay exactly. After any event it re-plans, sends due claims and
 * updates the followed channels.
 */
export const step = stepWith(minable);

const handle = (s: State, event: Event, now: Millis, rank: Rank): Handled => {
  switch (event._tag) {
    case "Started":
      return [
        {
          ...s,
          auth: "unknown",
          // A previous run's watch, sockets and channel picture died with it.
          watch: { _tag: "Idle", reason: "starting" },
          channels: new Map(),
          avoid: new Set(),
          avoidCampaigns: new Map(),
          skipCauses: new Map(),
          subscriptions: [],
          discovery: undefined,
          // A claim in flight when the process died may have succeeded: inventory decides, once
          // it can show the claim, as after a lost answer.
          claims: mapValues(s.claims, (c): ClaimIntent => ({
            ...c,
            status: "unknown",
            recheckAt: now + CLAIM_RECHECK,
          })),
          deadlines: {
            ...s.deadlines,
            validate: now + VALIDATE_INTERVAL,
            tick: undefined,
            online: new Map(),
            subscribe: undefined,
            deferred: new Map(),
          },
        },
        [Command.ValidateToken()],
      ];

    case "TokenValid":
      if (s.auth === "valid") return [s, []];
      return [
        {
          ...s,
          auth: "valid",
          deadlines: {
            ...s.deadlines,
            catalog: now + CATALOG_INTERVAL,
            inventory: nextInventory(s.claims, now),
          },
        },
        [Command.ReadCatalog(), Command.ReadInventory()],
      ];

    case "AuthFailed":
      return [
        {
          ...s,
          auth: "needs-login",
          watch: { _tag: "Idle", reason: "needs-login" },
          subscriptions: [],
          discovery: undefined,
          deadlines: {
            ...s.deadlines,
            tick: undefined,
            online: new Map(),
            subscribe: undefined,
            deferred: new Map(),
          },
        },
        [
          ...(s.watch._tag === "Watching" ? [Command.StopWatching()] : []),
          ...(s.subscriptions.length > 0 ? [Command.Subscribe({ channelIds: [] })] : []),
        ],
      ];

    case "CatalogRead": {
      const listed = new Set(event.campaigns.map((c) => c.id));
      const next: State = {
        ...s,
        catalog: event.campaigns,
        skipCauses: new Map([...s.skipCauses].filter(([id]) => listed.has(id))),
        catalogStatus: "ok",
        deadlines: {
          ...s.deadlines,
          catalog: Math.min(now + CATALOG_INTERVAL, nextOpening(s, event.campaigns, now)),
        },
      };
      const reads = discover(next, now, rank);
      const discovery =
        reads.length === 0
          ? undefined
          : { pending: reads.map((read) => readKey(read)), until: now + discoverySettle(reads) };
      return [{ ...next, discovery }, reads];
    }

    case "CatalogUnavailable":
      return [
        {
          ...s,
          catalogStatus: "unavailable",
          deadlines: { ...s.deadlines, catalog: now + CATALOG_RETRY },
        },
        [],
      ];

    case "InventoryRead": {
      const credited = creditShown(s, event.progress, now, rank);
      const progress = new Map(credited.progress);
      for (const read of event.progress)
        progress.set(read.dropId, merge(progress.get(read.dropId), read));
      const claims = new Map(s.claims);
      const shown = new Map(event.progress.map((p) => [p.dropId, p]));
      for (const [key, intent] of claims) {
        // Only the drop as this read shows it settles an intent, never the merged picture: a
        // read that omits the drop (inventory lag) proves nothing, and dropping the intent then
        // would send the claim again (twin seed 4647). Claimed means done. Still unclaimed in a
        // read taken after the recheck time means the lost claim failed, so dropping the intent
        // lets the claim pass send it again, informed. An earlier read may just lag the claim.
        const p = shown.get(intent.dropId);
        if (p === undefined) continue;
        const settled =
          intent.status === "unknown" && intent.recheckAt !== undefined && now >= intent.recheckAt;
        if (p.claimed || settled) claims.delete(key);
      }
      // Twitch lists each reward once, with its last award; keep the latest if it ever repeats.
      const awarded = new Map<string, Millis>();
      for (const a of event.awarded)
        awarded.set(a.benefitId, Math.max(a.at, awarded.get(a.benefitId) ?? a.at));
      const next = {
        ...credited,
        progress,
        awarded,
        inventoried: new Set(event.progress.map((p) => p.dropId)),
        claims,
        deadlines: {
          ...s.deadlines,
          // A refused read is owed at its retry time: this answer must not postpone it.
          inventory: Math.min(s.deadlines.inventory, nextInventory(claims, now)),
        },
      };
      return [confirmWatched(next, now), []];
    }

    case "DropProgress": {
      const updated = credit(s, event.dropId, event.minutes, now, rank);
      const drop = findDrop(s.catalog, event.dropId);
      // Once, as the drop completes: Twitch keeps sending minutes past the requirement.
      const was = s.progress.get(event.dropId)?.minutes ?? 0;
      const required = drop?.drop.requiredMinutes ?? Infinity;
      const completes = was < required && event.minutes >= required;
      return [updated, completes ? [Command.ReadInventory()] : []];
    }

    case "DropClaimable":
      return [withProgress(s, event.dropId, (p) => ({ ...p, instanceId: event.instanceId })), []];

    case "CurrentDropRead": {
      const w = s.watch;
      const current = w._tag === "Watching" && w.channelId === event.channelId;
      if (!current || event.dropId === undefined) return [s, []];
      return [credit(s, event.dropId, event.minutes, now, rank), []];
    }

    case "ChannelsRead": {
      const channels = new Map(s.channels);
      for (const channel of event.channels) channels.set(channel.id, channel);
      return [{ ...s, channels, discovery: answered(s, event.read) }, []];
    }

    case "ChannelsReadFailed":
      return [{ ...s, discovery: answered(s, event.read) }, []];

    case "StreamUp": {
      const online = new Map(s.deadlines.online);
      online.set(event.channelId, now + ONLINE_DELAY);
      return [{ ...s, deadlines: { ...s.deadlines, online } }, []];
    }

    case "StreamDown":
      return [withChannel(s, event.channelId, (ch) => ({ ...ch, live: undefined })), []];

    case "GameChanged":
      return [withChannel(s, event.channelId, (ch) => ({ ...ch, gameId: event.gameId })), []];

    case "WatchTicked":
      return ticked(s, event.channelId, now);

    case "WatchFailed":
      switch (event.reason) {
        case "offline":
          return [withChannel(s, event.channelId, (ch) => ({ ...ch, live: undefined })), []];
        case "refused":
          return [{ ...s, avoid: new Set([...s.avoid, event.channelId]) }, []];
        case "network":
          return [s, []];
      }
      return [s, []];

    case "ClaimResult": {
      const key = claimKey(event.campaignId, event.dropId);
      const claims = new Map(s.claims);
      if (event.outcome === "unknown") {
        const intent = claims.get(key);
        if (intent === undefined) return [s, []];
        const recheckAt = now + CLAIM_RECHECK;
        claims.set(key, { ...intent, status: "unknown", recheckAt });
        const inventory = Math.min(s.deadlines.inventory, recheckAt);
        return [{ ...s, claims, deadlines: { ...s.deadlines, inventory } }, []];
      }
      claims.delete(key);
      return [withProgress({ ...s, claims }, event.dropId, (p) => ({ ...p, claimed: true })), []];
    }

    case "Throttled": {
      let next = s;
      for (const refusal of event.refusals) {
        const at = Math.max(refusal.retryAt, now + THROTTLE_FLOOR);
        next = throttled(next, refusal.command, at, now);
      }
      return [next, []];
    }

    case "Tick":
      return tick(s, now, rank);
  }
};

/**
 * A request budget refused `command` before sending it: due again at `at`. A refused read moves
 * its deadline; a refused channel read waits in `deferred`, and the discovery waiting for it waits
 * that much longer. A refused claim was never sent, but it is settled the way a lost answer is:
 * its intent waits for an inventory read at or after `at`, which sends it again only if the drop
 * still shows unclaimed. A refused current-drop read is due again at `at`, and a refused
 * subscription is sent again then: `ticked` and `follow` had already counted both as done. A
 * refused watch tick needs nothing: the next one is due on its own schedule.
 */
const throttled = (s: State, command: Command, at: Millis, now: Millis): State => {
  const d = s.deadlines;
  switch (command._tag) {
    case "ValidateToken":
      return { ...s, deadlines: { ...d, validate: Math.min(d.validate, at) } };
    case "ReadCatalog":
      return { ...s, deadlines: { ...d, catalog: Math.min(d.catalog, at) } };
    case "ReadInventory":
      return { ...s, deadlines: { ...d, inventory: Math.min(d.inventory, at) } };
    case "ReadDirectory":
    case "ReadChannels": {
      if (s.auth !== "valid") return s;
      const key = readKey(command);
      const deferred = new Map(d.deferred);
      deferred.set(key, Math.min(deferred.get(key) ?? Infinity, at));
      const discovery =
        s.discovery?.pending.includes(key) === true
          ? { ...s.discovery, until: Math.max(s.discovery.until, at + discoverySettle([command])) }
          : s.discovery;
      return { ...s, discovery, deadlines: { ...d, deferred } };
    }
    case "Claim": {
      const key = claimKey(command.campaignId, command.dropId);
      const intent = s.claims.get(key);
      if (intent === undefined) return s;
      const recheckAt = Math.max(at, now + CLAIM_RECHECK);
      const claims = new Map(s.claims);
      claims.set(key, { ...intent, status: "unknown", recheckAt });
      return { ...s, claims, deadlines: { ...d, inventory: Math.min(d.inventory, recheckAt) } };
    }
    case "ReadCurrentDrop": {
      const w = s.watch;
      if (w._tag !== "Watching" || w.channelId !== command.channelId) return s;
      // `ticked` asks again once `CURRENT_DROP_RECHECK` has passed since this: at `at`.
      return { ...s, watch: { ...w, lastCurrentDropRead: at - CURRENT_DROP_RECHECK } };
    }
    case "Subscribe": {
      // `follow` took the set as followed when it sent it. Twitch never heard of it, so what is
      // followed is unknown: an empty set makes `follow` send the plan's set again at `at`.
      if (s.auth !== "valid" || !sameMembers(command.channelIds, s.subscriptions)) return s;
      return { ...s, subscriptions: [], deadlines: { ...d, subscribe: at } };
    }
    case "Watch":
    case "WatchTick":
    case "StopWatching":
      return s;
  }
};

const tick = (state: State, now: Millis, rank: Rank): Handled => {
  const commands: Array<Command> = [];
  const s = expireSkips(state, now);
  let d = s.deadlines;
  if (now >= d.validate) {
    commands.push(Command.ValidateToken());
    d = { ...d, validate: now + VALIDATE_INTERVAL };
  }
  let discovery = s.discovery;
  const openedAt = d.tick;
  if (s.auth === "valid") {
    if (now >= d.catalog) {
      commands.push(Command.ReadCatalog());
      d = { ...d, catalog: now + CATALOG_INTERVAL };
    } else if (s.watch._tag === "Idle" && openedAt !== undefined && now >= openedAt) {
      // A wanted drop opened (`firstOpening`). Discovery read channels only for what earned at
      // the catalog read, so ask now for the channels that can credit what opened if none known
      // can: an allow-list the core never read, or a game it never looked for (seed 280753). The
      // catalog read's own discovery does this when it is due.
      const known = [...s.channels.values()];
      const opened = new Set(
        (s.catalog ?? [])
          .filter(
            (c) =>
              c.drops.some((x) => x.startsAt >= openedAt && x.startsAt <= now) &&
              !known.some((ch) => channelCanEarn(c, ch, [], s.avoid)),
          )
          .map((c) => c.id),
      );
      const reads = discover(s, now, rank, opened).filter(
        (read) => s.discovery?.pending.includes(readKey(read)) !== true,
      );
      if (reads.length > 0) {
        commands.push(...reads);
        discovery = {
          pending: [...(s.discovery?.pending ?? []), ...reads.map((read) => readKey(read))],
          until: Math.max(s.discovery?.until ?? now, now + discoverySettle(reads)),
        };
      }
    }
    if (now >= d.inventory) {
      commands.push(Command.ReadInventory());
      d = { ...d, inventory: nextInventory(s.claims, now) };
    }
    const due = [...d.online].filter(([, at]) => now >= at).map(([id]) => id);
    if (due.length > 0) {
      commands.push(Command.ReadChannels({ channelIds: due.toSorted() }));
      d = { ...d, online: new Map([...d.online].filter(([, at]) => now < at)) };
    }
    const again = [...d.deferred].filter(([, at]) => now >= at).map(([key]) => key);
    if (again.length > 0) {
      commands.push(...again.toSorted().map(readOfKey));
      d = { ...d, deferred: new Map([...d.deferred].filter(([, at]) => now < at)) };
    }
  }
  return [{ ...s, discovery, deadlines: d }, commands];
};

/** A campaign skip ends at its time (`CAMPAIGN_SKIP`), so `nextDeadline` never points back. */
const expireSkips = (s: State, now: Millis): State => {
  if (![...s.avoidCampaigns.values()].some((until) => now >= until)) return s;
  return {
    ...s,
    avoidCampaigns: new Map([...s.avoidCampaigns].filter(([, until]) => now < until)),
  };
};

/**
 * On a `Tick`, the watch tick once due, for the watch the plan kept. Deciding it after the plan means a step
 * that stops or moves the watch never also ticks the old channel: the tick would credit a minute
 * after the stop (the simulator caught it when a drop's window closed at a tick).
 */
const watchTick = (s: State, now: Millis): Handled => {
  const tick = s.deadlines.tick;
  if (s.auth !== "valid" || s.watch._tag !== "Watching" || tick === undefined || now < tick) {
    return [s, []];
  }
  return [
    { ...s, deadlines: { ...s.deadlines, tick: now + WATCH_INTERVAL } },
    [Command.WatchTick({ channelId: s.watch.channelId })],
  ];
};

/**
 * The next inventory read: the regular interval, or earlier when a lost claim answer is due its
 * recheck. A recheck is just an inventory read, so it never needs a deadline of its own.
 */
const nextInventory = (claims: ReadonlyMap<string, ClaimIntent>, now: Millis): Millis =>
  Math.min(
    now + INVENTORY_INTERVAL,
    ...[...claims.values()].map((c) =>
      c.recheckAt !== undefined && c.recheckAt > now ? c.recheckAt : Infinity,
    ),
  );

const ticked = (s: State, channelId: ChannelId, now: Millis): Handled => {
  const w = s.watch;
  if (w._tag !== "Watching" || w.channelId !== channelId) return [s, []];
  const estimatedMinutes = w.estimatedMinutes + WATCH_INTERVAL / MINUTE;
  // Twitch confirmed nothing the plan can use on this channel for a long time. If it kept
  // crediting a drop of the watched campaign that earns nothing (received, past its requirement),
  // it picks that drop for this account wherever we watch: skip the campaign for a while
  // (`CAMPAIGN_SKIP`), and give the channel a fresh clock for the next target, since that skip was
  // the campaign's fault. Twitch credits one campaign per stream, so if it keeps crediting the
  // skipped one there, the next stall skips the channel. Otherwise the channel doesn't credit
  // us: skip the channel.
  if (now - w.confirmedAt >= STALL_AFTER) {
    const wasted = w.wasted === undefined ? undefined : findDrop(s.catalog, w.wasted);
    if (wasted !== undefined && wasted.campaign.id === w.campaignId) {
      return [skipCampaign({ ...s, watch: { ...w, estimatedMinutes } }, wasted.drop, now), []];
    }
    return [
      { ...s, avoid: new Set([...s.avoid, channelId]), watch: { ...w, estimatedMinutes } },
      [],
    ];
  }
  const distrust =
    estimatedMinutes - w.confirmedMinutes >= MAX_UNCONFIRMED_MINUTES &&
    (w.lastCurrentDropRead === undefined || now - w.lastCurrentDropRead >= CURRENT_DROP_RECHECK);
  if (!distrust) return [{ ...s, watch: { ...w, estimatedMinutes } }, []];
  return [
    { ...s, watch: { ...w, estimatedMinutes, lastCurrentDropRead: now } },
    [Command.ReadCurrentDrop({ channelId })],
  ];
};

const clearSkip = (s: State, campaignId: CampaignId): State =>
  s.skipCauses.has(campaignId)
    ? { ...s, skipCauses: new Map([...s.skipCauses].filter(([id]) => id !== campaignId)) }
    : s;

/**
 * Give up the watched campaign until Twitch may have moved off `drop`: its window's end, or
 * `CAMPAIGN_SKIP`. The channel gets a fresh clock for its next target (the stall was the
 * campaign's fault).
 */
const skipCampaign = (s: State, drop: Drop, now: Millis): State => {
  const w = s.watch;
  if (w._tag !== "Watching") return s;
  // A cause whose window is over will not be credited again: skip the full period, or the 20 s
  // floor would retry it every 80 s (review of A6). Otherwise retry no sooner than a catalog read.
  const until =
    drop.endsAt <= now
      ? now + CAMPAIGN_SKIP
      : Math.max(now + CATALOG_RETRY, Math.min(drop.endsAt, now + CAMPAIGN_SKIP));
  return {
    ...s,
    avoidCampaigns: new Map([...s.avoidCampaigns, [w.campaignId, until]]),
    skipCauses: new Map([...s.skipCauses, [w.campaignId, drop.id]]),
    watch: { ...w, confirmedAt: now, wasted: undefined },
  };
};

/**
 * Twitch credited minutes to `dropId`. Record them. Only a credit that earns something confirms
 * the watch (`STALL_AFTER`): new minutes, within the requirement, for a drop that could still
 * earn before this credit. A drop a goal wants is adopted if it isn't the watched one: several
 * campaigns can share a stream and Twitch picks which one progresses. Another drop of a campaign
 * a goal works on (a badge while the goal wants the item) confirms without adoption once it is
 * within a stall of completing: Twitch reports one drop, and moves on to the next once it
 * completes. A credit to anything else (received, complete, past its requirement, a filtered drop
 * further off, a campaign no goal works on) is noted in `wasted`;
 * if it is the drop the watched campaign was last given up for, the campaign is given up again.
 */
const credit = (s: State, dropId: DropId, minutes: number, now: Millis, rank: Rank): State => {
  const updated = withProgress(s, dropId, (p) => ({ ...p, minutes: Math.max(p.minutes, minutes) }));
  const w = s.watch;
  if (w._tag !== "Watching") return updated;
  const found = findDrop(s.catalog, dropId);
  if (found === undefined) {
    // A campaign that started after the last catalog read: the channel does credit us, and the
    // catalog is stale. Read it again within `CATALOG_RETRY`, which also bounds the rate.
    const catalog = Math.min(s.deadlines.catalog, now + CATALOG_RETRY);
    return {
      ...updated,
      watch: { ...w, confirmedAt: now },
      deadlines: { ...updated.deadlines, catalog },
    };
  }
  const input = planInput(s, s.catalog ?? [], now);
  const before = input.progress.get(dropId)?.minutes ?? 0;
  // Minutes past the requirement are no progress, even as the first number we hear: Twitch kept
  // counting a received drop to 352 of 240.
  const earns =
    before < minutes &&
    minutes <= found.drop.requiredMinutes &&
    canEarn(found.drop, input.progress, now) &&
    wantedOn(input, found.campaign, w.channelId, rank);
  const usable = earns && usableOn(input, found.campaign, found.drop, w.channelId, rank);
  // A filtered-out drop of a campaign a goal works on (a badge while the goal wants the emote):
  // Twitch reports one drop and moves on to the next once it completes, so it confirms the watch
  // without adoption, but only within a stall of completing (and before its window closes).
  // Further off, it is no sign a wanted drop comes soon: Twitch crediting only a filtered
  // 148-minute item confirmed a watch forever (seed 80578). It needn't be the watched campaign:
  // Twitch credits one campaign per stream, and the channel was given up 5 minutes before it moved
  // on to the emote (seed 270187). The twin's `wantedCredit` holds the same bound.
  const leadsOn =
    earns &&
    !usable &&
    (found.drop.requiredMinutes - minutes) * MINUTE <=
      Math.min(STALL_AFTER, found.drop.endsAt - now);
  if (!usable && !leadsOn) {
    // A credit that leads nowhere counts toward giving up: the channel, or the watched campaign
    // when it is that campaign's (`ticked`).
    const again = w.campaignId === found.campaign.id && s.skipCauses.get(w.campaignId) === dropId;
    if (again) return skipCampaign(updated, found.drop, now);
    return { ...updated, watch: { ...w, wasted: dropId } };
  }
  // The campaign earns again, so a skip it caused is over: a straggling frame for that drop must
  // not skip it again (review of A6: one stale frame cost a fresh hour).
  const clears = clearSkip(updated, found.campaign.id);
  if (leadsOn) return { ...clears, watch: { ...w, confirmedAt: now, wasted: undefined } };
  return {
    ...clears,
    watch: {
      ...w,
      campaignId: found.campaign.id,
      dropId,
      credited: w.dropId === dropId ? w.credited : true,
      confirmedAt: now,
      confirmedMinutes: minutes,
      // Twitch's number replaces our estimate, as TDM resets its extra minutes on every truth.
      estimatedMinutes: minutes,
      wasted: undefined,
    },
  };
};

/**
 * Twitch frames only the drop of a campaign closest to done (run4h), so a wanted drop beside it
 * progresses unframed: the inventory is the first to show its minutes rise. Each rise is a credit
 * like a frame's (`credit`: adopt, confirm or waste), as long as the watched channel can earn the
 * drop's campaign; a rise elsewhere is minutes the previous watch earned before a switch, whose
 * inventory trails it, and is only recorded.
 */
const creditShown = (s: State, shown: ReadonlyArray<Progress>, now: Millis, rank: Rank): State => {
  let next = s;
  for (const read of shown.toSorted((a, b) => a.dropId.localeCompare(b.dropId))) {
    if (read.claimed || read.minutes <= (next.progress.get(read.dropId)?.minutes ?? 0)) continue;
    const w = next.watch;
    const found = findDrop(next.catalog, read.dropId);
    const channel = w._tag === "Watching" ? next.channels.get(w.channelId) : undefined;
    const here =
      found !== undefined &&
      channel !== undefined &&
      channelCanEarn(found.campaign, channel, [], new Set());
    if (here) next = credit(next, read.dropId, read.minutes, now, rank);
  }
  return next;
};

/**
 * Record confirmed progress for the watched drop whenever Twitch's number moves forward, up to
 * the drop's requirement: minutes beyond it earn nothing.
 */
const confirmWatched = (s: State, now: Millis): State => {
  const w = s.watch;
  if (w._tag !== "Watching") return s;
  const required = findDrop(s.catalog, w.dropId)?.drop.requiredMinutes ?? Infinity;
  const minutes = Math.min(s.progress.get(w.dropId)?.minutes ?? 0, required);
  if (minutes <= w.confirmedMinutes) return s;
  return {
    ...clearSkip(s, w.campaignId),
    watch: {
      ...w,
      confirmedAt: now,
      confirmedMinutes: minutes,
      estimatedMinutes: minutes,
      wasted: undefined,
    },
  };
};

/** What the plan sees: progress with received rewards counted as claimed (`withReceived`). */
const planInput = (s: State, campaigns: ReadonlyArray<Campaign>, now: Millis): PlanInput => ({
  campaigns,
  progress: withReceived(campaigns, s.progress, s.awarded, s.inventoried),
  channels: s.channels,
  settings: s.settings,
  refused: s.avoid,
  avoidedCampaigns: new Set(
    [...s.avoidCampaigns].filter(([, until]) => now < until).map(([id]) => id),
  ),
  now,
  watching: s.watch._tag === "Watching" ? s.watch.campaignId : undefined,
});

const replan = (s: State, now: Millis, rank: Rank): Handled => {
  if (s.auth !== "valid") return [s, []];
  if (s.catalog === undefined) {
    const reason = s.catalogStatus === "unavailable" ? "catalog-unavailable" : "starting";
    return s.watch._tag === "Idle" ? [{ ...s, watch: { _tag: "Idle", reason } }, []] : [s, []];
  }
  const input = planInput(s, s.catalog, now);
  const target = plan(input, rank);
  const w = s.watch;
  if (typeof target === "string") {
    const reason =
      target === "no-live-channel" && s.discovery !== undefined ? "discovering" : target;
    // Something wanted earns now but no channel we know plays it: read the catalog and the
    // directories again within `CATALOG_OPENING_GAP`, as a person would refresh the directory,
    // rather than at the hourly read. A channel that turns to the game isn't followed (it played
    // another), and its frames may have been lost: seed 50138 sat idle for most of an hour.
    const catalog =
      reason === "no-live-channel"
        ? Math.min(s.deadlines.catalog, now + CATALOG_OPENING_GAP)
        : s.deadlines.catalog;
    // An idle core wakes when the next wanted drop opens its window: nothing else would wake it
    // before the next inventory read, up to `INVENTORY_INTERVAL` late (seed 270057). Then the
    // plan may find a channel it already knows, or `tick` reads the channels that can credit it.
    const opening = firstOpening(s, s.catalog, now);
    const idle: State = {
      ...s,
      watch: { _tag: "Idle", reason },
      deadlines: {
        ...s.deadlines,
        tick: opening === Infinity ? undefined : opening,
        catalog,
      },
    };
    return [idle, w._tag === "Watching" ? [Command.StopWatching()] : []];
  }
  if (w._tag === "Watching" && keepChannel(s, w, target)) {
    // The drop Twitch credits wins over our pick while it can still earn (several campaigns
    // can share a stream, and Twitch chooses which one progresses).
    const credited = w.credited ? findDrop(s.catalog, w.dropId) : undefined;
    const keepDrop =
      w.dropId === target.drop.id ||
      (credited !== undefined &&
        usableOn(input, credited.campaign, credited.drop, w.channelId, rank));
    if (keepDrop) return [s, []];
    return [confirmWatched({ ...s, watch: watching(s, target, w.channelId, now) }, now), []];
  }
  if (s.discovery !== undefined) return holdWhileDiscovering(s, input, rank);
  return [
    {
      ...s,
      watch: watching(s, target, target.channel.id, now),
      deadlines: { ...s.deadlines, tick: now + WATCH_INTERVAL },
    },
    [Command.Watch({ channelId: target.channel.id })],
  ];
};

/** Discovery stops waiting for a read once it answered or failed. */
const answered = (s: State, read: string): State["discovery"] =>
  s.discovery === undefined
    ? undefined
    : { ...s.discovery, pending: s.discovery.pending.filter((k) => k !== read) };

/** Discovery is done once every read it started has answered or failed, or `discoverySettle` passed. */
const settleDiscovery = (s: State, now: Millis): State =>
  s.discovery !== undefined && (s.discovery.pending.length === 0 || now >= s.discovery.until)
    ? { ...s, discovery: undefined }
    : s;

/**
 * While discovery runs, the plan only sees part of the channels, so it may not start or switch
 * a watch. A watch that can still earn what it was started for stays; one that can't stops.
 */
const holdWhileDiscovering = (s: State, input: PlanInput, rank: Rank): Handled => {
  const w = s.watch;
  if (w._tag === "Watching") {
    const channel = s.channels.get(w.channelId);
    const earns = rank(input).some(
      (p) =>
        p.campaign.id === w.campaignId &&
        channel !== undefined &&
        channelCanEarn(p.campaign, channel, input.settings.goals[p.goal]!.excludeChannels, s.avoid),
    );
    if (earns) return [s, []];
  }
  const idle: State = {
    ...s,
    watch: { _tag: "Idle", reason: "discovering" },
    deadlines: { ...s.deadlines, tick: undefined },
  };
  return [idle, w._tag === "Watching" ? [Command.StopWatching()] : []];
};

/** Stay on a channel that can still credit the target: viewer counts move, and switching costs. */
const keepChannel = (s: State, w: Watching, target: Target): boolean => {
  if (target.channel.id === w.channelId) return true;
  const current = s.channels.get(w.channelId);
  const excluded = s.settings.goals[target.goal]?.excludeChannels ?? [];
  return current !== undefined && channelCanEarn(target.campaign, current, excluded, s.avoid);
};

const watching = (s: State, target: Target, channelId: ChannelId, now: Millis): Watching => {
  const minutes = s.progress.get(target.drop.id)?.minutes ?? 0;
  const keep = s.watch._tag === "Watching" && s.watch.channelId === channelId ? s.watch : undefined;
  return {
    _tag: "Watching",
    channelId,
    campaignId: target.campaign.id,
    dropId: target.drop.id,
    credited: false,
    // A new target on the same channel keeps the channel's last confirmation: otherwise a target
    // changing every < STALL_AFTER would hold a channel that never credits (seed 22972).
    confirmedAt: keep?.confirmedAt ?? now,
    confirmedMinutes: minutes,
    estimatedMinutes: minutes,
    lastCurrentDropRead: keep?.lastCurrentDropRead,
    wasted: keep?.wasted,
  };
};

/** Every completed drop in its claim window gets exactly one claim, recorded before it is sent. */
const sendClaims = (s: State, now: Millis): Handled => {
  if (s.auth !== "valid") return [s, []];
  const commands: Array<Command> = [];
  const claims = new Map(s.claims);
  for (const p of [...s.progress.values()].toSorted((a, b) => a.dropId.localeCompare(b.dropId))) {
    const key = claimKey(p.campaignId, p.dropId);
    if (p.instanceId === undefined || !isClaimable(p, now) || claims.has(key)) continue;
    claims.set(key, {
      campaignId: p.campaignId,
      dropId: p.dropId,
      status: "sent",
      recheckAt: undefined,
    });
    commands.push(
      Command.Claim({ campaignId: p.campaignId, dropId: p.dropId, instanceId: p.instanceId }),
    );
  }
  return commands.length === 0 ? [s, []] : [{ ...s, claims }, commands];
};

/**
 * Follow the channels the plan wants. A change waits `SUBSCRIBE_SETTLE` from when it was first
 * seen, so a burst of reads coalesces into one `Subscribe` of the set wanted at the deadline; a
 * change that undoes itself before then sends nothing.
 */
const follow = (s: State, now: Millis, rank: Rank): Handled => {
  if (s.auth !== "valid" || s.catalog === undefined) return [s, []];
  const desired = watchlist(planInput(s, s.catalog, now), WATCHLIST_LIMIT, rank).toSorted();
  const pending = s.deadlines.subscribe;
  const withDeadline = (subscribe: Millis | undefined): State =>
    subscribe === pending ? s : { ...s, deadlines: { ...s.deadlines, subscribe } };
  if (sameMembers(desired, s.subscriptions)) return [withDeadline(undefined), []];
  if (pending === undefined) return [withDeadline(now + SUBSCRIBE_SETTLE), []];
  if (now < pending) return [s, []];
  return [
    { ...withDeadline(undefined), subscriptions: desired },
    [Command.Subscribe({ channelIds: desired })],
  ];
};

/**
 * When the next drop a goal wants opens its window. Discovery only reads channels for what can
 * earn at the catalog read, so the catalog is read again then (at most every `CATALOG_OPENING_GAP`):
 * otherwise a drop opening between hourly reads waits up to an hour for its channels.
 */
const nextOpening = (s: State, campaigns: ReadonlyArray<Campaign>, now: Millis): Millis => {
  const first = firstOpening(s, campaigns, now);
  return first === Infinity ? Infinity : Math.max(now + CATALOG_OPENING_GAP, first);
};

/** When the next drop a goal wants opens its window, after `now`. */
const firstOpening = (s: State, campaigns: ReadonlyArray<Campaign>, now: Millis): Millis => {
  const progress = withReceived(campaigns, s.progress, s.awarded, s.inventoried);
  const starts = campaigns.flatMap((campaign) => {
    if (now >= campaign.endsAt) return [];
    const wanted = new Set(
      s.settings.goals.flatMap((goal) => [...wantedDrops(goal, campaign, progress)]),
    );
    return campaign.drops
      .filter((d) => wanted.has(d.id) && d.startsAt > now)
      .map((d) => d.startsAt);
  });
  return Math.min(Infinity, ...starts);
};

/** Ask for the channels that can credit the minable campaigns: the directory or the allow-list. */
const discover = (
  s: State,
  now: Millis,
  rank: Rank,
  only?: ReadonlySet<CampaignId>,
): ReadonlyArray<ChannelRead> => {
  if (s.catalog === undefined) return [];
  const input = planInput(s, s.catalog, now);
  const games = new Set<string>();
  const listed = new Set<ChannelId>();
  const commands: Array<ChannelRead> = [];
  for (const { campaign } of rank(input)) {
    if (only !== undefined && !only.has(campaign.id)) continue;
    if (campaign.allowedChannels.length > 0) {
      for (const id of campaign.allowedChannels) if (listed.size < WATCHLIST_LIMIT) listed.add(id);
    } else if (!games.has(campaign.game.id)) {
      games.add(campaign.game.id);
      commands.push(Command.ReadDirectory({ gameId: campaign.game.id }));
    }
  }
  if (listed.size > 0) commands.push(Command.ReadChannels({ channelIds: [...listed].toSorted() }));
  return commands;
};

const findDrop = (catalog: ReadonlyArray<Campaign> | undefined, dropId: DropId) => {
  for (const campaign of catalog ?? []) {
    const drop = campaign.drops.find((d) => d.id === dropId);
    if (drop !== undefined) return { campaign, drop };
  }
  return undefined;
};

/** Update a drop's progress, creating it from the catalog when Twitch reports a drop first. */
const withProgress = (s: State, dropId: DropId, f: (p: Progress) => Progress): State => {
  const existing = s.progress.get(dropId);
  const found = existing === undefined ? findDrop(s.catalog, dropId) : undefined;
  const base: Progress | undefined =
    existing ??
    (found === undefined
      ? undefined
      : {
          dropId,
          campaignId: found.campaign.id,
          campaignEndsAt: found.campaign.endsAt,
          minutes: 0,
          instanceId: undefined,
          claimed: false,
        });
  if (base === undefined) return s;
  const progress = new Map(s.progress);
  progress.set(dropId, f(base));
  return { ...s, progress };
};

/** Inventory trails PubSub, so never move minutes backwards; a claim or instance id always wins. */
const merge = (existing: Progress | undefined, read: Progress): Progress =>
  existing === undefined
    ? read
    : {
        ...read,
        minutes: read.claimed ? read.minutes : Math.max(existing.minutes, read.minutes),
        instanceId: read.instanceId ?? existing.instanceId,
        claimed: read.claimed || existing.claimed,
      };

const withChannel = (s: State, id: ChannelId, f: (ch: Channel) => Channel): State => {
  const channel = s.channels.get(id);
  if (channel === undefined) return s;
  const channels = new Map(s.channels);
  channels.set(id, f(channel));
  return { ...s, channels };
};

const mapValues = <K, V>(map: ReadonlyMap<K, V>, f: (v: V) => V): ReadonlyMap<K, V> =>
  new Map([...map].map(([k, v]) => [k, f(v)]));

const sameMembers = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
