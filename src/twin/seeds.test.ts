import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { runSeed, type SeedResult } from "./sim.ts";

const kindOf = (result: SeedResult) =>
  result._tag === "Failed" ? result.capsule.violation.kind : "passed";

// Each seed runs the miner's real wire code against the twin; the sweeps sit in files of their
// own (`sweep-*.test.ts`), so the test runner spreads them over cores.
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
    120_000,
  );
});
