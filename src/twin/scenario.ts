import fc from "fast-check";
import { Schema } from "effect";
import type { Millis } from "../core/model.ts";
import {
  CHANNEL_FRAMES_PER_HOUR,
  CLAIMED_FLAG_LAG_MAX,
  DOWN_BURST_SHARE,
  FRAME_GAPS,
  HIDDEN_DROP_MINUTES,
  INVENTORY_LAG_MINUTES,
  RECONNECT_GAP,
} from "./calibration.ts";

/**
 * A simulated world as plain data: campaigns, channels with live schedules, settings and a fault
 * schedule. Every reference is an index taken modulo the length of its list when the world is
 * built, so any generated or shrunk value is a valid world and shrinking never needs a filter.
 */

/** 2026-10-29T12:00:00Z, the same instant as the core fixtures' `T0`. */
export const SIM_EPOCH: Millis = 1_793_275_200_000;

const BOUNDS = {
  horizonMinutes: [60, 1440],
  inventoryLagMinutes: [0, 3],
  index: [0, 7],
  short: [0, 3],
  pair: [0, 2],
  game: [0, 2],
  campaigns: [1, 4],
  goals: [1, 3],
  rewards: [1, 3],
  /** A campaign with drops claimed before the run may have started days before it. */
  startMinute: [-2880, 600],
  /** What the generator draws. */
  drawnStart: [-120, 600],
  durationMinutes: [30, 2880],
  drops: [1, 3],
  /** Up to a hidden campaign's drop (`HIDDEN_DROP_MINUTES`). */
  requiredMinutes: [1, HIDDEN_DROP_MINUTES],
  /** What the generator draws for a listed drop. */
  listedMinutes: [1, 240],
  channels: [1, 8],
  viewers: [1, 10_000],
  changes: [0, 6],
  atMinute: [0, 1440],
  /** Up to 8 drawn with the world, 2 derived (`refusalsOf`), and 4 of the wire (`wireArbitrary`). */
  faults: [0, 14],
  apiFaults: [0, 8],
  durationSeconds: [1, 1800],
  windowStart: [0, 600],
  frameGap: [1, 12],
  frameGaps: [1, 16],
  claimedFlagLagSeconds: [0, CLAIMED_FLAG_LAG_MAX / 1000],
  claimedBefore: [0, 3],
  otherGames: [0, 16],
  maxWait: [1_000, 15_000],
  crowd: [0, 80],
} as const;

type Bound = keyof typeof BOUNDS;

const int = (bound: Bound) => {
  const [minimum, maximum] = BOUNDS[bound];
  return Schema.Int.check(Schema.isBetween({ minimum, maximum }));
};
const intArb = (bound: Bound) => {
  const [min, max] = BOUNDS[bound];
  return fc.integer({ min, max });
};
const list = <S extends Schema.Top>(item: S, bound: Bound) => {
  const [minimum, maximum] = BOUNDS[bound];
  return Schema.Array(item).check(Schema.isBetweenLength(minimum, maximum));
};
const listArb = <A>(item: fc.Arbitrary<A>, bound: Bound) => {
  const [minLength, maxLength] = BOUNDS[bound];
  return fc.array(item, { minLength, maxLength });
};

/** The longest claimed-flag lag the sweep draws, in seconds (see `randomScenario`). */
export const CLAIM_FLAG_LAG_SWEPT = 59;

/** Whether the sweep frames every credited drop (`framesAll`, see `randomScenario`). */
export const FRAMES_ALL_SWEPT = false;

/** What window faults hit. The first eight are the API's, as the generator drew them before B1. */
export const OPERATIONS = [
  "validate",
  "ViewerDropsDashboard",
  "DropCampaignDetails",
  "Inventory",
  "DirectoryPage_Game",
  "VideoPlayerStreamInfoOverlayChannel",
  "DropCurrentSessionContext",
  /** The claim mutation (TDM `DropsPage_ClaimDropRewards`). */
  "ClaimDrop",
  /** Watching (research 02 §4): the token over GQL, then usher, playlists and segments. */
  "PlaybackAccessToken",
  "usher",
  "playlist",
  "segment",
] as const;
export type Operation = (typeof OPERATIONS)[number];

const API_OPERATIONS = OPERATIONS.slice(0, 8);
const WATCH_OPERATIONS = OPERATIONS.slice(8);

const WINDOW_FAULTS = ["http-5xx", "http-429", "timeout", "service-error", "null-catalog"] as const;
const CRASH_POINTS = ["before-persist", "after-persist", "in-claim"] as const;
const BENEFITS = ["BADGE", "EMOTE", "DIRECT_ENTITLEMENT"] as const;
const CHANGES = ["up", "down", "game-0", "game-1", "game-2"] as const;
const RECEIVED = ["in-window", "before-window"] as const;
/** Not drawn by the arbitraries, so seeds keep their worlds: named scenarios only. */
const RECEIVED_ANY = [...RECEIVED, "overlapping"] as const;
const REWARDS = ["item", "badge", "emote"] as const;
const ORDERS = ["ending-soonest", "least-slack"] as const;

