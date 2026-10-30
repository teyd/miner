import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { configPath, dataDir } from "../config/load.ts";
import { load } from "../config/load.ts";
import { Gzip } from "../platform/Gzip.ts";
import { run as runtime } from "../runtime/run.ts";
import { unmapped } from "../runtime/settings.ts";
import { SHADOW_STATE, shadowLayer } from "../runtime/shadow.ts";
import { Connector } from "../twitch/PubSub.ts";
import { Credentials } from "../twitch/Twitch.ts";
import { ConfigInvalid } from "./config.ts";

/** `run` without `--shadow`: nothing can watch or claim yet. Exit code 2, like a usage error. */
export class RunRefused extends Schema.TaggedError<RunRefused, { readonly brand: unique symbol }>()(
  "RunRefused",
  {},
) {}

/** The run stopped: no token, or the state file can't be read or written. Exit code 1. */
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
    if (!shadow) {
      yield* Console.log(
        "miner run needs --shadow for now: watching and claiming are not built yet, so a run " +
          "can only read Twitch and record what it would do.",
      );
      return yield* new RunRefused();
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.resolve(yield* dataDir);
    const loaded = yield* load(yield* configPath);
    if (loaded._tag === "Invalid") {
      for (const p of loaded.problems)
        yield* Console.log(`${loaded.path}#${p.pointer}: ${p.message}`);
      return yield* new ConfigInvalid({ path: loaded.path });
    }
    for (const note of unmapped(loaded.config)) yield* Effect.logWarning(`config: ${note}`);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* Effect.logInfo(
      `shadow run: state in ${path.join(dir, SHADOW_STATE)}, recordings in ${path.join(dir, "recordings")}`,
    );
    const services = shadowLayer(dir).pipe(
      Layer.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          Credentials.layer,
          Gzip.layer,
          Connector.webSocket.pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
        ),
      ),
    );
    return yield* runtime(loaded.config).pipe(
      Effect.provide(services),
      Effect.catchTags({
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
    "Run the miner. Only --shadow exists yet: real token, real reads, real planning; watch and " +
      "claim are recorded to $DATA_DIR/recordings, never sent.",
  ),
  Command.withExamples([
    { command: "miner run --shadow", description: "A read-only run that records what it would do" },
  ]),
);
