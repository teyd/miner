import { Clock, Context, Effect, FileSystem, Layer, Predicate } from "effect";

/** One Twitch answer as the miner saw it, so a run can be replayed without Twitch. */
export interface Entry {
  readonly at: number;
  readonly operation: string;
  readonly variables: unknown;
  readonly status: number;
  readonly body: unknown;
}

/**
 * Records every Twitch answer at the seam. Recordings feed replay and calibrate the simulator
 * (research 04 §3). They go into issues, so they never hold a secret (see `redact`).
 */
export class Journal extends Context.Service<
  Journal,
  { readonly record: (entry: Omit<Entry, "at">) => Effect.Effect<void> }
>()("miner/twitch/Journal") {
  static readonly none = Layer.succeed(Journal, Journal.of({ record: () => Effect.void }));

  /** Appends one redacted JSON line per answer. A failed write is logged, never fatal. */
  static readonly file = (path: string) =>
    Layer.effect(
      Journal,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return Journal.of({
          record: (entry) =>
            Effect.gen(function* () {
              const at = yield* Clock.currentTimeMillis;
              const line = `${JSON.stringify(redact({ at, ...entry }))}\n`;
              yield* fs.writeFileString(path, line, { flag: "a" });
            }).pipe(Effect.catch((error) => Effect.logWarning("journal: write failed", error))),
        });
      }),
    );
}

const SECRET_KEYS = new Set([
  "authorization",
  "token",
  "access_token",
  "accesstoken",
  "signature",
  "sig",
  "hdnts",
]);
const NAMES = "sig|token|hdnts|signature|auth|access_token|accesstoken";
/** `name=value` or URL-encoded `name%3Dvalue`, wherever it sits in a string. */
const PARAM_SECRET = new RegExp(
  String.raw`(?:\b|(?<=%3F|%26|%23))(${NAMES})(=|%3D)[^&#\s"']*`,
  "gi",
);
/** `"name": "value"` in a JSON document held as a string, escaped quotes included. */
const JSON_SECRET = new RegExp(
  String.raw`(\\?"(?:${NAMES}|authorization)\\?"\s*:\s*\\?")[^"\\]*`,
  "gi",
);
const OAUTH = /\b(OAuth|Bearer)\s+[A-Za-z0-9._~+/=-]+/g;

/**
 * Removes credentials from anything a recording holds: values under secret-looking keys,
 * secret query and fragment parameters in URLs, and `OAuth`/`Bearer` tokens inside strings.
 * Twitch returns the signed playback token as `{ value, signature }`, so `value` is a secret
 * only next to a `signature`.
 */
export const redact = (input: unknown): unknown => {
  if (typeof input === "string") {
    return input
      .replace(PARAM_SECRET, "$1$2REDACTED")
      .replace(JSON_SECRET, "$1REDACTED")
      .replace(OAUTH, "$1 REDACTED");
  }
  if (Array.isArray(input)) return input.map(redact);
  if (Predicate.isObject(input)) {
    const signed = "signature" in input;
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => {
        const secret = SECRET_KEYS.has(key.toLowerCase()) || (signed && key === "value");
        return [key, secret && typeof value === "string" ? "REDACTED" : redact(value)];
      }),
    );
  }
  return input;
};