export const Fault = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(WINDOW_FAULTS),
    operation: Schema.Literals([...OPERATIONS, "any"]),
    atMinute: int("atMinute"),
    durationSeconds: int("durationSeconds"),
  }),
  Schema.Struct({ kind: Schema.Literal("revoke-token"), atMinute: int("atMinute") }),
  /** The next claim applies, and its answer is lost. */
  Schema.Struct({ kind: Schema.Literal("lose-claim-answer"), atMinute: int("atMinute") }),
  /** PubSub frames are dropped for the window. */
  Schema.Struct({
    kind: Schema.Literal("frames-down"),
    atMinute: int("atMinute"),
    durationSeconds: int("durationSeconds"),
  }),
  /** A PubSub `RECONNECT`: frames are dropped until the new connection listens (`RECONNECT_GAP`). */
  Schema.Struct({
    kind: Schema.Literal("reconnect"),
    atMinute: int("atMinute"),
    gapMillis: Schema.Int.check(
      Schema.isBetween({ minimum: RECONNECT_GAP.min, maximum: RECONNECT_GAP.max }),
    ),
  }),
  /**
   * Another tool on this IP spent Twitch's GQL rate, and one of the miner's requests was answered
   * 429: the miner's API budget cools down for `durationSeconds` (at least `GQL_LIMITS.cooldown`)
   * and refuses every request asked meanwhile, claims included. It begins at the first inventory
   * answer from `atMinute` on that shows a drop to claim (`startCooldown` in `world.ts`).
   */
  Schema.Struct({
    kind: Schema.Literal("gql-cooldown"),
    atMinute: int("atMinute"),
    durationSeconds: int("durationSeconds"),
  }),
  /**
   * The edge asks every connection to reconnect, a few seconds apart (seen live 2026-10-30: five
   * `RECONNECT`s, one per connection, within four minutes). A `reconnect` is the same on the wire.
   */
  Schema.Struct({ kind: Schema.Literal("pubsub-reconnect"), atMinute: int("atMinute") }),
  /** The edge drops every socket and refuses new ones for the window. */
  Schema.Struct({
    kind: Schema.Literal("pubsub-outage"),
    atMinute: int("atMinute"),
    durationSeconds: int("durationSeconds"),
  }),
  Schema.Struct({
    kind: Schema.Literal("crash"),
    atMinute: int("atMinute"),
    point: Schema.Literals(CRASH_POINTS),
  }),
]);
export type Fault = typeof Fault.Type;

const DropSpec = Schema.Struct({
  requiredMinutes: int("requiredMinutes"),
  /** Index of an earlier drop in the same campaign that must be claimed first. */
  after: Schema.NullOr(int("game")),
  benefit: Schema.Literals(BENEFITS),
  /**
   * The drop's own window, from minutes after its campaign starts, cut to the campaign's.
   * Omitted: the campaign's window. Twitch gives each drop its own `startAt`/`endAt`.
   */
  window: Schema.optionalKey(
    Schema.Struct({ startMinute: int("windowStart"), durationMinutes: int("durationMinutes") }),
  ),
  /**
   * The account has this drop's reward already, listed in `gameEventDrops` only. `in-window`:
   * the drop was claimed at its start, before the run (a drop opening later is left alone).
   * `before-window`: another campaign gave the same reward a day before this drop opened, so the
   * drop is still to earn (TDM `inventory.py:71-90`). `overlapping`: another campaign gave the
   * same reward inside this drop's window, so TDM's rule takes the drop as received though Twitch
   * still credits it; the account can't tell the two apart. Omitted: none of these.
   */
  received: Schema.optionalKey(Schema.Literals(RECEIVED_ANY)),
});

const CampaignSpec = Schema.Struct({
  /** Game 2 is the special game `509663`, which earns on any channel. */
  game: int("game"),
  startMinute: int("startMinute"),
  durationMinutes: int("durationMinutes"),
  linked: Schema.Boolean,
  /**
   * Twitch credits this campaign's items to an unlinked account, to deliver once linked; some
   * campaigns do, some don't (research 02 §3). Omitted: false.
   */
  creditsUnlinked: Schema.optionalKey(Schema.Boolean),
  /** Channel indices. Empty: any drops-enabled channel streaming the game. */
  allowList: list(int("index"), "short"),
  drops: list(DropSpec, "drops"),
  /**
   * Index of the one drop a watch credits while its window is open, received, complete or not,
   * as Twitch credited Witchspire's received "Golden Stamp" past its requirement while the
   * campaign's other drop never moved (live run, 2026-10-30). Omitted: every earnable drop.
   */
  creditsOnly: Schema.optionalKey(int("game")),
  /**
   * With `creditsOnly`: Twitch credits that drop only while it can earn, then moves on to every
   * earnable drop, as it does once a drop completes. A campaign given up on its account is worth
   * trying again. Omitted: false, the drop is credited whatever its state.
   */
  creditsMoveOn: Schema.optionalKey(Schema.Boolean),
  /**
   * The first this many drops were claimed before the run, those that could have been earned by
   * then (`claimedBeforeRun` in `world.ts`). Omitted: none.
   */
  claimedBefore: Schema.optionalKey(int("claimedBefore")),
  /**
   * Twitch credits it alongside the campaign it lists for the channel, and lists it in no answer
   * (a 900-minute drop beside Apex, run4h 2026-10-30). Omitted: false.
   */
  hidden: Schema.optionalKey(Schema.Boolean),
});

