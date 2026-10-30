import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { TestConsole } from "effect/testing";
import { miner } from "./miner.ts";

const cli = Command.runWith(miner, { version: "0.0.0" });

describe("run", () => {
  it.effect("refuses to run without --shadow: nothing can watch or claim yet", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(cli(["run"]));
      assert.strictEqual(error._tag, "RunRefused");
      assert.include((yield* TestConsole.logLines).join("\n"), "needs --shadow");
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer])),
  );

  it.effect("documents --shadow", () =>
    Effect.gen(function* () {
      yield* cli(["run", "--shadow", "--help"]);
      const help = (yield* TestConsole.logLines).join("\n");
      assert.include(help, "--shadow");
      assert.include(help, "never sent");
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer])),
  );
});
