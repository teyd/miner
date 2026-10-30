import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { TestConsole } from "effect/testing";
import { miner } from "./miner.ts";

const cli = Command.runWith(miner, { version: "0.0.0" });

describe("run", () => {
  it.effect("documents --shadow", () =>
    Effect.gen(function* () {
      yield* cli(["run", "--shadow", "--help"]);
      const help = (yield* TestConsole.logLines).join("\n");
      assert.include(help, "--shadow");
      assert.include(help, "never sent");
      assert.include(help, "state.json");
      assert.include(help, "One miner per data directory");
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer])),
  );
});