const ChannelSpec = Schema.Struct({
  game: int("game"),
  viewers: int("viewers"),
  dropsEnabled: Schema.Boolean,
  /** Playback is refused to this account (sub-only, geo-blocked). */
  refuses: Schema.Boolean,
  liveAtStart: Schema.Boolean,
  changes: list(
    Schema.Struct({ atMinute: int("atMinute"), to: Schema.Literals(CHANGES) }),
    "changes",
  ),
});

const Rewards = list(Schema.Literals(REWARDS), "rewards");

/** A drops goal of `config.json` (decision 28), with game and channel indices for names. */
const GoalSpec = Schema.Struct({
  /** `null`: every game. Otherwise games in priority order, each with optional own rewards. */
  games: Schema.NullOr(
    list(Schema.Struct({ game: int("game"), rewards: Schema.NullOr(Rewards) }), "short"),
  ),
  rewards: Rewards,
  excludeGames: list(int("game"), "pair"),
  /** Channel indices. */
  exclude: list(int("index"), "pair"),
  linkedOnly: Schema.Boolean,
  order: Schema.Literals(ORDERS),
});
export type GoalSpec = typeof GoalSpec.Type;

/** The config file's default goal: every game, every reward, items only when linked. */
export const DEFAULT_GOAL_SPEC: GoalSpec = {
  games: null,
  rewards: ["item", "badge", "emote"],
  excludeGames: [],
  exclude: [],
  linkedOnly: true,
  order: "ending-soonest",
};

/**
 * Background channels: live and drops-enabled on games 0 and 1 by turns, a few viewers each, one
 * going offline for a while now and then. The directory lists them, so the core follows dozens of
 * channels over several PubSub connections, as live (100 channels on 5 sockets, 2026-10-30).
 */
const Crowd = Schema.Struct({ count: int("crowd") });

export const Scenario = Schema.Struct({
  /** Seeds `Random`, which draws request latencies. */
  latencySeed: Schema.Int,
  horizonMinutes: int("horizonMinutes"),
  inventoryLagMinutes: int("inventoryLagMinutes"),
  /** Inventory shows a claim this late. Omitted: `CLAIMED_FLAG_LAG` (world.ts). */
  claimedFlagLagSeconds: Schema.optionalKey(int("claimedFlagLagSeconds")),
  /**
   * Credited minutes between progress frames, each campaign taking the next in turn (measured,
   * `FRAME_GAPS`). Omitted: a frame every minute.
   */
  frameGaps: Schema.optionalKey(list(int("frameGap"), "frameGaps")),
  /**
   * Twitch sends `drop-claim` frames, which none of 6 live claims had (and none came in 4.6 h of
   * mining, 2026-10-30): the miner must find claimable drops in inventory. Omitted: false.
   */
  claimFrames: Schema.optionalKey(Schema.Boolean),
  /**
   * Every credited drop frames, not only the one closest to done, as the twin did before the
   * calibration. The sweep draws false (`FRAMES_ALL_SWEPT`), the measured world, since the core
   * learns an unframed drop's minutes from the inventory. Omitted: false.
   */
  framesAll: Schema.optionalKey(Schema.Boolean),
  settings: Schema.Struct({ goals: list(GoalSpec, "goals") }),
  campaigns: list(CampaignSpec, "campaigns"),
  channels: list(ChannelSpec, "channels"),
  /** Omitted: none. */
  crowd: Schema.optionalKey(Crowd),
  faults: list(Fault, "faults"),
  /**
   * Campaigns of this many more games that no channel streams: a catalog read then starts a
   * directory read for each game a goal wants. The live catalog of 2026-10-30 started 14 per read
   * (A0 recording), the games above at most 3. Omitted: none.
   */
  otherGames: Schema.optionalKey(int("otherGames")),
  /**
   * The API budget's `maxWait` in this world, shorter than the miner's 15 s so that bursts get
   * refused (`GQL_LIMITS`). Omitted: the miner's.
   */
  gqlMaxWait: Schema.optionalKey(int("maxWait")),
});
export type Scenario = typeof Scenario.Type;

export const Violation = Schema.Struct({
  kind: Schema.String,
  /** Minutes since `SIM_EPOCH`, fractional. */
  at: Schema.Finite,
  detail: Schema.String,
});
export type Violation = typeof Violation.Type;

