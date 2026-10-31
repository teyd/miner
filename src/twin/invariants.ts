import {
  CATALOG_INTERVAL,
  CAMPAIGN_SKIP,
  CLAIM_RECHECK,
  INVENTORY_INTERVAL,
  ONLINE_DELAY,
  READ_BATCH,
  READ_WORST_CASE,
  STALL_AFTER,
  SUBSCRIBE_SETTLE,
  THROTTLE_FLOOR,
  WATCHLIST_LIMIT,
  WATCH_INTERVAL,
  type State,
} from "../core/state.ts";
import {
  MINUTE,
  claimKey,
  type Campaign,
  type CampaignId,
  type ChannelId,
  type DropId,
  type DropInstanceId,
  type Millis,
} from "../core/model.ts";
import type { Command, Event } from "../core/protocol.ts";
import { canonical, decodeState, encodeState } from "../store/codec.ts";
import { allowedPicks, allowedWatch, canFinishOn, goalDrops, type View } from "./oracle.ts";
import { SIM_EPOCH, type Fault, type Violation } from "./scenario.ts";
import { CDN_LIMITS, GQL_LIMITS } from "../twitch/budget.ts";
import { TWIN_TIMEOUT, TWITCH_GQL_PER_SECOND, type Activity } from "./twin.ts";
import {
  channelOf,
  claimShows,
  claimableAt,
  completeAt,
  creditedCampaign,
  creditedDrops,
  earnable,
  earnedAt,
  faultWindows,
  gameAt,
  cooldownWindows,
  instanceOf,
  isClaimedAt,
  looksReceived,
  isRevoked,
  liveAt,
  minutesAt,
  sessionAt,
  ACCOUNT,
  type Credit,
  type World,
} from "./world.ts";
import { channelTopics, dropsTopic } from "../twitch/frames.ts";
import { PUBSUB_MAX_CONNECTIONS, PUBSUB_TOPICS_PER_CONNECTION } from "../twitch/identity.ts";

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
  /** Topics listened on the edge's open sockets. */
  readonly listening: ReadonlySet<string>;
  /**
   * The last `Subscribe` went out without the account id: PubSub could not validate (a refused
   * or failed request) and follows the account's drops from the next change (`PubSub.ts`).
   */
  readonly accountUnknown?: boolean;
}

/**
 * The most requests one command sends one after the other: a stream read of a full watchlist, in
 * batches of `READ_BATCH`, or a catalog read (validation, dashboard, details).
 */
export const MOST_REQUESTS = Math.max(Math.ceil(WATCHLIST_LIMIT / READ_BATCH), 3);
/**
 * A command still in flight this long, or a request started this long after the core parked, is
 * a defect: each of its requests at its worst (`READ_WORST_CASE`), one after the other, and a
 * minute. A fixed 5 min was shorter than a three-batch read whose every attempt hangs (582 s).
 */
export const COMMAND_DEADLINE: Millis = MOST_REQUESTS * READ_WORST_CASE + MINUTE;
/**
 * The same command (kind and arguments) in flight at most this often: a read that outlives its
 * interval may overlap the next, a storm may not. Different commands of one kind may all be out
 * at once (a catalog read starts one directory read per game, 14 live on 2026-10-30); what
 * reaches Twitch at once is bounded by the request budgets, invariant 8.
 */
export const IN_FLIGHT_LIMIT = 4;
/**
 * All commands in flight at once, at most: two discoveries' worth of reads (a directory read per
 * game and one of allow-listed channels each, as when a catalog read comes while the last one's
 * reads still hang), plus room for the core's own reads, claims, ticks and subscriptions. A
 * storm of distinct reads, each paced by the budget, passes `IN_FLIGHT_LIMIT` but not this.
 */
export const inFlightCap = (games: number): number => 2 * (games + 1) + 10;
/**
 * 9: a drop the twin would let the account claim (complete, unclaimed, inside its claim window) is
 * claimed within this long, unless the token is revoked or a fault window is open. The core hears
 * of it from a frame, or from the next inventory read once inventory shows it (`inventoryLag`);
 * a refused or lost claim waits `CLAIM_RECHECK` and another inventory read; each of the two reads
 * may take `READ_WORST_CASE`; a 429 just before cools the budget down `GQL_LIMITS.cooldown`.
 */
export const claimLiveness = (world: World): Millis =>
  world.inventoryLag +
  INVENTORY_INTERVAL +
  CLAIM_RECHECK +
  2 * READ_WORST_CASE +
  GQL_LIMITS.cooldown +
  2 * MINUTE;
/** A refused read must be sent again by its retry time (`Throttled`), give or take this. */
const RESEND_SLACK: Millis = 1_000;
/** Refused commands the core must send again itself; a claim goes through inventory (9). */
const RESENT = new Set<Command["_tag"]>([
  "ValidateToken",
  "ReadCatalog",
  "ReadInventory",
  "ReadDirectory",
  "ReadChannels",
]);
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
/**
 * A `Subscribe` this old, with no fault around it, is listened on the edge: connecting, a LISTEN
 * and its RESPONSE take seconds, a lost one 10 s and a reconnect.
 */
export const LISTEN_SETTLE: Millis = 2 * MINUTE;
/** A `Subscribe` that empties a connection closes it at once; this allows for its pacing. */
const CLOSE_AFTER_SUBSCRIBE: Millis = 30_000;
/** Topics the edge can hold for one process. */
const TOPIC_CAPACITY = PUBSUB_MAX_CONNECTIONS * PUBSUB_TOPICS_PER_CONNECTION;

/**
 * Connections the client needs for a `Subscribe`: its channels' two topics each, packed 50 to a
 * connection (`assign` in `PubSub.ts` keeps exactly as many as the topics fill). The account's
 * drops topic is left out: without the account id it isn't sent, so this is the fewest. A gap:
 * with the id known, 25k channels fill k connections and the drops topic needs one more, which
 * this doesn't count, so a close (or a `RECONNECT` left unanswered) that drops that extra
 * connection passes `shrunk` though the drops topic then has no socket. Only `NotListening`
 * catches that, and only after a `Subscribe` that settles with no fault near it.
 */
const connectionsFor = (channels: number) =>
  Math.min(PUBSUB_MAX_CONNECTIONS, Math.ceil((2 * channels) / PUBSUB_TOPICS_PER_CONNECTION));

interface ClaimTrack {
  /** The previous `Claim` was settled by an inventory read after its recheck time, drop unclaimed. */
  readonly settled: boolean;
  readonly applied: boolean;
  /** A claim of a drop Twitch already held as claimed went out, excused once (`blind`). */
  readonly blindRetried: boolean;
}

