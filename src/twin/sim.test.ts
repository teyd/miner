import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  MINUTE,
  type ChannelId,
  type DropId,
  type DropsGoal,
  type Settings,
} from "../core/model.ts";
import {
  compareNumbers,
  compareText,
  minable,
  SLACK_HYSTERESIS,
  type Pick,
  type Rank,
} from "../core/plan.ts";
import { Command, Event } from "../core/protocol.ts";
import { canEarn, isActive, minutesOf, slackOf, wantedDrops } from "../core/rules.ts";
import { nextDeadline } from "../core/state.ts";
import { GQL_LIMITS, UNLIMITED } from "../twitch/budget.ts";
import { step, stepWith } from "../core/step.ts";
import { CLAIM_AFTER_FRAME_MAX, FRAME_GAPS } from "./calibration.ts";
import {
  Capsule,
  DEFAULT_GOAL_SPEC,
  SIM_EPOCH,
  Scenario,
  plainScenarioArbitrary,
  scenarioArbitrary,
  type Fault,
  type GoalSpec,
} from "./scenario.ts";
import {
  runProperty,
  runScenario,
  runSeed,
  runSeeds,
  runTwice,
  type Core,
  type SeedResult,
} from "./sim.ts";
import { minutesAt } from "./world.ts";
import seed22 from "./fixtures/seed-22.json" with { type: "json" };
import seed90052 from "./fixtures/seed-90052.json" with { type: "json" };

/** One linked campaign on one live channel, with a 10-minute drop and a 30-minute one. */
const base: Scenario = {
  latencySeed: 7,
  horizonMinutes: 120,
  inventoryLagMinutes: 1,
  settings: { goals: [DEFAULT_GOAL_SPEC] },
  campaigns: [
    {
      game: 0,
      startMinute: -10,
      durationMinutes: 600,
      linked: true,
      allowList: [],
      drops: [
        { requiredMinutes: 10, after: null, benefit: "DIRECT_ENTITLEMENT" },
        { requiredMinutes: 30, after: 0, benefit: "DIRECT_ENTITLEMENT" },
      ],
    },
  ],
  channels: [
    {
      game: 0,
      viewers: 10_000,
      dropsEnabled: true,
      refuses: false,
      liveAtStart: true,
      changes: [],
    },
    {
      game: 0,
      viewers: 50,
      dropsEnabled: true,
      refuses: false,
      liveAtStart: false,
      changes: [{ atMinute: 20, to: "up" }],
    },
  ],
  faults: [],
};

interface TraceLine {
  readonly at: number;
  readonly kind: string;
  readonly data: {
    readonly event?: { readonly _tag: string; readonly minutes?: number };
    readonly calls?: ReadonlyArray<{ readonly kind: string; readonly at: number }>;
  };
}

const withFaults = (...faults: ReadonlyArray<Fault>): Scenario => ({ ...base, faults });

const kindOf = (result: SeedResult) =>
  result._tag === "Failed" ? result.capsule.violation.kind : "passed";

const size = (s: Scenario) => [s.campaigns.length, s.channels.length, s.faults.length];

const plant = (f: (commands: ReadonlyArray<Command>) => ReadonlyArray<Command>): Core => ({
  nextDeadline,
  step: (state, event, now) => {
    const result = step(state, event, now);
    return { ...result, commands: f(result.commands) };
  },
});

const plantWith = (
  f: (commands: ReadonlyArray<Command>, event: Event, now: number) => ReadonlyArray<Command>,
): Core => ({
  nextDeadline,
  step: (state, event, now) => {
    const result = step(state, event, now);
    return { ...result, commands: f(result.commands, event, now) };
  },
});

const claimTwice = (commands: ReadonlyArray<Command>) =>
  commands.flatMap((c): ReadonlyArray<Command> => (c._tag === "Claim" ? [c, c] : [c]));

/** Random worlds that always hold the base campaign and its busy channel, so claims happen. */
const withBase = scenarioArbitrary.map((s): Scenario => ({
  ...s,
  settings: base.settings,
  // Within the Schema's bounds, so a capsule decodes.
  campaigns: [base.campaigns[0]!, ...s.campaigns].slice(0, 4),
  channels: [base.channels[0]!, ...s.channels].slice(0, 8),
  faults: s.faults.filter((f) => f.kind !== "revoke-token"),
}));