/** A failure, ready to rerun: `miner sim --trace <file>`. */
export const Capsule = Schema.Struct({
  seed: Schema.NullOr(Schema.Int),
  scenario: Scenario,
  violation: Violation,
  digest: Schema.String,
  /** The last trace lines, canonical JSON each. */
  tail: Schema.Array(Schema.String),
});
export type Capsule = typeof Capsule.Type;

const windowFault: fc.Arbitrary<Fault> = fc.record({
  kind: fc.constantFrom(...WINDOW_FAULTS),
  operation: fc.constantFrom(...API_OPERATIONS, "any" as const),
  atMinute: intArb("atMinute"),
  durationSeconds: intArb("durationSeconds"),
});

const faultArbitrary: fc.Arbitrary<Fault> = fc.oneof(
  windowFault,
  fc.record({ kind: fc.constant("revoke-token" as const), atMinute: intArb("atMinute") }),
  fc.record({ kind: fc.constant("lose-claim-answer" as const), atMinute: intArb("atMinute") }),
  fc.oneof(
    // A `RECONNECT`: the connection listens again 1.67–2.335 s later (run4h, `RECONNECT_GAP`).
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("reconnect" as const),
        atMinute: intArb("atMinute"),
        gapMillis: fc.integer({ min: RECONNECT_GAP.min, max: RECONNECT_GAP.max }),
      }),
    },
    // An outage, never seen live: kept so a long silence stays covered.
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("frames-down" as const),
        atMinute: intArb("atMinute"),
        durationSeconds: intArb("durationSeconds"),
      }),
    },
  ),
  fc.record({
    kind: fc.constant("crash" as const),
    atMinute: intArb("atMinute"),
    point: fc.constantFrom(...CRASH_POINTS),
  }),
);

/** Faults of the wire: the watch path's requests, and the PubSub edge. */
const wireFaultArbitrary: fc.Arbitrary<Fault> = fc.oneof(
  fc.record({
    kind: fc.constantFrom("http-5xx", "http-429", "timeout"),
    operation: fc.constantFrom(...WATCH_OPERATIONS),
    atMinute: intArb("atMinute"),
    durationSeconds: intArb("durationSeconds"),
  }),
  fc.record({ kind: fc.constant("pubsub-reconnect" as const), atMinute: intArb("atMinute") }),
  fc.record({
    kind: fc.constant("pubsub-outage" as const),
    atMinute: intArb("atMinute"),
    durationSeconds: intArb("durationSeconds"),
  }),
);

/**
 * What the wire-level twin added (B1): a crowd one time in three, big enough that the
 * directory's 30 channels of one game and the scenario's own need two PubSub connections, and
 * up to four wire faults. Drawn after the rest, so a seed's world is the one it generated before,
 * plus these.
 */
const wireArbitrary = fc.record({
  crowd: fc.oneof(
    { arbitrary: fc.constant(undefined), weight: 2 },
    { arbitrary: fc.record({ count: fc.integer({ min: 50, max: BOUNDS.crowd[1] }) }), weight: 1 },
  ),
  faults: fc.array(wireFaultArbitrary, { maxLength: 4 }),
});

/** Adds the wire's draws to a world. */
const withWire = (
  scenario: Scenario,
  { crowd, faults }: typeof wireArbitrary extends fc.Arbitrary<infer W> ? W : never,
): Scenario => ({
  ...scenario,
  ...(crowd === undefined ? {} : { crowd }),
  faults: [...scenario.faults, ...faults],
});

const dropArbitrary = (requiredMinutes: fc.Arbitrary<number>) =>
  fc.record({
    requiredMinutes,
    after: fc.option(intArb("game"), { nil: null }),
    benefit: fc.constantFrom(...BENEFITS),
  });

/** A random drop, one in three with a window of its own. */
const windowedDropArbitrary = fc
  .tuple(
    dropArbitrary(intArb("listedMinutes")),
    fc.option(
      fc.record({ startMinute: intArb("windowStart"), durationMinutes: intArb("durationMinutes") }),
      { nil: null, freq: 2 },
    ),
  )
  .map(([drop, window]) => (window === null ? drop : { ...drop, window }));

/**
 * A schedule change, up or down against a game change as `CHANNEL_FRAMES_PER_HOUR` measured them
 * (run4h, 4 hours: 58 `stream-up` and `stream-down` frames to 9 game changes). Ups and downs are
 * evened out: the miner follows channels it found live, so it hears mostly downs.
 */
export const UP_OR_DOWN_WEIGHT = Math.round(
  (CHANNEL_FRAMES_PER_HOUR.streamUp + CHANNEL_FRAMES_PER_HOUR.streamDown) * 4,
);
export const GAME_CHANGE_WEIGHT = Math.round(CHANNEL_FRAMES_PER_HOUR.gameChange * 4);

