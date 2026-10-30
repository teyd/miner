import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { Config } from "../config/schema.ts";
import { HOUR, type ChannelId, type DropId, type DropInstanceId } from "../core/model.ts";
import { Gzip, nodeGzip } from "../platform/Gzip.ts";
import { Instance } from "../platform/instance.ts";
import { decodeState } from "../store/codec.ts";
import { memoryFileSystem, type MemoryFiles } from "../store/memoryFileSystem.ts";
import { twinHttp } from "../twin/http.ts";
import { DEFAULT_GOAL_SPEC, SIM_EPOCH, type Scenario } from "../twin/scenario.ts";
import { makeTwin, type Twin } from "../twin/twin.ts";
import * as World from "../twin/world.ts";
import token from "../twitch/fixtures/playback-token.json" with { type: "json" };
import { parseRecording } from "../twitch/journal.ts";
import { fakeEdge } from "../twitch/fakeSocket.ts";
import { Connector } from "../twitch/PubSub.ts";
import { stubPlayback } from "../twitch/stub.ts";
import { Credentials } from "../twitch/Twitch.ts";
import { LIVE_STATE, liveLayer } from "./live.ts";
import { run } from "./run.ts";
import { STATUS_FILE } from "./status.ts";
import { parseStatus } from "../status/snapshot.ts";
import { SHADOW_STATE } from "./shadow.ts";

const DIR = "/data";
const TOKEN = "twinsecrettoken0123456789";

/** One game, one channel: a drop already complete, and a long one to watch for. */
const scenario: Scenario = {
  latencySeed: 1,
  horizonMinutes: 1440,
  inventoryLagMinutes: 0,
  settings: { goals: [DEFAULT_GOAL_SPEC] },
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
  faults: [],
};

const config = Schema.decodeSync(Config)({
  priorities: [{ type: "drops", games: [{ name: "game 0" }] }],
});

const makeWorld = (): Twin => {
  const twin = makeTwin(World.buildWorld(scenario));
  const done = "c0-d0" as DropId;
  twin.world = {
    ...twin.world,
    minutes: new Map([[done, [{ at: SIM_EPOCH - HOUR, minutes: 1 }]]]),
  };
  return twin;
};

/** A playback token that expires 20 minutes after it is issued, as Twitch's do. */
const tokenAt = (now: number) => {
  const recorded = token.body[0]!.data.streamPlaybackAccessToken;
  const value = JSON.stringify({ ...JSON.parse(recorded.value), expires: now / 1000 + 1200 });
  return {
    status: 200,
    body: [{ data: { streamPlaybackAccessToken: { ...recorded, value } } }],
  };
};

/**
 * Reads from the twin; playback and claims from recorded answers. They apply to the twin as on
 * Twitch: usher opens its session, each media playlist read credits the watch, and a claim lands,
 * so the next inventory shows them.
 */
const liveHttp = (twin: Twin, claimsToKill = 0) => {
  let kill = claimsToKill;
  const stub = stubPlayback({}, twinHttp(twin));
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const sent =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as ReadonlyArray<{
              readonly operationName: string;
              readonly variables: { readonly input?: { readonly dropInstanceID: string } };
            }>)
          : [];
      const name = sent[0]?.operationName;
      if (name === "PlaybackAccessToken") stub.state.token = tokenAt(now);
      if (name === "DropsPage_ClaimDropRewards" && kill > 0) {
        kill -= 1;
        return yield* Effect.die(new Error("the claim's fiber died before Twitch saw it"));
      }
      if (name === "DropsPage_ClaimDropRewards") {
        const id = sent[0]!.variables.input!.dropInstanceID as DropInstanceId;
        twin.world = World.claim(twin.world, id, now).world;
      }
      const usher = /\/api\/channel\/hls\/chan(\d+)\.m3u8/.exec(request.url);
      if (usher !== null)
        twin.world = World.openSession(twin.world, `ch${usher[1]}` as ChannelId, now);
      const session = twin.world.session;
      if (request.url.includes("/v1/playlist/") && session !== undefined) {
        twin.world = World.tick(twin.world, session.channelId, now).world;
      }
      return yield* stub.http.execute(request);
    }),
  );
  return { http, requests: stub.requests };
};

const liveRun = (twin: Twin, files: MemoryFiles, hours: number, claimsToKill = 0) =>
  Effect.gen(function* () {
    const { http, requests } = liveHttp(twin, claimsToKill);
    const services = liveLayer(DIR).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(
            Credentials,
            Credentials.of({ token: Redacted.make(TOKEN), deviceId: "0".repeat(32) }),
          ),
          Layer.succeed(Connector, fakeEdge().connector),
          Gzip.layer,
          Layer.succeed(Instance, Instance.of({ version: "0.0.0-test", pid: 4242 })),
          files.layer,
        ),
      ),
    );
    const fiber = yield* Effect.forkChild(run(config).pipe(Effect.provide(services)));
    for (let t = 0; t < hours * HOUR; t += 1000) yield* TestClock.adjust(1000);
    assert.isUndefined(fiber.pollUnsafe(), "the runtime stopped by itself");
    yield* Fiber.interrupt(fiber);
    return requests;
  });

