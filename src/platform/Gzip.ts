import { constants, gunzipSync, gzipSync } from "node:zlib";
import { Context, Layer } from "effect";

export interface GzipService {
  readonly gzip: (data: Uint8Array) => Uint8Array;
  /**
   * Reads concatenated members too, as a recording holds one member per entry. A member torn
   * by a crash mid-write yields what it holds instead of failing the whole file, wherever it
   * sits: after a restart the recorder appends behind it.
   */
  readonly gunzip: (data: Uint8Array) => Uint8Array;
}

/**
 * How every member `gzipSync` writes begins: magic, deflate, no flags, mtime 0. Eight fixed
 * bytes, so a match inside compressed data is a 2^-64 event per offset.
 */
const MEMBER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
const NEWLINE = 0x0a;

/**
 * Inflates each member on its own. One pass over the concatenation is not enough: a torn member
 * followed by more members can end the pass early without an error, losing every later line.
 * A member that fails yields nothing, and a torn one's text gets a newline, so it can't run into
 * the next line.
 */
const memberByMember = (data: Uint8Array): Uint8Array => {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.length);
  const starts: Array<number> = [];
  for (let at = bytes.indexOf(MEMBER); at !== -1; at = bytes.indexOf(MEMBER, at + 1)) {
    starts.push(at);
  }
  // Not ours (another writer's header): one pass, as gunzip would.
  if (starts[0] !== 0) starts.unshift(0);
  const parts: Array<Uint8Array> = [];
  for (const [n, start] of starts.entries()) {
    let text: Uint8Array;
    try {
      text = gunzipSync(bytes.subarray(start, starts[n + 1] ?? bytes.length), {
        finishFlush: constants.Z_SYNC_FLUSH,
      });
    } catch {
      continue;
    }
    if (text.length === 0) continue;
    parts.push(text);
    if (text[text.length - 1] !== NEWLINE) parts.push(Uint8Array.of(NEWLINE));
  }
  return new Uint8Array(Buffer.concat(parts));
};

export const nodeGzip: GzipService = {
  gzip: (data) => new Uint8Array(gzipSync(data)),
  gunzip: memberByMember,
};

/**
 * Synchronous gzip. Synchronous on purpose: an entry is at most a capped body, compressing one
 * takes about a millisecond, and a call that never leaves the fiber keeps `TestClock` runs exact.
 */
export class Gzip extends Context.Service<Gzip, GzipService>()("miner/platform/Gzip") {
  static readonly layer = Layer.succeed(Gzip, Gzip.of(nodeGzip));
}
