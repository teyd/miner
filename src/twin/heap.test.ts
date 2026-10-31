import { assert, describe, it } from "@effect/vitest";
import { Console, Effect, Schema } from "effect";
import { HttpClient } from "effect/http";
import { sample } from "../platform/memory.ts";
import {
  DAY_MINUTES,
  HEAP_LIMITS,
  overLimits,
  runHeapWeek,
  WEEK_MINUTES,
  weekScenario,
} from "./heap.ts";
import { Scenario } from "./scenario.ts";

const MB = 1_000_000;

describe("a simulated week", () => {
  it("is a scenario a capsule can hold", () => {
    assert.doesNotThrow(() => Schema.decodeSync(Scenario)(weekScenario()));
  });

  // `it.live`: the scenario brings its own `TestClock`, and the figures reach the real console.
  it.live(
    "keeps the heap flat while it mines, reconnects and restarts",
    () =>
      Effect.gen(function* () {
        const run = yield* runHeapWeek(sample);
        assert.isUndefined(run.result.violation);
        // It did a week's work: most of the twelve drops claimed, the crash on day 3 survived.
        assert.isAtLeast(run.result.claimsApplied, 9);
        assert.strictEqual(run.result.restarts, 1);
        assert.strictEqual(run.samples.at(-1)?.minute, WEEK_MINUTES);
        const series = (key: "heapUsed" | "rss") =>
          run.samples.map((s) => (s.memory[key] / MB).toFixed(1)).join(" ");
        const report =
          `a simulated week, every 6 h after a forced collection: heap used MB ${series("heapUsed")}; ` +
          `rss MB ${series("rss")}; growth after day 1 ${(run.growthBytes / MB).toFixed(2)} MB ` +
          `(limit ${HEAP_LIMITS.growthBytes / MB} MB)`;
        yield* Console.log(report);
        assert.isUndefined(overLimits(run), report);
      }),
    { timeout: 600_000 },
  );

  it.effect(
    "catches a leak of 1 KB a request",
    () =>
      Effect.gen(function* () {
        const kept: Array<ReadonlyArray<number>> = [];
        const leak = (client: HttpClient.HttpClient) =>
          HttpClient.mapRequest(client, (request) => {
            kept.push(Array.from({ length: 128 }, () => kept.length));
            return request;
          });
        const run = yield* runHeapWeek(sample, {
          horizonMinutes: 2 * DAY_MINUTES,
          plant: { http: leak },
        });
        assert.isAbove(
          run.growthBytes,
          HEAP_LIMITS.growthBytes,
          `${kept.length} kept, ${run.samples.map((s) => s.minute + ":" + s.memory.heapUsed).join(" ")}`,
        );
        assert.isAbove(kept.length, 0);
      }),
    { timeout: 120_000 },
  );
});
