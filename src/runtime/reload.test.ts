import { assert, describe, it } from "@effect/vitest";
import {
  ByteSize,
  DateTime,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { Config } from "../config/schema.ts";
import { SUBSCRIBE_SETTLE, WATCH_INTERVAL } from "../core/state.ts";
import { Gzip } from "../platform/Gzip.ts";
import { Instance } from "../platform/instance.ts";
import { parseStatus } from "../status/snapshot.ts";
import { memoryFileSystem, type MemoryFiles } from "../store/memoryFileSystem.ts";
import { webSocketConstructor } from "../twin/edge.ts";
import { twinHttp } from "../twin/http.ts";
import { DEFAULT_GOAL_SPEC, SIM_EPOCH, type Scenario } from "../twin/scenario.ts";
import { bindClock, makeTwin, type Twin } from "../twin/twin.ts";
import { buildWorld } from "../twin/world.ts";
import { Connector } from "../twitch/PubSub.ts";
import { Credentials } from "../twitch/Twitch.ts";
import { liveLayer } from "./live.ts";
import { makeConfigWatch, RELOAD_EVERY } from "./reload.ts";
import { run } from "./run.ts";
import { STATUS_FILE } from "./status.ts";

const FILE = "/data/config.json";

/** Decodes a config as `load` would, outside any Effect. */
const parse = (value: unknown): Config => Schema.decodeUnknownSync(Config)(value);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const only = (game: string) => ({ priorities: [{ type: "drops", games: [{ name: game }] }] });
const write = (files: MemoryFiles, text: string) =>
  files.files.set(FILE, new TextEncoder().encode(text));

const capture = () => {
  const lines: Array<{ level: string; message: string }> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    lines.push({ level: logLevel, message: [message].flat().map(String).join(" ") });
  });
  return { lines, layer: Logger.layer([logger]) };
};

const gamesOf = (config: Config) =>
  config.priorities.flatMap((g) =>
    g.type === "drops" && g.games !== "all" ? g.games.map((e) => e.name) : [],
  );

