import { assert, describe, it } from "@effect/vitest";
import {
  campaign,
  channel,
  chid,
  cid,
  did,
  games,
  iid,
  progress,
  settings,
  T0,
} from "../core/fixtures.ts";
import { DEFAULT_GOAL, MINUTE } from "../core/model.ts";
import { initial, type State, type Watching } from "../core/state.ts";
import { canonical, decodeState, encodeState } from "./codec.ts";

const c = campaign("c");

const watching: Watching = {
  _tag: "Watching",
  channelId: chid("a"),
  campaignId: cid("c"),
  dropId: did("c-d2"),
  credited: true,
  confirmedAt: T0,
  confirmedMinutes: 3,
  estimatedMinutes: 4,
  lastCurrentDropRead: undefined,
  wasted: did("c-d1"),
};

/** Every kind of value `State` holds: Maps, Sets, `undefined` fields, both claim statuses. */
const populated: State = {
  ...initial(settings({ games: games([c.game.id], ["badge"]), excludeChannels: [chid("x")] })),
  auth: "needs-login",
  catalog: [c],
  catalogStatus: "unavailable",
  discovery: { pending: ["directory:game-1"], until: 5 },
  progress: new Map([
    [did("c-d1"), progress(c, "c-d1", { minutes: 60, instanceId: iid("i1") })],
    [did("c-d2"), progress(c, "c-d2", { minutes: 3 })],
  ]),
  channels: new Map([
    [chid("a"), channel("a", { viewers: 500 })],
    [chid("b"), channel("b", "offline")],
  ]),
  awarded: new Map([
    ["b-badge", T0 - 60 * MINUTE],
    ["b-item", T0 - 120 * MINUTE],
  ]),
  inventoried: new Set([did("c-d1"), did("c-d2")]),
  avoid: new Set([chid("z"), chid("y")]),
  avoidCampaigns: new Map([
    [cid("old"), T0 + 30 * MINUTE],
    [cid("stuck"), T0 + 60 * MINUTE],
  ]),
  skipCauses: new Map([
    [cid("old"), did("old-d1")],
    [cid("stuck"), did("stuck-d2")],
  ]),
  watch: watching,

  claims: new Map([
    ["c/c-d1", { campaignId: cid("c"), dropId: did("c-d1"), status: "sent", recheckAt: undefined }],
    ["c/c-d0", { campaignId: cid("c"), dropId: did("c-d0"), status: "unknown", recheckAt: T0 }],
  ]),
  subscriptions: [chid("a"), chid("b")],
  deadlines: {
    validate: T0 + 60 * MINUTE,
    catalog: T0 + 5 * MINUTE,
    inventory: T0 + MINUTE,
    tick: undefined,
    online: new Map([[chid("b"), T0 + 2 * MINUTE]]),
    subscribe: T0 + 10_000,
  },
};

describe("codec", () => {
  it("round-trips a fully populated state", () => {
    const text = encodeState(populated);
    const decoded = decodeState(text);
    assert.deepStrictEqual(decoded, populated);
    assert.isTrue("tick" in decoded.deadlines);
    assert.isUndefined(decoded.deadlines.tick);
    assert.strictEqual(encodeState(decoded), text);
  });

  it("encodes canonically: insertion order changes nothing", () => {
    const reordered: State = {
      ...populated,
      progress: new Map([...populated.progress].toReversed()),
      avoid: new Set([...populated.avoid].toReversed()),
      claims: new Map([...populated.claims].toReversed()),
    };
    assert.strictEqual(encodeState(reordered), encodeState(populated));
    assert.strictEqual(
      canonical({ b: 1, a: [2, undefined] }),
      canonical({ a: [2, undefined], b: 1 }),
    );
  });
});

/** The watch as version 3 saved it, without `wasted`. */
const watch3 = (): unknown => {
  const { wasted: _, ...watch } = watching;
  return watch;
};

/**
 * A state file as version 2 wrote it (the live miner's before 2026-10-30): settings as a game
 * list and flags, no `discovery`, and none of version 4's fields.
 */
const version2 = (): string => {
  const {
    discovery: _,
    settings: __,
    awarded: ___,
    inventoried: ____,
    avoidCampaigns: _____,
    skipCauses: ______,
    ...rest
  } = populated;
  const settings = { badgesAndEmotes: true, excludeChannels: ["x"], games: ["game-1"] };
  return `{"state":${canonical({ ...rest, watch: watch3(), settings })},"version":2}`;
};

