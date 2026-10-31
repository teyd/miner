import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Queue, Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { Config } from "../config/schema.ts";
import { HOUR, MINUTE, type DropId, type GameId } from "../core/model.ts";
import { Command, Event } from "../core/protocol.ts";
import { Gzip, nodeGzip } from "../platform/Gzip.ts";
import { Instance } from "../platform/instance.ts";
import { decodeState } from "../store/codec.ts";
import { memoryFileSystem, type MemoryFiles } from "../store/memoryFileSystem.ts";
import { twinHttp } from "../twin/http.ts";
import { DEFAULT_GOAL_SPEC, SIM_EPOCH, type Scenario } from "../twin/scenario.ts";
import { makeTwin, type Twin } from "../twin/twin.ts";
import { buildWorld } from "../twin/world.ts";
import { fakeEdge, listenedOn, type FakeEdge } from "../twitch/fakeSocket.ts";
import { DEFAULT_LIMITS, parseRecording, type Limits } from "../twitch/journal.ts";
import { GQL_LIMITS } from "../twitch/budget.ts";
import { Connector } from "../twitch/PubSub.ts";
import { Credentials } from "../twitch/Twitch.ts";
import { coalesce, countAt, MAX_STEPS_AT_INSTANT, run } from "./run.ts";
import { SHADOW_STATE, shadowLayer } from "./shadow.ts";

const DIR = "/data";
const TOKEN = "twinsecrettoken0123456789";

/**
 * Game 0 has a completed drop and a long one; `chan1` has the most viewers but is excluded by
 * login; game 1 is not in the config's list. A correct shadow run plans `chan0`, would claim the
 * completed drop, and sends neither.
 */
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
    {
      game: 1,
      startMinute: -60,
      durationMinutes: 6000,
      linked: true,
      allowList: [],
      drops: [{ requiredMinutes: 30, after: null, benefit: "DIRECT_ENTITLEMENT" }],
    },
  ],
  channels: [
    { game: 0, viewers: 50, dropsEnabled: true, refuses: false, liveAtStart: true, changes: [] },
    { game: 0, viewers: 5000, dropsEnabled: true, refuses: false, liveAtStart: true, changes: [] },
    { game: 1, viewers: 100, dropsEnabled: true, refuses: false, liveAtStart: true, changes: [] },
  ],
  faults: [],
};

const config = Schema.decodeSync(Config)({
  priorities: [{ type: "drops", games: [{ name: "game 0" }], exclude: { channels: ["CHAN1"] } }],
});

const makeWorld = (): Twin => {
  const twin = makeTwin(buildWorld(scenario));
  const done = "c0-d0" as DropId;
  twin.world = {
    ...twin.world,
    minutes: new Map([[done, [{ at: SIM_EPOCH - HOUR, minutes: 1 }]]]),
  };
  return twin;
};

/**
 * Runs the shadow runtime over the twin for `hours` of virtual time, then stops it. Time moves in
 * `stepMs` steps: the twin's answers resolve through a web `Response` outside the Effect
 * scheduler, so one long `adjust` would pass reads still in flight (the simulator polls for the
 * same reason).
 */
const shadowRun = (
  twin: Twin,
  files: MemoryFiles,
  hours: number,
  limits?: Limits,
  stepMs = 1000,
  edge: FakeEdge = fakeEdge(),
  during: (hour: number) => void = () => {},
) =>
  Effect.gen(function* () {
    const services = shadowLayer(DIR, limits).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, twinHttp(twin)),
          Layer.succeed(
            Credentials,
            Credentials.of({ token: Redacted.make(TOKEN), deviceId: "0".repeat(32) }),
          ),
          Gzip.layer,
          Layer.succeed(Instance, Instance.of({ version: "0.0.0-test", pid: 4242 })),
          files.layer,
          Layer.succeed(Connector, edge.connector),
        ),
      ),
    );
    const fiber = yield* Effect.forkChild(run(config).pipe(Effect.provide(services)));
    for (let t = 0; t < hours * HOUR; t += stepMs) {
      if (t % HOUR === 0) during(t / HOUR);
      yield* TestClock.adjust(stepMs);
    }
    assert.isUndefined(fiber.pollUnsafe(), "the runtime stopped by itself");
    yield* Fiber.interrupt(fiber);
  });