const changeArbitrary = (atMinute: fc.Arbitrary<number>) =>
  fc.record({
    atMinute,
    to: fc.oneof(
      { weight: UP_OR_DOWN_WEIGHT, arbitrary: fc.constantFrom("up" as const, "down" as const) },
      {
        weight: GAME_CHANGE_WEIGHT,
        arbitrary: fc.constantFrom("game-0" as const, "game-1" as const, "game-2" as const),
      },
    ),
  });

const rewardsArb = fc.uniqueArray(fc.constantFrom(...REWARDS), {
  minLength: BOUNDS.rewards[0],
  maxLength: BOUNDS.rewards[1],
});

const goalArbitrary: fc.Arbitrary<GoalSpec> = fc.record({
  games: fc.option(
    listArb(
      fc.record({ game: intArb("game"), rewards: fc.option(rewardsArb, { nil: null }) }),
      "short",
    ),
    { nil: null },
  ),
  rewards: rewardsArb,
  excludeGames: listArb(intArb("game"), "pair"),
  exclude: listArb(intArb("index"), "pair"),
  linkedOnly: fc.boolean(),
  order: fc.constantFrom(...ORDERS),
});

const randomScenario: fc.Arbitrary<Scenario> = fc
  .record({
    latencySeed: fc.integer({ min: 0, max: 1_000_000 }),
    horizonMinutes: intArb("horizonMinutes"),
    // Measured `INVENTORY_LAG_MINUTES`; 1 for a read inside the minute, 2–3 for a worse Twitch.
    inventoryLagMinutes: fc.oneof(
      { weight: 7, arbitrary: fc.constant(INVENTORY_LAG_MINUTES) },
      { weight: 2, arbitrary: fc.constant(1) },
      { weight: 1, arbitrary: fc.integer({ min: 2, max: BOUNDS.inventoryLagMinutes[1] }) },
    ),
    // Measured at most 300 s (`CLAIMED_FLAG_LAG_MAX`); drawn below the core's 60 s `CLAIM_RECHECK`
    // until the core waits that long (`sim.test.ts` shows the double claim a longer lag causes).
    claimedFlagLagSeconds: fc.integer({ min: 0, max: CLAIM_FLAG_LAG_SWEPT }),
    // Shrinks towards the first gap, 1: a frame every minute.
    frameGaps: listArb(fc.constantFrom(...FRAME_GAPS), "frameGaps"),
    claimFrames: fc.integer({ min: 0, max: 9 }).map((n) => n === 9),
    // Measured: one framed drop per campaign. The core hears an unframed credit when an
    // inventory read shows its minutes (`creditShown` in `step.ts`; sweep seed 161).
    framesAll: fc.constant(FRAMES_ALL_SWEPT),
    settings: fc.record({ goals: listArb(goalArbitrary, "goals") }),
    campaigns: listArb(
      fc.record({
        game: intArb("game"),
        startMinute: intArb("drawnStart"),
        durationMinutes: intArb("durationMinutes"),
        linked: fc.boolean(),
        creditsUnlinked: fc.boolean(),
        allowList: listArb(intArb("index"), "short"),
        drops: listArb(windowedDropArbitrary, "drops"),
        // One campaign in four has history, at times all of it: a campaign claimed in full before
        // the run is in no inventory, only in `gameEventDrops` (Witchspire, run4h).
        claimedBefore: fc.oneof(
          { weight: 3, arbitrary: fc.constant(0) },
          { weight: 1, arbitrary: intArb("claimedBefore") },
        ),
      }),
      "campaigns",
    ),
    channels: listArb(
      fc.record({
        game: intArb("game"),
        viewers: intArb("viewers"),
        dropsEnabled: fc.boolean(),
        // One channel in five refuses playback, so most worlds have something to watch.
        refuses: fc.integer({ min: 0, max: 4 }).map((n) => n === 4),
        liveAtStart: fc.boolean(),
        changes: listArb(changeArbitrary(intArb("atMinute")), "changes"),
      }),
      "channels",
    ),
    // Two places stay free for the faults `refusalsOf` derives.
    // Two places stay free for the faults `refusalsOf` derives, four for the wire's.
    faults: fc.array(faultArbitrary, { maxLength: BOUNDS.apiFaults[1] }),
  })
  .map((s) => ({
    ...s,
    // From the latency seed rather than a draw of its own, so every seed keeps the world it had
    // before `otherGames` existed, and gains only the other games.
    otherGames: s.latencySeed % (BOUNDS.otherGames[1] + 1),
  }));

/**
 * A linked campaign that has started, and a drops-enabled channel streaming its game from the
 * start for at least an hour, with drops short enough to complete in the shortest horizon.
 * Random worlds alone line these up rarely (4 claims in 100 seeds), which left the sweep
 * checking worlds with nothing to earn.
 */
