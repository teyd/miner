import { Predicate } from "effect";

const SECRET_KEYS = new Set([
  "authorization",
  "token",
  "access_token",
  "accesstoken",
  // PubSub LISTEN and UNLISTEN carry the OAuth token here.
  "auth_token",
  "signature",
  "sig",
  "hdnts",
  "dna",
  "user_ip",
]);
/** `dna` signs each HLS segment URL (seen live 2026-10-30). */
const NAMES = "sig|token|hdnts|dna|signature|auth|auth_token|access_token|accesstoken";
/** `name=value` or URL-encoded `name%3Dvalue`, wherever it sits in a string. */
const PARAM_SECRET = new RegExp(
  String.raw`(?:\b|(?<=%3F|%26|%23))(${NAMES})(=|%3D)[^&#\s"']*`,
  "gi",
);
/** `"name": "value"` in a JSON document held as a string, escaped quotes included. */
const JSON_SECRET = new RegExp(
  String.raw`(\\?"(?:${NAMES}|authorization|user_ip)\\?"\s*:\s*\\?")[^"\\]*`,
  "gi",
);
const OAUTH = /\b(OAuth|Bearer)\s+[A-Za-z0-9._~+/=-]+/g;
/**
 * Twitch's playlist and segment URLs carry their signature in the path
 * (`/v1/playlist/CuUF….m3u8`, `/v1/segment/CvQC….ts`, `/trigger/CssF…`): any path segment this
 * long is an opaque credential (seen live 2026-10-30).
 */
const PATH_SECRET = /(?<=\/)[A-Za-z0-9_-]{64,}/g;
/** The master playlist names the viewer's IP and two opaque per-viewer values. */
const PLAYLIST_SECRET = /\b(USER-IP|C|E)=(\\?")[^"\\]*\\?"/g;

/**
 * Removes credentials from anything a recording holds: values under secret-looking keys,
 * secret query and fragment parameters in URLs, signed URL paths, the viewer's IP in a
 * playlist, and `OAuth`/`Bearer` tokens inside strings.
 * Twitch returns the signed playback token as `{ value, signature }`, so `value` is a secret
 * only next to a `signature`.
 */
export const redact = (input: unknown): unknown => {
  if (typeof input === "string") {
    return input
      .replace(PARAM_SECRET, "$1$2REDACTED")
      .replace(JSON_SECRET, "$1REDACTED")
      .replace(OAUTH, "$1 REDACTED")
      .replace(PATH_SECRET, "REDACTED")
      .replace(PLAYLIST_SECRET, "$1=$2REDACTED$2");
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

/**
 * The check a recording passes before it is written: the redacted line must be a fixed point of
 * `redact` (nothing left that a rule would still remove) and hold none of the known secrets, such
 * as the token itself. A line that fails is never written.
 */
export const isSealed = (line: string, secrets: ReadonlyArray<string>): boolean =>
  redact(line) === line && secrets.every((secret) => secret.length === 0 || !line.includes(secret));
