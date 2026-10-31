import * as v8 from "node:v8";
import * as vm from "node:vm";
import { Effect } from "effect";

/** `process.memoryUsage()` after a full garbage collection, in bytes. */
export interface MemorySample {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
}

let collector: (() => void) | undefined;

/** `gc()`, without needing `node --expose-gc`: exposing it late is what V8's own tests do. */
const collect = (): void => {
  if (collector === undefined) {
    const exposed = (globalThis as { gc?: () => void }).gc;
    if (exposed === undefined) v8.setFlagsFromString("--expose-gc");
    collector = exposed ?? (vm.runInNewContext("gc") as () => void);
  }
  collector();
};

export const sample: Effect.Effect<MemorySample> = Effect.sync(() => {
  // Twice: the first collection's finalizers may free more.
  collect();
  collect();
  const { rss, heapUsed, heapTotal, external } = process.memoryUsage();
  return { rss, heapUsed, heapTotal, external };
});

/**
 * V8 flags for a process that idles between small bursts for days (research 03 §2): size over
 * speed for the heap, and only the interpreter: the compilers' code, and the pages of the `node`
 * binary they run from, cost 13 MB of RSS for CPU the miner doesn't use. WebAssembly still
 * compiles, which `fetch` needs (`--jitless` would stop it).
 *
 * These go on node's command line, before it starts: `v8.setFlagsFromString` after startup is
 * documented as possibly unpredictable, and the mining path does not gamble on V8 internals. The
 * Dockerfile, `deploy/miner.service` and README's plain-node line all pass them.
 */
export const LEAN_V8_FLAGS = [
  "--optimize-for-size",
  "--no-opt",
  "--no-maglev",
  "--no-sparkplug",
] as const;
