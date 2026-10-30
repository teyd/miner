import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { Effect, Schema } from "effect";

/** Another miner holds the lock on this data directory. */
export class DataDirLocked extends Schema.TaggedError<
  DataDirLocked,
  { readonly brand: unique symbol }
>()("DataDirLocked", { path: Schema.String, pid: Schema.Finite, host: Schema.String }) {}

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

interface Holder {
  readonly pid: number;
  /** Docker gives each container its own hostname (its id), and every container is pid 1. */
  readonly host: string | undefined;
}

const create = (path: string, host: string): boolean => {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, `${process.pid} ${host}\n`);
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
};

const holder = (path: string): Holder | undefined => {
  try {
    const [pidText, host] = readFileSync(path, "utf8").trim().split(/\s+/);
    const pid = Number.parseInt(pidText ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? { pid, host } : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether the lock still binds us. On our host the pid decides: ours means a restart of the same
 * container (pid 1 again), a dead one means a crash. Another host's pid can't be checked from
 * here, so its lock holds until that miner stops or a person removes the file. A lock without a
 * host comes from an older version and is read as ours.
 */
const held = (h: Holder, host: string, isAlive: (pid: number) => boolean): boolean =>
  h.host !== undefined && h.host !== host ? true : h.pid !== process.pid && isAlive(h.pid);

/**
 * One miner per data directory: two on one state file would each send the claims the other
 * already sent, and Twitch counts one account's limits once (AGENTS.md: one live miner). The
 * lock is `$DATA_DIR/miner.lock` holding `<pid> <hostname>`, released when the scope closes.
 */
export const lockDataDir = (
  dir: string,
  isAlive: (pid: number) => boolean = alive,
  host: string = hostname(),
) => {
  const path = `${dir}/${LOCK_FILE}`;
  const acquire = Effect.suspend(() => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (create(path, host)) return Effect.void;
      const h = holder(path);
      if (h !== undefined && held(h, host, isAlive)) {
        return Effect.fail(new DataDirLocked({ path, pid: h.pid, host: h.host ?? host }));
      }
      try {
        unlinkSync(path);
      } catch {
        // Another process removed it first; the next attempt decides.
      }
    }
    const h = holder(path);
    return Effect.fail(new DataDirLocked({ path, pid: h?.pid ?? 0, host: h?.host ?? host }));
  });
  const release = Effect.sync(() => {
    const h = holder(path);
    if (h === undefined || h.pid !== process.pid || (h.host !== undefined && h.host !== host))
      return;
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  });
  return Effect.acquireRelease(acquire, () => release);
};