/** A wanted credit, and whether the core has heard of it yet. */
interface HeardCredit {
  readonly at: Millis;
  readonly campaignId: CampaignId;
  /** Each credited drop's minutes after this credit: a read or frame showing as many heard it. */
  readonly totals: ReadonlyArray<readonly [DropId, number]>;
  readonly heard: boolean;
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
  /** Campaigns the core avoids for a reason the twin agrees with, each until when. */
  readonly fairlyAvoidedCampaigns: ReadonlyMap<CampaignId, Millis>;
  /** The core's last campaign skip per channel: that channel gets a fresh stall for its next target. */
  readonly campaignSkippedAt: ReadonlyMap<ChannelId, Millis>;
  /** The core's last inventory read since a restart. */
  readonly lastInventoryAt: Millis | undefined;
  /** Channels whose last schedule change reached the core as a frame. */
  readonly heard: ReadonlySet<ChannelId>;
  /**
   * The last credit of a campaign missing from the core's catalog. The core takes it as a sign of
   * life and rereads the catalog (`credit` in `step.ts`), so its stall clock restarts there.
   */
  readonly unknownCreditAt: Millis | undefined;
  /** When each channel last credited a campaign the settings want. */
  readonly lastWantedCredit: ReadonlyMap<ChannelId, Millis>;
  /** When each channel last credited a minute that earned, for any goal that may watch it. */
  readonly lastEarnedCredit: ReadonlyMap<ChannelId, Millis>;
  /**
   * The last such credit on each channel to a campaign missing from the core's catalog. The core
   * can't keep the frame's minutes (no campaign to file them under), so it learns them from the
   * first inventory read that shows them, and confirms the watch then (`confirmWatched`).
   */
  readonly unplacedCredit: ReadonlyMap<
    ChannelId,
    { readonly at: Millis; readonly dropIds: ReadonlyArray<DropId> }
  >;
  /** The core's inventory read that may be the first to show each channel's `unplacedCredit`. */
  readonly unplacedHeardAt: ReadonlyMap<ChannelId, Millis>;
  /** Each channel's wanted credits in the last `STALL_AFTER`, by campaign. */
  readonly wantedCredits: ReadonlyMap<ChannelId, ReadonlyArray<HeardCredit>>;
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
  /** The last catalog read that changed the core's catalog. */
  readonly lastCatalogChangeAt: Millis | undefined;
  /** The last catalog or channel read that gave up: the core's picture missed its answer. */
  readonly lastReadFailureAt: Millis | undefined;
  /** The core's last `Subscribe` since a restart, and whether the edge was checked for it. */
  readonly lastSubscribe:
    | {
        readonly at: Millis;
        readonly channelIds: ReadonlyArray<ChannelId>;
        readonly checked?: boolean;
      }
    | undefined;
  /** API requests (GQL, validation, claims) that ended within `SPAN_MEMORY`, for concurrency. */
  readonly apiSpans: ReadonlyArray<Span>;
  /** CDN requests (usher, playlists, segments) that ended within `SPAN_MEMORY`, for concurrency. */
  readonly cdnSpans: ReadonlyArray<Span>;
  /** CDN request starts within the last `CDN_LIMITS.window`. */
  readonly cdnStarts: ReadonlyArray<Millis>;
  /** Refused commands (canonical) the core owes, and by when it must send them again. */
  readonly owed: ReadonlyMap<string, Millis>;
  /** Drops claimable by twin truth, and since when, while nothing excuses the wait. */
  readonly claimableSince: ReadonlyMap<DropId, Millis>;
  /** Since when the core's watch is idle: a credit from a tick it asked for later is a leak. */
  readonly stoppedAt: Millis | undefined;
  /**
   * The twin's last claim call per instance, until a `ClaimResult` reports it: whether Twitch
   * answered it with a grant (`ELIGIBLE_FOR_ALL` for a fresh or an already applied claim).
   */
  readonly claimAnswers: ReadonlyMap<DropInstanceId, { readonly granted: boolean }>;
}

interface Span {
  readonly at: Millis;
  readonly endedAt: Millis;
}

/**
 * How long a finished request is kept to count what overlapped it: longer than any request lasts
 * (`TWIN_TIMEOUT`), so the last of a set of overlapping requests to end still sees the others.
 */
const SPAN_MEMORY: Millis = 2 * MINUTE;

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
  fairlyAvoidedCampaigns: new Map(),
  campaignSkippedAt: new Map(),
  lastInventoryAt: undefined,
  heard: new Set(),
  lastWantedCredit: new Map(),
  lastEarnedCredit: new Map(),
  unplacedCredit: new Map(),
  unplacedHeardAt: new Map(),
  wantedCredits: new Map(),
  lastObservedAt: SIM_EPOCH,
  lastSaved: undefined,
  lastWatch: undefined,
  lastCatalogChangeAt: undefined,
  lastReadFailureAt: undefined,
  lastSubscribe: undefined,
  apiSpans: [],
  cdnSpans: [],
  cdnStarts: [],
  owed: new Map(),
  claimableSince: new Map(),
  stoppedAt: SIM_EPOCH,
  claimAnswers: new Map(),
};

/** The campaigns a skip covers at `now`. */
const skippedAt = (skips: ReadonlyMap<CampaignId, Millis>, now: Millis): ReadonlySet<CampaignId> =>
  new Set([...skips].filter(([, until]) => now < until).map(([id]) => id));

/**
 * The minute earned something: one of the credited drops was short of its requirement, unclaimed,
 * open and unlocked, in a campaign where some goal that may watch the channel asks for a drop that
 * can earn. A wanted drop needn't be the credited one: Twitch reports one drop and moves on to the
 * next once it completes (`creditsMoveOn`), so a credited drop that completes within a stall, and
 * within its window, leads to it. One further off can't be held against a core that waits a stall
 * for a wanted credit (sweep seed 131: an unwanted 139-minute item credited alone, 100 minutes
 * short, on a channel the core watched for another campaign). A campaign the core fairly gave up
 * on earns nothing.
 */
const wantedCredit = (
  world: World,
  credit: Credit,
  avoided: ReadonlyMap<CampaignId, Millis>,
): boolean => {
  const campaign = world.campaigns.find((x) => x.id === credit.campaignId);
  // A hidden campaign is no goal's: the miner can't know it exists.
  if (campaign === undefined || world.hidden.has(campaign.id)) return false;
  if (skippedAt(avoided, credit.at).has(campaign.id)) return false;
  const earning = campaign.drops.filter(
    (d) => credit.dropIds.includes(d.id) && earnedAt(world, d, credit.at),
  );
  const movesOn = earning.some((d) => {
    const left = (d.requiredMinutes - minutesAt(world, d.id, credit.at)) * MINUTE;
    return left <= Math.min(STALL_AFTER, d.endsAt - credit.at);
  });
  return (
    earning.length > 0 &&
    world.settings.goals.some(
      (g) =>
        !g.excludeChannels.includes(credit.channelId) &&
        goalDrops(g, campaign, (id) => isClaimedAt(world, id, credit.at)).some(
          (d) =>
            earnedAt(world, d, credit.at) &&
            !looksReceived(world, d, credit.at) &&
            (earning.includes(d) || movesOn),
        ),
    )
  );
};

