import { Predicate } from "effect";
import type { State } from "../core/state.ts";

/**
 * Canonical JSON for core values: object keys sorted, Maps and Sets as sorted tagged entries,
 * `undefined` kept as a sentinel. Equal values give equal text whatever their insertion order, so
 * the text works as a trace line and as a saved state.
 */
export const canonical = (value: unknown): string => {
  if (value === undefined) return '{"$undefined":true}';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Map) {
    const entries = [...value].map(([k, v]) => `[${canonical(k)},${canonical(v)}]`).toSorted();
    return `{"$map":[${entries.join(",")}]}`;
  }
  if (value instanceof Set) return `{"$set":[${[...value].map(canonical).toSorted().join(",")}]}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).toSorted();
  const record = value as Record<string, unknown>;
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
};

const revive = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(revive);
  if (!Predicate.isObject(value)) return value;
  const record = value as Record<string, unknown>;
  if (record["$undefined"] === true) return undefined;
  if (Array.isArray(record["$map"])) {
    return new Map(
      (record["$map"] as ReadonlyArray<readonly [unknown, unknown]>).map(([k, v]) => [
        revive(k),
        revive(v),
      ]),
    );
  }
  if (Array.isArray(record["$set"])) return new Set((record["$set"] as Array<unknown>).map(revive));
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, revive(v)]));
};

/**
 * Bumped whenever `State` changes shape. A file with another version is refused rather than
 * guessed at: a misread claim intent could send a claim twice.
 */
export const STATE_VERSION = 1;

export const encodeState = (state: State): string =>
  `{"state":${canonical(state)},"version":${STATE_VERSION}}`;

/** Throws on text that isn't a saved state of this version. */
export const decodeState = (text: string): State => {
  const parsed: unknown = JSON.parse(text);
  if (!Predicate.isObject(parsed) || !("version" in parsed) || !("state" in parsed)) {
    throw new Error("not a saved miner state");
  }
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`state version ${String(parsed.version)}, this miner reads ${STATE_VERSION}`);
  }
  return revive(parsed.state) as State;
};