describe("fixed scenarios", () => {
  it.effect("mine, claim both drops in order and stay healthy", () =>
    Effect.gen(function* () {
      const result = yield* runTwice(base);
      assert.isUndefined(result.violation);
      assert.include(result.tail.join("\n"), '"outcome":"claimed"');
    }),
  );

  // Live, no `drop-claim` frame came in 4.6 hours (2026-10-30), so worlds send none unless they
  // opt in; the miner finds claimable drops in inventory either way.
  it.effect("claim both drops when Twitch sends drop-claim frames too", () =>
    Effect.gen(function* () {
      const result = yield* runTwice({ ...base, claimFrames: true });
      assert.isUndefined(result.violation, JSON.stringify(result.violation));
      assert.strictEqual(result.claimsApplied, 2);
      assert.isAbove(result.wire["heard DropClaimable"] ?? 0, 0);
      const quiet = yield* runTwice(base);
      assert.strictEqual(quiet.claimsApplied, 2);
      assert.isUndefined(quiet.wire["heard DropClaimable"]);
    }),
  );

  const cases: ReadonlyArray<readonly [string, Scenario]> = [
    [
      "a 5xx storm",
      withFaults({ kind: "http-5xx", operation: "any", atMinute: 3, durationSeconds: 600 }),
    ],
    [
      "a short 5xx blip the retries absorb",
      withFaults({ kind: "http-5xx", operation: "any", atMinute: 0, durationSeconds: 5 }),
    ],
    [
      "429s on inventory",
      withFaults({ kind: "http-429", operation: "Inventory", atMinute: 4, durationSeconds: 900 }),
    ],
    [
      "a hanging network, ticks delayed (s3 bound)",
      withFaults({ kind: "timeout", operation: "any", atMinute: 4, durationSeconds: 300 }),
    ],
    [
      "service errors",
      withFaults({ kind: "service-error", operation: "any", atMinute: 2, durationSeconds: 400 }),
    ],
    [
      "a null catalog",
      withFaults({
        kind: "null-catalog",
        operation: "ViewerDropsDashboard",
        atMinute: 0,
        durationSeconds: 900,
      }),
    ],
    ["a revoked token", withFaults({ kind: "revoke-token", atMinute: 15 })],
    ["a lost claim answer", withFaults({ kind: "lose-claim-answer", atMinute: 0 })],
    [
      "claims during a 5xx window",
      withFaults({ kind: "http-5xx", operation: "ClaimDrop", atMinute: 9, durationSeconds: 300 }),
    ],
    ["PubSub down", withFaults({ kind: "frames-down", atMinute: 0, durationSeconds: 1800 })],
    [
      "a crash before persisting",
      withFaults({ kind: "crash", atMinute: 7, point: "before-persist" }),
    ],
    [
      "a crash after persisting",
      withFaults({ kind: "crash", atMinute: 7, point: "after-persist" }),
    ],
    // Plan §7: a restart with a claim in flight used to spin (`BusyWake`) and resend the claim.
    [
      "a crash between applying a claim and its answer",
      withFaults({ kind: "crash", atMinute: 0, point: "in-claim" }),
    ],
  ];
  for (const [name, scenario] of cases) {
    it.effect(`survive ${name}`, () =>
      Effect.gen(function* () {
        const result = yield* runTwice(scenario);
        assert.isUndefined(result.violation, JSON.stringify(result.violation));
        const crashes = scenario.faults.filter((f) => f.kind === "crash").length;
        assert.strictEqual(result.restarts, crashes);
      }),
    );
  }

  it.effect("a large catalog's discovery refused at once is one step, not one per read", () =>
    Effect.gen(function* () {
      // Thirty games more than the live catalog's 14, read with a 1 s wait for a turn: four
      // reads get one, and the rest are refused at one instant as each frees its slot. One step
      // per refusal was more than `BUSY_STEPS`.
      const large: Scenario = { ...base, otherGames: 30, gqlMaxWait: 1_000 };
      const result = yield* runTwice(large);
      assert.isUndefined(result.violation);
      assert.include(result.refused, "ReadDirectory");
      assert.isAbove(result.claimsApplied, 0);
    }),
  );

  it.effect("park on a revoked token and poll nothing afterwards", () =>
    Effect.gen(function* () {
      const result = yield* runScenario(withFaults({ kind: "revoke-token", atMinute: 15 }));
      assert.isUndefined(result.violation);
      const after = result.tail.filter((line) => line.includes('"kind":"step"')).at(-1) ?? "";
      assert.include(after, '"reason":"needs-login"');
    }),
  );
});

describe("seeds found by longer sweeps", () => {
  // CI runs seeds 1-20; these came from sweeps of 1000 and stay fixed regressions, in the
  // worlds they were found in (`plainScenarioArbitrary`).
  const found: ReadonlyArray<readonly [number, string]> = [
    // The doomed campaign's drop runs out of time and the core rightly moves to one that can
    // finish: WatchFlip took it for a switch without a cause.
    [2011, "a doomed campaign left for one that can finish"],
    [4664, "a doomed campaign left for one that can finish, after a restart"],
    // An inventory read without the drop settled a lost claim and the claim went out again.
    [4647, "a claim settled by an inventory read that omitted its drop"],
    // Twitch credited another wanted campaign and the core followed it: not a flip.
    [23266, "a switch that follows Twitch's credit"],
    // A new target on the same channel restarted the stall clock, holding a dead channel.
    [22972, "a channel that never credits, its target changing"],
    // Measured frame gaps: a credit began 20 s before the stall rule fired, too late to be heard.
    [7242, "a stall just as the channel starts crediting, frames 9 minutes apart"],
    [7291, "a stall just as the channel starts crediting, frames 3 and 7 minutes apart"],
    [30860, "a stall clock restarted by an inventory read minutes after the last credit"],
  ];
  // Stored as a world: the generator has changed since, so the seed alone draws another.
  it.effect("seed 90052: the last minute before a channel moved its credit came by inventory", () =>
    Effect.gen(function* () {
      // ch2 credited c0 while c2 had nothing to earn, then c2 again after its claim, mid-way
      // through c0's frame countdown: the core heard that minute at the next inventory read,
      // 5 minutes later, and its stall clock rightly ran from there.
      const scenario = yield* Schema.decodeUnknownEffect(Scenario)(seed90052);
      const result = yield* runTwice(scenario);
      assert.isUndefined(result.violation, JSON.stringify(result.violation));
    }),
  );
  it.effect("seed 22 (sweep of 2026-10-31): a channel avoided once its campaign had ended", () =>
    Effect.gen(function* () {
      // ch0 credited c2 for its last minute, c2's drop window cut to it, and nothing after.
      const scenario = yield* Schema.decodeUnknownEffect(Scenario)(seed22);
      const result = yield* runTwice(scenario);
      assert.isUndefined(result.violation, JSON.stringify(result.violation));
    }),
  );
  for (const [seed, name] of found) {
    it.effect(
      `seed ${seed}: ${name}`,
      () =>
        Effect.gen(function* () {
          assert.strictEqual(kindOf(yield* runProperty(plainScenarioArbitrary, seed)), "passed");
        }),
      60_000,
    );
  }
  // Found with the quirks of the 4 h live run (`scenarioArbitrary`).
  const quirky: ReadonlyArray<readonly [number, string]> = [
    // Twitch credited only a locked drop of the newest campaign on the channel; giving up that
    // campaign restarted the channel's clock for the next target there, which it never credited.
    [40277, "a campaign given up, the channel kept for another it never credits"],
    // The only channel the core knew on the game was given up after a stall (its change of game
    // was lost with the frames); another turned to the game unheard, and the core sat idle until
    // the hourly catalog read.
    [50138, "no live channel for what earns, the directory read again within 15 min"],
    // A campaign skip that ended put the core back on it, where Twitch still credited the drop
    // it was skipped for: a stall each hour, given up at once now (`skipCauses`).
    [106, "a skipped campaign retried, Twitch still on the same drop"],
    // That at-once skip followed the channel's credits to another campaign: the fairness check
    // looks at the campaign's own credits.
    [50613, "a retry given up at once after another campaign's credits"],
    // A channel given up while Twitch credited another campaign's unwanted item, 100 minutes
    // short of moving on to the emote a goal wants (calibrated generator, 2026-10-31).
    [131, "a channel given up, Twitch more than a stall from a wanted drop"],
    // One framed drop per campaign (measured, `framesAll` off): a wanted drop credited beside the
    // framed one shows only in the inventory, and the channel was given up while it earned.
    [161, "a wanted drop credited without frames, heard through the inventory"],
    [160174, "a wanted drop credited without frames, after a switch"],
    // Twitch credited only a drop the goal filters out, far from done, and each frame confirmed
    // the watch: the miner never gave the campaign up.
    [80578, "a filtered drop credited alone, 148 minutes from done"],
    [280710, "a filtered drop credited alone, 236 minutes from done"],
    // Another wanted campaign's filtered badge, 5 minutes short of the emote Twitch moves on to.
    [270187, "a channel kept while another wanted campaign's badge leads to its emote"],
    // A known drop's opening woke nothing but the next inventory read, or a catalog read 15
    // minutes after the last; the channels of an allow-list were read only at that catalog read.
    [270057, "a known drop opens: the core wakes for it"],
    [280721, "a known drop opens on a channel the core knows"],
    [280753, "a known drop opens on an allow-list the core never read"],
  ];
  for (const [seed, name] of quirky) {
    it.effect(
      `seed ${seed}: ${name}`,
      () =>
        Effect.gen(function* () {
          assert.strictEqual(kindOf(yield* runSeed(seed)), "passed");
        }),
      60_000,
    );
  }
});