/** A state file as version 3 wrote it (the live miner's of 2026-10-30): no received rewards. */
const version3 = (): string => {
  const { awarded: _, inventoried: __, avoidCampaigns: ___, skipCauses: ____, ...rest } = populated;
  return `{"state":${canonical({ ...rest, watch: watch3() })},"version":3}`;
};

describe("decodeState", () => {
  it("migrates version 2, keeping progress, claims, catalog and deadlines", () => {
    const decoded = decodeState(version2());
    assert.deepStrictEqual(decoded.progress, populated.progress);
    assert.deepStrictEqual(decoded.claims, populated.claims);
    assert.deepStrictEqual(decoded.catalog, populated.catalog);
    assert.deepStrictEqual(decoded.deadlines, populated.deadlines);
    assert.deepStrictEqual(decoded.watch, { ...watching, wasted: undefined });
    assert.isUndefined(decoded.discovery);
    assert.deepStrictEqual(decoded.settings, { goals: [DEFAULT_GOAL] });
    assert.strictEqual(decoded.awarded.size, 0);
    // Saved again, it is a version 4 file that reads back the same.
    assert.deepStrictEqual(decodeState(encodeState(decoded)), decoded);
  });

  it("migrates version 3: nothing received or avoided yet, everything else kept", () => {
    const decoded = decodeState(version3());
    const expected: State = {
      ...populated,
      awarded: new Map(),
      inventoried: new Set(),
      avoidCampaigns: new Map(),
      skipCauses: new Map(),
      watch: { ...watching, wasted: undefined },
    };
    assert.deepStrictEqual(decoded, expected);
    assert.deepStrictEqual(decodeState(encodeState(decoded)), decoded);
    assert.match(encodeState(decoded), /"version":4}$/);
  });

  it("reads the unmerged first version 4, which saved skipped campaigns as a set", () => {
    const { skipCauses: _, ...rest } = populated;
    const text = `{"state":${canonical({ ...rest, avoidCampaigns: new Set([cid("old")]) })},"version":4}`;
    const decoded = decodeState(text);
    assert.deepStrictEqual(decoded, {
      ...populated,
      avoidCampaigns: new Map(),
      skipCauses: new Map(),
    });
  });

  it("refuses another version and text that isn't a state", () => {
    const text = encodeState(populated);
    assert.match(text, /"version":4}$/);
    assert.throws(() => decodeState(text.replace('"version":4', '"version":1')), /version 1/);
    assert.throws(() => decodeState(text.replace('"version":4', '"version":5')), /version 5/);
    assert.throws(() => decodeState(canonical(populated)), /not a saved miner state/);
    assert.throws(() => decodeState("{"));
  });

  it("refuses a file that parses but isn't a whole state, whatever its version", () => {
    assert.throws(() => decodeState('{"version":2,"state":{}}'), /not a saved miner state/);
    assert.throws(() => decodeState('{"version":3,"state":{}}'), /not a saved miner state/);
    assert.throws(() => decodeState('{"version":3,"state":[]}'), /not a saved miner state/);
    assert.throws(() => decodeState('{"version":4,"state":{}}'), /not a saved miner state/);
    const saved = JSON.parse(encodeState(populated)) as { state: Record<string, unknown> };
    for (const key of Object.keys(saved.state)) {
      const { [key]: _, ...rest } = saved.state;
      const text = JSON.stringify({ state: rest, version: 4 });
      assert.throws(() => decodeState(text), /not a saved miner state/, key);
    }
    // A claim intent missing its status could be resent: refused, not guessed at.
    const claims = saved.state["claims"] as { $map: Array<[string, Record<string, unknown>]> };
    const broken = claims.$map.map(([k, v]): [string, unknown] => [k, { ...v, status: "lost" }]);
    const text = JSON.stringify({
      state: { ...saved.state, claims: { $map: broken } },
      version: 4,
    });
    assert.throws(() => decodeState(text), /`claims`/);
  });

  it("keeps claim intents exactly through the version 2 migration", () => {
    const decoded = decodeState(version2());
    assert.strictEqual(canonical(decoded.claims), canonical(populated.claims));
  });
});