/**
 * A credit that moved minutes forward inside a drop's requirement, in a campaign some goal that may
 * watch this channel asks for. Weaker than `wantedCredit` by design: it leaves out "looks already
 * received", where the core's own `awarded` set and the twin can disagree by one inventory read, and
 * it is only used to restart the unproductive clock (a credit that earns is evidence Twitch credits
 * the channel, not that the drop is worth keeping).
 */
const earnedWantedCredit = (
  world: World,
  credit: Credit,
  avoided: ReadonlyMap<CampaignId, Millis>,
) => {
  const campaign = world.campaigns.find((x) => x.id === credit.campaignId);
  if (campaign === undefined || world.hidden.has(campaign.id)) return false;
  if (skippedAt(avoided, credit.at).has(campaign.id)) return false;
  return campaign.drops.some(
    (d) =>
      credit.dropIds.includes(d.id) &&
      earnedAt(world, d, credit.at) &&
      world.settings.goals.some(
        (g) =>
          !g.excludeChannels.includes(credit.channelId) &&
          goalDrops(g, campaign, (id) => isClaimedAt(world, id, credit.at)).includes(d),
      ),
  );
};

/**
 * A minute there would credit a drop of the campaign that can earn, and some goal that may watch
 * `channelId` asks for a drop of it that can earn: Twitch may credit only one drop
 * (`creditsOnly`), which earns nothing once received or complete.
 */
const wanted = (world: World, campaign: Campaign, channelId: ChannelId, now: Millis): boolean => {
  const credited = creditedDrops(world, campaign, now);
  if (!credited.some((d) => earnable(world, d, now))) return false;
  return world.settings.goals.some(
    (g) =>
      !g.excludeChannels.includes(channelId) &&
      goalDrops(g, campaign, (id) => world.claimed.has(id)).some(
        (d) => earnable(world, d, now) && !looksReceived(world, d, now),
      ),
  );
};

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
  avoidedCampaigns: ReadonlySet<CampaignId> = new Set(),
): ReadonlyArray<Opportunity> =>
  world.channels.flatMap((ch) => {
    if (avoided.has(ch.id)) return [];
    const campaign = creditedCampaign(world, ch.id, now);
    if (campaign === undefined || avoidedCampaigns.has(campaign.id)) return [];
    if (!wanted(world, campaign, ch.id, now)) return [];
    const discoverable =
      campaign.allowedChannels.length > 0 || gameAt(world, ch.id, now) === campaign.game.id;
    return discoverable ? [{ channelId: ch.id, campaign }] : [];
  });

/** The twin's session channel is earning something the settings want. */
const productive = (world: World, now: Millis): boolean => {
  const session = sessionAt(world, now);
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
      fairlyAvoidedCampaigns: new Map(),
      campaignSkippedAt: new Map(),
      lastInventoryAt: undefined,
      heard: new Set(),
      lastWatch: undefined,
      lastSubscribe: undefined,
      stoppedAt: o.now,
      // What a previous run read or failed to read is no news to this one, which reads again.
      lastCatalogChangeAt: undefined,
      lastReadFailureAt: undefined,
      unplacedCredit: new Map(),
      unplacedHeardAt: new Map(),
      // The new run starts its reads over.
      owed: new Map(),
    };
  }

  // 3c: an idle core watches nothing: no beat credits that a tick asked for after the stop, or
  // that no tick asked for. A tick sent before the stop may still land.
  const coreIdle = (o.step?.before ?? o.state).watch._tag === "Idle";
  const stoppedAt = c.stoppedAt;
  const leaked = o.activity.credits.find(
    (x) => x.sentAt === undefined || (stoppedAt !== undefined && x.sentAt >= stoppedAt),
  );
  if (coreIdle && leaked !== undefined && o.restart === undefined) {
    fail("IdleButWatching", `the core is idle, ${leaked.channelId} credited a minute`);
  }

  // The wire: every request belongs to a command in flight, the token never reaches the CDN,
  // sockets and topics stay within Twitch's limits, and each tick reports what Twitch answered.
  for (const orphan of o.activity.orphans) fail("Orphan", orphan);
  for (const leak of o.activity.leaks) fail("TokenLeak", leak);
  for (const wrong of o.activity.wrongTokens) fail("WrongToken", wrong);
  for (const missing of o.activity.identity) fail("CdnIdentity", missing);
  for (const breach of o.activity.budget) fail("SocketBudget", breach);
  for (const misread of o.activity.misreads) fail("WatchMisread", misread);
  // A `RECONNECT` must be obeyed: the socket closed and another opened. One closed for good is
  // fine when a `Subscribe` around it emptied that slot, as for a close (`shrunk` below): the
  // sockets left hold every channel the core follows, none when it follows nothing.
  for (const r of o.activity.reconnects) {
    const last = c.lastSubscribe;
    const shrunk =
      last !== undefined &&
      last.at >= r.at - CLOSE_AFTER_SUBSCRIBE &&
      last.at <= r.checkedAt &&
      r.remaining >= connectionsFor(last.channelIds.length);
    if (!r.closed) fail("ReconnectIgnored", `socket ${r.socket} stayed open after a RECONNECT`);
    else if (!shrunk)
      fail("ReconnectIgnored", `no new socket after socket ${r.socket}'s RECONNECT`);
  }
  // A socket the client closes needs a cause: the edge asked (`RECONNECT`, an error), the
  // process stopped, or a `Subscribe` emptied its slot: one that left as many sockets as its
  // channels need. Twitch answers every PING and LISTEN, so a client timeout here is a client
  // bug (#15: every write went down the newest socket).
  for (const close of o.activity.closes) {
    const last = c.lastSubscribe;
    const shrunk =
      last !== undefined &&
      close.at - last.at <= CLOSE_AFTER_SUBSCRIBE &&
      close.remaining >= connectionsFor(last.channelIds.length);
    if (!close.excused && !shrunk) {
      fail("SocketChurn", `the client closed socket ${close.socket} with no cause`);
    }
  }

  // Twin activity: claims, ticks, requests.
  for (const call of o.activity.calls) {
    if (call.kind === "claim") {
      const granted =
        call.answered && (call.outcome === "claimed" || call.outcome === "already-claimed");
      const claimAnswers = new Map(c.claimAnswers).set(call.instanceId, { granted });
      c = { ...c, claimAttempts: c.claimAttempts + 1, claimAnswers };
      if (call.alreadyApplied && blind(world, call.dropId)) {
        // Allowed, see `blind`.
      } else if (call.alreadyApplied) {
        fail("ClaimedTwice", `${call.instanceId} was claimed again`);
      }
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
  const lastEarnedCredit = new Map(c.lastEarnedCredit);
  const unplacedCredit = new Map(c.unplacedCredit);
  const wantedCredits = new Map(
    [...c.wantedCredits].map(([id, xs]) => [id, xs.filter((x) => x.at > o.now - STALL_AFTER)]),
  );
  for (const credit of o.activity.credits) {
    const unknown = o.state.catalog?.some((x) => x.id === credit.campaignId) !== true;
    if (unknown) c = { ...c, unknownCreditAt: credit.at };
    if (isRevoked(world, credit.at))
      fail("TwinBroken", `credit on ${credit.channelId} after revoke`);
    if (earnedWantedCredit(world, credit, c.fairlyAvoidedCampaigns)) {
      lastEarnedCredit.set(credit.channelId, credit.at);
      if (unknown) unplacedCredit.set(credit.channelId, { at: credit.at, dropIds: credit.dropIds });
    }
    if (wantedCredit(world, credit, c.fairlyAvoidedCampaigns)) {
      lastWantedCredit.set(credit.channelId, credit.at);
      const totals = credit.dropIds.map((d) => [d, minutesAt(world, d, credit.at)] as const);
      wantedCredits.set(credit.channelId, [
        ...(wantedCredits.get(credit.channelId) ?? []),
        { at: credit.at, campaignId: credit.campaignId, totals, heard: false },
      ]);
    }
  }
  c = {
    ...c,
    lastWantedCredit,
    lastEarnedCredit,
    unplacedCredit,
    wantedCredits,
  };
  c = checkBudgets(c, o, fail);
  const session = world.session;
  if (session !== undefined && session.creditedSeconds * 1000 > o.now - session.openedAt + 1) {
    fail("TwinBroken", `session on ${session.channelId} credited more than its open time`);
  }

  // s3, s5: executor outcomes and in-flight work.
  for (const defect of o.defects) fail("Defect", defect);
  const perCommand = new Map<string, number>();
  for (const f of o.inFlight) {
    const same = canonical(f.command);
    perCommand.set(same, (perCommand.get(same) ?? 0) + 1);
    if (o.now - f.since > COMMAND_DEADLINE) {
      fail("Defect", `${f.command._tag} in flight since +${minutesSince(f.since)}m`);
    }
  }
  for (const [kind, n] of perCommand) {
    if (n > IN_FLIGHT_LIMIT) fail("TooManyInFlight", `${n} ${kind} in flight`);
  }
  const cap = inFlightCap(new Set(world.campaigns.map((x) => x.game.id)).size);
  if (o.inFlight.length > cap) {
    fail("TooManyInFlight", `${o.inFlight.length} commands in flight, more than ${cap}`);
  }

  if (o.step !== undefined) c = checkCommands(c, o, o.step, fail);

  // Channels whose schedule changed since the last look are news the core hasn't heard, until
  // the edge delivers their frame to a socket listening for it. A change to what already holds
  // (`up` while live) sends no frame (`channelFrames`), so it isn't heard.
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
    if (changed) heard.delete(ch.id);
  }
  for (const d of o.activity.delivered) heard.add(d.channelId);
  c = { ...c, heard };
  c = checkListening(c, o, fail);

  c = checkIdle(c, o, fail);
  checkUnproductive(c, o, fail);
  c = checkOwed(c, o, fail);
  c = checkClaimLiveness(c, o, fail);
  return [{ ...c, lastObservedAt: o.now }, found];
};

