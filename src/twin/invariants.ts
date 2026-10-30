import {
  CATALOG_INTERVAL,
  INVENTORY_INTERVAL,
  ONLINE_DELAY,
  STALL_AFTER,
  SUBSCRIBE_SETTLE,
  WATCH_INTERVAL,
  type State,
} from "../core/state.ts";
import {
  MINUTE,
  claimKey,
  type Campaign,
  type CampaignId,
  type ChannelId,
  type Millis,
} from "../core/model.ts";
import type { Command, Event } from "../core/protocol.ts";
import { canonical, decodeState, encodeState } from "../store/codec.ts";
import { allowedPicks, goalDrops } from "./oracle.ts";
import { SIM_EPOCH, type Violation } from "./scenario.ts";
import { TWIN_TIMEOUT, type Activity } from "./twin.ts";
import {
  channelOf,
  claimableAt,
  creditedCampaign,
  earnable,
  faultWindows,
  framesDownAt,
  gameAt,
  instanceOf,
  isClaimedAt,
  isRevoked,
  liveAt,
  type Credit,
  type World,
} from "./world.ts";

/** A command whose executor fiber hasn't finished. */
export interface InFlight {
  readonly command: Command;
  readonly since: Millis;
}

/** One core step: the event, the states around it, and what it asked for. */
export interface StepRecord {
  readonly event: Event;
  readonly before: State;
  readonly after: State;
  readonly commands: ReadonlyArray<Command>;
  /** The saved text. */
  readonly persisted: string;
}

/** Everything the checker sees at one loop wake-up. */
export interface Observation {
  readonly now: Millis;
  readonly step: StepRecord | undefined;
  /** The core's state now. */
  readonly state: State;
  readonly world: World;
  /** What the twin saw since the last observation. */
  readonly activity: Activity;
  readonly defects: ReadonlyArray<string>;
  readonly inFlight: ReadonlyArray<InFlight>;
  /** Set when the process restarted since the last observation: the last save and what resumed. */
  readonly restart: { readonly saved: string | undefined; readonly resumed: State } | undefined;
}

/** A command issued, or a request started, this long after it should have stopped is a defect. */
export const COMMAND_DEADLINE: Millis = 5 * MINUTE;
export const IN_FLIGHT_LIMIT = 4;
export const BUSY_STEPS = 20;
/**
 * A `Watch` this soon after the previous one needs a cause (`WatchFlip`). The startup flip seen
 * live came 5 s after the first watch.
 */
export const FLIP_WINDOW: Millis = 2 * MINUTE;
/** How far before a watch a schedule change may still be news to the core: `stream-up` waits. */
const NEWS_LAG: Millis = ONLINE_DELAY + MINUTE;
/** Discovery after a restart: validate, catalog, directory and channel reads. */
const RESTART_GRACE: Millis = 2 * MINUTE;

interface ClaimTrack {
  /** The previous `Claim` was settled by an inventory read after its recheck time, drop unclaimed. */
  readonly settled: boolean;
  readonly applied: boolean;
}

export interface Checker {
  /** The core's last `Watch` since a restart or `StopWatching`. */
  readonly watching: ChannelId | undefined;
  readonly lastTick: { readonly channelId: ChannelId; readonly at: Millis } | undefined;
  readonly claims: ReadonlyMap<string, ClaimTrack>;
  readonly claimCommands: number;
  readonly claimAttempts: number;
  readonly parkedSince: Millis | undefined;
  readonly instant: { readonly at: Millis; readonly steps: number };
  readonly idleSince: Millis | undefined;
  /** Since when the core could know of a current opportunity (catalog, channel live). */
  readonly knownSince: Millis | undefined;
  /** When the core's current watch began. */
  readonly watchSince: Millis | undefined;
  readonly restartedAt: Millis | undefined;
  /** Channels the core avoids for a reason the twin agrees with. */
  readonly fairlyAvoided: ReadonlySet<ChannelId>;
  /** Channels whose last schedule change reached the core as a frame. */
  readonly heard: ReadonlySet<ChannelId>;
  /**
   * The last credit of a campaign missing from the core's catalog. The core takes it as a sign of
   * life and rereads the catalog (`credit` in `step.ts`), so its stall clock restarts there.
   */
  readonly unknownCreditAt: Millis | undefined;
  /** When each channel last credited a campaign the settings want. */
  readonly lastWantedCredit: ReadonlyMap<ChannelId, Millis>;
  readonly lastObservedAt: Millis;
  readonly lastSaved: string | undefined;
  /** The core's last `Watch` since a restart, kept through `StopWatching`. */
  readonly lastWatch:
    | {
        readonly channelId: ChannelId;
        readonly at: Millis;
        readonly campaignId: CampaignId | undefined;
      }
    | undefined;
  readonly lastCatalogReadAt: Millis | undefined;
  /** The last catalog or channel read that gave up: the core's picture missed its answer. */
  readonly lastReadFailureAt: Millis | undefined;
  /** The core's last `Subscribe` since a restart. */
  readonly lastSubscribe:
    | { readonly at: Millis; readonly channelIds: ReadonlyArray<ChannelId> }
    | undefined;
}