const lines = (files: MemoryFiles): ReadonlyArray<string> =>
  [...files.files.keys()]
    .filter((k) => k.startsWith(`${DIR}/recordings/`))
    .toSorted()
    .flatMap((k) =>
      new TextDecoder()
        .decode(nodeGzip.gunzip(files.files.get(k)!))
        .split("\n")
        .filter(Boolean),
    );

describe("run with the live actuator", () => {
  // A claim fiber that dies sent nothing the core heard back: left "sent", the intent blocked
  // the drop forever (review of #25). Reported unknown, inventory settles it and it goes again.
  it.effect(
    "reports a claim whose fiber died as unknown, so inventory settles it and it is sent once more",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(SIM_EPOCH);
        const twin = makeWorld();
        const files = memoryFileSystem();
        yield* liveRun(twin, files, 1, 1);
        assert.isTrue(twin.world.claimed.has("c0-d0" as DropId));
        const saved = decodeState(
          new TextDecoder().decode(files.files.get(`${DIR}/${LIVE_STATE}`)!),
        );
        assert.lengthOf([...saved.claims.values()], 0);
      }),
    30_000,
  );

  it.effect(
    "watches over HLS every 20 s, claims the complete drop once, and saves state.json",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(SIM_EPOCH);
        const twin = makeWorld();
        const files = memoryFileSystem();
        const requests = yield* liveRun(twin, files, 2);
        const count = (step: string) => requests.filter((r) => r.step === step).length;

        // One claim, applied: the next inventory shows it claimed, so none follows.
        assert.strictEqual(count("claim"), 1);
        assert.isTrue(twin.world.claimed.has("c0-d0" as DropId));

        // A media playlist per tick for two hours, on the planned channel; a token per ~19 min.
        const media = requests.filter((r) => r.step === "media");
        assert.isAtLeast(media.length, 330);
        assert.isAtMost(media.length, 361);
        assert.isAtLeast(count("token"), 6);
        assert.isAtMost(count("token"), 8);
        const ushers = requests.filter((r) => r.step === "usher");
        assert.isTrue(ushers.every((r) => new URL(r.url).pathname.endsWith("/chan0.m3u8")));
        assert.strictEqual(count("segment"), media.length * 16);
        assert.isTrue(
          requests.every(
            (r) =>
              r.step === "claim" || r.step === "token" || r.headers["authorization"] === undefined,
          ),
        );

        // The live state file, never the shadow one.
        const saved = decodeState(
          new TextDecoder().decode(files.files.get(`${DIR}/${LIVE_STATE}`)!),
        );
        assert.isTrue(saved.progress.get("c0-d0" as DropId)?.claimed);
        assert.lengthOf([...saved.claims.values()], 0);
        assert.isFalse(files.files.has(`${DIR}/${SHADOW_STATE}`));

        // status.json: a live run that claimed the drop and watched for real, then stopped.
        const status = parseStatus(
          new TextDecoder().decode(files.files.get(`${DIR}/${STATUS_FILE}`)!),
        );
        assert.strictEqual(status._tag, "Read");
        if (status._tag === "Read") {
          const s = status.status;
          assert.strictEqual(s.miner.mode, "live");
          assert.deepStrictEqual(
            s.claims.claimedThisRun.map((c) => [c.dropId, c.drop]),
            [["c0-d0", "Game 0: Drop 0.0"]],
          );
          assert.lengthOf(s.claims.inFlight, 0);
          assert.isAtLeast(s.reads.watchTick ?? 0, SIM_EPOCH + 2 * HOUR - 60_000);
          assert.deepInclude(s.watch, {
            state: "watching",
            channel: { id: "ch0", login: "chan0" },
          });
          assert.strictEqual(s.stoppedAt, SIM_EPOCH + 2 * HOUR);
        }

        // Recorded: the claim answer and the ticks, without the token or a signature.
        const recorded = lines(files);
        const parsed = parseRecording(recorded.join("\n")) as ReadonlyArray<
          Record<string, unknown>
        >;
        const operations = new Set(parsed.map((l) => l["operation"]));
        for (const op of ["DropsPage_ClaimDropRewards", "PlaybackAccessToken", "usher", "hls"]) {
          assert.isTrue(operations.has(op), `${op} recorded`);
        }
        for (const line of recorded) {
          assert.notInclude(line, TOKEN);
          assert.notInclude(line, "0".repeat(40));
          assert.notInclude(line, "omitted");
        }

        // A restart resumes from state.json and claims nothing again.
        const again = yield* liveRun(twin, files, 1);
        assert.strictEqual(again.filter((r) => r.step === "claim").length, 0);
        assert.isAtLeast(again.filter((r) => r.step === "media").length, 150);
      }),
  );
});
