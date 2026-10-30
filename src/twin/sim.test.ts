import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Command } from "../core/protocol.ts";
import { nextDeadline } from "../core/state.ts";
import { step } from "../core/step.ts";
import {
  Capsule,
  DEFAULT_GOAL_SPEC,
  scenarioArbitrary,
  type Fault,
  type Scenario,
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

const claimTwice = (commands: ReadonlyArray<Command>) =>
  commands.flatMap((c): ReadonlyArray<Command> => (c._tag === "Claim" ? [c, c] : [c]));

/** Random worlds that always hold the base campaign and its busy channel, so claims happen. */
const withBase = scenarioArbitrary.map((s): Scenario => ({
  ...s,
  settings: base.settings,
  campaigns: [base.campaigns[0]!, ...s.campaigns],
  channels: [base.channels[0]!, ...s.channels],
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

  it.effect("park on a revoked token and poll nothing afterwards", () =>
    Effect.gen(function* () {
      const result = yield* runScenario(withFaults({ kind: "revoke-token", atMinute: 15 }));
      assert.isUndefined(result.violation);
      const after = result.tail.filter((line) => line.includes('"kind":"step"')).at(-1) ?? "";
      assert.include(after, '"reason":"needs-login"');
    }),
  );
});

describe("seeds", () => {
  it.effect(
    "seeds 1-20 pass with 6 h horizons, and replay to the same digest",
    () =>
      Effect.gen(function* () {
        for (let seed = 1; seed <= 20; seed++) {
          const first = yield* runSeed(seed, { maxHorizonMinutes: 360 });
          assert.strictEqual(kindOf(first), "passed", `seed ${seed}`);
          const again = yield* runSeed(seed, { maxHorizonMinutes: 360 });
          assert.deepStrictEqual(again, first);
        }
      }),
    60_000,
  );
});

describe("the default sweep", () => {
  // Generated worlds always hold an opportunity (scenario.ts); faults, newer campaigns and
  // schedule changes may still block it. Seeds 1-100 measured 99 watching and 86 claiming.
  it.effect(
    "watches and claims in at least 75 of seeds 1-100 with 2 h horizons",
    () =>
      Effect.gen(function* () {
        const results = yield* runSeeds(1, 100, { maxHorizonMinutes: 120 });
        assert.deepStrictEqual(
          results.map(kindOf),
          results.map(() => "passed"),
        );
        const earned = results.filter(
          (r) => r._tag === "Passed" && r.creditedMinutes > 0 && r.claimsApplied > 0,
        );
        assert.isAtLeast(earned.length, 75);
      }),
    120_000,
  );
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
