import { constants, gunzipSync, gzipSync } from "node:zlib";
import { Context, Layer } from "effect";

export interface GzipService {
  readonly gzip: (data: Uint8Array) => Uint8Array;
  /**
   * Reads concatenated members too, as a recording holds one member per entry. A member torn
   * by a crash mid-write yields what it holds instead of failing the whole file.
   */
  readonly gunzip: (data: Uint8Array) => Uint8Array;
}

export const nodeGzip: GzipService = {
  gzip: (data) => new Uint8Array(gzipSync(data)),
  gunzip: (data) => new Uint8Array(gunzipSync(data, { finishFlush: constants.Z_SYNC_FLUSH })),
};

/**
 * Synchronous gzip. Synchronous on purpose: an entry is at most a capped body, compressing one
 * takes about a millisecond, and a call that never leaves the fiber keeps `TestClock` runs exact.
 */
export class Gzip extends Context.Service<Gzip, GzipService>()("miner/platform/Gzip") {
  static readonly layer = Layer.succeed(Gzip, Gzip.of(nodeGzip));
}
