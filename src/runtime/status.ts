import { Cause, Clock, Context, Effect, FileSystem, Layer } from "effect";
import type { Millis } from "../core/model.ts";
import type { State } from "../core/state.ts";
import { Instance } from "../platform/instance.ts";
import { encodeStatusFile, HEARTBEAT_SECONDS, type StatusFile } from "../status/schema.ts";
import { changeKey, snapshot, type Meta, type RunFacts } from "../status/snapshot.ts";
import { PubSub } from "../twitch/PubSub.ts";

/** `$DATA_DIR/status.json`, which `miner status` reads. */
export const STATUS_FILE = "status.json";

export const HEARTBEAT: Millis = HEARTBEAT_SECONDS * 1000;
/**
 * A change waits this long after the last write, so the burst of answers after a catalog read
 * (reads start 300 ms apart) ends in one write, not one per answer.
 */
export const MIN_GAP: Millis = 2000;

/** Where the status goes. Writing never fails the run: the miner mines without a status file. */
export class StatusSink extends Context.Service<
  StatusSink,
  {
    readonly meta: Meta;
    readonly write: (status: StatusFile) => Effect.Effect<void>;
  }
>()("miner/runtime/StatusSink") {
  /**
   * One JSON file, replaced by rename so a reader sees the old document or the new one, never
   * half. No fsync: the file is rewritten every 30 s and a lost one only looks stale.
   */
  static readonly file = (path: string, mode: Meta["mode"]) =>
    Layer.effect(
      StatusSink,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { version, pid } = yield* Instance;
        const tmp = `${path}.tmp`;
        let failing = false;
        const write = (status: StatusFile) =>
          Effect.suspend(() =>
            fs.writeFileString(tmp, `${JSON.stringify(encodeStatusFile(status), null, 2)}\n`),
          ).pipe(
            Effect.andThen(fs.rename(tmp, path)),
            Effect.andThen(
              Effect.suspend(() => {
                if (!failing) return Effect.void;
                failing = false;
                return Effect.logInfo(`status: writing ${path} again`);
              }),
            ),
            // Logged once per run of failures, not every heartbeat.
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause) || failing) return Effect.void;
              failing = true;
              return Effect.logWarning(`status: can't write ${path}; mining goes on`, cause);
            }),
          );
        return StatusSink.of({ meta: { version, pid, mode }, write });
      }),
    );
}

/**
 * Decides when the run loop writes the status: on a change, at most every `MIN_GAP`, and
 * otherwise every `HEARTBEAT`. It lives in the scheduler fiber, so the heartbeat also proves the
 * loop is alive; a hung loop goes stale.
 */
export const makeReporter = Effect.gen(function* () {
  const sink = yield* StatusSink;
  const pubsub = yield* PubSub;
  let written: string | undefined;
  let writtenAt = -Infinity;
  let dirty = true;

  const build = (state: State, facts: RunFacts, now: Millis, stoppedAt?: Millis) =>
    Effect.map(pubsub.status, (sockets) =>
      snapshot({ state, facts, meta: sink.meta, sockets, now, stoppedAt }),
    );

  const due = (): Millis => writtenAt + (dirty ? MIN_GAP : HEARTBEAT);

  const update = (state: State, facts: RunFacts, now: Millis) =>
    Effect.gen(function* () {
      const status = yield* build(state, facts, now);
      const key = changeKey(status);
      dirty = key !== written;
      if (now < due()) return;
      written = key;
      writtenAt = now;
      dirty = false;
      yield* sink.write(status);
    });

  /** The last write: a clean stop, so `miner status` says "not running" at once. */
  const stop = (state: State, facts: RunFacts) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sink.write(yield* build(state, facts, now, now));
    });

  return { update, due, stop };
});