type Line = Record<string, unknown>;

const lines = (files: MemoryFiles): ReadonlyArray<Line> =>
  [...files.files.keys()]
    .filter((k) => k.startsWith(`${DIR}/recordings/`))
    .toSorted()
    .flatMap(
      (k) =>
        parseRecording(new TextDecoder().decode(nodeGzip.gunzip(files.files.get(k)!))) as never,
    );

const intents = (files: MemoryFiles, command: string) =>
  lines(files).filter((l) => l["kind"] === "intent" && l["command"] === command);

const saved = (files: MemoryFiles) =>
  decodeState(new TextDecoder().decode(files.files.get(`${DIR}/${SHADOW_STATE}`)!));

const READS = new Set([
  "validate",
  "ViewerDropsDashboard",
  "DropCampaignDetails",
  "Inventory",
  "DirectoryPage_Game",
  "VideoPlayerStreamInfoOverlayChannel",
  "DropCurrentSessionContext",
]);

describe("run --shadow", () => {
  it.effect(
    "reads, plans, records what it would do, persists, and resumes from the saved file",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(SIM_EPOCH);
        const twin = makeWorld();
        const files = memoryFileSystem();
        yield* shadowRun(twin, files, 3);

        // Planned on real reads: the excluded and the unlisted channel were never picked.
        const watched = intents(files, "Watch").map((l) => (l["detail"] as Line)["channelId"]);
        assert.deepStrictEqual(watched, ["ch0"]);
        assert.lengthOf(intents(files, "Claim"), 1);

        // Nothing was sent: the twin applied no claim and saw no watch, and only reads went out.
        assert.strictEqual(twin.world.claimed.size, 0);
        assert.isUndefined(twin.world.session);
        assert.lengthOf(twin.activity.calls, 0);
        const operations = new Set(twin.activity.requests.map((r) => r.operation));
        for (const op of operations) assert.isTrue(READS.has(op), op);
        const answered = new Set(lines(files).map((l) => l["operation"]));
        for (const op of ["validate", "ViewerDropsDashboard", "Inventory", "DirectoryPage_Game"]) {
          assert.isTrue(answered.has(op), `${op} recorded`);
        }

        // Browser-like: reads start at least the gap apart, about 1 per 5 minutes at rest.
        const starts = twin.activity.requests.map((r) => r.at).toSorted((a, b) => a - b);
        for (let i = 1; i < starts.length; i++) {
          assert.isAtLeast(starts[i]! - starts[i - 1]!, GQL_LIMITS.gap);
        }
        assert.isBelow(starts.length, 80);

        // The state on disk holds what a restart needs, including the claim intent.
        const first = saved(files);
        assert.lengthOf(first.catalog ?? [], 2);
        assert.isTrue(first.progress.get("c0-d0" as DropId)?.instanceId !== undefined);
        assert.strictEqual([...first.claims.values()][0]?.status, "sent");

        // A restart resumes from the file: the catalog is there before any read.
        const requestsBefore = twin.activity.requests.length;
        yield* shadowRun(twin, files, 1);
        const resumed = saved(files);
        assert.lengthOf(resumed.catalog ?? [], 2);
        // The claim in flight is checked against inventory, found unclaimed, and would be
        // claimed again: once more, not in a loop.
        assert.lengthOf(intents(files, "Claim"), 2);
        assert.strictEqual(twin.world.claimed.size, 0);
        const after = twin.activity.requests.slice(requestsBefore);
        assert.isBelow(after.filter((r) => r.operation === "Inventory").length, 20);
        assert.isAtLeast(
          intents(files, "Watch").length,
          2,
          "the restarted run planned the watch again",
        );
      }),
  );

  it.effect("listens to the followed channels and hears what their frames say", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const twin = makeWorld();
      const files = memoryFileSystem();
      const edge = fakeEdge();
      // An hour in, Twitch says the watched channel went offline.
      const offline = JSON.stringify({
        type: "MESSAGE",
        data: { topic: "video-playback-by-id.ch0", message: '{"type":"stream-down"}' },
      });
      yield* shadowRun(twin, files, 2, undefined, 1000, edge, (hour) => {
        if (hour === 1) for (const c of edge.connections) if (!c.closed) c.push(offline);
      });

      // Listening is read-only and real: one socket, the account's drops and the plan's channels.
      assert.lengthOf(edge.connections, 1);
      const topics = listenedOn(edge.connections[0]!);
      assert.isTrue(topics.has("video-playback-by-id.ch0"));
      assert.isTrue([...topics].some((t) => t.startsWith("user-drop-events.")));
      assert.lengthOf(intents(files, "Subscribe"), 0, "subscribe is not a shadow intent");
      const recorded = lines(files).filter((l) => l["kind"] === "frame");
      assert.isTrue(recorded.some((l) => String(l["text"]).includes("stream-down")));
      for (const l of recorded) assert.notInclude(JSON.stringify(l), TOKEN);

      // The frame reached the core: it stopped watching ch0 straight away.
      assert.isAtLeast(intents(files, "StopWatching").length, 1);
      const stopAt = intents(files, "StopWatching")[0]!["at"] as number;
      assert.isAtLeast(stopAt, SIM_EPOCH + HOUR);
      assert.isBelow(stopAt, SIM_EPOCH + HOUR + MINUTE);
    }),
  );

  it.effect(
    "keeps its recordings within the limits over several days",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(SIM_EPOCH);
        const files = memoryFileSystem();
        const limits = { ...DEFAULT_LIMITS, keepDays: 2, maxBytes: 200_000, maxDayBytes: 60_000 };
        yield* shadowRun(makeWorld(), files, 72, limits, MINUTE);
        const recordings = [...files.files.keys()].filter((k) =>
          k.startsWith(`${DIR}/recordings/`),
        );
        assert.lengthOf(recordings, 2);
        const total = recordings.reduce((sum, k) => sum + files.files.get(k)!.length, 0);
        assert.isAtMost(total, limits.maxBytes);
        assert.isTrue(
          Option.isSome(Option.fromNullishOr(files.files.get(`${DIR}/${SHADOW_STATE}`))),
        );
      }),
    // 72 virtual hours of the whole runtime: about 2 s here, over 5 s on CI's 4-core runner.
    30_000,
  );
});