describe("makeConfigWatch", () => {
  it.effect("applies a valid change, refuses a broken or vanished file, and recovers", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const files = memoryFileSystem();
      const logs = capture();
      write(files, json(only("Game 0")));
      const initial = parse(only("Game 0"));
      const watch = yield* makeConfigWatch(FILE, initial).pipe(Effect.provide(files.layer));
      const poll = watch.poll.pipe(Effect.provide(logs.layer));

      // The file the miner started with is not a change.
      assert.isFalse(yield* poll);
      assert.deepStrictEqual(watch.facts(), { reloadedAt: undefined, rejected: undefined });

      // Rewritten with the same content, formatted differently: nothing to re-plan.
      write(files, JSON.stringify(only("Game 0")));
      assert.isFalse(yield* poll);
      assert.isUndefined(watch.facts().reloadedAt);

      yield* TestClock.adjust(10_000);
      write(files, json(only("Game 1")));
      assert.isTrue(yield* poll);
      assert.deepStrictEqual(gamesOf(watch.config()), ["Game 1"]);
      assert.strictEqual(watch.facts().reloadedAt, 1_010_000);
      assert.isFalse(yield* poll, "a change applies once");

      // Half an edit: not JSON. Refused with the problem, the last good config stays.
      yield* TestClock.adjust(10_000);
      write(files, '{ "priorities": [');
      assert.isFalse(yield* poll);
      assert.deepStrictEqual(gamesOf(watch.config()), ["Game 1"]);
      const rejected = watch.facts().rejected;
      assert.strictEqual(rejected?.at, 1_020_000);
      assert.match(rejected?.problems[0] ?? "", /^\/data\/config\.json#: not valid JSON/);
      const warnings = logs.lines.filter((l) => l.level === "Warn").map((l) => l.message);
      assert.isTrue(warnings.some((m) => m.startsWith("config: /data/config.json#: not valid")));
      assert.isTrue(warnings.some((m) => m.includes("mining goes on with the last valid config")));
      assert.strictEqual(watch.facts().reloadedAt, 1_010_000);

      // Valid JSON that the schema refuses: the pointer names the field.
      write(files, json({ priorities: [{ type: "drops", games: "some" }] }));
      assert.isFalse(yield* poll);
      assert.match(watch.facts().rejected?.problems[0] ?? "", /#\/priorities\/0\/games: /);
      assert.deepStrictEqual(gamesOf(watch.config()), ["Game 1"]);

      // Gone (an editor saving by rename): refused, not the defaults ("all").
      files.files.delete(FILE);
      assert.isFalse(yield* poll);
      assert.match(watch.facts().rejected?.problems[0] ?? "", /the file is gone/);
      assert.deepStrictEqual(gamesOf(watch.config()), ["Game 1"]);

      // Fixed: applied, and the refusal is over.
      yield* TestClock.adjust(10_000);
      write(files, json(only("Game 0")));
      assert.isTrue(yield* poll);
      assert.deepStrictEqual(gamesOf(watch.config()), ["Game 0"]);
      assert.deepStrictEqual(watch.facts(), { reloadedAt: 1_030_000, rejected: undefined });
      assert.isTrue(logs.lines.some((l) => l.message.includes("is valid again")));
    }),
  );

  it.effect("warns about a newly unsupported option once, not about the ones it started with", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      const logs = capture();
      const points = { type: "points", channels: ["someone"] };
      const start = { priorities: [...only("Game 0").priorities, points] };
      write(files, json(start));
      const watch = yield* makeConfigWatch(FILE, parse(start)).pipe(Effect.provide(files.layer));
      write(files, json({ ...start, streams: { max: 2 } }));
      assert.isTrue(yield* watch.poll.pipe(Effect.provide(logs.layer)));
      const warnings = logs.lines.filter((l) => l.level === "Warn").map((l) => l.message);
      assert.deepStrictEqual(warnings, [
        "config: streams.max 2 is not supported yet: one stream is watched",
      ]);
    }),
  );

  it.effect("looks at the modification time and size, and reads only when they move", () =>
    Effect.gen(function* () {
      let mtime = 1;
      let text = json(only("Game 0"));
      let reads = 0;
      const fs = FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        stat: () =>
          Effect.succeed({
            type: "File",
            size: ByteSize.bytes(text.length),
            mtime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(mtime))),
          } as unknown as FileSystem.File.Info),
        readFileString: () =>
          Effect.sync(() => {
            reads += 1;
            return text;
          }),
      });
      const layer = Layer.succeed(FileSystem.FileSystem, fs);
      const watch = yield* makeConfigWatch(FILE, parse(only("Game 0"))).pipe(Effect.provide(layer));
      for (let i = 0; i < 5; i++) assert.isFalse(yield* watch.poll);
      assert.strictEqual(reads, 0, "an unchanged stat reads nothing");
      text = json(only("Game 1"));
      mtime = 2;
      assert.isTrue(yield* watch.poll);
      assert.strictEqual(reads, 1);
      assert.deepStrictEqual(gamesOf(watch.config()), ["Game 1"]);
    }),
  );
});

const DIR = "/data";
const TOKEN = "twinsecrettoken0123456789";

/** Two games, one long drop and one live channel each: `chan0` plays game 0, `chan1` game 1. */
const scenario: Scenario = {
  latencySeed: 1,
  horizonMinutes: 1440,
  inventoryLagMinutes: 0,
  settings: { goals: [DEFAULT_GOAL_SPEC] },
  campaigns: [0, 1].map((game) => ({
    game,
    startMinute: -60,
    durationMinutes: 6000,
    linked: true,
    allowList: [],
    drops: [{ requiredMinutes: 900, after: null, benefit: "DIRECT_ENTITLEMENT" as const }],
  })),
  channels: [0, 1].map((game) => ({
    game,
    viewers: 100,
    dropsEnabled: true,
    refuses: false,
    liveAtStart: true,
    changes: [],
  })),
  faults: [],
};

interface Seen {
  readonly at: number;
  readonly kind: "usher" | "token" | "media" | "other";
  readonly url: string;
}