/**
 * A claimed drop the inventory never shows claimed: an item of an unlinked campaign (Marvel Rivals,
 * 2026-10-30: answered `ELIGIBLE_FOR_ALL`, listed unclaimed with its instance id 2.5 hours later).
 * After a lost answer settled by a read, or for a drop claimed before the run, nothing the core
 * can read tells it the claim went through, so one more claim can't be held against it
 * (`blindClaim`). What Twitch answers to it is unmeasured (research 04 §2b, open for lane D); the
 * twin answers `already-claimed`.
 */
const blind = (world: World, dropId: DropId | undefined): boolean =>
  dropId !== undefined && world.claimed.has(dropId) && !claimShows(world, dropId);

/**
 * Why a claim of a `blind` drop is not excused, or `undefined`. Excused once per drop, and only
 * when the core had no answer it could trust: the previous claim's answer was lost and an
 * inventory read past its recheck time settled it, or the drop was claimed before the run.
 */
const blindClaim = (
  world: World,
  dropId: DropId,
  track: ClaimTrack | undefined,
): readonly [kind: string, detail: string] | undefined => {
  if (track === undefined) {
    const claimedAt = world.claimed.get(dropId);
    return claimedAt !== undefined && claimedAt < SIM_EPOCH
      ? undefined
      : ["ClaimedTwice", "claimed again, never claimed by this run"];
  }
  if (track.blindRetried) return ["ClaimedTwice", "claimed again after its one blind re-claim"];
  if (!track.settled) {
    return ["MutationRetried", "claimed again before inventory settled the last claim"];
  }
  return undefined;
};

/** The core heard a credit: a read or frame shows a credited drop at its minutes or more. */
const hears = (event: Event, credit: HeardCredit): boolean => {
  const shown: ReadonlyArray<{ readonly dropId: DropId | undefined; readonly minutes: number }> =
    event._tag === "InventoryRead"
      ? event.progress
      : event._tag === "DropProgress" || event._tag === "CurrentDropRead"
        ? [event]
        : [];
  return credit.totals.some(([dropId, total]) =>
    shown.some((p) => p.dropId === dropId && p.minutes >= total),
  );
};

/**
 * 8: the miner keeps within Twitch's per-IP limits and its own request budgets (`budget.ts`,
 * critique 08 CF-5): no GQL request answered 429 for the rate (`TWITCH_GQL_PER_SECOND`), at most
 * `GQL_LIMITS.concurrency` API requests in flight, CDN requests (usher, playlists, segment `HEAD`s,
 * each one on the wire) `CDN_LIMITS.concurrency` at a time and at most `CDN_LIMITS.max` a window.
 * Every request is counted once, as the twin served it; the miner's budgets charge them in its own
 * code (`gql.ts`, `hls.ts`), so a request that bypassed a budget shows here. Sockets are the edge's
 * to count (`SocketBudget`). Twitch counts per IP, so a restart forgets nothing here.
 */
