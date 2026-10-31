import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { sample } from "./memory.ts";

describe("sample", () => {
  it.effect("collects garbage first, without node --expose-gc", () =>
    Effect.gen(function* () {
      let garbage: Array<ReadonlyArray<number>> | undefined = Array.from(
        { length: 4_000 },
        (_, i) => Array.from({ length: 1_000 }, () => i),
      );
      const holding = yield* sample;
      assert.isAbove(garbage.length, 0);
      garbage = undefined;
      const after = yield* sample;
      // 4 million small integers are 32 MB of elements.
      assert.isAbove(holding.heapUsed - after.heapUsed, 25_000_000);
      assert.isAbove(after.rss, after.heapUsed);
      assert.isAtLeast(after.heapTotal, after.heapUsed);
    }),
  );
});
