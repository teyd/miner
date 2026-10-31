import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Schema } from "effect";
import { Command } from "effect/cli";
import { TestClock, TestConsole } from "effect/testing";
import committed from "../../schema/status.v1.json" with { type: "json" };
import { campaign, channel, chid, did, progress, settings, T0 } from "../core/fixtures.ts";
import { initial, type State } from "../core/state.ts";
import { STATUS_FILE } from "../runtime/status.ts";
import { encodeStatusFile, StatusReport, type StatusFile } from "../status/schema.ts";
import { snapshot, startFacts } from "../status/snapshot.ts";
import { miner } from "./miner.ts";

const cli = Command.runWith(miner, { version: "0.0.0" });
const output = TestConsole.logLines.pipe(Effect.map((lines) => lines.join("\n")));
const decodeReport = Schema.decodeUnknownSync(StatusReport);

const c1 = campaign("c1");
const state: State = {
  ...initial(settings()),
  auth: "valid",
  catalog: [c1],
  catalogStatus: "ok",
  progress: new Map([[did("c1-d1"), progress(c1, "c1-d1", { minutes: 12 })]]),
  channels: new Map([[chid("ch1"), channel("ch1")]]),
  watch: {
    _tag: "Watching",
    channelId: chid("ch1"),
    campaignId: c1.id,
    dropId: did("c1-d1"),
    credited: true,
    confirmedAt: T0,
    confirmedMinutes: 12,
    estimatedMinutes: 12,
    lastCurrentDropRead: undefined,
    wasted: undefined,
  },
};

const file = (patch: Partial<StatusFile> = {}): StatusFile => ({
  ...snapshot({
    state,
    facts: startFacts(T0 - 3_600_000),
    meta: { version: "1.0.0", pid: 99, mode: "live" },
    sockets: { connections: 1, listening: 1, topics: 5, dropped: 0 },
    now: T0,
  }),
  ...patch,
});

/** Runs `miner status <args>` on a data directory holding `status` (or none), at `T0 + 10 s`. */
const status = (args: ReadonlyArray<string>, written: StatusFile | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    if (written !== undefined) {
      yield* fs.writeFileString(`${dir}/${STATUS_FILE}`, JSON.stringify(encodeStatusFile(written)));
    }
    yield* TestClock.setTime(T0 + 10_000);
    const exit = yield* cli(["status", ...args]).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ DATA_DIR: dir }))),
      Effect.exit,
    );
    const code = Exit.isSuccess(exit)
      ? 0
      : Exit.findErrorOption(exit).pipe((e) =>
          e._tag === "Some" && e.value._tag === "StatusUnhealthy" ? e.value.exitCode : -1,
        );
    return { code, out: yield* output };
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer)));

describe("miner status", () => {
  it.effect("summarises a healthy miner for a person, exit 0", () =>
    Effect.gen(function* () {
      const { code, out } = yield* status([], file());
      assert.strictEqual(code, 0);
      assert.include(out, "healthy: running");
      assert.include(out, "miner 1.0.0 (live, pid 99), started 60 min ago, heartbeat 10 s ago");
      assert.include(out, "watching ch1 for Game game-1: Drop c1-d1 (12/60 min)");
      assert.include(out, "pubsub: 1/1 connections listening, 5 topics");
    }),
  );

  it.effect("prints the documented JSON report, with the file", () =>
    Effect.gen(function* () {
      const { code, out } = yield* status(["--json"], file());
      assert.strictEqual(code, 0);
      const report = decodeReport(JSON.parse(out));
      assert.deepStrictEqual(report.health, { state: "healthy", exitCode: 0, detail: "running" });
      assert.deepStrictEqual(report.status, file());
      assert.strictEqual(report.checkedAt, T0 + 10_000);
    }),
  );

  it.effect("exits 1 without a status file, and still prints a report", () =>
    Effect.gen(function* () {
      const { code, out } = yield* status(["--json"], undefined);
      assert.strictEqual(code, 1);
      const report = decodeReport(JSON.parse(out));
      assert.strictEqual(report.health.state, "not-running");
      assert.isNull(report.status);
    }),
  );

  it.effect("exits 2 when parked on a rejected token, 3 when discovery is broken", () =>
    Effect.gen(function* () {
      const parked = yield* status([], file({ auth: "needs-login" }));
      assert.strictEqual(parked.code, 2);
      assert.include(parked.out, "needs-login: Twitch rejected the token");
      const broken = file({ catalog: { status: "unavailable", campaigns: 0 } });
      assert.strictEqual((yield* status([], broken)).code, 3);
    }),
  );

  it.effect("prints the committed JSON Schema with --schema", () =>
    Effect.gen(function* () {
      const { code, out } = yield* status(["--schema"], undefined);
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(JSON.parse(out), committed);
    }),
  );

  it.effect("documents the exit codes in --help", () =>
    Effect.gen(function* () {
      const { out } = yield* status(["--help"], undefined);
      for (const text of ["0 healthy", "1 not running", "2 needs login", "3 discovery broken"]) {
        assert.include(out, text);
      }
    }),
  );
});