describe("planted bugs are caught and shrunk", () => {
  const expectCaught = (result: SeedResult, kinds: ReadonlyArray<string>) => {
    assert.strictEqual(result._tag, "Failed");
    if (result._tag !== "Failed") return;
    assert.include(kinds, result.capsule.violation.kind);
    const [campaigns, channels, faults] = size(result.capsule.scenario);
    const [c0, ch0, f0] = size(result.initial);
    assert.isAtMost(campaigns!, c0!);
    assert.isAtMost(channels!, ch0!);
    assert.isAtMost(faults!, f0!);
  };

  it.effect("a claim sent twice", () =>
    Effect.gen(function* () {
      const twice = plant(claimTwice);
      const result = yield* runProperty(withBase, 1, {
        core: twice,
        maxShrinks: 30,
        maxHorizonMinutes: 120,
      });
      expectCaught(result, ["MutationRetried", "ClaimedTwice"]);
    }),
  );

  it.effect("watch ticks without a watch", () =>
    Effect.gen(function* () {
      const noWatch = plant((cs) => cs.filter((c) => c._tag !== "Watch"));
      const result = yield* runProperty(withBase, 1, {
        core: noWatch,
        maxShrinks: 30,
        maxHorizonMinutes: 120,
      });
      expectCaught(result, ["TwoWatches"]);
    }),
  );

  it.effect("planning on the first discovery answer (the live startup flip)", () =>
    Effect.gen(function* () {
      // Game 0 ranks first and its campaign is allow-listed to channel 1; game 1's directory
      // read goes out first and answers first, with channel 0.
      const flip: Scenario = {
        ...base,
        horizonMinutes: 30,
        settings: {
          goals: [{ ...DEFAULT_GOAL_SPEC, games: [0, 1].map((game) => ({ game, rewards: null })) }],
        },
        campaigns: [
          { ...base.campaigns[0]!, allowList: [1] },
          { ...base.campaigns[0]!, game: 1 },
        ],
        channels: [
          { ...base.channels[0]!, game: 1 },
          { ...base.channels[0]!, viewers: 10 },
        ],
      };
      const impatient: Core = {
        nextDeadline,
        step: (state, event, now) => {
          const result = step({ ...state, discovery: undefined }, event, now);
          return { ...result, state: { ...result.state, discovery: undefined } };
        },
      };
      const caught = yield* runTwice(flip, { core: impatient });
      assert.strictEqual(caught.violation?.kind, "WatchFlip");
      assert.strictEqual((yield* runTwice(flip)).violation, undefined);
      // A 5 s blip the retries absorb leaves the core's picture whole: no excuse for the flip.
      const blip: Scenario = {
        ...flip,
        faults: [{ kind: "http-5xx", operation: "any", atMinute: 0, durationSeconds: 5 }],
      };
      const blipped = yield* runTwice(blip, { core: impatient });
      assert.strictEqual(blipped.violation?.kind, "WatchFlip");
      assert.strictEqual((yield* runTwice(blip)).violation, undefined);
    }),
  );

  it.effect(
    "a claim re-sent at every inventory read, for an unlinked item never shown claimed",
    () =>
      Effect.gen(function* () {
        // Marvel Rivals, 2026-10-30: an unlinked item stays unclaimed in the inventory after its
        // claim, so a core that trusts the flag claims it again at every read. Re-sent on every
        // step, the claims pile up in flight (`TooManyInFlight`); at every read they don't.
        const unlinked: Scenario = {
          ...base,
          horizonMinutes: 30,
          settings: { goals: [{ ...DEFAULT_GOAL_SPEC, linkedOnly: false }] },
          campaigns: [{ ...base.campaigns[0]!, linked: false, creditsUnlinked: true }],
        };
        const resending = (): Core => {
          let last: Command | undefined;
          return {
            nextDeadline,
            step: (state, event, now) => {
              const result = step(state, event, now);
              if (event._tag === "Started") last = undefined;
              const claim = result.commands.findLast((c) => c._tag === "Claim");
              const commands =
                claim === undefined && last !== undefined && event._tag === "InventoryRead"
                  ? [...result.commands, last]
                  : result.commands;
              last = claim ?? last;
              return { ...result, commands };
            },
          };
        };
        const caught = yield* runScenario(unlinked, { core: resending() });
        assert.include(["ClaimedTwice", "MutationRetried"], caught.violation?.kind);
        const real = yield* runTwice(unlinked);
        assert.isUndefined(real.violation, JSON.stringify(real.violation));
        assert.isAtLeast(real.claimsApplied, 1);
      }),
  );

  it.effect("a restart that forgets claims in flight", () =>
    Effect.gen(function* () {
      const forgetful: Core = {
        nextDeadline,
        step: (state, event, now) =>
          step(event._tag === "Started" ? { ...state, claims: new Map() } : state, event, now),
      };
      const crashing = withBase.map((s): Scenario => ({
        ...s,
        faults: [...s.faults, { kind: "crash", atMinute: 0, point: "in-claim" }],
      }));
      const result = yield* runProperty(crashing, 1, {
        core: forgetful,
        maxShrinks: 30,
        maxHorizonMinutes: 120,
      });
      expectCaught(result, ["ClaimedTwice", "MutationRetried"]);
    }),
  );

  it.effect(
    "no GQL budget: a large catalog's discovery burst gets 429s",
    () =>
      Effect.gen(function* () {
        const unbudgeted = { limits: { gql: UNLIMITED }, maxHorizonMinutes: 120 };
        // Seed 7: fourteen other games, as many as the live catalog of 2026-10-30.
        const result = yield* runSeed(7, { ...unbudgeted, maxShrinks: 30 });
        assert.strictEqual(result._tag, "Failed");
        if (result._tag !== "Failed") return;
        assert.strictEqual(result.capsule.violation.kind, "OverBudget");
        assert.match(result.capsule.violation.detail, /429/);
        assert.isUndefined((yield* runTwice(result.capsule.scenario)).violation);
        // The sweep finds it without being pointed at it.
        const swept = yield* runSeeds(1, 40, { ...unbudgeted, maxShrinks: 0 });
        assert.isAtLeast(swept.filter((r) => r._tag === "Failed").length, 1);
      }),
    // A shrink plus a 40-seed sweep against an unbudgeted twin: over 30 s on CI.
    120_000,
  );

  it.effect("the API budget's concurrency alone keeps nothing under Twitch's rate", () =>
    Effect.gen(function* () {
      // Gap and window gone, four in flight kept: answers of 100–400 ms let more than five start
      // in a second.
      const gql = { ...GQL_LIMITS, gap: 0, window: 1, max: Number.MAX_SAFE_INTEGER };
      const result = yield* runSeed(7, { limits: { gql }, maxHorizonMinutes: 120, maxShrinks: 0 });
      assert.strictEqual(result._tag, "Failed");
      if (result._tag === "Failed") assert.strictEqual(result.capsule.violation.kind, "OverBudget");
    }),
  );
});

