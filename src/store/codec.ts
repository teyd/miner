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
 * of drops goals (2 migrates). 4: `awarded`, `inventoried`, `avoidCampaigns`, `skipCauses` and
 * the watch's `wasted` (2 and 3 migrate). A file of the unmerged first version 4, which saved
 * `avoidCampaigns` as a set, reads with nothing avoided: a start resets both anyway.
 */
export const STATE_VERSION = 4;

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

/**
 * Version 3 to 4. Received rewards come with the next inventory read, which a start asks for, and
 * nothing is avoided yet. A saved watch gets no `wasted`; a start resets the watch anyway.
 */
const fromVersion3 = (state: Record<string, unknown>): Record<string, unknown> => ({
  ...state,
  awarded: new Map(),
  inventoried: new Set(),
  avoidCampaigns: new Map(),
  skipCauses: new Map(),
  watch:
    Predicate.isObject(state["watch"]) && state["watch"]["_tag"] === "Watching"
      ? { ...state["watch"], wasted: undefined }
      : state["watch"],
});

/** Throws on text that isn't a saved state of this version, or of one it migrates (2, 3). */
export const decodeState = (text: string): State => {
  const parsed: unknown = JSON.parse(text);
  if (!Predicate.isObject(parsed) || !("version" in parsed) || !("state" in parsed)) {
    throw new Error("not a saved miner state");
  }
  if (parsed.version === 2 || parsed.version === 3) {
    if (!Predicate.isObject(parsed.state) || Array.isArray(parsed.state)) {
      throw new Error("not a saved miner state");
    }
    const state = revive(parsed.state) as Record<string, unknown>;
    return checked(fromVersion3(parsed.version === 2 ? fromVersion2(state) : state));
  }
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`state version ${String(parsed.version)}, this miner reads ${STATE_VERSION}`);
  }
  const state = revive(parsed.state);
  if (Predicate.isObject(state) && state["avoidCampaigns"] instanceof Set) {
    return checked({ ...state, avoidCampaigns: new Map(), skipCauses: new Map() });
  }
  return checked(state);
};

type Check = (value: unknown) => boolean;

// `canonical` writes Infinity as null, which the next load would refuse.
const isNumber: Check = (v) => typeof v === "number" && Number.isFinite(v);
const isString: Check = (v) => typeof v === "string";
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v);
const oneOf =
  (...values: ReadonlyArray<string>): Check =>
  (v) =>
    typeof v === "string" && values.includes(v);
const arrayOf =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);
const mapOf =
  (key: Check, value: Check): Check =>
  (v) =>
    v instanceof Map && [...v].every(([k, x]) => key(k) && value(x));
const setOf =
  (check: Check): Check =>
  (v) =>
    v instanceof Set && [...v].every(check);
/** Every key present (an `undefined` field is saved as a sentinel, so it is present too). */
const record =
  (fields: Record<string, Check>): Check =>
  (v) =>
    Predicate.isObject(v) &&
    Object.entries(fields).every(
      ([k, check]) => k in v && check((v as Record<string, unknown>)[k]),
    );
const isObject: Check = (v) => Predicate.isObject(v);

const claimIntent = record({
  campaignId: isString,
  dropId: isString,
  status: oneOf("sent", "unknown"),
  recheckAt: optional(isNumber),
});

const progressOf = record({
  dropId: isString,
  campaignId: isString,
  campaignEndsAt: isNumber,
  minutes: isNumber,
  instanceId: optional(isString),
  claimed: (v) => typeof v === "boolean",
});

/**
 * The fields of `State`, deep where a misread could cost a claim (claims, progress, deadlines)
 * and by kind elsewhere. A file that parses but lacks them is refused like any unreadable state:
 * starting from a half state would forget claims in flight.
 */
const fields: { readonly [K in keyof State]-?: Check } = {
  settings: record({ goals: arrayOf(isObject) }),
  auth: oneOf("unknown", "valid", "needs-login"),
  catalog: optional(arrayOf(isObject)),
  catalogStatus: oneOf("unknown", "ok", "unavailable"),
  progress: mapOf(isString, progressOf),
  awarded: mapOf(isString, isNumber),
  inventoried: setOf(isString),
  channels: mapOf(isString, isObject),
  avoid: (v) => v instanceof Set,
  avoidCampaigns: mapOf(isString, isNumber),
  skipCauses: mapOf(isString, isString),
  watch: (v) => record({ _tag: oneOf("Watching", "Idle") })(v),
  claims: mapOf(isString, claimIntent),
  subscriptions: arrayOf(isString),
  discovery: optional(record({ pending: arrayOf(isString), until: isNumber })),
  deadlines: record({
    validate: isNumber,
    catalog: isNumber,
    inventory: isNumber,
    tick: optional(isNumber),
    online: mapOf(isString, isNumber),
    subscribe: optional(isNumber),
  }),
};

const checked = (state: unknown): State => {
  if (!Predicate.isObject(state)) throw new Error("not a saved miner state");
  const saved = state as Record<string, unknown>;
  for (const [key, check] of Object.entries(fields)) {
    if (!(key in saved) || !check(saved[key])) {
      throw new Error(`not a saved miner state: \`${key}\` is missing or malformed`);
    }
  }
  return saved as unknown as State;
};
