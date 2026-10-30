import fc from "fast-check";
import { Schema } from "effect";
import type { Millis } from "../core/model.ts";

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
  startMinute: [-120, 600],
  durationMinutes: [30, 2880],
  drops: [1, 3],
  requiredMinutes: [1, 240],
  channels: [1, 8],
  viewers: [1, 10_000],
  changes: [0, 6],
  atMinute: [0, 1440],
  faults: [0, 8],
  durationSeconds: [1, 1800],
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

export const OPERATIONS = [
  "validate",
  "ViewerDropsDashboard",
  "DropCampaignDetails",
  "Inventory",
  "DirectoryPage_Game",
  "VideoPlayerStreamInfoOverlayChannel",
  "DropCurrentSessionContext",
  /** The claim mutation (TDM `DropsPage_ClaimDropRewards`), served by the twin's actuator. */
  "ClaimDrop",
] as const;
export type Operation = (typeof OPERATIONS)[number];

const WINDOW_FAULTS = ["http-5xx", "http-429", "timeout", "service-error", "null-catalog"] as const;
const CRASH_POINTS = ["before-persist", "after-persist", "in-claim"] as const;
const BENEFITS = ["BADGE", "EMOTE", "DIRECT_ENTITLEMENT"] as const;
const CHANGES = ["up", "down", "game-0", "game-1", "game-2"] as const;
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

export const Scenario = Schema.Struct({
  /** Seeds `Random`, which draws request latencies. */
  latencySeed: Schema.Int,
  horizonMinutes: int("horizonMinutes"),
  inventoryLagMinutes: int("inventoryLagMinutes"),
  settings: Schema.Struct({ goals: list(GoalSpec, "goals") }),
  campaigns: list(CampaignSpec, "campaigns"),
  channels: list(ChannelSpec, "channels"),
  faults: list(Fault, "faults"),
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
  operation: fc.constantFrom(...OPERATIONS, "any" as const),
  atMinute: intArb("atMinute"),
  durationSeconds: intArb("durationSeconds"),
});

const faultArbitrary: fc.Arbitrary<Fault> = fc.oneof(
  windowFault,
  fc.record({ kind: fc.constant("revoke-token" as const), atMinute: intArb("atMinute") }),
  fc.record({ kind: fc.constant("lose-claim-answer" as const), atMinute: intArb("atMinute") }),
  fc.record({
    kind: fc.constant("frames-down" as const),
    atMinute: intArb("atMinute"),
    durationSeconds: intArb("durationSeconds"),
  }),
  fc.record({
    kind: fc.constant("crash" as const),
    atMinute: intArb("atMinute"),
    point: fc.constantFrom(...CRASH_POINTS),
  }),
);

const dropArbitrary = (requiredMinutes: fc.Arbitrary<number>) =>
  fc.record({
    requiredMinutes,
    after: fc.option(intArb("game"), { nil: null }),
    benefit: fc.constantFrom(...BENEFITS),
  });

const changeArbitrary = (atMinute: fc.Arbitrary<number>) =>
  fc.record({ atMinute, to: fc.constantFrom(...CHANGES) });

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

const randomScenario: fc.Arbitrary<Scenario> = fc.record({
  latencySeed: fc.integer({ min: 0, max: 1_000_000 }),
  horizonMinutes: intArb("horizonMinutes"),
  inventoryLagMinutes: intArb("inventoryLagMinutes"),
  settings: fc.record({ goals: listArb(goalArbitrary, "goals") }),
  campaigns: listArb(
    fc.record({
      game: intArb("game"),
      startMinute: intArb("startMinute"),
      durationMinutes: intArb("durationMinutes"),
      linked: fc.boolean(),
      creditsUnlinked: fc.boolean(),
      allowList: listArb(intArb("index"), "short"),
      drops: listArb(dropArbitrary(intArb("requiredMinutes")), "drops"),
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
  faults: listArb(faultArbitrary, "faults"),
});

/**
 * A linked campaign that has started, and a drops-enabled channel streaming its game from the
 * start for at least an hour, with drops short enough to complete in the shortest horizon.
 * Random worlds alone line these up rarely (4 claims in 100 seeds), which left the sweep
 * checking worlds with nothing to earn.
 */
const opportunityArbitrary = fc.record({
  game: intArb("game"),
  startMinute: fc.integer({ min: BOUNDS.startMinute[0], max: 0 }),
  durationMinutes: fc.integer({ min: 240, max: BOUNDS.durationMinutes[1] }),
  drops: listArb(dropArbitrary(fc.integer({ min: 1, max: 45 })), "drops"),
  viewers: intArb("viewers"),
  changes: listArb(changeArbitrary(fc.integer({ min: 60, max: BOUNDS.atMinute[1] })), "changes"),
  /** The goal that wants it, modulo the number of goals. */
  goal: intArb("short"),
});

const REWARD_OF = { BADGE: "badge", EMOTE: "emote", DIRECT_ENTITLEMENT: "item" } as const;

/**
 * Generates scenarios within the Schema's bounds; fast-check shrinks them towards fewer things.
 * Campaign 0 on channel 0 is always an opportunity one of the goals wants. The rest is random,
 * so faults, newer campaigns, other goals and schedule changes may still stand in its way.
 */
export const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .tuple(randomScenario, opportunityArbitrary)
  .map(([s, o]): Scenario => {
    const { game, startMinute, durationMinutes, drops, viewers, changes } = o;
    const campaign = { game, startMinute, durationMinutes, linked: true, allowList: [], drops };
    const channel = {
      game,
      viewers,
      dropsEnabled: true,
      refuses: false,
      liveAtStart: true,
      changes,
    };
    const channels = [channel, ...s.channels.slice(0, BOUNDS.channels[1] - 1)];
    const index = o.goal % s.settings.goals.length;
    const goals = s.settings.goals.map((g, i) =>
      i === index ? wanting(g, game, drops, channels.length) : g,
    );
    return {
      ...s,
      settings: { goals },
      campaigns: [campaign, ...s.campaigns.slice(0, BOUNDS.campaigns[1] - 1)],
      channels,
    };
  });

/**
 * Bends a goal just enough to want the first drop of a linked campaign of `game` on channel 0:
 * the game listed (last, so the list keeps its order) and not excluded, the drop's reward wanted,
 * channel 0 not excluded.
 */
const wanting = (
  goal: GoalSpec,
  game: number,
  drops: ReadonlyArray<{ readonly benefit: (typeof BENEFITS)[number] }>,
  channels: number,
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
    exclude: goal.exclude.filter((k) => k % channels !== 0),
  };
};
