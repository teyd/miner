import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { TestConsole } from "effect/testing";
import { miner } from "./miner.ts";

describe("miner", () => {
  it.effect("prints its version", () =>
    Effect.gen(function* () {
      yield* Command.runWith(miner, { version: "1.2.3" })(["--version"]);
      const lines = yield* TestConsole.logLines;
      assert.include(lines.join("\n"), "1.2.3");
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer])),
  );
});