const opportunityArbitrary = fc.record({
  game: intArb("game"),
  startMinute: fc.integer({ min: BOUNDS.drawnStart[0], max: 0 }),
  durationMinutes: fc.integer({ min: 240, max: BOUNDS.durationMinutes[1] }),
  drops: listArb(dropArbitrary(fc.integer({ min: 1, max: 45 })), "drops"),
  viewers: intArb("viewers"),
  changes: listArb(changeArbitrary(fc.integer({ min: 60, max: BOUNDS.atMinute[1] })), "changes"),
  /** The goal that wants it, modulo the number of goals. */
  goal: intArb("short"),
});

/**
 * A second campaign that competes with campaign 0, on game 0 or 1 (never the one campaign 0 is
 * on, unless that is the special game) with its own live channel, channel 1. Its drops are
 * random, so it may have more or less slack than campaign 0, or be unable to finish; half the
 * time it ends within 4 hours of campaign 0, where `ending-soonest` and `least-slack` disagree
 * most. As `wanted`, a goal (campaign 0's, or another) is bent to want it; as a decoy, the goal
 * excludes its game, or it is an unlinked item campaign for a goal with `linkedOnly`. Without a
 * rival, random worlds almost never make the planner choose, and planted ranking bugs went
 * uncaught (review of decision 28, P2-3).
 */
const rivalArbitrary = fc.option(
  fc.record({
    game: fc.integer({ min: 0, max: 1 }),
    startMinute: fc.integer({ min: BOUNDS.drawnStart[0], max: 0 }),
    durationMinutes: fc.integer({ min: 180, max: BOUNDS.durationMinutes[1] }),
    /** Minutes between its end and campaign 0's, or `null` for its own duration. */
    endsNear: fc.option(fc.integer({ min: -240, max: 240 }), { nil: null }),
    // The first drop earns from the start; later ones may open later.
    drops: fc
      .tuple(
        dropArbitrary(intArb("listedMinutes")),
        fc.array(windowedDropArbitrary, { maxLength: BOUNDS.drops[1] - 1 }),
      )
      .map(([first, rest]) => [first, ...rest]),
    viewers: intArb("viewers"),
    changes: listArb(changeArbitrary(fc.integer({ min: 60, max: BOUNDS.atMinute[1] })), "changes"),
    /** The goal it is for, modulo the number of goals; `null`: campaign 0's goal. */
    goal: fc.option(intArb("short"), { nil: null }),
    role: fc.constantFrom("wanted", "wanted", "excluded", "unlinked"),
  }),
  { nil: null, freq: 3 },
);

/**
 * Rewards received before the run and Twitch crediting one drop only (`received`, `creditsOnly`)
 * on one of the first campaigns, usually the opportunity, campaign 0. Drawn after everything
 * else, so a seed's world is the one it was before these existed, plus the quirk; half the seeds
 * have none.
 */
const quirkArbitrary = fc.option(
  fc.record({
    campaign: fc.integer({ min: 0, max: 3 }).map((n) => (n < 2 ? 0 : n - 1)),
    drop: intArb("game"),
    received: fc.constantFrom(...RECEIVED, null),
    // One quirk in three.
    creditsOnly: fc
      .tuple(fc.integer({ min: 0, max: 2 }), intArb("game"))
      .map(([k, drop]) => (k === 0 ? drop : null)),
  }),
  { nil: null, freq: 2 },
);

type Quirk = NonNullable<typeof quirkArbitrary extends fc.Arbitrary<infer Q> ? Q : never>;

const withQuirk = (scenario: Scenario, quirk: Quirk | null, moveOn: boolean): Scenario => {
  if (quirk === null) return scenario;
  // Hidden campaigns come last; a quirk goes to a listed one.
  const listed = scenario.campaigns.filter((c) => c.hidden !== true).length;
  const campaigns = scenario.campaigns.map((c, i) => {
    if (i !== quirk.campaign % listed) return c;
    const target = quirk.drop % c.drops.length;
    const drops = c.drops.map((d, j) =>
      j === target && quirk.received !== null ? { ...d, received: quirk.received } : d,
    );
    if (quirk.creditsOnly === null) return { ...c, drops };
    const only = { ...c, drops, creditsOnly: quirk.creditsOnly % c.drops.length };
    return moveOn ? { ...only, creditsMoveOn: true } : only;
  });
  return { ...scenario, campaigns };
};

const REWARD_OF = { BADGE: "badge", EMOTE: "emote", DIRECT_ENTITLEMENT: "item" } as const;

/**
 * What the recordings showed beyond the random world: a hidden campaign beside campaign 0 (1 of 6
 * watched campaigns had one, run4h: a 900-minute drop, drawn half the time), and `stream-down`
 * changes that land in the same minute as a `stream-down` on the channel before
 * (`DOWN_BURST_SHARE` of `stream-down` frames came within 60 s of the previous one).
 */
