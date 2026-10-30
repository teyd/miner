import {
  MINUTE,
  claimKey,
  type Campaign,
  type Channel,
  type ChannelId,
  type DropId,
  type Millis,
  type Progress,
} from "./model.ts";
import {
  minable,
  plan,
  wantedOn,
  watchlist,
  type PlanInput,
  type Rank,
  type Target,
} from "./plan.ts";
import { Command, readKey, type ChannelRead, type Event } from "./protocol.ts";
import { canEarn, channelCanEarn, isClaimable, wantedDrops } from "./rules.ts";
import {
  CATALOG_INTERVAL,
  CATALOG_RETRY,
  CLAIM_RECHECK,
  CURRENT_DROP_RECHECK,
  INVENTORY_INTERVAL,
  MAX_UNCONFIRMED_MINUTES,
  ONLINE_DELAY,
  STALL_AFTER,
  SUBSCRIBE_SETTLE,
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
          deadlines: { ...s.deadlines, tick: undefined, online: new Map(), subscribe: undefined },
        },
        [
          ...(s.watch._tag === "Watching" ? [Command.StopWatching()] : []),
          ...(s.subscriptions.length > 0 ? [Command.Subscribe({ channelIds: [] })] : []),
        ],
      ];

    case "CatalogRead": {
      const next: State = {
        ...s,
        catalog: event.campaigns,
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
      const progress = new Map(s.progress);
      for (const read of event.progress)
        progress.set(read.dropId, merge(progress.get(read.dropId), read));
      const claims = new Map(s.claims);
      for (const [key, intent] of claims) {
        const p = progress.get(intent.dropId);
        // A lost claim answer is resolved here: claimed means done. Still unclaimed in a read
        // taken after the recheck time means it failed, so dropping the intent lets the claim
        // pass send it again, informed. An earlier read may just lag the claim.
        const settled =
          intent.status === "unknown" && intent.recheckAt !== undefined && now >= intent.recheckAt;
        if (p?.claimed === true || (settled && p !== undefined)) {
          claims.delete(key);
        }
      }
      const next = {
        ...s,
        progress,
        claims,
        deadlines: { ...s.deadlines, inventory: nextInventory(claims, now) },
      };
      return [confirmWatched(next, now), []];
    }

    case "DropProgress": {
      const updated = credit(s, event.dropId, event.minutes, now, rank);
      const drop = findDrop(s.catalog, event.dropId);
      const complete = drop !== undefined && event.minutes >= drop.drop.requiredMinutes;
      return [updated, complete ? [Command.ReadInventory()] : []];
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

    case "Tick":
      return tick(s, now);
  }
};

const tick = (s: State, now: Millis): Handled => {
  const commands: Array<Command> = [];
  let d = s.deadlines;
  if (now >= d.validate) {
    commands.push(Command.ValidateToken());
    d = { ...d, validate: now + VALIDATE_INTERVAL };
  }
  if (s.auth === "valid") {
    if (now >= d.catalog) {
      commands.push(Command.ReadCatalog());
      d = { ...d, catalog: now + CATALOG_INTERVAL };
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
  }
  return [{ ...s, deadlines: d }, commands];
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
  // Twitch never confirmed a minute on this channel for a long time: it doesn't credit us here.
  if (now - w.confirmedAt >= STALL_AFTER) {
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

/**
 * Twitch credited minutes to `dropId`. Record them, and if we're watching, adopt that drop even
 * if we planned another: several campaigns can share a stream and Twitch picks which progresses.
 */
const credit = (s: State, dropId: DropId, minutes: number, now: Millis, rank: Rank): State => {
  const updated = withProgress(s, dropId, (p) => ({ ...p, minutes: Math.max(p.minutes, minutes) }));
  const w = updated.watch;
  if (w._tag !== "Watching" || w.dropId === dropId) return confirmWatched(updated, now);
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
  // Twitch credits a campaign the settings don't ask for: no progress for us, so no adoption.
  if (!wantedOn(planInput(updated, s.catalog ?? [], now), found.campaign, w.channelId, rank)) {
    return updated;
  }
  return confirmWatched(
    {
      ...updated,
      watch: { ...w, campaignId: found.campaign.id, dropId, credited: true, confirmedMinutes: -1 },
    },
    now,
  );
};

/** Record confirmed progress for the watched drop whenever Twitch's number moves forward. */
const confirmWatched = (s: State, now: Millis): State => {
  const w = s.watch;
  if (w._tag !== "Watching") return s;
  const minutes = s.progress.get(w.dropId)?.minutes ?? 0;
  if (minutes <= w.confirmedMinutes) return s;
  return {
    ...s,
    watch: {
      ...w,
      confirmedAt: now,
      confirmedMinutes: minutes,
      // Twitch's number replaces our estimate, as TDM resets its extra minutes on every truth.
      estimatedMinutes: minutes,
    },
  };
};

const planInput = (s: State, campaigns: ReadonlyArray<Campaign>, now: Millis): PlanInput => ({
  campaigns,
  progress: s.progress,
  channels: s.channels,
  settings: s.settings,
  refused: s.avoid,
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
    const idle: State = {
      ...s,
      watch: { _tag: "Idle", reason },
      deadlines: { ...s.deadlines, tick: undefined },
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
        wantedOn(input, credited.campaign, w.channelId, rank) &&
        canEarn(credited.drop, s.progress, now));
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
    confirmedAt: now,
    confirmedMinutes: minutes,
    estimatedMinutes: minutes,
    lastCurrentDropRead: keep?.lastCurrentDropRead,
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
 * earn at the catalog read, so the catalog is read again then (at most every `CATALOG_RETRY`):
 * otherwise a drop opening between hourly reads waits up to an hour for its channels.
 */
const nextOpening = (s: State, campaigns: ReadonlyArray<Campaign>, now: Millis): Millis => {
  const starts = campaigns.flatMap((campaign) => {
    if (now >= campaign.endsAt) return [];
    const wanted = new Set(
      s.settings.goals.flatMap((goal) => [...wantedDrops(goal, campaign, s.progress)]),
    );
    return campaign.drops
      .filter((d) => wanted.has(d.id) && d.startsAt > now)
      .map((d) => d.startsAt);
  });
  return starts.length === 0 ? Infinity : Math.max(now + CATALOG_RETRY, Math.min(...starts));
};

/** Ask for the channels that can credit the minable campaigns: the directory or the allow-list. */
const discover = (s: State, now: Millis, rank: Rank): ReadonlyArray<ChannelRead> => {
  if (s.catalog === undefined) return [];
  const input = planInput(s, s.catalog, now);
  const games = new Set<string>();
  const listed = new Set<ChannelId>();
  const commands: Array<ChannelRead> = [];
  for (const { campaign } of rank(input)) {
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
