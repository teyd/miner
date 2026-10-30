import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { Effect, Schema } from "effect";

/** Another miner holds the lock on this data directory. */
export class DataDirLocked extends Schema.TaggedError<
  DataDirLocked,
  { readonly brand: unique symbol }
>()("DataDirLocked", { path: Schema.String, pid: Schema.Finite }) {}

export const LOCK_FILE = "miner.lock";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const create = (path: string): boolean => {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
};

const holder = (path: string): number | undefined => {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * One miner per data directory: two on one state file would each send the claims the other
 * already sent, and Twitch counts one account's limits once (AGENTS.md: one live miner). The
 * lock is `$DATA_DIR/miner.lock` holding a pid, released when the scope closes. A lock whose
 * process is gone is stale and taken over, and so is one holding our own pid: a restarted
 * container runs as the same pid 1 after a crash.
 */
export const lockDataDir = (dir: string, isAlive: (pid: number) => boolean = alive) => {
  const path = `${dir}/${LOCK_FILE}`;
  const acquire = Effect.suspend(() => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (create(path)) return Effect.void;
      const pid = holder(path);
      if (pid !== undefined && pid !== process.pid && isAlive(pid)) {
        return Effect.fail(new DataDirLocked({ path, pid }));
      }
      try {
        unlinkSync(path);
      } catch {
        // Another process removed it first; the next attempt decides.
      }
    }
    return Effect.fail(new DataDirLocked({ path, pid: holder(path) ?? 0 }));
  });
  const release = Effect.sync(() => {
    if (holder(path) !== process.pid) return;
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  });
  return Effect.acquireRelease(acquire, () => release);
};