export const initialChecker: Checker = {
  watching: undefined,
  lastTick: undefined,
  claims: new Map(),
  claimCommands: 0,
  claimAttempts: 0,
  parkedSince: undefined,
  instant: { at: -1, steps: 0 },
  idleSince: undefined,
  knownSince: undefined,
  watchSince: undefined,
  unknownCreditAt: undefined,
  restartedAt: undefined,
  fairlyAvoided: new Set(),
  heard: new Set(),
  lastWantedCredit: new Map(),
  lastObservedAt: SIM_EPOCH,
  lastSaved: undefined,
  lastWatch: undefined,
  lastCatalogReadAt: undefined,
  lastReadFailureAt: undefined,
  lastSubscribe: undefined,
};

/** Some goal that may watch `channelId` asks for one of these credited drops. */
const wantedCredit = (world: World, credit: Credit): boolean => {
  const campaign = world.campaigns.find((x) => x.id === credit.campaignId);
  if (campaign === undefined) return false;
  return world.settings.goals.some(
    (g) =>
      !g.excludeChannels.includes(credit.channelId) &&
      goalDrops(g, campaign, (id) => isClaimedAt(world, id, credit.at)).some((d) =>
        credit.dropIds.includes(d.id),
      ),
  );
};

/** Some goal that may watch `channelId` asks for a drop of the campaign that can earn now. */
const wanted = (world: World, campaign: Campaign, channelId: ChannelId, now: Millis): boolean =>
  world.settings.goals.some(
    (g) =>
      !g.excludeChannels.includes(channelId) &&
      goalDrops(g, campaign, (id) => world.claimed.has(id)).some((d) => earnable(world, d, now)),
  );

export interface Opportunity {
  readonly channelId: ChannelId;
  readonly campaign: Campaign;
}

/**
 * Channels where a watch would earn something the settings want, by twin truth: live, not
 * excluded, not refusing, not fairly avoided, and discoverable by the miner (on the campaign's
 * allow-list, or streaming its game so the directory lists it).
 */
export const opportunities = (
  world: World,
  now: Millis,
  avoided: ReadonlySet<ChannelId>,
): ReadonlyArray<Opportunity> =>
  world.channels.flatMap((ch) => {
    if (avoided.has(ch.id)) return [];
    const campaign = creditedCampaign(world, ch.id, now);
    if (campaign === undefined || !wanted(world, campaign, ch.id, now)) return [];
    const discoverable =
      campaign.allowedChannels.length > 0 || gameAt(world, ch.id, now) === campaign.game.id;
    return discoverable ? [{ channelId: ch.id, campaign }] : [];
  });

/** The twin's session channel is earning something the settings want. */
const productive = (world: World, now: Millis): boolean => {
  const session = world.session;
  if (session === undefined) return false;
  const campaign = creditedCampaign(world, session.channelId, now);
  return campaign !== undefined && wanted(world, campaign, session.channelId, now);
};

const minutesSince = (at: Millis) => ((at - SIM_EPOCH) / MINUTE).toFixed(2);

export const violation = (kind: string, now: Millis, detail: string): Violation => ({
  kind,
  at: Number(((now - SIM_EPOCH) / MINUTE).toFixed(3)),
  detail,
});

/**
 * Checks one observation against every invariant of the plan's §4 and returns the next checker
 * state with the violations found. Pure, so a failure replays from its observations.
 */