describe("planted bugs in what a request budget refused are caught by the sweep", () => {
  /** The core never sees some refusals: the bug of a `Throttled` handler that ignores them. */
  const ignoring = (dropped: (command: Command) => boolean): Core => ({
    nextDeadline,
    step: (state, event, now) =>
      step(
        state,
        event._tag === "Throttled"
          ? Event.Throttled({ refusals: event.refusals.filter((r) => !dropped(r.command)) })
          : event,
        now,
      ),
  });
  const sweep = (core: Core) => runSeeds(1, 60, { core, maxShrinks: 0 });
  const caught = (results: ReadonlyArray<SeedResult>, kind: string) =>
    results.filter((r) => r._tag === "Failed" && r.capsule.violation.kind === kind).length;

  it.effect(
    "a refused claim dropped, its intent left sent forever",
    () =>
      Effect.gen(function* () {
        const results = yield* sweep(ignoring((c) => c._tag === "Claim"));
        assert.isAtLeast(caught(results, "ClaimLate"), 3);
      }),
    120_000,
  );

  it.effect(
    "a refused channel read deferred and never sent again",
    () =>
      Effect.gen(function* () {
        const forgetful: Core = {
          nextDeadline,
          step: (state, event, now) => {
            const result = step(state, event, now);
            const deadlines = { ...result.state.deadlines, deferred: new Map() };
            return { ...result, state: { ...result.state, deadlines } };
          },
        };
        const results = yield* sweep(forgetful);
        assert.isAtLeast(caught(results, "RefusalDropped"), 3);
      }),
    120_000,
  );

  it.effect(
    "a paced storm of distinct reads",
    () =>
      Effect.gen(function* () {
        // Once the token is valid, sixty current-drop reads at once, each of another channel: no
        // two the same, so only the total in flight shows it. The budget paces them, so none is
        // over Twitch's rate either.
        const storm = plantWith((commands, event) =>
          event._tag === "TokenValid"
            ? [
                ...commands,
                ...Array.from({ length: 60 }, (_, i) =>
                  Command.ReadCurrentDrop({ channelId: `storm-${i}` as ChannelId }),
                ),
              ]
            : commands,
        );
        const results = yield* runSeeds(1, 10, {
          core: storm,
          maxShrinks: 0,
          maxHorizonMinutes: 60,
        });
        assert.isAtLeast(caught(results, "TooManyInFlight"), 8);
      }),
    120_000,
  );
});

/**
 * A core whose planner reads other settings than the config's: the bug of a planner that
 * mishandles one option. The state keeps the real settings, so only the plan sees the change.
 */
const misreads = (f: (goals: ReadonlyArray<DropsGoal>) => ReadonlyArray<DropsGoal>): Core => ({
  nextDeadline,
  step: (state, event, now) => {
    const settings: Settings = { goals: f(state.settings.goals) };
    const result = step({ ...state, settings }, event, now);
    return { ...result, state: { ...result.state, settings: state.settings } };
  },
});

/**
 * The ranking as it was before the review: `least-slack` counted drops whose window had not
 * opened (`futureDrops`, P1-1), and goals went strictly in order whether or not their drops
 * could finish (`blindToDoom`, P1-2). Written here from the old `plan.ts`, to plant it.
 */
const oldRank =
  (bugs: { readonly futureDrops: boolean; readonly blindToDoom: boolean }): Rank =>
  (input) => {
    const keyOf = (goal: DropsGoal, campaign: Pick["campaign"], drops: Pick["drops"]) => {
      if (goal.order === "ending-soonest") return campaign.endsAt;
      const wanted = wantedDrops(goal, campaign, input.progress);
      const ranked = bugs.futureDrops
        ? campaign.drops.filter(
            (d) =>
              wanted.has(d.id) &&
              input.now < d.endsAt &&
              minutesOf(input.progress, d.id) < d.requiredMinutes,
          )
        : drops;
      const slacks = ranked
        .map((d) => slackOf(campaign, d, input.progress, input.now))
        .filter((x) => x >= 0);
      return Math.min(...slacks) - (campaign.id === input.watching ? SLACK_HYSTERESIS : 0);
    };
    const gameRank = (goal: DropsGoal, pick: Pick) =>
      goal.games === "all" ? 0 : goal.games.findIndex((g) => g.id === pick.campaign.game.id);
    return input.settings.goals
      .flatMap((goal, index) =>
        input.campaigns.flatMap((campaign): ReadonlyArray<Pick> => {
          if (!isActive(campaign, input.now)) return [];
          const wanted = wantedDrops(goal, campaign, input.progress);
          const drops = campaign.drops.filter(
            (d) => wanted.has(d.id) && canEarn(d, input.progress, input.now),
          );
          if (drops.length === 0) return [];
          const feasible = drops.some((d) => slackOf(campaign, d, input.progress, input.now) >= 0);
          return [{ goal: index, campaign, drops, feasible, key: keyOf(goal, campaign, drops) }];
        }),
      )
      .toSorted((a, b) => {
        const goal = input.settings.goals[a.goal]!;
        return (
          (bugs.blindToDoom ? 0 : Number(b.feasible) - Number(a.feasible)) ||
          a.goal - b.goal ||
          (a.goal === b.goal ? gameRank(goal, a) - gameRank(goal, b) : 0) ||
          compareNumbers(a.key, b.key) ||
          compareNumbers(a.campaign.endsAt, b.campaign.endsAt) ||
          compareText(a.campaign.id, b.campaign.id)
        );
      });
  };

