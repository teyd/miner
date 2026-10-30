import { assert, describe, it } from "@effect/vitest";
import { campaign, channel, chid, did, drop, progress, settings } from "../core/fixtures.ts";
import { initial, type State } from "../core/state.ts";
import { describeWatch, progressLines } from "./narrate.ts";

const c = campaign("c1", { drops: [drop("c1-d1", { name: "Hoodie", requiredMinutes: 15 })] });
const base: State = {
  ...initial(settings()),
  catalog: [c],
  channels: new Map([[chid("ch1"), { ...channel("ch1"), login: "oilrats" }]]),
};
const withMinutes = (s: State, minutes: number, claimed = false): State => ({
  ...s,
  progress: new Map([[did("c1-d1"), progress(c, "c1-d1", { minutes, claimed })]]),
});
const watching = {
  _tag: "Watching",
  channelId: chid("ch1"),
  campaignId: c.id,
  dropId: did("c1-d1"),
  credited: true,
  confirmedAt: 0,
  confirmedMinutes: 0,
  estimatedMinutes: 0,
  lastCurrentDropRead: undefined,
} as unknown as State["watch"];

describe("narrate", () => {
  it("names the channel, game and drop, with progress of the total", () => {
    assert.strictEqual(
      describeWatch(withMinutes(base, 6), watching),
      "watching oilrats for Game game-1: Hoodie (6/15 min)",
    );
  });

  it("falls back to ids the state can't name yet", () => {
    const unknown = { ...base, catalog: [], channels: new Map() };
    assert.strictEqual(describeWatch(unknown, watching), "watching ch1 for c1-d1 (0 min)");
  });

  it("summarises the first inventory read in one line", () => {
    assert.deepStrictEqual(progressLines(base, withMinutes(base, 3)), [
      "inventory: 1 drops known, 1 not claimed yet",
    ]);
  });

  it("reports a minute gained and a claim, and nothing when nothing changed", () => {
    const at6 = withMinutes(base, 6);
    assert.deepStrictEqual(progressLines(at6, withMinutes(base, 7)), [
      "progress Game game-1: Hoodie 7/15 min",
    ]);
    assert.deepStrictEqual(progressLines(at6, withMinutes(base, 15, true)), [
      "claimed Game game-1: Hoodie",
    ]);
    assert.deepStrictEqual(progressLines(at6, at6), []);
  });
});