export const checkStep = (
  checker: Checker,
  o: Observation,
): readonly [Checker, ReadonlyArray<Violation>] => {
  const found: Array<Violation> = [];
  const fail = (kind: string, detail: string) => found.push(violation(kind, o.now, detail));
  let c: Checker = checker;
  const world = o.world;

  // 5: what resumes after a crash is exactly the last save.
  if (o.restart !== undefined) {
    if (o.restart.saved !== undefined && encodeState(o.restart.resumed) !== o.restart.saved) {
      fail("StateLost", "the state resumed after a restart differs from the last save");
    }
    c = {
      ...c,
      watching: undefined,
      lastTick: undefined,
      parkedSince: undefined,
      restartedAt: o.now,
      idleSince: undefined,
      knownSince: undefined,
      watchSince: undefined,
      unknownCreditAt: undefined,
      fairlyAvoided: new Set(),
      heard: new Set(),
      lastWatch: undefined,
      lastSubscribe: undefined,
    };
  }

  // 3c: what the core did at its last step has run: an idle core watches nothing.
  const coreIdle = (o.step?.before ?? o.state).watch._tag === "Idle";
  if (coreIdle && world.session !== undefined && o.restart === undefined) {
    fail(
      "IdleButWatching",
      `the core is idle, the twin still has a session on ${world.session.channelId}`,
    );
  }
  if (coreIdle && o.activity.credits.length > 0 && o.restart === undefined) {
    fail(
      "IdleButWatching",
      `the core is idle, ${o.activity.credits[0]!.channelId} credited a minute`,
    );
  }

  // Twin activity: claims, ticks, requests.
  for (const call of o.activity.calls) {
    if (call.kind === "claim") {
      c = { ...c, claimAttempts: c.claimAttempts + 1 };
      if (call.alreadyApplied) fail("ClaimedTwice", `${call.instanceId} was claimed again`);
      if (call.applied && call.dropId !== undefined) {
        const claims = new Map(c.claims);
        for (const [key, track] of claims) {
          if (key.endsWith(`/${call.dropId}`)) claims.set(key, { ...track, applied: true });
        }
        c = { ...c, claims };
      }
      if (isRevoked(world, call.endedAt) && call.applied) {
        fail("TwinBroken", `${call.instanceId} applied after the token was revoked`);
      }
    }
    if (call.kind === "tick" && call.result === "ticked") {
      const last = c.lastTick;
      if (
        last !== undefined &&
        last.channelId !== call.channelId &&
        call.endedAt - last.at < WATCH_INTERVAL - 1_000
      ) {
        fail(
          "TwoWatches",
          `${last.channelId} and ${call.channelId} credited ${call.endedAt - last.at} ms apart`,
        );
      }
      c = { ...c, lastTick: { channelId: call.channelId, at: call.endedAt } };
    }
    if (
      (call.kind === "tick" || call.kind === "claim") &&
      call.endedAt - call.at > TWIN_TIMEOUT + 1_000
    ) {
      fail("Defect", `a ${call.kind} waited ${call.endedAt - call.at} ms`);
    }
    if (c.parkedSince !== undefined && call.at > c.parkedSince + COMMAND_DEADLINE) {
      fail("ParkedButPolling", `${call.kind} while parked`);
    }
  }
  if (c.claimAttempts > c.claimCommands + countClaims(o.step?.commands ?? [])) {
    fail("MutationRetried", "the executor sent more claims than the core asked for");
  }
  for (const request of o.activity.requests) {
    if (request.endedAt - request.at > TWIN_TIMEOUT + 1_000) {
      fail("Defect", `${request.operation} waited ${request.endedAt - request.at} ms`);
    }
    if (c.parkedSince !== undefined && request.at > c.parkedSince + COMMAND_DEADLINE) {
      fail("ParkedButPolling", `${request.operation} while parked`);
    }
  }
  const lastWantedCredit = new Map(c.lastWantedCredit);
  for (const credit of o.activity.credits) {
    if (o.state.catalog?.some((x) => x.id === credit.campaignId) !== true) {
      c = { ...c, unknownCreditAt: credit.at };
    }
    if (isRevoked(world, credit.at))
      fail("TwinBroken", `credit on ${credit.channelId} after revoke`);
    if (wantedCredit(world, credit)) {
      lastWantedCredit.set(credit.channelId, credit.at);
    }
  }
  c = { ...c, lastWantedCredit };
  const session = world.session;
  if (session !== undefined && session.creditedSeconds * 1000 > o.now - session.openedAt + 1) {
    fail("TwinBroken", `session on ${session.channelId} credited more than its open time`);
  }

  // s3, s5: executor outcomes and in-flight work.
  for (const defect of o.defects) fail("Defect", defect);
  const perKind = new Map<string, number>();
  for (const f of o.inFlight) {
    perKind.set(f.command._tag, (perKind.get(f.command._tag) ?? 0) + 1);
    if (o.now - f.since > COMMAND_DEADLINE) {
      fail("Defect", `${f.command._tag} in flight since +${minutesSince(f.since)}m`);
    }
  }
  for (const [kind, n] of perKind) {
    if (n > IN_FLIGHT_LIMIT) fail("TooManyInFlight", `${n} ${kind} in flight`);
  }

  if (o.step !== undefined) c = checkCommands(c, o, o.step, fail);

  // Channels whose schedule changed since the last look: did the core hear about it? A change
  // to what already holds (`up` while live) sends no frame (`channelFrames`), so it isn't heard.
  const heard = new Set(c.heard);
  for (const ch of world.channels) {
    const changed = ch.phases.some((p, i) => {
      const before = ch.phases[i - 1];
      return (
        before !== undefined &&
        p.at > c.lastObservedAt &&
        p.at <= o.now &&
        (p.live !== before.live || p.gameId !== before.gameId)
      );
    });
    if (!changed) continue;
    if (world.subscriptions.has(ch.id) && !framesDownAt(world, o.now)) heard.add(ch.id);
    else heard.delete(ch.id);
  }
  c = { ...c, heard };

  c = checkIdle(c, o, fail);
  return [{ ...c, lastObservedAt: o.now }, found];
};