const listing = (...games: ReadonlyArray<number>): GoalSpec => ({
  ...DEFAULT_GOAL_SPEC,
  games: games.map((game) => ({ game, rewards: null })),
});

/** Two campaigns of games 0 and 1, each with its own live channel, for one half-hour. */
const twoGames = (
  goals: ReadonlyArray<GoalSpec>,
  campaigns: readonly [Scenario["campaigns"][number], Scenario["campaigns"][number]],
): Scenario => ({
  ...base,
  horizonMinutes: 30,
  settings: { goals },
  campaigns: [...campaigns],
  channels: [base.channels[0]!, { ...base.channels[0]!, game: 1, viewers: 20 }],
});

const item = (requiredMinutes: number) =>
  ({ requiredMinutes, after: null, benefit: "DIRECT_ENTITLEMENT" }) as const;
const camp = (
  game: number,
  durationMinutes: number,
  drops: Scenario["campaigns"][number]["drops"],
  linked = true,
): Scenario["campaigns"][number] => ({
  game,
  startMinute: -10,
  durationMinutes,
  linked,
  allowList: [],
  drops,
});

/**
 * A core that never leaves a campaign it watches while that can earn: it plans and discovers like
 * the real one, but drops every switch. (Planting it in the ranking would also hide the better
 * campaign from discovery, so the core would never see it.)
 */
const sticky: Core = {
  nextDeadline,
  step: (state, event, now) => {
    const result = step(state, event, now);
    const [w, next] = [state.watch, result.state.watch];
    if (w._tag !== "Watching" || next._tag !== "Watching" || next.campaignId === w.campaignId) {
      return result;
    }
    return {
      state: { ...result.state, watch: w },
      commands: result.commands.flatMap((c): ReadonlyArray<Command> =>
        c._tag === "Watch" ? [] : c._tag === "WatchTick" ? [{ ...c, channelId: w.channelId }] : [c],
      ),
    };
  },
};

/** Ranks the campaigns that can't finish by their end, latest first. */
const doomLast: Rank = (input) => {
  const all = minable(input);
  const doomed = all
    .filter((p) => !p.feasible)
    .toSorted((a, b) => compareNumbers(b.campaign.endsAt, a.campaign.endsAt));
  return [...all.filter((p) => p.feasible), ...doomed];
};

describe("the twin's goal oracle catches planted planner bugs (WrongPick)", () => {
  const planted: ReadonlyArray<readonly [string, Scenario, Core]> = [
    [
      "goals tried in reverse priority",
      twoGames([listing(0), listing(1)], [camp(0, 600, [item(30)]), camp(1, 600, [item(30)])]),
      misreads((goals) => goals.toReversed()),
    ],
    [
      "least-slack ranked as ending-soonest",
      twoGames(
        [{ ...DEFAULT_GOAL_SPEC, order: "least-slack" }],
        [camp(0, 300, [item(30)]), camp(1, 400, [item(230)])],
      ),
      misreads((goals) => goals.map((g) => ({ ...g, order: "ending-soonest" }))),
    ],
    [
      "excludeGames ignored",
      twoGames(
        [{ ...DEFAULT_GOAL_SPEC, excludeGames: [0] }],
        [camp(0, 300, [item(30)]), camp(1, 600, [item(30)])],
      ),
      misreads((goals) => goals.map((g) => ({ ...g, excludeGames: [] }))),
    ],
    [
      "linkedOnly ignored",
      twoGames([DEFAULT_GOAL_SPEC], [camp(0, 300, [item(30)], false), camp(1, 600, [item(30)])]),
      misreads((goals) => goals.map((g) => ({ ...g, linkedOnly: false }))),
    ],
    [
      "least-slack ranking a drop whose window opens later (P1-1 reverted)",
      // Game 0's watchable drop has a day to spare; its tight drop opens at +110 min. Game 1's
      // campaign ends at +110 min and needs 100.
      twoGames(
        [{ ...DEFAULT_GOAL_SPEC, order: "least-slack" }],
        [
          camp(0, 1440, [
            item(60),
            { ...item(55), window: { startMinute: 120, durationMinutes: 60 } },
          ]),
          camp(1, 120, [item(100)]),
        ],
      ),
      { nextDeadline, step: stepWith(oldRank({ futureDrops: true, blindToDoom: false })) },
    ],
    [
      "a doomed first goal starving the second (P1-2 reverted)",
      // Goal 1's campaign ends in 50 minutes and needs 240; goal 2's needs 30 of 590.
      twoGames([listing(0), listing(1)], [camp(0, 60, [item(240)]), camp(1, 600, [item(30)])]),
      { nextDeadline, step: stepWith(oldRank({ futureDrops: false, blindToDoom: true })) },
    ],
    [
      "least-slack without the switching margin",
      // Game 0 has 190 min to spare, game 1 200: game 0 is watched and keeps its slack while
      // game 1's shrinks a minute a minute, overtaking it after 10 minutes, not 40.
      twoGames(
        [{ ...DEFAULT_GOAL_SPEC, order: "least-slack" }],
        [camp(0, 300, [item(100)]), camp(1, 300, [item(90)])],
      ),
      { nextDeadline, step: stepWith((input) => minable({ ...input, watching: undefined })) },
    ],
    [
      "an excluded channel watched",
      // The goal excludes the busier channel; a planner blind to it watches it anyway.
      {
        ...twoGames(
          [{ ...DEFAULT_GOAL_SPEC, exclude: [0] }],
          [camp(0, 600, [item(30)]), camp(0, 600, [item(30)])],
        ),
        channels: [base.channels[0]!, { ...base.channels[0]!, viewers: 20 }],
      },
      misreads((goals) => goals.map((g) => ({ ...g, excludeChannels: [] }))),
    ],
    [
      "never switching to a better campaign",
      // Game 1's drop opens at +5 min, in a campaign that ends first: ending-soonest moves to it.
      twoGames(
        [DEFAULT_GOAL_SPEC],
        [
          camp(0, 600, [item(30)]),
          camp(1, 200, [{ ...item(30), window: { startMinute: 15, durationMinutes: 100 } }]),
        ],
      ),
      sticky,
    ],
    [
      "campaigns that can't finish ranked latest end first",
      // Neither can finish: the one ending sooner goes first, under least-slack too (an
      // ending-soonest oracle ranked them by end already).
      twoGames(
        [{ ...DEFAULT_GOAL_SPEC, order: "least-slack" }],
        [camp(0, 70, [item(240)]), camp(1, 130, [item(240)])],
      ),
      { nextDeadline, step: stepWith(doomLast) },
    ],
  ];
  for (const [name, scenario, core] of planted) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const caught = yield* runTwice(scenario, { core });
        assert.strictEqual(caught.violation?.kind, "WrongPick", JSON.stringify(caught.violation));
        const real = yield* runTwice(scenario);
        assert.isUndefined(real.violation, JSON.stringify(real.violation));
        assert.isAbove(real.creditedMinutes, 0);
      }),
    );
  }

  it.effect("the old ranking, both bugs at once, on its fixed scenarios", () =>
    Effect.gen(function* () {
      const old: Core = {
        nextDeadline,
        step: stepWith(oldRank({ futureDrops: true, blindToDoom: true })),
      };
      for (const [, scenario] of planted.filter(([name]) => name.includes("reverted"))) {
        assert.strictEqual((yield* runTwice(scenario, { core: old })).violation?.kind, "WrongPick");
      }
    }),
  );
});

