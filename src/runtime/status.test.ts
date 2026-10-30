import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { statusReport } from "../cli/status.ts";
import { Config } from "../config/schema.ts";
import { HOUR, MINUTE, type DropId } from "../core/model.ts";
import { Gzip } from "../platform/Gzip.ts";
import { Instance } from "../platform/instance.ts";
import {
  encodeStatusFile,
  HEARTBEAT_SECONDS,
  type StatusFile,
  type StatusReport,
} from "../status/schema.ts";
import { changeKey, parseStatus } from "../status/snapshot.ts";
import { memoryFileSystem, type MemoryFiles } from "../store/memoryFileSystem.ts";
import { twinHttp } from "../twin/http.ts";
import { SIM_EPOCH, type Fault, type Scenario } from "../twin/scenario.ts";
import { makeTwin, type Twin } from "../twin/twin.ts";
import { buildWorld } from "../twin/world.ts";
import { fakeEdge } from "../twitch/fakeSocket.ts";
import { Connector } from "../twitch/PubSub.ts";
import { Credentials } from "../twitch/Twitch.ts";
import { run } from "./run.ts";
import { shadowLayer } from "./shadow.ts";
import { MIN_GAP, STATUS_FILE } from "./status.ts";

const DIR = "/data";
const PATH = `${DIR}/${STATUS_FILE}`;

/** One game, one live channel; drop 0 is complete and claimable, drop 1 is long. */
const scenario = (faults: ReadonlyArray<Fault>): Scenario => ({
  latencySeed: 1,
  horizonMinutes: 1440,
  inventoryLagMinutes: 0,
  settings: { games: [], exclude: [], badgesAndEmotes: true },
  campaigns: [
    {
      game: 0,
      startMinute: -60,
      durationMinutes: 6000,
      linked: true,
      allowList: [],
      drops: [
        { requiredMinutes: 1, after: null, benefit: "DIRECT_ENTITLEMENT" },
        { requiredMinutes: 600, after: null, benefit: "DIRECT_ENTITLEMENT" },
      ],
    },
  ],
  channels: [
    { game: 0, viewers: 50, dropsEnabled: true, refuses: false, liveAtStart: true, changes: [] },
  ],
  faults,
});

const config = Schema.decodeSync(Config)({
  priorities: [{ type: "drops", games: [{ name: "game 0" }] }],
});

/** A game the twin has no campaign for. */
const other = Schema.decodeSync(Config)({
  priorities: [{ type: "drops", games: [{ name: "game 9" }] }],
});

const makeWorld = (faults: ReadonlyArray<Fault> = []): Twin => {
  const twin = makeTwin(buildWorld(scenario(faults)));
  twin.world = {
    ...twin.world,
    minutes: new Map([["c0-d0" as DropId, [{ at: SIM_EPOCH - HOUR, minutes: 1 }]]]),
  };
  return twin;
};

const current = (files: MemoryFiles): StatusFile | undefined => {
  const bytes = files.files.get(PATH);
  if (bytes === undefined) return undefined;
  const read = parseStatus(new TextDecoder().decode(bytes));
  assert.strictEqual(read._tag, "Read", "status.json always decodes");
  return read._tag === "Read" ? read.status : undefined;
};

/**
 * A shadow run over the twin for `minutes` of virtual time in 1 s steps, recording every distinct
 * status.json it wrote. With `stop` false the fiber is left running and returned.
 */
const shadowRun = (
  twin: Twin,
  files: MemoryFiles,
  minutes: number,
  stop = true,
  settings: Config = config,
) =>
  Effect.gen(function* () {
    const services = shadowLayer(DIR).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, twinHttp(twin)),
          Layer.succeed(
            Credentials,
            Credentials.of({
              token: Redacted.make("twinsecrettoken0123456789"),
              deviceId: "0".repeat(32),
            }),
          ),
          Layer.succeed(Instance, Instance.of({ version: "1.2.3", pid: 4242 })),
          Layer.succeed(Connector, fakeEdge().connector),
          Gzip.layer,
          files.layer,
        ),
      ),
    );
    const fiber = yield* Effect.forkChild(run(settings).pipe(Effect.provide(services)));
    const writes: Array<StatusFile> = [];
    for (let t = 0; t < minutes * MINUTE; t += 1000) {
      yield* TestClock.adjust(1000);
      const now = current(files);
      if (now !== undefined && now.heartbeatAt !== writes.at(-1)?.heartbeatAt) writes.push(now);
    }
    assert.isUndefined(fiber.pollUnsafe(), "the runtime stopped by itself");
    if (stop) yield* Fiber.interrupt(fiber);
    return { writes, fiber };
  });

const report = (files: MemoryFiles) =>
  statusReport(PATH).pipe(Effect.provide(files.layer)) as Effect.Effect<StatusReport>;

