import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect, Exit, FileSystem, Option } from "effect";
import { Command } from "effect/cli";
import { TestConsole } from "effect/testing";
import type { Command as CoreCommand } from "../core/protocol.ts";
import { nextDeadline } from "../core/state.ts";
import { step } from "../core/step.ts";
import type { Capsule, Scenario } from "../twin/scenario.ts";
import { runTwice, type Core } from "../twin/sim.ts";
import { miner } from "./miner.ts";
import { simulate } from "./sim.ts";

/** One linked campaign with a 10-minute drop on one live channel: the miner claims within the hour. */
const scenario: Scenario = {
  latencySeed: 3,
  horizonMinutes: 60,
  inventoryLagMinutes: 0,
  settings: { games: [], exclude: [], badgesAndEmotes: true },
  campaigns: [
    {
      game: 0,
      startMinute: -10,
      durationMinutes: 600,
      linked: true,
      allowList: [],
      drops: [{ requiredMinutes: 10, after: null, benefit: "DIRECT_ENTITLEMENT" }],
    },
  ],
  channels: [
    { game: 0, viewers: 100, dropsEnabled: true, refuses: false, liveAtStart: true, changes: [] },
  ],
  faults: [],
};

/** A planted bug: every claim is sent twice. */
const claimTwice: Core = {
  nextDeadline,
  step: (state, event, now) => {
    const result = step(state, event, now);
    const commands = result.commands.flatMap((c): ReadonlyArray<CoreCommand> =>
      c._tag === "Claim" ? [c, c] : [c],
    );
    return { ...result, commands };
  },
};

const output = TestConsole.logLines.pipe(Effect.map((lines) => lines.join("\n")));

const inTemp = <A, E>(
  use: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem | TestConsole.TestConsole>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* use(yield* fs.makeTempDirectoryScoped());
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, TestConsole.layer]));

const writeCapsule = (dir: string, capsule: Capsule) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${dir}/capsule.json`;
    yield* fs.writeFileString(path, JSON.stringify(capsule));
    return path;
  });

const trace = (path: string, json = false) => ({
  seed: 1,
  seeds: 1,
  trace: Option.some(path),
  json,
});

describe("miner sim", () => {
  it.effect("runs a range of seeds and prints the summary", () =>
    Effect.gen(function* () {
      yield* Command.runWith(miner, { version: "0" })(["sim", "--seed", "1", "--seeds", "2"]);
      assert.include(
        yield* output,
        "2 seeds, 2 passed, 0 failed; 2 earned watch minutes, 2 claimed a drop",
      );
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer])),
  );

  it.effect("takes the seed count from MINER_SIM_SEEDS", () =>
    Effect.gen(function* () {
      yield* Command.runWith(miner, { version: "0" })(["sim"]);
      assert.include(yield* output, "1 seeds, 1 passed, 0 failed");
    }).pipe(
      Effect.provide([
        NodeServices.layer,
        TestConsole.layer,
        ConfigProvider.layer(ConfigProvider.fromEnvRecord({ MINER_SIM_SEEDS: "1" })),
      ]),
    ),
  );

  it.effect("prints one JSON document with --json", () =>
    Effect.gen(function* () {
      yield* Command.runWith(miner, { version: "0" })(["sim", "--seeds", "1", "--json"]);
      const document = JSON.parse(yield* output);
      assert.deepStrictEqual(document, {
        ok: true,
        seeds: { first: 1, count: 1 },
        passed: 1,
        watched: 1,
        claimed: 1,
        failures: [],
      });
    }).pipe(Effect.provide([NodeServices.layer, TestConsole.layer])),
  );

  it.effect("replays a capsule whose violation is gone and says the digest matches", () =>
    inTemp((dir) =>
      Effect.gen(function* () {
        const run = yield* runTwice(scenario);
        assert.isUndefined(run.violation);
        const violation = { kind: "Idle", at: 1, detail: "fixed since" };
        const path = yield* writeCapsule(dir, {
          seed: null,
          scenario,
          violation,
          digest: run.digest,
          tail: [],
        });
        yield* simulate(trace(path));
        const text = yield* output;
        assert.include(text, "digest matches the capsule");
        assert.include(text, "no violation");
      }),
    ),
  );

  it.effect("fails with SimFailed while the capsule still fails", () =>
    inTemp((dir) =>
      Effect.gen(function* () {
        const run = yield* runTwice(scenario, { core: claimTwice });
        assert.isDefined(run.violation);
        const path = yield* writeCapsule(dir, {
          seed: null,
          scenario,
          violation: run.violation!,
          digest: run.digest,
          tail: run.tail,
        });
        const exit = yield* Effect.exit(simulate(trace(path, true), { core: claimTwice }));
        assert.isTrue(Exit.isFailure(exit));
        assert.include(JSON.stringify(exit), "SimFailed");
        const document = JSON.parse(yield* output);
        assert.isFalse(document.ok);
        assert.isTrue(document.digestMatches);
        assert.strictEqual(document.violation.kind, run.violation!.kind);
      }),
    ),
  );

  it.effect("fails with SimTraceInvalid on a file that isn't a capsule", () =>
    inTemp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${dir}/bad.json`, '{"seed": "x"}');
        const bad = yield* Effect.exit(simulate(trace(`${dir}/bad.json`)));
        const missing = yield* Effect.exit(simulate(trace(`${dir}/missing.json`)));
        for (const exit of [bad, missing]) {
          assert.isTrue(Exit.isFailure(exit));
          assert.include(JSON.stringify(exit), "SimTraceInvalid");
        }
        assert.include(yield* output, "bad.json: not a capsule");
      }),
    ),
  );
});
