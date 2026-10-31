import { Clock, Effect, FileSystem, Option } from "effect";
import { load, type Problem } from "../config/load.ts";
import type { Config } from "../config/schema.ts";
import type { Millis } from "../core/model.ts";
import { canonical } from "../store/codec.ts";
import type { ConfigFacts } from "../status/snapshot.ts";
import { unmapped } from "./settings.ts";

/** How often the running miner looks at `config.json`: one `stat`, no read unless it changed. */
export const RELOAD_EVERY: Millis = 10_000;

/**
 * What a `stat` says about the file: its modification time and size. A file system without
 * modification times (the tests' memory one) is fingerprinted by its content instead, so a
 * change is never missed, only read for.
 */
const fingerprint = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string> =>
  fs.stat(path).pipe(
    Effect.flatMap((info) =>
      Option.match(info.mtime, {
        onSome: (mtime) => Effect.succeed(`${mtime.getTime()}:${String(info.size)}`),
        onNone: () =>
          fs
            .readFileString(path)
            .pipe(Effect.map((text) => `content:${String(info.size)}:${text}`)),
      }),
    ),
    // Gone or unreadable is a state too: `load` says which when it changes.
    Effect.catch((e) => Effect.succeed(`error:${e.reason._tag}`)),
  );

const line = (path: string, p: Problem) => `${path}#${p.pointer}: ${p.message}`;

/**
 * `config.json` while the miner runs (decision 28: the file reloads). `poll` looks at the file
 * once: when it changed and decodes, its config replaces the current one and `poll` says `true`,
 * so the run loop steps the core with the new settings. An invalid or vanished file is logged
 * and refused: the miner keeps mining with the last good config, never stops and never falls
 * back to the defaults of a missing file (an editor that saves by rename can leave none for a
 * moment). The first fingerprint is taken when this is made, so the file the miner started with
 * is not reloaded.
 */
export const makeConfigWatch = (
  path: string,
  initial: Config,
): Effect.Effect<ConfigWatch, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let seen = yield* fingerprint(fs, path);
    let current = initial;
    let notes = new Set(unmapped(initial));
    let facts: ConfigFacts = { reloadedAt: undefined, rejected: undefined };

    const reject = (problems: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        facts = { ...facts, rejected: { at, problems } };
        for (const p of problems) yield* Effect.logWarning(`config: ${p}`);
        yield* Effect.logWarning(
          `config: ${path} not reloaded; mining goes on with the last valid config`,
        );
        return false;
      });

    const poll: Effect.Effect<boolean> = Effect.gen(function* () {
      const now = yield* fingerprint(fs, path);
      if (now === seen) return false;
      seen = now;
      const loaded = yield* load(path).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.catch((e) =>
          Effect.succeed({
            _tag: "Invalid",
            path,
            problems: [{ pointer: "", message: `cannot read the file: ${e.message}` }],
          } as const),
        ),
      );
      if (loaded._tag === "Missing") {
        return yield* reject([`${path}: the file is gone; restart the miner to use the defaults`]);
      }
      if (loaded._tag === "Invalid")
        return yield* reject(loaded.problems.map((p) => line(path, p)));
      if (facts.rejected !== undefined) {
        facts = { ...facts, rejected: undefined };
        yield* Effect.logInfo(`config: ${path} is valid again`);
      }
      for (const w of loaded.warnings) yield* Effect.logWarning(`config: ${line(path, w)}`);
      if (canonical(loaded.config) === canonical(current)) {
        yield* Effect.logDebug(`config: ${path} was written, nothing changed`);
        return false;
      }
      current = loaded.config;
      facts = { ...facts, reloadedAt: yield* Clock.currentTimeMillis };
      yield* Effect.logInfo(`config: reloaded ${path}`);
      const next = unmapped(current);
      for (const note of next) if (!notes.has(note)) yield* Effect.logWarning(`config: ${note}`);
      notes = new Set(next);
      return true;
    });

    return {
      poll,
      config: (): Config => current,
      facts: (): ConfigFacts => facts,
    };
  });

export interface ConfigWatch {
  readonly poll: Effect.Effect<boolean>;
  readonly config: () => Config;
  readonly facts: () => ConfigFacts;
}