const measuredArbitrary = fc.record({
  hidden: fc.oneof(
    { weight: 10, arbitrary: fc.constant(null) },
    { weight: 1, arbitrary: fc.constant(HIDDEN_DROP_MINUTES) },
    { weight: 1, arbitrary: intArb("requiredMinutes") },
  ),
  bursts: fc.array(
    // Unbiased: fast-check favours small integers, which drew bursts 28 % of the time.
    fc.noBias(fc.integer({ min: 0, max: 999 })).map((n) => n < DOWN_BURST_SHARE * 1000),
    {
      minLength: BOUNDS.channels[1] * BOUNDS.changes[1],
      maxLength: BOUNDS.channels[1] * BOUNDS.changes[1],
    },
  ),
});

/**
 * Generates scenarios within the Schema's bounds; fast-check shrinks them towards fewer things.
 * Campaign 0 on channel 0 is always an opportunity one of the goals wants; three times in four
 * campaign 1 on channel 1 is a rival (`rivalArbitrary`). The rest is random,
 * so faults, newer campaigns, other goals and schedule changes may still stand in its way. Half
 * the seeds add a quirk the live run found (`quirkArbitrary`); half of those crediting one drop
 * move on once it completes (`creditsMoveOn`). The wire's crowd and faults (`wireArbitrary`) are
 * drawn last, so earlier seeds keep their worlds.
 */
export const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .tuple(
    randomScenario,
    opportunityArbitrary,
    rivalArbitrary,
    measuredArbitrary,
    quirkArbitrary,
    fc.boolean(),
    wireArbitrary,
  )
  .map(([s, o, r, m, q, moveOn, w]): Scenario =>
    withWire(withQuirk(baseScenario(s, o, r, m), q, moveOn), w),
  );

/**
 * The worlds of `scenarioArbitrary` without the quirks of the live run (`quirkArbitrary`). The
 * regression seeds found by earlier sweeps replay on it. The calibration (`measuredArbitrary`,
 * the measured timings in `randomScenario`) redrew every seed's world, so these seeds no longer
 * draw the world they were found in; they stay as worlds of the same family.
 */
export const plainScenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .tuple(randomScenario, opportunityArbitrary, rivalArbitrary, measuredArbitrary)
  .map(([s, o, r, m]): Scenario => baseScenario(s, o, r, m));

const baseScenario = (
  s: Scenario,
  o: typeof opportunityArbitrary extends fc.Arbitrary<infer O> ? O : never,
  r: typeof rivalArbitrary extends fc.Arbitrary<infer R> ? R : never,
  m: typeof measuredArbitrary extends fc.Arbitrary<infer M> ? M : never,
): Scenario => {
  const refusals = refusalsOf(s.latencySeed, o.drops[0]!.requiredMinutes);
  const { game, startMinute, durationMinutes, drops, viewers, changes } = o;
  const allowList = refusals.allowListed ? [0] : [];
  const campaign = { game, startMinute, durationMinutes, linked: true, allowList, drops };
  const live = (g: number, v: number, c: typeof changes) => ({
    game: g,
    viewers: v,
    dropsEnabled: true,
    refuses: false,
    liveAtStart: true,
    changes: c,
  });
  const rivalGame = r === null ? 0 : r.game === game ? 1 - r.game : r.game;
  const rivalEnd =
    r === null || r.endsNear === null ? undefined : startMinute + durationMinutes + r.endsNear;
  const rivals =
    r === null
      ? []
      : [
          {
            campaign: {
              game: rivalGame,
              startMinute: r.startMinute,
              durationMinutes:
                rivalEnd === undefined
                  ? r.durationMinutes
                  : Math.min(BOUNDS.durationMinutes[1], Math.max(180, rivalEnd - r.startMinute)),
              linked: r.role !== "unlinked",
              allowList: [],
              drops:
                r.role === "unlinked"
                  ? r.drops.map((d) => ({ ...d, benefit: "DIRECT_ENTITLEMENT" as const }))
                  : r.drops,
            },
            channel: live(rivalGame, r.viewers, r.changes),
          },
        ];
  const fixed = 1 + rivals.length;
  const channels = [
    live(game, viewers, changes),
    ...rivals.map((x) => x.channel),
    ...s.channels.slice(0, BOUNDS.channels[1] - fixed),
  ];
  const n = s.settings.goals.length;
  const forRival = (g: GoalSpec): GoalSpec => {
    if (r === null) return g;
    switch (r.role) {
      case "wanted":
        return wanting(g, rivalGame, r.drops, channels.length, 1);
      case "excluded":
        return g.games === null
          ? { ...g, excludeGames: [...new Set([rivalGame, ...g.excludeGames])].slice(0, 2) }
          : { ...g, games: g.games.filter((x) => x.game !== rivalGame) };
      case "unlinked":
        return { ...g, linkedOnly: true };
    }
  };
  // The rival first: campaign 0's goal is bent last, so it always wants campaign 0.
  const goals = s.settings.goals
    .map((g, i) => (r !== null && i === (r.goal ?? o.goal) % n ? forRival(g) : g))
    .map((g, i) => (i === o.goal % n ? wanting(g, game, drops, channels.length, 0) : g));
  const listed = [
    campaign,
    ...rivals.map((x) => x.campaign),
    ...s.campaigns.slice(0, BOUNDS.campaigns[1] - fixed - (m.hidden === null ? 0 : 1)),
  ];
  const hidden =
    m.hidden === null
      ? []
      : [
          {
            game,
            startMinute,
            durationMinutes,
            linked: true,
            allowList: [],
            drops: [
              { requiredMinutes: m.hidden, after: null, benefit: "DIRECT_ENTITLEMENT" as const },
            ],
            hidden: true,
          },
        ];
  return {
    ...s,
    ...(refusals.gqlMaxWait === undefined ? {} : { gqlMaxWait: refusals.gqlMaxWait }),
    faults: [...s.faults, ...refusals.faults],
    settings: { goals },
    campaigns: [...listed, ...hidden],
    channels: channels.map((channel, i) => ({
      ...channel,
      changes: channel.changes.map((change, j) => {
        const downs = (channels[i - 1]?.changes ?? []).filter((x) => x.to === "down");
        const burst =
          change.to === "down" && m.bursts[i * BOUNDS.changes[1] + j] === true && downs.length;
        return burst ? { ...change, atMinute: downs[j % downs.length]!.atMinute } : change;
      }),
    })),
  };
};

