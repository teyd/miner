import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, FileSystem } from "effect";
import { Command } from "effect/cli";
import { TestConsole } from "effect/testing";
import { nodeGzip } from "../platform/Gzip.ts";
import inventory from "../twitch/fixtures/inventory.json" with { type: "json" };
import { compact, parseRecording, seal, type Entry } from "../twitch/journal.ts";
import { miner } from "./miner.ts";

const answer = (at: number, body: unknown): Entry => ({
  kind: "answer",
  at,
  operation: "Inventory",
  variables: {},
  status: 200,
  body,
});

/** Two reads of the inventory fixture as the recorder writes them: the second one a reference. */
const recording = () => {
  const whole = seal(answer(1, inventory.body), [], 1e6);
  const { parts } = compact(inventory.body, () => false);
  const again = compact(inventory.body, (id) => parts.includes(id));
  const second = JSON.stringify({ ...answer(2, again.body), refs: again.refs });
  return { lines: [whole, second], expected: [whole, seal(answer(2, inventory.body), [], 1e6)] };
};

const cat = (contents: Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const path = `${dir}/2026-10-30.jsonl.gz`;
    yield* fs.writeFile(path, contents);
    const exit = yield* Effect.exit(
      Command.runWith(miner, { version: "0" })(["journal", "cat", path]),
    );
    return { exit, lines: (yield* TestConsole.logLines) as ReadonlyArray<string> };
  }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer]));

describe("miner journal cat", () => {
  it.effect("prints a gzip recording with every answer whole", () =>
    Effect.gen(function* () {
      const { lines, expected } = recording();
      const gz = nodeGzip.gzip(new TextEncoder().encode(lines.map((l) => `${l}\n`).join("")));
      const out = yield* cat(gz);
      assert.isTrue(Exit.isSuccess(out.exit));
      assert.deepStrictEqual(
        parseRecording(out.lines.join("\n")),
        parseRecording(expected.join("\n")),
      );
      assert.include(lines[1], `"$same"`);
    }),
  );

  it.effect("reads a plain one too, and fails on a reference it can't resolve", () =>
    Effect.gen(function* () {
      const { lines } = recording();
      const out = yield* cat(new TextEncoder().encode(`${lines[1]}\n`));
      assert.isTrue(Exit.isFailure(out.exit));
      assert.include(JSON.stringify(out.exit), "JournalUnreadable");
      assert.include(out.lines.join("\n"), `"$same"`);
    }),
  );

  it.effect("fails on a gzip file none of whose members inflate", () =>
    Effect.gen(function* () {
      const gz = nodeGzip.gzip(new TextEncoder().encode('{"kind":"answer"}\n'));
      const broken = gz.slice(0, 10).fill(0, 10); // a gzip header with nothing behind it
      const out = yield* cat(new Uint8Array([...broken, 0xff, 0xff, 0xff]));
      assert.isTrue(Exit.isFailure(out.exit));
      assert.include(JSON.stringify(out.exit), "no gzip member could be inflated");
    }),
  );
});
