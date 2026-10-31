import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Config } from "../config/schema.ts";
import { nodeGzip } from "../platform/Gzip.ts";
import { parseStatus } from "../status/snapshot.ts";
import { expandRecording, parseRecording } from "../twitch/journal.ts";
import { runSeed } from "./sim.ts";
import { runTwice } from "./sim.ts";
import { scenarioOfSeed, shadowOverTwin } from "./shadow.ts";
import { TWIN_TOKEN } from "./twin.ts";

const config = Schema.decodeSync(Config)({ priorities: [{ type: "drops", games: "all" }] });
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("shadowOverTwin", () => {
  it.effect(
    "writes the files of a shadow run: state, status, recordings and logs, without the token",
    () =>
      Effect.gen(function* () {
        const result = yield* shadowOverTwin(scenarioOfSeed(3), config, 30);
        assert.isUndefined(result.stopped);
        const names = [...result.files.keys()];
        assert.include(names, "state.shadow.json");
        assert.include(names, "status.json");
        assert.include(names, "logs/miner.log");
        const read = parseStatus(text(result.files.get("status.json")));
        assert.strictEqual(read._tag, "Read");
        if (read._tag === "Read") {
          assert.strictEqual(read.status.miner.mode, "shadow");
          assert.isNotNull(read.status.stoppedAt);
        }
        const recordings = names.filter((n) => n.startsWith("recordings/"));
        assert.isAtLeast(recordings.length, 1);
        for (const name of recordings) {
          const expanded = expandRecording(
            parseRecording(text(nodeGzip.gunzip(result.files.get(name)!))),
          );
          assert.isAbove(expanded.entries.length, 0);
          assert.deepStrictEqual(expanded.missing, []);
        }
        for (const [name, bytes] of result.files) {
          const plain = name.endsWith(".gz") ? nodeGzip.gunzip(bytes) : bytes;
          assert.notInclude(text(plain), TWIN_TOKEN, name);
        }
      }),
    60_000,
  );

  it.effect(
    "writes the same bytes for the same scenario",
    () =>
      Effect.gen(function* () {
        const a = yield* shadowOverTwin(scenarioOfSeed(5), config, 10);
        const b = yield* shadowOverTwin(scenarioOfSeed(5), config, 10);
        assert.deepStrictEqual([...a.files.keys()], [...b.files.keys()]);
        for (const [name, bytes] of a.files) assert.deepStrictEqual(bytes, b.files.get(name), name);
      }),
    60_000,
  );

  it.effect(
    "takes seed N's world from the scenario `miner sim --seed N` runs",
    () =>
      Effect.gen(function* () {
        const seeded = yield* runSeed(4);
        const sampled = yield* runTwice(scenarioOfSeed(4));
        assert.strictEqual(seeded._tag, "Passed");
        if (seeded._tag === "Passed") assert.strictEqual(sampled.digest, seeded.digest);
      }),
    60_000,
  );
});
