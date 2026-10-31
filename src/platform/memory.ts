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