/**
 * The 4 h live run of 2026-10-30 (roadmap A6): Witchspire's Logo and Gold Stamp were received the
 * day before and listed only in `gameEventDrops`, which the wire ignored, and Twitch credited the
 * Gold Stamp past its requirement, which kept the stall clock from ever firing. Another campaign
 * on another game was there to mine all along.
 */
describe("rewards already received, and credit the plan can't use (the 4 h live run)", () => {
  const badge = (requiredMinutes: number, received?: "in-window") => ({
    requiredMinutes,
    after: null,
    benefit: "BADGE" as const,
    ...(received === undefined ? {} : { received }),
  });
  const witchspire = (logo: "in-window" | undefined): Scenario => ({
    ...base,
    // Giving up Witchspire after one stall, the other campaign's drop is claimed by +65 min;
    // giving up its two channels one stall each, not before +95.
    horizonMinutes: 80,
    campaigns: [
      {
        game: 0,
        startMinute: -24 * 60,
        durationMinutes: 48 * 60,
        linked: false,
        allowList: [],
        drops: [badge(60, logo), badge(240, "in-window")],
        creditsOnly: 1,
      },
      // Ends after Witchspire, so `ending-soonest` tries Witchspire first.
      {
        game: 1,
        startMinute: -60,
        durationMinutes: 2880,
        linked: true,
        allowList: [],
        drops: [{ requiredMinutes: 30, after: null, benefit: "DIRECT_ENTITLEMENT" }],
      },
    ],
    channels: [
      base.channels[0]!,
      { ...base.channels[0]!, viewers: 20 },
      { ...base.channels[0]!, game: 1, viewers: 5 },
    ],
  });

  /** The wire before this fix: `gameEventDrops` never reached the core. */
  const blindToAwards: Core = {
    nextDeadline,
    step: (state, event, now) =>
      step(state, event._tag === "InventoryRead" ? { ...event, awarded: [] } : event, now),
  };

  /** The stall clock before this fix: any credit of a known drop restarts it. */
  const anyCreditCounts: Core = {
    nextDeadline,
    step: (state, event, now) => {
      const result = step(state, event, now);
      const w = result.state.watch;
      const credit =
        (event._tag === "DropProgress" || event._tag === "CurrentDropRead") &&
        state.catalog?.some((c) => c.drops.some((d) => d.id === event.dropId)) === true;
      if (!credit || w._tag !== "Watching") return result;
      return { ...result, state: { ...result.state, watch: { ...w, confirmedAt: now } } };
    },
  };

  it.effect("the miner skips received rewards and mines the other campaign", () =>
    Effect.gen(function* () {
      for (const logo of ["in-window", undefined] as const) {
        const result = yield* runTwice(witchspire(logo));
        assert.isUndefined(result.violation, String(logo));
        assert.strictEqual(result.claimsApplied, 1, String(logo));
      }
    }),
  );

  it.effect("ignoring gameEventDrops watches for a received Logo: WatchedClaimed", () =>
    Effect.gen(function* () {
      const result = yield* runTwice(witchspire("in-window"), { core: blindToAwards });
      assert.strictEqual(result.violation?.kind, "WatchedClaimed");
    }),
  );

  it.effect("taking any credit as progress holds the channel for good: Unproductive", () =>
    Effect.gen(function* () {
      const result = yield* runTwice(witchspire(undefined), { core: anyCreditCounts });
      assert.include(["Unproductive", "Idle"], result.violation?.kind);
    }),
  );

  /**
   * Seed 150534, shrunk, faults past its horizon dropped. A badge campaign starts unseen and is
   * credited on ch0 for two minutes; its frames can't be filed, so the core learns the second
   * minute from the inventory read at +10.1m, a read late, and confirms its watch then. From +4.4m
   * Twitch credits only an unwanted emote there and never the linked badge the core targets.
   */
  const unplacedCredit: Scenario = {
    latencySeed: 0,
    horizonMinutes: 60,
    inventoryLagMinutes: 1,
    settings: {
      goals: [{ ...DEFAULT_GOAL_SPEC, rewards: ["item", "badge"] }],
    },
    campaigns: [
      {
        game: 0,
        startMinute: -23,
        durationMinutes: 1100,
        linked: true,
        allowList: [],
        drops: [{ requiredMinutes: 1, after: null, benefit: "BADGE" }],
      },
      {
        game: 0,
        startMinute: 1,
        durationMinutes: 30,
        linked: false,
        creditsUnlinked: false,
        allowList: [],
        drops: [
          {
            requiredMinutes: 2,
            after: null,
            benefit: "BADGE",
            window: { startMinute: 2, durationMinutes: 30 },
          },
          { requiredMinutes: 1, after: null, benefit: "BADGE" },
        ],
      },
      {
        game: 0,
        startMinute: 0,
        durationMinutes: 1306,
        linked: false,
        creditsUnlinked: false,
        allowList: [5, 6],
        drops: [
          { requiredMinutes: 77, after: 2, benefit: "EMOTE" },
          { requiredMinutes: 4, after: 0, benefit: "DIRECT_ENTITLEMENT" },
        ],
      },
    ],
    channels: [
      {
        game: 0,
        viewers: 6310,
        dropsEnabled: true,
        refuses: false,
        liveAtStart: true,
        changes: [],
      },
      {
        game: 2,
        viewers: 5625,
        dropsEnabled: true,
        refuses: false,
        liveAtStart: true,
        changes: [{ atMinute: 0, to: "game-1" }],
      },
    ],
    faults: [],
  };

  it.effect("a credit first heard through the inventory restarts the stall clock there", () =>
    Effect.gen(function* () {
      const result = yield* runTwice(unplacedCredit);
      assert.isUndefined(result.violation, JSON.stringify(result.violation));
      // The emote credited every minute still must not hold the channel.
      const old = yield* runTwice(unplacedCredit, { core: anyCreditCounts });
      assert.strictEqual(old.violation?.kind, "Unproductive");
    }),
  );

  it.effect(
    "both at once, the miner of the live run, on random worlds with these quirks",
    () =>
      Effect.gen(function* () {
        const old: Core = {
          nextDeadline,
          step: (state, event, now) =>
            anyCreditCounts.step(
              state,
              event._tag === "InventoryRead" ? { ...event, awarded: [] } : event,
              now,
            ),
        };
        // The live run's Twitch stayed on its drop: worlds where it moves on spare the old miner.
        const quirky = scenarioArbitrary.filter(
          (s) =>
            s.campaigns.some(
              (c) => c.creditsOnly !== undefined || c.drops.some((d) => d.received),
            ) && s.campaigns.every((c) => c.creditsMoveOn !== true),
        );
        // The first seed whose world it fails in. Not every world tempts it: of 100 sampled, it
        // failed 32 of A6's and 28 of the calibrated generator's, and seeds 1–10 pass it now.
        let failed: Array<string> = [];
        for (let seed = 1; seed <= 15 && failed.length === 0; seed++) {
          const result = yield* runProperty(quirky, seed, {
            core: old,
            maxShrinks: 30,
            maxHorizonMinutes: 240,
          });
          if (result._tag === "Failed") failed = [result.capsule.violation.kind];
        }
        assert.lengthOf(failed, 1);
        assert.include(["WatchedClaimed", "Unproductive", "Idle"], failed[0]);
      }),
    120_000,
  );
});