/**
 * `miner run` over the twin's whole wire for `hours`, with `config.json` in a memory file system
 * and the watch the CLI makes; `during(second)` may edit the file. The run is never restarted.
 */
const liveRun = (
  files: MemoryFiles,
  hours: number,
  during: (second: number) => void,
  logs = capture(),
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(SIM_EPOCH);
    const twin: Twin = makeTwin(buildWorld(scenario), { token: TOKEN, direct: true });
    yield* bindClock(twin);
    const twinClient = twinHttp(twin);
    const seen: Array<Seen> = [];
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const kind = body.includes("PlaybackAccessToken")
          ? "token"
          : request.url.includes("/api/channel/hls/")
            ? "usher"
            : request.url.includes("/v1/playlist/")
              ? "media"
              : "other";
        seen.push({ at: twin.now(), kind, url: request.url });
        return yield* twinClient.execute(request);
      }),
    );
    const services = Layer.mergeAll(
      liveLayer(DIR).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, http),
            Layer.succeed(
              Credentials,
              Credentials.of({ token: Redacted.make(TOKEN), deviceId: "0".repeat(32) }),
            ),
            Connector.webSocket.pipe(Layer.provide(webSocketConstructor(twin))),
            Gzip.layer,
            Layer.succeed(Instance, Instance.of({ version: "0.0.0-test", pid: 4242 })),
            files.layer,
          ),
        ),
      ),
      logs.layer,
    );
    const config = parse(JSON.parse(new TextDecoder().decode(files.files.get(FILE)!)));
    const watch = yield* makeConfigWatch(FILE, config).pipe(Effect.provide(files.layer));
    const fiber = yield* Effect.forkChild(run(watch).pipe(Effect.provide(services)));
    for (let t = 0; t < hours * 3600; t++) {
      during(t);
      yield* TestClock.adjust(1000);
    }
    assert.isUndefined(fiber.pollUnsafe(), "the runtime stopped by itself");
    yield* Fiber.interrupt(fiber);
    const text = new TextDecoder().decode(files.files.get(`${DIR}/${STATUS_FILE}`)!);
    const status = parseStatus(text);
    assert.strictEqual(status._tag, "Read");
    return { seen, status: status._tag === "Read" ? status.status : undefined, logs: logs.lines };
  });

const ushers = (seen: ReadonlyArray<Seen>, login: string) =>
  seen.filter((s) => s.kind === "usher" && new URL(s.url).pathname.endsWith(`/${login}.m3u8`));

/** Between hourly reads (validate, catalog), so only the reload moves anything. */
const EDIT_AT = 3600 + 17 * 60 + 3;
const edited = SIM_EPOCH + EDIT_AT * 1000;
/** The watch polls every `RELOAD_EVERY` from the start: the first poll after the edit. */
const polled = SIM_EPOCH + Math.ceil((EDIT_AT * 1000) / RELOAD_EVERY) * RELOAD_EVERY;

/** Media playlists of `login`, one per watch tick. */
const media = (seen: ReadonlyArray<Seen>, login: string) => {
  // A playlist URL doesn't name the channel; the usher answer before it does.
  const out: Array<Seen> = [];
  let current: string | undefined;
  for (const s of seen) {
    if (s.kind === "usher") current = new URL(s.url).pathname.split("/").at(-1);
    if (s.kind === "media" && current === `${login}.m3u8`) out.push(s);
  }
  return out;
};

