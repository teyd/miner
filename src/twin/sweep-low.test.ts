import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { runSeeds } from "./sim.ts";

// Generated worlds always hold an opportunity (scenario.ts); faults, newer campaigns and schedule
// changes may still block it. On the calibrated, budgeted twin (2026-10-31) seeds 1-100 claim in
// 75 worlds with the typed actuator (40 in 1-50, 35 in 51-100) and 74 over the wire (39 and 35:
// seed 43's segment timeouts block it, seed 33 doesn't finish a drop in 2 h, seed 8 now claims),
// 96 watching either way. Half of the sweep per file, so the test runner spreads them over cores.
describe("the default sweep, first half", () => {
  it.effect(
    "watches and claims in at least 37 of seeds 1-50 with 2 h horizons",
    () =>
      Effect.gen(function* () {
        const results = yield* runSeeds(1, 50, { maxHorizonMinutes: 120 });
        assert.deepStrictEqual(
          results.flatMap((r) => (r._tag === "Failed" ? [r.capsule] : [])),
          [],
        );
        const earned = results.filter(
          (r) => r._tag === "Passed" && r.creditedMinutes > 0 && r.claimsApplied > 0,
        );
        assert.isAtLeast(earned.length, 37);
      }),
    120_000,
  );
});
