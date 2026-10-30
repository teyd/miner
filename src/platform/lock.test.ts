import { assert, describe, it } from "@effect/vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { LOCK_FILE, lockDataDir } from "./lock.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "miner-lock-"));

describe("lockDataDir", () => {
  it.effect("holds the directory for one miner and releases it with the scope", () =>
    Effect.gen(function* () {
      const dir = fresh();
      const scope = yield* Scope.make();
      yield* Scope.provide(lockDataDir(dir, undefined, "box"), scope);
      assert.strictEqual(readFileSync(join(dir, LOCK_FILE), "utf8"), `${process.pid} box\n`);
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(existsSync(join(dir, LOCK_FILE)));
    }),
  );

  it.effect("refuses while another live process holds it, and leaves its lock alone", () =>
    Effect.gen(function* () {
      const dir = fresh();
      writeFileSync(join(dir, LOCK_FILE), "424242\n");
      const error = yield* Effect.flip(Effect.scoped(lockDataDir(dir, () => true, "box")));
      assert.strictEqual(error._tag, "DataDirLocked");
      assert.strictEqual(error.pid, 424242);
      assert.strictEqual(readFileSync(join(dir, LOCK_FILE), "utf8"), "424242\n");
    }),
  );

  it.effect("takes over a stale lock: a dead process, our own pid, or garbage", () =>
    Effect.gen(function* () {
      for (const content of ["424242\n", `${process.pid}\n`, `${process.pid} box\n`, "not a pid"]) {
        const dir = fresh();
        writeFileSync(join(dir, LOCK_FILE), content);
        yield* Effect.scoped(
          Effect.andThen(
            lockDataDir(dir, () => false, "box"),
            () =>
              Effect.sync(() =>
                assert.strictEqual(
                  readFileSync(join(dir, LOCK_FILE), "utf8"),
                  `${process.pid} box\n`,
                ),
              ),
          ),
        );
        assert.isFalse(existsSync(join(dir, LOCK_FILE)));
      }
    }),
  );

  // Two containers on one ./data are both pid 1 (review of #23): the pid alone can't tell them apart.
  it.effect("refuses a lock from another host even with our pid, and releases only its own", () =>
    Effect.gen(function* () {
      const dir = fresh();
      writeFileSync(join(dir, LOCK_FILE), `${process.pid} other-container\n`);
      const error = yield* Effect.flip(Effect.scoped(lockDataDir(dir, () => false, "box")));
      assert.strictEqual(error._tag, "DataDirLocked");
      assert.strictEqual(error.host, "other-container");
      assert.strictEqual(
        readFileSync(join(dir, LOCK_FILE), "utf8"),
        `${process.pid} other-container\n`,
      );
    }),
  );
});
