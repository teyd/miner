import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { LEAN_V8_FLAGS, sample } from "./memory.ts";

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

describe("LEAN_V8_FLAGS", () => {
  it("are flags this V8 knows", () => {
    // Set at run time, an unknown flag would do nothing, silently: a Node upgrade must not drop one.
    const known = execFileSync(process.execPath, ["--v8-options"], { encoding: "utf8" });
    for (const flag of LEAN_V8_FLAGS) {
      assert.include(known, `  --${flag.replace(/^--(no-)?/, "")} (`, flag);
    }
  });

  it("are on node's command line where the image and the unit start the miner", () => {
    const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const entrypoint = /^ENTRYPOINT (.*)$/m.exec(read("Dockerfile"))?.[1] ?? "";
    const service = read("deploy/miner.service");
    const execStart = /^ExecStart=(.*)$/m.exec(service)?.[1] ?? "";
    for (const flag of LEAN_V8_FLAGS) {
      assert.include(entrypoint, `"${flag}"`);
      assert.include(execStart, ` ${flag} `);
    }
    assert.match(service, /^Environment=MALLOC_MMAP_THRESHOLD_=16384$/m);
  });
});