const countClaims = (commands: ReadonlyArray<Command>) =>
  commands.filter((x) => x._tag === "Claim").length;

const checkCommands = (
  checker: Checker,
  o: Observation,
  step: StepRecord,
  fail: (kind: string, detail: string) => void,
): Checker => {
  let c = checker;
  const world = o.world;
  const { before, after, event, commands } = step;

  // 5: every save decodes to itself.
  if (!roundTrips(step.persisted)) {
    fail("StateLost", "the saved state does not survive a round-trip");
  }
  c = { ...c, lastSaved: step.persisted };

  // s2: the core keeps waking at one instant.
  const instant =
    c.instant.at === o.now ? { at: o.now, steps: c.instant.steps + 1 } : { at: o.now, steps: 1 };
  if (instant.steps === BUSY_STEPS + 1) fail("BusyWake", `${instant.steps} steps at one instant`);
  c = { ...c, instant };

  // s1: parked means silent (decision 11).
  if (before.auth === "needs-login" && event._tag !== "Started" && commands.length > 0) {
    fail("ParkedButPolling", `parked, yet ${commands.map((x) => x._tag).join(", ")}`);
  }
  if (after.auth === "needs-login" && before.auth !== "needs-login")
    c = { ...c, parkedSince: o.now };

  // 4: a lost claim answer settles only through a late enough inventory read.
  if (event._tag === "InventoryRead") {
    const claims = new Map(c.claims);
    for (const [key, intent] of before.claims) {
      const track = claims.get(key);
      const read = event.progress.find((p) => p.dropId === intent.dropId);
      const late =
        intent.status === "unknown" && intent.recheckAt !== undefined && o.now >= intent.recheckAt;
      if (track !== undefined && late && read !== undefined && !read.claimed) {
        claims.set(key, { ...track, settled: true });
      }
    }
    c = { ...c, claims };
  }

  if (event._tag === "CatalogRead") c = { ...c, lastCatalogReadAt: o.now };
  if (event._tag === "ChannelsReadFailed" || event._tag === "CatalogUnavailable") {
    c = { ...c, lastReadFailureAt: o.now };
  }

  for (const command of commands) {
    switch (command._tag) {
      case "Watch": {
        const flip = flipWithoutCause(c, o, step, command.channelId);
        if (flip !== undefined) fail("WatchFlip", flip);
        const campaignId = after.watch._tag === "Watching" ? after.watch.campaignId : undefined;
        const wrong = wrongPick(o, step, campaignId);
        if (wrong !== undefined) fail("WrongPick", wrong);
        c = {
          ...c,
          watching: command.channelId,
          watchSince: o.now,
          lastWatch: { channelId: command.channelId, at: o.now, campaignId },
        };
        break;
      }
      case "StopWatching":
        c = { ...c, watching: undefined };
        break;
      case "Subscribe": {
        // Churn: the same set twice without a restart, or a new set sooner than the settle time
        // after the last (unsubscribing on a refused token goes out at once).
        const last = c.lastSubscribe;
        if (last !== undefined && canonical(last.channelIds) === canonical(command.channelIds)) {
          fail("SubscribeChurn", `the same ${command.channelIds.length} channels again`);
        } else if (
          last !== undefined &&
          command.channelIds.length > 0 &&
          o.now - last.at < SUBSCRIBE_SETTLE
        ) {
          fail("SubscribeChurn", `a new set ${o.now - last.at} ms after the last`);
        }
        c = { ...c, lastSubscribe: { at: o.now, channelIds: command.channelIds } };
        break;
      }
      case "WatchTick":
        // 1: a tick for a channel the core never opened a session on.
        if (c.watching !== command.channelId) {
          fail(
            "TwoWatches",
            `tick for ${command.channelId}, the session is ${c.watching ?? "none"}`,
          );
        }
        break;
      case "Claim": {
        const key = claimKey(command.campaignId, command.dropId);
        // 2a: the twin already holds this drop as claimed. 2b: complete, the right instance,
        // within the window, by twin truth.
        if (world.claimed.has(command.dropId)) {
          fail("ClaimedTwice", `${key} is already claimed`);
        } else if (
          !claimableAt(world, command.dropId, o.now) ||
          command.instanceId !== instanceOf(command.dropId)
        ) {
          fail("ClaimedEarly", `${key} is not claimable now`);
        }
        const track = c.claims.get(key);
        if (track !== undefined && !(track.settled && !track.applied)) {
          fail("MutationRetried", `${key} claimed again before inventory settled the last claim`);
        }
        const claims = new Map(c.claims);
        claims.set(key, { settled: false, applied: false });
        c = { ...c, claims, claimCommands: c.claimCommands + 1 };
        break;
      }
      default:
        break;
    }
  }

  // 3b: avoid a channel only for a cause the twin agrees with.
  for (const id of after.avoid) {
    if (before.avoid.has(id)) continue;
    const refuses = channelOf(world, id)?.refuses === true;
    const quietFor = STALL_AFTER - INVENTORY_INTERVAL - world.inventoryLag - 2 * MINUTE;
    const lastCredit = c.lastWantedCredit.get(id);
    const quiet = lastCredit === undefined || o.now - lastCredit >= quietFor;
    const disturbed = faultWindows(world).some(
      (w) => w.from <= o.now && w.to >= o.now - STALL_AFTER,
    );
    if (refuses || quiet || disturbed) {
      c = { ...c, fairlyAvoided: new Set([...c.fairlyAvoided, id]) };
    } else {
      fail("AvoidedUnfairly", `${id} avoided, it credited at +${minutesSince(lastCredit ?? 0)}m`);
    }
  }
  return c;
};

