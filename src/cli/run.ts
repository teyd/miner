import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { configPath, dataDir } from "../config/load.ts";
import { load } from "../config/load.ts";
import { Gzip } from "../platform/Gzip.ts";
import { makeConfigWatch } from "../runtime/reload.ts";
import { fingerprint } from "../runtime/reload.ts";
import { run as runtime } from "../runtime/run.ts";
import { unmapped } from "../runtime/settings.ts";
import { LIVE_STATE, liveLayer } from "../runtime/live.ts";
import { SHADOW_STATE, shadowLayer } from "../runtime/shadow.ts";
import { Instance } from "../platform/instance.ts";
import { lockDataDir } from "../platform/lock.ts";
import { Connector } from "../twitch/PubSub.ts";
import { Credentials } from "../twitch/Twitch.ts";
import { ConfigInvalid } from "./config.ts";

/**
 * The run stopped: no token, another miner on the data directory, or the state file can't be
 * read or written. Exit code 1.
 */
export class RunFailed extends Schema.TaggedError<RunFailed, { readonly brand: unique symbol }>()(
  "RunFailed",
  { reason: Schema.String },
) {}

export const run = Command.make(
  "run",
  {
    shadow: Flag.Boolean("shadow").pipe(
      Flag.withDescription(
        "Read Twitch and plan for real, but only record what would be watched and claimed",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ shadow }) {
    // Before the services are built: the run is the miner's one long-lived process.
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.resolve(yield* dataDir);
    const file = yield* configPath;
    // Before the read: an edit made in between is then still seen as a change (review of C3).
    const baseline = yield* fingerprint(fs, file).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    const loaded = yield* load(file);
    if (loaded._tag === "Invalid") {
      for (const p of loaded.problems)
        yield* Console.log(`${loaded.path}#${p.pointer}: ${p.message}`);
      return yield* new ConfigInvalid({ path: loaded.path });
    }
    for (const note of unmapped(loaded.config)) yield* Effect.logWarning(`config: ${note}`);
    yield* fs.makeDirectory(dir, { recursive: true });
    const state = path.join(dir, shadow ? SHADOW_STATE : LIVE_STATE);
    yield* Effect.logInfo(
      `${shadow ? "shadow" : "live"} run: state in ${state}, recordings in ${path.join(dir, "recordings")}`,
    );
    const services = (shadow ? shadowLayer(dir) : liveLayer(dir)).pipe(
      Layer.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          Credentials.layer,
          Gzip.layer,
          Instance.layer,
          Connector.webSocket.pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
        ),
      ),
    );
    // The file reloads while the miner runs (decision 28); a bad edit is logged and ignored.
    const config = yield* makeConfigWatch(loaded.path, loaded.config, baseline);
    return yield* runtime(config).pipe(
      Effect.provide(services),
      // Shadow runs count as the one live miner too (AGENTS.md), so both modes take the lock.
      (effect) => Effect.andThen(lockDataDir(dir), effect),
      Effect.scoped,
      Effect.catchTags({
        DataDirLocked: (e) =>
          Effect.fail(
            new RunFailed({
              reason: `another miner (pid ${e.pid} on ${e.host}) runs on ${dir}; stop it first, or remove ${e.path} if none runs`,
            }),
          ),
        AuthRejected: (e) => Effect.fail(new RunFailed({ reason: e.reason })),
        StateUnreadable: (e) =>
          Effect.fail(
            new RunFailed({
              reason: `${e.path} can't be read (${e.detail}); move it away to start fresh`,
            }),
          ),
        StateNotSaved: (e) => Effect.fail(new RunFailed({ reason: `${e.path}: ${e.detail}` })),
        RunStuck: (e) =>
          Effect.fail(
            new RunFailed({
              reason: `the core stepped ${e.steps} times at ${e.at} ms without time moving (a bug, please report it)`,
            }),
          ),
      }),
      Effect.tapError((e) => Console.log(`run stopped: ${e.reason}`)),
    );
  }),
).pipe(
  Command.withDescription(
    "Run the miner: watch and claim drops for the account of $TOKEN, with state in " +
      "$DATA_DIR/state.json. With --shadow, real reads and real planning, but watch and claim " +
      "are recorded to $DATA_DIR/recordings, never sent. One miner per data directory.",
  ),
  Command.withExamples([
    { command: "miner run", description: "Mine drops" },
    { command: "miner run --shadow", description: "A read-only run that records what it would do" },
  ]),
);
