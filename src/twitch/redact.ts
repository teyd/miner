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
]);
const NAMES = "sig|token|hdnts|signature|auth|auth_token|access_token|accesstoken";
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

/**
 * The check a recording passes before it is written: the redacted line must be a fixed point of
 * `redact` (nothing left that a rule would still remove) and hold none of the known secrets, such
 * as the token itself. A line that fails is never written.
 */
export const isSealed = (line: string, secrets: ReadonlyArray<string>): boolean =>
  redact(line) === line && secrets.every((secret) => secret.length === 0 || !line.includes(secret));