const changedBetween = (world: World, id: ChannelId, from: Millis, to: Millis): boolean =>
  channelOf(world, id)?.phases.some((p, i) => i > 0 && from < p.at && p.at <= to) === true;

/**
 * 6: a `Watch` within `FLIP_WINDOW` of the previous one on another channel needs a cause the
 * twin or the core can name: the old channel changed, failed or is avoided, the old campaign has
 * nothing wanted left, or there is news since: the new channel changed, a claim unlocked a drop,
 * a campaign started, or a new catalog read found more. Planning on half the discovery answers
 * has none of these (the startup flip, live 2026-10-30). Returns the violation's detail.
 */
const flipWithoutCause = (
  c: Checker,
  o: Observation,
  step: StepRecord,
  next: ChannelId,
): string | undefined => {
  const last = c.lastWatch;
  if (last === undefined || last.channelId === next || o.now - last.at >= FLIP_WINDOW) {
    return undefined;
  }
  const world = o.world;
  const from = last.at - NEWS_LAG;
  // Only a read that gave up leaves the core with a picture it can't complete; a fault its
  // retries absorbed changed nothing it knows (a 5 s blip excused the startup flip, review P2-2).
  const faulted = c.lastReadFailureAt !== undefined && c.lastReadFailureAt >= from;
  const old = last.channelId;
  const oldChanged =
    changedBetween(world, old, from, o.now) ||
    step.after.avoid.has(old) ||
    step.after.channels.get(old)?.live === undefined;
  const oldCampaigns = [
    last.campaignId,
    step.before.watch._tag === "Watching" ? step.before.watch.campaignId : undefined,
  ].flatMap((id) => world.campaigns.filter((x) => x.id === id));
  const oldDone = oldCampaigns.some((campaign) => !wanted(world, campaign, old, o.now));
  const news =
    changedBetween(world, next, from, o.now) ||
    (c.lastCatalogReadAt !== undefined && c.lastCatalogReadAt > last.at) ||
    [...world.claimed.values()].some((at) => at > from) ||
    world.campaigns.some((x) =>
      [x.startsAt, ...x.drops.map((d) => d.startsAt)].some((t) => from < t && t <= o.now),
    );
  if (faulted || oldChanged || oldDone || news) return undefined;
  return `${old} at +${minutesSince(last.at)}m, then ${next} with no cause`;
};