const checkBudgets = (
  checker: Checker,
  o: Observation,
  fail: (kind: string, detail: string) => void,
): Checker => {
  let c = checker;
  const api: Array<Span> = [];
  const cdn: Array<Span> = [];
  let cdnStarts = [...c.cdnStarts];
  for (const request of o.activity.requests) {
    if (CDN_OPERATIONS.has(request.operation)) {
      cdn.push(request);
      cdnStarts = [...cdnStarts.filter((t) => t > request.at - CDN_LIMITS.window), request.at];
      if (cdnStarts.length > CDN_LIMITS.max) {
        fail("OverBudget", `${cdnStarts.length} CDN requests within ${CDN_LIMITS.window} ms`);
      }
      continue;
    }
    // A tick's requests are CDN requests, so two overlapping ticks are caught by the CDN
    // concurrency limit above; the client's own `busy` guard is what serialises them.
    api.push(request);
    if (request.limited) {
      fail(
        "OverBudget",
        `Twitch answered ${request.operation} 429: over ${TWITCH_GQL_PER_SECOND} GQL requests a second`,
      );
    }
  }
  const overlapping = (
    kept: ReadonlyArray<Span>,
    limit: number,
    what: string,
  ): ReadonlyArray<Span> => {
    for (const span of kept) {
      const open = kept.filter((s) => s.at <= span.at && span.at < s.endedAt).length;
      if (open > limit) {
        fail("OverBudget", `${open} ${what} requests in flight at +${minutesSince(span.at)}m`);
        break;
      }
    }
    return kept;
  };
  const recent = (spans: ReadonlyArray<Span>) =>
    spans.filter((s) => s.endedAt > o.now - SPAN_MEMORY);
  if (api.length > 0) {
    const apiSpans = overlapping([...recent(c.apiSpans), ...api], GQL_LIMITS.concurrency, "API");
    c = { ...c, apiSpans };
  }
  if (cdn.length > 0) {
    const cdnSpans = overlapping([...recent(c.cdnSpans), ...cdn], CDN_LIMITS.concurrency, "CDN");
    c = { ...c, cdnSpans };
  }
  return { ...c, cdnStarts };
};

const CDN_OPERATIONS: ReadonlySet<string> = new Set(["usher", "playlist", "segment"]);

/**
 * 11: once a `Subscribe` settled with nothing disturbing it (no fault, crash or revoked token from
 * `LISTEN_SETTLE` before it until now), the edge's open sockets listen to exactly its topics:
 * each channel's two, and the account's drops while any channel is followed, unless PubSub said
 * it subscribed without the account id (`accountUnknown`: a budget refused or Twitch failed its
 * validation; it follows the drops from the next change). Checked once per `Subscribe`.
 */
const checkListening = (
  c: Checker,
  o: Observation,
  fail: (kind: string, detail: string) => void,
): Checker => {
  const last = c.lastSubscribe;
  if (last === undefined || last.checked === true || o.now - last.at < LISTEN_SETTLE) return c;
  const checked = { ...c, lastSubscribe: { ...last, checked: true } };
  const from = last.at - LISTEN_SETTLE;
  const disturbed =
    o.state.auth !== "valid" ||
    isRevoked(o.world, o.now) ||
    (c.restartedAt !== undefined && c.restartedAt >= from) ||
    o.world.faults.some((f) => {
      const start = SIM_EPOCH + f.atMinute * MINUTE;
      const end = start + ("durationSeconds" in f ? f.durationSeconds * 1000 : 0);
      return start <= o.now && end >= from && disturbsListening(f);
    });
  const wanted = new Set(last.channelIds.flatMap(channelTopics));
  if (last.channelIds.length > 0 && o.accountUnknown !== true) {
    wanted.add(dropsTopic(ACCOUNT.userId));
  }
  if (disturbed || wanted.size > TOPIC_CAPACITY) return checked;
  const missing = [...wanted].filter((t) => !o.listening.has(t));
  const extra = [...o.listening].filter((t) => !wanted.has(t));
  if (missing.length + extra.length > 0) {
    fail(
      "NotListening",
      `${minutesSince(o.now)}m: ${missing.length} topics missing (${missing.slice(0, 3).join(", ")}), ` +
        `${extra.length} extra, ${((o.now - last.at) / 1000).toFixed(0)} s after the last Subscribe`,
    );
  }
  return checked;
};

/**
 * Faults that can leave the edge listening to other topics than the last `Subscribe`'s: the edge
 * itself (a `RECONNECT`, an outage), a crash, a revoked token, and a failed `validate`, without
 * which the client can't name the account's drops topic. Other API faults touch no socket.
 */
const disturbsListening = (f: Fault): boolean => {
  switch (f.kind) {
    case "pubsub-reconnect":
    case "reconnect":
    case "pubsub-outage":
    case "crash":
    case "revoke-token":
      return true;
    case "http-5xx":
    case "http-429":
    case "timeout":
    case "service-error":
      return f.operation === "validate" || f.operation === "any";
    default:
      return false;
  }
};

/**
 * What a `ClaimResult` may say, by what the twin did with the claim: `claimed` only when Twitch
 * granted it and holds it, `already-claimed` only when it holds it, `unknown` only when no grant
 * came back (a fault, a lost answer, a refusal). Returns the violation's detail.
 */