describe("the spin guard", () => {
  it("counts steps at one instant and restarts when time moves", () => {
    let instant: readonly [number, number] = [-1, 0];
    for (let i = 0; i < MAX_STEPS_AT_INSTANT + 1; i++) instant = countAt(instant, 5);
    assert.deepStrictEqual(instant, [5, MAX_STEPS_AT_INSTANT + 1]);
    assert.deepStrictEqual(countAt(instant, 6), [6, 1]);
  });

  it.effect("takes refusals queued together as one event, so a refused burst is one step", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<Event>();
      const refusal = (gameId: string) =>
        Event.Throttled({
          refusals: [
            {
              command: Command.ReadDirectory({ gameId: gameId as GameId }),
              budget: "gql",
              retryAt: 1,
            },
          ],
        });
      const burst = Array.from({ length: MAX_STEPS_AT_INSTANT + 1 }, (_, i) => refusal(`g${i}`));
      yield* Queue.offerAll(events, [...burst.slice(1), Event.Tick(), refusal("after")]);
      const merged = yield* coalesce(events, burst[0]!);
      assert.strictEqual(merged._tag, "Throttled");
      if (merged._tag === "Throttled") {
        assert.deepStrictEqual(
          merged.refusals,
          burst.flatMap((e) => (e._tag === "Throttled" ? e.refusals : [])),
        );
      }
      // Only the run right behind it: the tick and what follows it keep their order.
      assert.strictEqual((yield* Queue.take(events))._tag, "Tick");
      const tick = Event.Tick();
      assert.strictEqual(yield* coalesce(events, tick), tick);
      assert.strictEqual(yield* Queue.size(events), 1);
    }),
  );
});