/**
 * Worlds where the request budgets refuse, drawn from the latency seed, as `otherGames` is, so
 * every seed keeps the world it had and only gains these. Without them no sweep refused a claim
 * or a channel read (review of A7, P1). Each is independent and holds in half the seeds or so:
 * - `gqlMaxWait` of 1 or 2 s: a discovery burst of more than a few reads is partly refused;
 * - a `gql-cooldown` of 3 to 5 minutes from the first inventory answer showing a drop to claim,
 *   a minute before campaign 0's first drop completes or later: that claim is refused;
 * - a 429 on the first directory read of the first or second catalog read: the budget cools
 *   down, and every directory and channel read queued behind it is refused at once;
 * - campaign 0 allow-listed to channel 0: discovery reads its channels after the directories,
 *   so the read of the channel that earns is the one refused.
 */
const refusalsOf = (
  latencySeed: number,
  firstDropMinutes: number,
): {
  readonly gqlMaxWait: number | undefined;
  readonly allowListed: boolean;
  readonly faults: ReadonlyArray<Fault>;
} => {
  const draw = Math.floor(latencySeed / (BOUNDS.otherGames[1] + 1));
  // Set bits add refusals, so a seed shrunk towards 0 sheds them.
  const bit = (n: number) => Math.floor(draw / 2 ** n) % 2 === 1;
  const gqlMaxWait = bit(0) ? (bit(1) ? 1_000 : 2_000) : undefined;
  const allowListed = bit(5);
  const faults: Array<Fault> = [];
  if (bit(2)) {
    // Armed a minute before the drop completes on a watch begun at once (`startCooldown`).
    faults.push({
      kind: "gql-cooldown",
      atMinute: Math.max(0, firstDropMinutes - 1),
      durationSeconds: 60 * (3 + (Math.floor(draw / 64) % 3)),
    });
  }
  if (bit(3)) {
    faults.push({
      kind: "http-429",
      operation: "DirectoryPage_Game",
      atMinute: bit(4) ? 0 : 60,
      durationSeconds: 30,
    });
  }
  return { gqlMaxWait, allowListed, faults };
};

/**
 * Bends a goal just enough to want the first drop of a linked campaign of `game` on channel
 * `channel`: the game listed (last, so the list keeps its order) and not excluded, the drop's
 * reward wanted, the channel not excluded.
 */
const wanting = (
  goal: GoalSpec,
  game: number,
  drops: ReadonlyArray<{ readonly benefit: (typeof BENEFITS)[number] }>,
  channels: number,
  channel: number,
): GoalSpec => {
  const reward = REWARD_OF[drops[0]!.benefit];
  const withReward = (rewards: ReadonlyArray<(typeof REWARDS)[number]>) =>
    rewards.includes(reward) ? rewards : [...rewards.slice(0, BOUNDS.rewards[1] - 1), reward];
  const games =
    goal.games === null
      ? null
      : goal.games.some((g) => g.game === game)
        ? goal.games.map((g) =>
            g.game === game && g.rewards !== null ? { ...g, rewards: withReward(g.rewards) } : g,
          )
        : [...goal.games.slice(0, BOUNDS.short[1] - 1), { game, rewards: null }];
  // The game's first entry decides; a later duplicate never does.
  const own = games?.find((g) => g.game === game)?.rewards ?? null;
  return {
    ...goal,
    games,
    rewards: own === null ? withReward(goal.rewards) : goal.rewards,
    excludeGames: goal.excludeGames.filter((g) => g !== game),
    exclude: goal.exclude.filter((k) => k % channels !== channel),
  };
};