const claimMisread = (
  c: Checker,
  world: World,
  event: Extract<Event, { readonly _tag: "ClaimResult" }>,
): string | undefined => {
  const answer = c.claimAnswers.get(instanceOf(event.dropId));
  const held = world.claimed.has(event.dropId);
  switch (event.outcome) {
    case "claimed":
      return answer?.granted === true && held
        ? undefined
        : `${event.dropId} reported claimed, Twitch ${answer === undefined ? "saw no claim" : answer.granted ? "holds none" : "granted none"}`;
    case "already-claimed":
      return held ? undefined : `${event.dropId} reported already claimed, Twitch holds none`;
    case "unknown":
      return answer?.granted === true
        ? `${event.dropId} reported unknown, Twitch answered a grant`
        : undefined;
  }
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

  // 5: every save decodes to itself (a save equal to the last one was checked then).
  if (step.persisted !== c.lastSaved && !roundTrips(step.persisted)) {
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
    // The read shows minutes up to its request minus `inventoryLag`; the request left at most a
    // timeout before its answer arrived here. It may be the first to show a credit when the
    // previous read may not have (seed 150534: a minute earned at +4.4m, unplaced, first shown by
    // the read at +10.1m, which confirmed the watch).
    const unplacedHeardAt = new Map(c.unplacedHeardAt);
    for (const [channelId, unplaced] of c.unplacedCredit) {
      // The read must actually carry the credit's minutes: a credit the core can never place (a
      // campaign that opens and closes between two catalog reads) earns no slack (review of A6).
      const carried = event.progress.some(
        (p) => unplaced.dropIds.includes(p.dropId) && p.minutes > 0,
      );
      const previous = c.lastInventoryAt;
      const first =
        carried &&
        unplaced.at + o.world.inventoryLag <= o.now &&
        (previous === undefined || unplaced.at + o.world.inventoryLag > previous - 1_000);
      if (first) unplacedHeardAt.set(channelId, o.now);
    }
    c = { ...c, lastInventoryAt: o.now, unplacedHeardAt };
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

  if (
    event._tag === "CatalogRead" &&
    (before.catalog === undefined || canonical(before.catalog) !== canonical(event.campaigns))
  ) {
    c = { ...c, lastCatalogChangeAt: o.now };
  }
  if (
    event._tag === "ChannelsReadFailed" ||
    event._tag === "CatalogUnavailable" ||
    (event._tag === "Throttled" &&
      event.refusals.some((r) =>
        ["ReadCatalog", "ReadDirectory", "ReadChannels"].includes(r.command._tag),
      ))
  ) {
    c = { ...c, lastReadFailureAt: o.now };
  }

  // 10: what a budget refused, the core sends again by its retry time (a claim: 9).
  const owed = new Map(c.owed);
  if (event._tag === "Started" || after.auth === "needs-login") owed.clear();
  if (event._tag === "Throttled") {
    for (const r of event.refusals) {
      // Only a validation goes out without a valid token.
      const needsToken = r.command._tag !== "ValidateToken";
      if (!RESENT.has(r.command._tag) || (needsToken && before.auth !== "valid")) continue;
      const due = Math.max(r.retryAt, o.now + THROTTLE_FLOOR) + RESEND_SLACK;
      const key = canonical(r.command);
      owed.set(key, Math.min(owed.get(key) ?? Infinity, due));
    }
  }
  for (const command of commands) owed.delete(canonical(command));
  c = { ...c, owed };
  // A refused subscription never reached Twitch: sending the set again is no churn.
  const last = c.lastSubscribe;
  if (
    event._tag === "Throttled" &&
    last !== undefined &&
    event.refusals.some(
      (r) =>
        r.command._tag === "Subscribe" &&
        canonical(r.command.channelIds) === canonical(last.channelIds),
    )
  ) {
    c = { ...c, lastSubscribe: undefined };
  }
  // The executor reports what Twitch answered the claim, never more.
  if (event._tag === "ClaimResult") {
    const misread = claimMisread(c, world, event);
    if (misread !== undefined) fail("ClaimMisread", misread);
    const claimAnswers = new Map(c.claimAnswers);
    claimAnswers.delete(instanceOf(event.dropId));
    c = { ...c, claimAnswers };
  }

  for (const command of commands) {
    switch (command._tag) {
      case "Watch": {
        const flip = flipWithoutCause(c, o, step, command.channelId);
        if (flip !== undefined) fail("WatchFlip", flip);
        const campaignId = after.watch._tag === "Watching" ? after.watch.campaignId : undefined;
        const wrong = wrongPick(o, step, campaignId, command.channelId);
        if (wrong !== undefined) fail("WrongPick", wrong);
        c = {
          ...c,
          watching: command.channelId,
          watchSince: o.now,
          lastWatch: { channelId: command.channelId, at: o.now, campaignId },
          stoppedAt: undefined,
        };
        break;
      }
      case "StopWatching":
        c = { ...c, watching: undefined, stoppedAt: o.now };
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
        const track = c.claims.get(key);
        const isBlind = blind(world, command.dropId);
        // 2a: the twin already holds this drop as claimed. 2b: complete, the right instance,
        // within the window, by twin truth.
        if (isBlind) {
          if (
            !completeAt(world, command.dropId, o.now) ||
            command.instanceId !== instanceOf(command.dropId)
          ) {
            fail("ClaimedEarly", `${key} is not claimable now`);
          }
          const refused = blindClaim(world, command.dropId, track);
          if (refused !== undefined) fail(refused[0], `${key} ${refused[1]}`);
        } else if (world.claimed.has(command.dropId)) {
          fail("ClaimedTwice", `${key} is already claimed`);
        } else if (
          !claimableAt(world, command.dropId, o.now) ||
          command.instanceId !== instanceOf(command.dropId)
        ) {
          fail("ClaimedEarly", `${key} is not claimable now`);
        }
        if (!isBlind && track !== undefined && !(track.settled && !track.applied)) {
          fail("MutationRetried", `${key} claimed again before inventory settled the last claim`);
        }
        const claims = new Map(c.claims);
        claims.set(key, {
          settled: false,
          applied: false,
          blindRetried: isBlind || (track?.blindRetried ?? false),
        });
        c = { ...c, claims, claimCommands: c.claimCommands + 1 };
        break;
      }
      default:
        break;
    }
  }

  // 7: a watch the core keeps must still be one decision 28 ranks first.
  if (!commands.some((x) => x._tag === "Watch")) {
    const held = wrongHold(o, step);
    if (held !== undefined) fail("WrongPick", held);
  }

  // What this step's read or frame told the core of the credits it hadn't heard.
  c = {
    ...c,
    wantedCredits: new Map(
      [...c.wantedCredits].map(([id, xs]) => [
        id,
        xs.map((x) => (x.heard || !hears(event, x) ? x : { ...x, heard: true })),
      ]),
    ),
  };

  // 3b: avoid a channel only for a cause the twin agrees with.
  for (const id of after.avoid) {
    if (before.avoid.has(id)) continue;
    const refuses = channelOf(world, id)?.refuses === true;
    // Unfair: a wanted credit recent enough that hearing it would have kept the stall clock
    // running. One the core demonstrably hasn't heard yet, by read or frame, is excused while
    // it may still be on its way (`newsDelay`; seeds 7242, 7291).
    const quietFor = STALL_AFTER - INVENTORY_INTERVAL - world.inventoryLag - 2 * MINUTE;
    const counted = (c.wantedCredits.get(id) ?? []).filter(
      (x) => o.now - x.at < quietFor && (x.heard || o.now - x.at >= newsDelay(world)),
    );
    const lastCredit = counted.at(-1)?.at;
    const quiet = lastCredit === undefined;
    const disturbed = faultWindows(world).some(
      (w) => w.from <= o.now && w.to >= o.now - STALL_AFTER,
    );
    // Nothing wanted to earn there now, so nothing lost: its credits were for a campaign that
    // has since ended or run out (a drop window cut to its campaign's last minute, seed 22).
    const earning = creditedCampaign(world, id, o.now);
    const barren = earning === undefined || !wanted(world, earning, id, o.now);
    if (refuses || quiet || disturbed || barren) {
      c = { ...c, fairlyAvoided: new Set([...c.fairlyAvoided, id]) };
    } else {
      fail("AvoidedUnfairly", `${id} avoided, it credited at +${minutesSince(lastCredit ?? 0)}m`);
    }
  }
  // 3b, for campaigns: the campaign earned nothing wanted for a stall's length, and
  // the skip ends within `CAMPAIGN_SKIP`: Twitch may move on, so a skip until restart could
  // abandon a campaign that earns again (the Idle invariant then sees it unwatched).
  for (const [id, until] of after.avoidCampaigns) {
    if (before.avoidCampaigns.get(id) === until) continue;
    const channelId = before.watch._tag === "Watching" ? before.watch.channelId : undefined;
    const quietFor = STALL_AFTER - INVENTORY_INTERVAL - world.inventoryLag - 2 * MINUTE;
    // The campaign's own credits: a retry given up at once on the drop it was skipped for
    // (`skipCauses`) may follow a channel's wanted credits for another campaign. As for a
    // channel, a credit the core hasn't heard yet is excused while it may be on its way.
    const lastCredit = [...c.wantedCredits.values()]
      .flat()
      .filter(
        (x) =>
          x.campaignId === id &&
          o.now - x.at < quietFor &&
          (x.heard || o.now - x.at >= newsDelay(world)),
      )
      .reduce<Millis | undefined>((last, x) => Math.max(last ?? x.at, x.at), undefined);
    const quiet = lastCredit === undefined;
    const disturbed = faultWindows(world).some(
      (w) => w.from <= o.now && w.to >= o.now - STALL_AFTER,
    );
    if (until - o.now > CAMPAIGN_SKIP) {
      fail("AvoidedTooLong", `${id} avoided until +${minutesSince(until)}m`);
    }
    if (quiet || disturbed) {
      c = {
        ...c,
        fairlyAvoidedCampaigns: new Map([...c.fairlyAvoidedCampaigns, [id, until]]),
        campaignSkippedAt:
          channelId === undefined
            ? c.campaignSkippedAt
            : new Map([...c.campaignSkippedAt, [channelId, o.now]]),
      };
    } else {
      fail(
        "AvoidedUnfairly",
        `${id} avoided, ${channelId ?? "its channel"} credited it at +${minutesSince(lastCredit ?? 0)}m`,
      );
    }
  }

  // 8: the core watches no drop the account already has, once an inventory read could show it,
  // in `self.isClaimed` or, for a campaign Twitch no longer lists, in `gameEventDrops` (the live
  // run's two hours on a received "Witchspire Logo", 2026-10-30). Both show a claim
  // `claimedFlagLag` late (measured up to 300 s), and never an unlinked item's (`claimShows`). A
  // minute covers the answer's latency.
  const w = after.watch;
  const claimedAt = w._tag === "Watching" ? world.claimed.get(w.dropId) : undefined;
  if (
    w._tag === "Watching" &&
    claimedAt !== undefined &&
    claimShows(world, w.dropId) &&
    c.lastInventoryAt !== undefined &&
    claimedAt + world.claimedFlagLag + MINUTE <= c.lastInventoryAt
  ) {
    fail(
      "WatchedClaimed",
      `watching ${w.channelId} for ${w.dropId}, claimed at +${minutesSince(claimedAt)}m, ` +
        `inventory read at +${minutesSince(c.lastInventoryAt)}m`,
    );
  }
  return c;
};

