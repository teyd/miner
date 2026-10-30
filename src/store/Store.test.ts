import { assert, describe, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, FileSystem, Option } from "effect";
import { settings } from "../core/fixtures.ts";
import { initial, type State } from "../core/state.ts";
import { encodeState } from "./codec.ts";
import { memoryFileSystem } from "./memoryFileSystem.ts";
import { Store } from "./Store.ts";

const state: State = { ...initial(settings()), auth: "valid", catalogStatus: "ok" };

const withStore = <A, E>(path: string, use: (store: Store["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* Store);
  }).pipe(Effect.provide(Store.file(path)));

describe("Store.file", () => {
  it.effect("loads nothing before the first save, then what was saved", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      const loaded = yield* withStore("/d/state.json", (store) =>
        Effect.gen(function* () {
          assert.isTrue(Option.isNone(yield* store.load));
          yield* store.save(state);
          return yield* store.load;
        }),
      ).pipe(Effect.provide(files.layer));
      assert.deepStrictEqual(Option.getOrThrow(loaded), state);
      assert.deepStrictEqual([...files.files.keys()], ["/d/state.json"]);
    }),
  );

  it.effect("refuses a state of another version instead of starting fresh", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      const text = encodeState(state).replace('"version":1', '"version":9');
      files.files.set("/d/state.json", new TextEncoder().encode(text));
      const error = yield* withStore("/d/state.json", (store) => store.load).pipe(
        Effect.provide(files.layer),
        Effect.flip,
      );
      assert.strictEqual(error._tag, "StateUnreadable");
      assert.match(error.detail, /version 9/);
    }),
  );

  it.effect("fails a save the disk refuses, and keeps the old state", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      const old = encodeState(state);
      files.files.set("/d/state.json", new TextEncoder().encode(old));
      files.failWrites = true;
      const error = yield* withStore("/d/state.json", (store) =>
        store.save({ ...state, auth: "needs-login" }),
      ).pipe(Effect.provide(files.layer), Effect.flip);
      assert.strictEqual(error._tag, "StateNotSaved");
      assert.strictEqual(new TextDecoder().decode(files.files.get("/d/state.json")), old);
    }),
  );

  it.effect("saves through a real file system: write, flush, rename", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/state.json`;
      const loaded = yield* withStore(path, (store) =>
        Effect.andThen(store.save(state), store.load),
      );
      assert.deepStrictEqual(Option.getOrThrow(loaded), state);
      assert.deepStrictEqual(yield* fs.readDirectory(dir), ["state.json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