/**
 * Twitch credits one drop of a campaign, a drop the goal filters out (review of A6, P1-1): it
 * earns alongside the wanted one, or moves on to it once complete, so the watch is no stall.
 */
describe("credit to a drop the goal filters out", () => {
  const filtered = (moveOn: boolean): Scenario => ({
    ...base,
    horizonMinutes: 180,
    settings: { goals: [{ ...DEFAULT_GOAL_SPEC, rewards: ["item"] }] },
    campaigns: [
      {
        game: 0,
        startMinute: -10,
        durationMinutes: 600,
        linked: true,
        allowList: [],
        drops: [
          { requiredMinutes: 40, after: null, benefit: "BADGE" },
          { requiredMinutes: 30, after: null, benefit: "DIRECT_ENTITLEMENT" },
        ],
        creditsOnly: 0,
        ...(moveOn ? { creditsMoveOn: true } : {}),
      },
    ],
  });

  it.effect("keeps the watch while the badge earns, and earns the item once Twitch moves on", () =>
    Effect.gen(function* () {
      const result = yield* runTwice(filtered(true));
      assert.isUndefined(result.violation, JSON.stringify(result.violation));
      // The badge, then the item.
      assert.strictEqual(result.claimsApplied, 2);
    }),
  );

  it.effect("skips the campaign for a while when Twitch stays on the badge past its end", () =>
    Effect.gen(function* () {
      // Skipped after a stall past the badge's 40 min, tried again an hour later and given up at
      // once: the invariants hold the skip to `CAMPAIGN_SKIP` and the watch to a stall.
      const result = yield* runTwice(filtered(false));
      assert.isUndefined(result.violation, JSON.stringify(result.violation));
      assert.strictEqual(result.claimsApplied, 1);
    }),
  );
});

/**
 * A reward another campaign gave inside a drop's window, sharing the benefit id (review of A6,
 * P2-2). TDM's rule takes the drop as received; the account reads nothing that says otherwise, so
 * the miner skips it and logs it once (`receivedLines`). Pinned: a change that mines it fails here.
 */
describe("a reward an overlapping campaign gave", () => {
  it.effect("counts the drop as received: the miner doesn't mine it", () =>
    Effect.gen(function* () {
      const scenario: Scenario = {
        ...base,
        campaigns: [
          {
            ...base.campaigns[0]!,
            drops: [
              { requiredMinutes: 10, after: null, benefit: "BADGE", received: "overlapping" },
            ],
          },
        ],
      };
      const result = yield* runTwice(scenario);
      assert.isUndefined(result.violation, JSON.stringify(result.violation));
      assert.strictEqual(result.creditedMinutes, 0);
      // Without the shared reward it is mined.
      const plain = { requiredMinutes: 10, after: null, benefit: "BADGE" } as const;
      const mined = yield* runTwice({
        ...scenario,
        campaigns: [{ ...scenario.campaigns[0]!, drops: [plain] }],
      });
      assert.strictEqual(mined.claimsApplied, 1);
    }),
  );
});