/**
 * How long a credit can take to reach the core, plus a minute. With a frame every minute, the
 * frame. With measured gaps (`FRAME_GAPS`) a frame's countdown stops when the channel stops
 * crediting the campaign, so the last minutes before a stop are never framed: only the next
 * inventory read (`INVENTORY_INTERVAL` and the lag) is sure to carry them. Seeds 7242 and 7291:
 * a credit that began 20 s before the stall rule fired; seed 30860: the stall clock restarted at
 * an inventory read 3.5 minutes after the last credit; seed 90052: the channel moved its credit
 * to another campaign mid-countdown, and the last minute reached the core 5 minutes later.
 */
const newsDelay = (world: World): Millis =>
  (Math.max(1, ...world.frameGaps) === 1 ? MINUTE : INVENTORY_INTERVAL + world.inventoryLag) +
  MINUTE;

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
    (last.campaignId !== undefined && step.after.avoidCampaigns.has(last.campaignId)) ||
    step.after.channels.get(old)?.live === undefined;
  const oldCampaigns = [
    last.campaignId,
    step.before.watch._tag === "Watching" ? step.before.watch.campaignId : undefined,
  ].flatMap((id) => world.campaigns.filter((x) => x.id === id));
  // Done: nothing wanted left by twin truth, or, as far as the core knows, nothing wanted that
  // earns now can still finish (the switch from a doomed campaign to one that can, seeds 2011
  // and 4664).
  const view = viewOf(o, step);
  const oldDone = oldCampaigns.some(
    (campaign) =>
      !wanted(world, campaign, old, o.now) ||
      (view.catalog.some((x) => x.id === campaign.id) &&
        !canFinishOn(world.settings, view, campaign.id, old)),
  );
  const news =
    changedBetween(world, next, from, o.now) ||
    (c.lastCatalogChangeAt !== undefined && c.lastCatalogChangeAt > last.at) ||
    [...world.claimed.values()].some((at) => at > from) ||
    // Twitch credited a wanted campaign: the core follows the credit (seed 23266).
    [...c.lastWantedCredit.values()].some((at) => at > from) ||
    world.campaigns.some((x) =>
      [x.startsAt, ...x.drops.map((d) => d.startsAt)].some((t) => from < t && t <= o.now),
    );
  if (faulted || oldChanged || oldDone || news) return undefined;
  return `${old} at +${minutesSince(last.at)}m, then ${next} with no cause`;
};

const viewOf = (o: Observation, step: StepRecord): View => ({
  catalog: step.after.catalog ?? [],
  progress: step.after.progress,
  awarded: step.after.awarded,
  inventoried: step.after.inventoried,
  channels: step.after.channels,
  avoid: step.after.avoid,
  avoidCampaigns: skippedAt(step.after.avoidCampaigns, o.now),
  now: o.now,
});

/**
 * The campaigns that hold the `least-slack` margin when the core planned: the one watched before
 * the step, and one a credit adopted during it. None when the core watched nothing.
 */
const holdersOf = (step: StepRecord): ReadonlyArray<CampaignId> => {
  const { before, after, event } = step;
  return [
    ...(before.watch._tag === "Watching" ? [before.watch.campaignId] : []),
    ...((event._tag === "DropProgress" || event._tag === "CurrentDropRead") &&
    event.dropId !== undefined
      ? (after.catalog ?? [])
          .filter((x) => x.drops.some((d) => d.id === event.dropId))
          .map((x) => x.id)
      : []),
  ];
};

const instead = (o: Observation, step: StepRecord): string => {
  const allowed = allowedPicks(o.world.settings, viewOf(o, step), holdersOf(step));
  return allowed.size === 0 ? "no goal wants anything" : [...allowed].join(", ");
};

/**
 * 7: a new watch is for a campaign decision 28 ranks first among what the core knew (`oracle.ts`,
 * written apart from the planner), on a channel that goal may watch and that credits it. It judges
 * the ranking, not the data: the core's catalog, progress and channels are the input, so a fault
 * or a discovery still running can't excuse a wrong pick. Returns the violation's detail.
 */
const wrongPick = (
  o: Observation,
  step: StepRecord,
  campaignId: CampaignId | undefined,
  channelId: ChannelId,
): string | undefined => {
  if (campaignId === undefined || step.after.catalog === undefined) return undefined;
  const view = viewOf(o, step);
  if (allowedWatch(o.world.settings, view, holdersOf(step), campaignId, channelId)) {
    return undefined;
  }
  return `watching ${channelId} for ${campaignId}, decision 28 ranks first: ${instead(o, step)}`;
};