/**
 * 7: a new watch is for a campaign decision 28 ranks first among what the core knew (`oracle.ts`,
 * written apart from the planner). It judges the ranking, not the data: the core's catalog,
 * progress and channels are the input, so a fault or a discovery still running can't excuse a
 * wrong pick. Returns the violation's detail.
 */
const wrongPick = (
  o: Observation,
  step: StepRecord,
  campaignId: CampaignId | undefined,
): string | undefined => {
  const { before, after, event } = step;
  if (campaignId === undefined || after.catalog === undefined) return undefined;
  const watched = [
    ...(before.watch._tag === "Watching" ? [before.watch.campaignId] : []),
    ...((event._tag === "DropProgress" || event._tag === "CurrentDropRead") &&
    event.dropId !== undefined
      ? after.catalog.filter((x) => x.drops.some((d) => d.id === event.dropId)).map((x) => x.id)
      : []),
  ];
  const view = {
    catalog: after.catalog,
    progress: after.progress,
    channels: after.channels,
    avoid: after.avoid,
    now: o.now,
  };
  const allowed = allowedPicks(o.world.settings, view, watched);
  if (allowed.has(campaignId)) return undefined;
  const instead = allowed.size === 0 ? "no goal wants anything" : [...allowed].join(", ");
  return `watching for ${campaignId}, decision 28 ranks first: ${instead}`;
};

/**
 * 3: while the twin says a watch would earn something wanted and the miner earns nothing, an idle
 * clock runs. Its bound depends on what the miner could know (critique P0.6).
 */
const checkIdle = (
  checker: Checker,
  o: Observation,
  fail: (kind: string, detail: string) => void,
): Checker => {
  const world = o.world;
  const windows = faultWindows(world);
  const faulted = windows.some((w) => w.from <= o.now && o.now < w.to);
  const restarting =
    checker.restartedAt !== undefined && o.now - checker.restartedAt < RESTART_GRACE;
  const paused = faulted || isRevoked(world, o.now) || restarting || o.state.auth === "needs-login";
  const chances = opportunities(world, o.now, checker.fairlyAvoided);
  if (paused || chances.length === 0 || productive(world, o.now)) {
    return { ...checker, idleSince: undefined, knownSince: undefined };
  }
  const since = checker.idleSince ?? o.now;
  const known = chances.some((chance) => {
    const inCatalog = o.state.catalog?.some((x) => x.id === chance.campaign.id) === true;
    const seen = o.state.channels.get(chance.channelId);
    const seenLive =
      seen?.live !== undefined && seen.gameId === gameAt(world, chance.channelId, o.now);
    return inCatalog && (seenLive || checker.heard.has(chance.channelId));
  });
  const knownSince = known ? (checker.knownSince ?? o.now) : undefined;
  const recentFault = windows.some((w) => w.to <= o.now && o.now - w.to < CATALOG_INTERVAL);
  // Watching a channel the core believes credits: stream info can't tell `dropsEnabled`
  // (`wire.ts`), so only the stall rule can find out.
  const watching = o.state.watch._tag === "Watching";
  const watchedFor =
    o.now - Math.max(since, checker.watchSince ?? since, checker.unknownCreditAt ?? since);
  const late = watching
    ? watchedFor > STALL_AFTER + 2 * MINUTE
    : o.now - since > CATALOG_INTERVAL + 2 * MINUTE ||
      (knownSince !== undefined && !recentFault && o.now - knownSince > ONLINE_DELAY + MINUTE);
  if (late) {
    const chance = chances[0]!;
    fail(
      "Idle",
      `${chance.channelId} could earn ${chance.campaign.id} since +${minutesSince(since)}m ` +
        `(live: ${liveAt(world, chance.channelId, o.now)}, core: ${canonical(o.state.watch)})`,
    );
    return { ...checker, idleSince: undefined, knownSince: undefined };
  }
  return { ...checker, idleSince: since, knownSince };
};

const roundTrips = (text: string): boolean => {
  try {
    return encodeState(decodeState(text)) === text;
  } catch {
    return false;
  }
};