/** The twin calibrated on the 2026-10-30 recordings, end to end (research 04 §2b). */
describe("calibrated twin", () => {
  const measured: Scenario = {
    ...base,
    inventoryLagMinutes: 0,
    frameGaps: FRAME_GAPS,
    claimedFlagLagSeconds: 59,
  };

  it.effect("claims within a second of the completing frame, as live (0.60–0.88 s)", () =>
    Effect.gen(function* () {
      const result = yield* runTwice({ ...measured, horizonMinutes: 12 });
      assert.isUndefined(result.violation);
      // Trace lines are canonical JSON; the twin's are `<ms> twin <compact JSON>` (`compact`),
      // whose first element lists requests as [operation, status, ms since SIM_EPOCH, duration].
      const lines = result.tail
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as TraceLine);
      const done = lines.find(
        (l) =>
          l.kind === "step" && l.data.event?._tag === "DropProgress" && l.data.event.minutes === 10,
      );
      const claimAt = result.tail
        .filter((l) => !l.startsWith("{"))
        .flatMap((l) => {
          const [requests] = JSON.parse(l.slice(l.indexOf(" twin ") + 6)) as [
            ReadonlyArray<readonly [string, unknown, number, number]>,
          ];
          return requests;
        })
        .find(([operation]) => operation === "ClaimDrop")?.[2];
      assert.isDefined(done);
      assert.isDefined(claimAt);
      // The simulator looks at work in flight once a second (`POLL`), so the inventory read the
      // frame asked for lands, and the claim goes out, a second after the frame at most.
      const after = claimAt! - done!.at;
      assert.isAbove(after, 0);
      assert.isAtMost(after, CLAIM_AFTER_FRAME_MAX);
    }),
  );

  it.effect("mines a hidden campaign's channel without a violation, and claims both drops", () =>
    Effect.gen(function* () {
      const hidden = {
        ...base.campaigns[0]!,
        startMinute: -60,
        drops: [{ requiredMinutes: 200, after: null, benefit: "DIRECT_ENTITLEMENT" as const }],
        hidden: true,
      };
      const result = yield* runTwice({ ...measured, campaigns: [...base.campaigns, hidden] });
      assert.isUndefined(result.violation);
      assert.strictEqual(result.claimsApplied, 2);
      // It moved in step with the listed campaign, a minute for each of its 40.
      const end = SIM_EPOCH + measured.horizonMinutes * MINUTE;
      assert.strictEqual(minutesAt(result.world, "c1-d0" as DropId, end), 40);
    }),
  );

  it.effect("a campaign claimed in full before the run: left for the one that earns", () =>
    Effect.gen(function* () {
      // Witchspire, run4h: its badges were claimed the day before, so no inventory lists it and
      // the session counter read 263 of 240. The core watched it for 2 hours; it now reads
      // `gameEventDrops` and counts no credit past a requirement (A6), so it mines the other.
      const spent = {
        ...base.campaigns[0]!,
        // Started long enough before the run for both drops to be earned and claimed.
        startMinute: -600,
        durationMinutes: 900,
        linked: false,
        drops: [
          { requiredMinutes: 60, after: null, benefit: "BADGE" as const },
          { requiredMinutes: 240, after: null, benefit: "BADGE" as const },
        ],
        claimedBefore: 2,
      };
      const other = { ...base.campaigns[0]!, game: 1 };
      const result = yield* runTwice({
        ...measured,
        campaigns: [spent, other],
        channels: [base.channels[0]!, { ...base.channels[0]!, game: 1, viewers: 10 }],
      });
      assert.isUndefined(result.violation, JSON.stringify(result.violation));
      // Both drops of the other campaign, none of the spent one.
      assert.strictEqual(result.claimsApplied, 2);
    }),
  );

  it.effect("a wanted drop credited without frames: the channel kept while it earns", () =>
    Effect.gen(function* () {
      // Twitch frames one drop per campaign, the closest to done (run4h). The newer campaign
      // credits an unwanted badge (framed, 40 minutes) and the wanted emote beside it (silent,
      // 50 minutes); only the inventory shows the emote move. The core used to adopt or confirm
      // a drop only from frames and the session read, stall on the item it targeted and give
      // up the channel while the emote earned (sweep seed 161). Inventory rises are credits.
      const goal = { ...DEFAULT_GOAL_SPEC, rewards: ["item", "emote"] as const };
      const result = yield* runTwice({
        ...measured,
        frameGaps: [1],
        horizonMinutes: 45,
        settings: { goals: [{ ...goal, rewards: [...goal.rewards] }] },
        campaigns: [
          {
            ...base.campaigns[0]!,
            startMinute: -60,
            durationMinutes: 300,
            drops: [{ requiredMinutes: 60, after: null, benefit: "DIRECT_ENTITLEMENT" }],
          },
          {
            ...base.campaigns[0]!,
            startMinute: -10,
            durationMinutes: 2000,
            drops: [
              { requiredMinutes: 50, after: null, benefit: "EMOTE" },
              { requiredMinutes: 40, after: null, benefit: "BADGE" },
            ],
          },
        ],
        channels: [base.channels[0]!],
      });
      assert.isUndefined(result.violation, JSON.stringify(result.violation));
    }),
  );

  /**
   * What the calibrated twin still finds in the core, kept out of the sweep (`scenario.ts`) until
   * the core is fixed. The test pins the failure; when a fix lands it fails, and the bound goes.
   */
  describe("core gaps (known, research 04 §2b)", () => {
    it.effect("a claimed flag later than CLAIM_RECHECK: a lost answer's claim is sent again", () =>
      Effect.gen(function* () {
        // Measured: the flag (and `gameEventDrops`) shows within 5 minutes; the core rechecks
        // after 1.
        const result = yield* runTwice({
          ...measured,
          claimedFlagLagSeconds: 120,
          faults: [{ kind: "lose-claim-answer", atMinute: 0 }],
        });
        assert.include(["ClaimedTwice", "MutationRetried"], result.violation?.kind);
      }),
    );
  });
});

describe("capsules", () => {
  it.effect("replay to the digest of the failure that produced them", () =>
    Effect.gen(function* () {
      const twice = plant(claimTwice);
      const result = yield* runProperty(withBase, 2, {
        core: twice,
        maxShrinks: 10,
        maxHorizonMinutes: 120,
      });
      assert.strictEqual(result._tag, "Failed");
      if (result._tag !== "Failed") return;
      const decoded = yield* Schema.decodeUnknownEffect(Capsule)(
        JSON.parse(JSON.stringify(result.capsule)),
      );
      const replayed = yield* runTwice(decoded.scenario, { core: twice });
      assert.strictEqual(replayed.digest, result.capsule.digest);
      assert.deepStrictEqual(replayed.violation, result.capsule.violation);
    }),
  );
});