/**
 * 7, for a watch the core keeps: after every step it must still be one decision 28 ranks first,
 * or the core never moves to a better campaign. A discovery still running excuses holding on
 * (the core may not switch on half a picture), and so does a credit Twitch chose: several
 * campaigns can share a stream, and Twitch picks which one progresses, so a channel that credits
 * a first-ranked campaign is right whatever it credits.
 */
const wrongHold = (o: Observation, step: StepRecord): string | undefined => {
  const { after } = step;
  const w = after.watch;
  if (w._tag !== "Watching" || after.auth !== "valid" || after.catalog === undefined) {
    return undefined;
  }
  if (after.discovery !== undefined) return undefined;
  const view = viewOf(o, step);
  const holders = holdersOf(step);
  const settings = o.world.settings;
  if (allowedWatch(settings, view, holders, w.campaignId, w.channelId)) return undefined;
  if (w.credited && allowedWatch(settings, view, holders, undefined, w.channelId)) return undefined;
  return `kept ${w.channelId} for ${w.campaignId}, decision 28 ranks first: ${instead(o, step)}`;
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
  const chances = opportunities(
    world,
    o.now,
    checker.fairlyAvoided,
    skippedAt(checker.fairlyAvoidedCampaigns, o.now),
  );
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
  // An idle core learns only from GQL reads, so a GQL cooldown holds its news back like a fault
  // window (a claim's outcome, seed 80053). A watching core still ticks through one (CDN), so the
  // stall clock below takes no excuse from it.
  const recentFault = [...windows, ...cooldownWindows(world)].some(
    (w) => w.from <= o.now && o.now - w.to < CATALOG_INTERVAL,
  );
  // Watching a channel the core believes credits: stream info can't tell `dropsEnabled`
  // (`wire.ts`), so only the stall rule can find out.
  const watching = o.state.watch._tag === "Watching";
  const watched = o.state.watch._tag === "Watching" ? o.state.watch.channelId : undefined;
  const watchedFor =
    o.now -
    Math.max(
      since,
      checker.watchSince ?? since,
      checker.unknownCreditAt ?? since,
      (watched && checker.campaignSkippedAt.get(watched)) ?? -Infinity,
      (watched && checker.unplacedHeardAt.get(watched)) ?? -Infinity,
    );
  const late = watching
    ? // The stall clock restarts when the core hears the last credit, up to `newsDelay` after it.
      watchedFor > STALL_AFTER + newsDelay(world)
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
  // While watching, `knownSince` restarts: an idle core knows its chance from when the watch
  // ended, not from when the channel was first seen live hours before.
  return { ...checker, idleSince: since, knownSince: watching ? undefined : knownSince };
};

/**
 * 9: a watch that earns nothing wanted ends within a stall. Twitch may credit the channel all the
 * while, with drops past their requirement, received, or unwanted (`creditsOnly`): the live run
 * of 2026-10-30 watched one channel for two hours because any credit restarted its stall clock.
 * The clock starts at the watch, a wanted credit there, a credit the core couldn't place (it
 * rereads the catalog) and the inventory read that may first show its minutes, a restart, the
 * end of a fault, or a campaign skip: the next target on the channel gets a stall of its own
 * (`ticked` in `step.ts`), so a channel that keeps crediting the skipped campaign is given up one
 * stall later.
 */
const checkUnproductive = (
  c: Checker,
  o: Observation,
  fail: (kind: string, detail: string) => void,
): void => {
  const w = o.state.watch;
  if (w._tag !== "Watching" || c.watching !== w.channelId || c.watchSince === undefined) return;
  if (o.state.auth !== "valid" || isRevoked(o.world, o.now)) return;
  const faults = faultWindows(o.world).filter((x) => x.from <= o.now);
  const since = Math.max(
    c.watchSince,
    c.lastWantedCredit.get(w.channelId) ?? -Infinity,
    c.lastEarnedCredit.get(w.channelId) ?? -Infinity,
    c.unplacedHeardAt.get(w.channelId) ?? -Infinity,
    c.unknownCreditAt ?? -Infinity,
    c.restartedAt ?? -Infinity,
    c.campaignSkippedAt.get(w.channelId) ?? -Infinity,
    ...faults.map((x) => x.to),
  );
  // The core's stall clock restarts when it hears the last credit, `newsDelay` after it at most.
  if (o.now - since > STALL_AFTER + newsDelay(o.world)) {
    fail(
      "Unproductive",
      `${w.channelId} earned nothing wanted since +${minutesSince(since)}m ` +
        `(core: ${canonical(w)})`,
    );
  }
};

/** 10: a refused command not sent again by its retry time. */
const checkOwed = (
  checker: Checker,
  o: Observation,
  fail: (kind: string, detail: string) => void,
): Checker => {
  const late = [...checker.owed].filter(([, due]) => o.now > due);
  if (late.length === 0) return checker;
  for (const [key, due] of late) {
    fail("RefusalDropped", `${key}, refused, not sent again by +${minutesSince(due)}m`);
  }
  return { ...checker, owed: new Map([...checker.owed].filter(([, due]) => o.now <= due)) };
};

/**
 * 9: every drop the twin would let the account claim gets claimed within `claimLiveness`. A
 * revoked token, a parked core or an open fault window stops the clock (it starts again after).
 */
const checkClaimLiveness = (
  checker: Checker,
  o: Observation,
  fail: (kind: string, detail: string) => void,
): Checker => {
  const world = o.world;
  const excused =
    o.state.auth === "needs-login" ||
    isRevoked(world, o.now) ||
    [...faultWindows(world), ...cooldownWindows(world)].some(
      (w) => w.from <= o.now && o.now < w.to,
    );
  if (excused)
    return checker.claimableSince.size === 0 ? checker : { ...checker, claimableSince: new Map() };
  const bound = claimLiveness(world);
  const claimableSince = new Map<DropId, Millis>();
  for (const campaign of world.campaigns) {
    // A hidden campaign is in no answer: the miner can't know its drop is there to claim.
    if (world.hidden.has(campaign.id)) continue;
    for (const drop of campaign.drops) {
      if (!claimableAt(world, drop.id, o.now)) continue;
      const since = checker.claimableSince.get(drop.id) ?? o.now;
      if (o.now - since > bound) {
        fail("ClaimLate", `${drop.id} claimable since +${minutesSince(since)}m, never claimed`);
        continue;
      }
      claimableSince.set(drop.id, since);
    }
  }
  return { ...checker, claimableSince };
};

const roundTrips = (text: string): boolean => {
  try {
    return encodeState(decodeState(text)) === text;
  } catch {
    return false;
  }
};