describe("run reloads config.json", () => {
  it.effect(
    "a valid change re-plans at the next poll, without a restart",
    () =>
      Effect.gen(function* () {
        const files = memoryFileSystemWith(json(only("Game 0")));
        const { seen, status, logs } = yield* liveRun(files, 2, (t) => {
          if (t === EDIT_AT) write(files, json(only("Game 1")));
        });
        assert.isNotEmpty(ushers(seen, "chan0"));
        assert.isTrue(ushers(seen, "chan0").every((s) => s.at < edited));
        // The old watch stops at the poll: its last playlist is the tick before.
        const old = media(seen, "chan0");
        assert.isAtLeast(old.at(-1)!.at, polled - WATCH_INTERVAL);
        assert.isAtMost(old.at(-1)!.at, polled);
        // Game 1's channels were never read (the old config didn't want it): the directory is read
        // at the poll, not at the next catalog read (up to an hour) or `CATALOG_OPENING_GAP`.
        const first = ushers(seen, "chan1")[0];
        assert.isDefined(first, "the new game's channel is watched");
        assert.isAtLeast(first!.at, polled);
        assert.isAtMost(first!.at, polled + SUBSCRIBE_SETTLE + 15_000);
        assert.isAtLeast(media(seen, "chan1").length, (2 * 3600 - EDIT_AT) / 20 - 5);
        assert.strictEqual(status?.config?.reloadedAt, polled);
        assert.isNull(status?.config?.rejected);
        assert.deepInclude(status?.watch, {
          state: "watching",
          channel: { id: "ch1", login: "chan1" },
        });
        assert.isTrue(logs.some((l) => l.message === `config: reloaded ${FILE}`));
        assert.isFalse(logs.some((l) => l.level === "Warn" && l.message.startsWith("config:")));
      }),
    30_000,
  );

  it.effect(
    "an invalid change is ignored with a warning, and the watch goes on",
    () =>
      Effect.gen(function* () {
        const files = memoryFileSystemWith(json(only("Game 0")));
        const { seen, status, logs } = yield* liveRun(files, 2, (t) => {
          if (t === EDIT_AT) write(files, '{ "priorities": [ { "type": "drops", "games": "Game 1"');
        });
        assertWatchKept(seen);
        assert.isNull(status?.config?.reloadedAt);
        assert.strictEqual(status?.config?.rejected?.at, polled);
        assert.match(status?.config?.rejected?.problems[0] ?? "", /not valid JSON/);
        const warnings = logs.filter((l) => l.level === "Warn").map((l) => l.message);
        assert.isTrue(warnings.some((m) => m.includes("not valid JSON")));
        assert.isTrue(warnings.some((m) => m.includes("not reloaded")));
      }),
    30_000,
  );

  it.effect(
    "a change that keeps the plan does not restart the watch",
    () =>
      Effect.gen(function* () {
        const files = memoryFileSystemWith(json(only("Game 0")));
        const { seen, status } = yield* liveRun(files, 2, (t) => {
          // A note, an exclusion that matches nothing watched, and game 1 listed second.
          if (t === EDIT_AT)
            write(
              files,
              json({
                priorities: [
                  {
                    type: "drops",
                    note: "edited while running",
                    games: [{ name: "Game 0" }, { name: "Game 1" }],
                    exclude: { channels: ["someone_else"] },
                  },
                ],
              }),
            );
        });
        assert.strictEqual(status?.config?.reloadedAt, polled);
        assertWatchKept(seen);
      }),
    30_000,
  );
});

/**
 * One watch of `chan0` all along: a playlist every tick across the reload, and the playback
 * token and usher only on their usual cadence (about every 19 minutes), never at the reload.
 */
const assertWatchKept = (seen: ReadonlyArray<Seen>) => {
  assert.isEmpty(ushers(seen, "chan1"));
  const lists = media(seen, "chan0").map((s) => s.at);
  const around = lists.filter((at) => at >= edited - 60_000 && at <= polled + 60_000);
  assert.isAtLeast(around.length, 6);
  for (let i = 1; i < around.length; i++) assert.isAtMost(around[i]! - around[i - 1]!, 21_000);
  const tokens = seen.filter((s) => s.kind === "token").map((s) => s.at);
  assert.isFalse(
    tokens.some((at) => at >= polled - 1_000 && at <= polled + 2 * WATCH_INTERVAL),
    "no new playback token at the reload",
  );
  const gaps = tokens.slice(1).map((at, i) => at - tokens[i]!);
  for (const gap of gaps) assert.isAtLeast(gap, 15 * 60_000, "tokens only on their cadence");
};

const memoryFileSystemWith = (text: string) => {
  const files = memoryFileSystem();
  write(files, text);
  return files;
};