describe("status.json from a running miner", () => {
  it.effect(
    "reports the shadow run, writes on change or heartbeat only, and says when it stops",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(SIM_EPOCH);
        const files = memoryFileSystem();
        const { writes, fiber } = yield* shadowRun(makeWorld(), files, 60, false);

        const s = current(files)!;
        assert.deepStrictEqual(s.miner, {
          version: "1.2.3",
          pid: 4242,
          mode: "shadow",
          startedAt: SIM_EPOCH,
        });
        assert.strictEqual(s.auth, "valid");
        assert.deepStrictEqual(s.catalog, { status: "ok", campaigns: 1 });
        assert.deepInclude(s.watch, {
          state: "watching",
          channel: { id: "ch0", login: "chan0" },
          game: "Game 0",
        });
        assert.strictEqual(s.watch.state === "watching" ? s.watch.drop.id : "", "c0-d1");
        // The shadow claim never answers, so it stays in flight and nothing is claimed.
        assert.lengthOf(s.claims.inFlight, 1);
        assert.strictEqual(s.claims.inFlight[0]?.status, "sent");
        assert.strictEqual(s.claims.inFlight[0]?.dropId, "c0-d0");
        assert.lengthOf(s.claims.claimedThisRun, 0);
        for (const kind of ["validate", "catalog", "inventory", "channels"] as const) {
          assert.isNotNull(s.reads[kind], kind);
        }
        assert.isNull(s.reads.watchTick, "a shadow watch never ticks");
        assert.deepStrictEqual(s.pubsub, { connections: 1, listening: 1, topics: 3, dropped: 0 });

        // Throttled: never two writes within MIN_GAP, an unchanged document only on the
        // heartbeat, and the heartbeat never missed. The watch ticks every 20 s and is not a change.
        for (let i = 1; i < writes.length; i++) {
          const gap = writes[i]!.heartbeatAt - writes[i - 1]!.heartbeatAt;
          assert.isAtLeast(gap, MIN_GAP);
          assert.isAtMost(gap, HEARTBEAT_SECONDS * 1000 + 1000);
          if (changeKey(writes[i]!) === changeKey(writes[i - 1]!)) {
            assert.isAtLeast(gap, HEARTBEAT_SECONDS * 1000);
          }
        }
        assert.isAtMost(writes.length, 60 * 2 + 15);

        const healthy = yield* report(files);
        assert.deepInclude(healthy.health, { state: "healthy", exitCode: 0 });

        // A clean stop is written at once.
        yield* Fiber.interrupt(fiber);
        const stopped = current(files)!;
        assert.strictEqual(stopped.stoppedAt, SIM_EPOCH + 60 * MINUTE);
        assert.deepInclude((yield* report(files)).health, { state: "not-running", exitCode: 1 });
      }),
  );

  it.effect("goes stale when the miner dies without a word", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const files = memoryFileSystem();
      yield* shadowRun(makeWorld(), files, 5);
      // Pretend the process was killed: put back the last document before the clean stop.
      const last = { ...current(files)!, stoppedAt: null };
      files.files.set(PATH, new TextEncoder().encode(JSON.stringify(encodeStatusFile(last))));
      assert.strictEqual((yield* report(files)).health.exitCode, 0);
      yield* TestClock.adjust(91_000);
      assert.deepInclude((yield* report(files)).health, { state: "not-running", exitCode: 1 });
    }),
  );

  it.effect("keeps its heartbeat while parked on a rejected token, and says needs-login", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const files = memoryFileSystem();
      const twin = makeWorld([{ kind: "revoke-token", atMinute: 10 }]);
      const { writes } = yield* shadowRun(twin, files, 150, false);
      const s = writes.at(-1)!;
      assert.strictEqual(s.auth, "needs-login");
      assert.deepStrictEqual(s.watch, { state: "idle", reason: "needs-login" });
      // The core has no deadline once parked; the heartbeat still comes from the run loop.
      assert.isAtLeast(s.heartbeatAt, SIM_EPOCH + 150 * MINUTE - HEARTBEAT_SECONDS * 1000);
      assert.deepInclude((yield* report(files)).health, { state: "needs-login", exitCode: 2 });
    }),
  );

  it.effect("tells discovery broken apart from nothing to mine", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const broken = memoryFileSystem();
      const fault: Fault = {
        kind: "null-catalog",
        operation: "ViewerDropsDashboard",
        atMinute: 0,
        durationSeconds: 3 * 3600,
      };
      yield* shadowRun(makeWorld([fault]), broken, 20, false);
      const s = current(broken)!;
      assert.strictEqual(s.catalog.status, "unavailable");
      assert.deepStrictEqual(s.watch, { state: "idle", reason: "catalog-unavailable" });
      assert.isNull(s.reads.catalog);
      assert.deepInclude((yield* report(broken)).health, {
        state: "discovery-broken",
        exitCode: 3,
      });

      // The same world without the fault, for a game without campaigns: healthy and idle.
      const empty = memoryFileSystem();
      yield* shadowRun(makeWorld(), empty, 20, false, other);
      const e = current(empty)!;
      assert.strictEqual(e.catalog.status, "ok");
      assert.deepStrictEqual(e.watch, { state: "idle", reason: "nothing-to-mine" });
      assert.deepInclude((yield* report(empty)).health, { state: "healthy", exitCode: 0 });
    }),
  );
});
