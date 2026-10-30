import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import type { State } from "../core/state.ts";
import { decodeState, encodeState } from "./codec.ts";

/** The saved state exists but can't be read. Starting fresh would forget claims in flight. */
export class StateUnreadable extends Schema.TaggedError<
  StateUnreadable,
  { readonly brand: unique symbol }
>()("StateUnreadable", { path: Schema.String, detail: Schema.String }) {}

/** The state could not be written, so its commands must not run. */
export class StateNotSaved extends Schema.TaggedError<
  StateNotSaved,
  { readonly brand: unique symbol }
>()("StateNotSaved", { path: Schema.String, detail: Schema.String }) {}

/** The core's state on disk. The runtime saves it before it runs the commands of a step. */
export class Store extends Context.Service<
  Store,
  {
    readonly load: Effect.Effect<Option.Option<State>, StateUnreadable>;
    readonly save: (state: State) => Effect.Effect<void, StateNotSaved>;
  }
>()("miner/store/Store") {
  /**
   * One JSON file, replaced atomically: written to `<path>.tmp`, flushed to disk, then renamed
   * over the old file, so a crash leaves the old state or the new one, never half of either.
   */
  static readonly file = (path: string) =>
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tmp = `${path}.tmp`;
        const load = Effect.gen(function* () {
          const unreadable = (detail: string) => new StateUnreadable({ path, detail });
          const exists = yield* fs.exists(path).pipe(Effect.mapError((e) => unreadable(e.message)));
          if (!exists) return Option.none();
          const text = yield* fs
            .readFileString(path)
            .pipe(Effect.mapError((e) => unreadable(e.message)));
          return yield* Effect.try({
            try: () => Option.some(decodeState(text)),
            catch: (e) => unreadable(e instanceof Error ? e.message : String(e)),
          });
        });
        const save = (state: State) =>
          Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(tmp, { flag: "w" });
              yield* file.writeAll(new TextEncoder().encode(encodeState(state)));
              yield* file.sync;
            }),
          ).pipe(
            Effect.andThen(fs.rename(tmp, path)),
            Effect.mapError((e) => new StateNotSaved({ path, detail: e.message })),
          );
        return Store.of({ load, save });
      }),
    );
}
