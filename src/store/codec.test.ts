import { assert, describe, it } from "@effect/vitest";
import {
  campaign,
  channel,
  chid,
  cid,
  did,
  iid,
  progress,
  settings,
  T0,
} from "../core/fixtures.ts";
import { MINUTE } from "../core/model.ts";
import { initial, type State } from "../core/state.ts";
import { canonical, decodeState, encodeState } from "./codec.ts";

const c = campaign("c");

/** Every kind of value `State` holds: Maps, Sets, `undefined` fields, both claim statuses. */
const populated: State = {
  ...initial(settings({ games: [c.game.id], excludeChannels: [chid("x")] })),
  auth: "needs-login",
  catalog: [c],
  catalogStatus: "unavailable",
  progress: new Map([
    [did("c-d1"), progress(c, "c-d1", { minutes: 60, instanceId: iid("i1") })],
    [did("c-d2"), progress(c, "c-d2", { minutes: 3 })],
  ]),
  channels: new Map([
    [chid("a"), channel("a", { viewers: 500 })],
    [chid("b"), channel("b", "offline")],
  ]),
  avoid: new Set([chid("z"), chid("y")]),
  watch: {
    _tag: "Watching",
    channelId: chid("a"),
    campaignId: cid("c"),
    dropId: did("c-d2"),
    credited: true,
    confirmedAt: T0,
    confirmedMinutes: 3,
    estimatedMinutes: 4,
    lastCurrentDropRead: undefined,
  },
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

describe("decodeState", () => {
  it("refuses another version and text that isn't a state", () => {
    const text = encodeState(populated);
    assert.match(text, /"version":2}$/);
    // Version 1 had no `deadlines.subscribe`.
    assert.throws(() => decodeState(text.replace('"version":2', '"version":1')), /version 1/);
    assert.throws(() => decodeState(canonical(populated)), /not a saved miner state/);
    assert.throws(() => decodeState("{"));
  });
});
