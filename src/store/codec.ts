import { Predicate } from "effect";
import { DEFAULT_GOAL } from "../core/model.ts";
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
 * guessed at: a misread claim intent could send a claim twice, so only a version with a
 * written migration is read. 2: `deadlines.subscribe`. 3: `discovery`, and `settings` as a list
 * of drops goals (2 migrates).
 */
export const STATE_VERSION = 3;

export const encodeState = (state: State): string =>
  `{"state":${canonical(state)},"version":${STATE_VERSION}}`;

/**
 * Version 2 to 3. Only `settings` changed shape, and the runtime maps them from `config.json`
 * before every step, so any valid value does: the default goal. Discovery starts empty, as after
 * a restart. Catalog, progress, claims and deadlines are kept as they are.
 */
const fromVersion2 = (state: Record<string, unknown>): Record<string, unknown> => ({
  ...state,
  settings: { goals: [DEFAULT_GOAL] },
  discovery: undefined,
});

/** Throws on text that isn't a saved state of this version, or of one it migrates (2). */
export const decodeState = (text: string): State => {
  const parsed: unknown = JSON.parse(text);
  if (!Predicate.isObject(parsed) || !("version" in parsed) || !("state" in parsed)) {
    throw new Error("not a saved miner state");
  }
  if (parsed.version === 2 && Predicate.isObject(parsed.state)) {
    return revive(fromVersion2(parsed.state as Record<string, unknown>)) as State;
  }
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`state version ${String(parsed.version)}, this miner reads ${STATE_VERSION}`);
  }
  return revive(parsed.state) as State;
};
