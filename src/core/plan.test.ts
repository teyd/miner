import { assert, describe, it } from "@effect/vitest";
import { HOUR, type Campaign, type Channel } from "./model.ts";
import { campaign, channel, drop, game, progress, settings, T0 } from "./fixtures.ts";
import { plan, type PlanInput } from "./plan.ts";

const input = (
  campaigns: ReadonlyArray<Campaign>,
  channels: ReadonlyArray<Channel>,
  overrides: Partial<PlanInput> = {},
): PlanInput => ({
  campaigns,
  progress: new Map(),
  channels: new Map(channels.map((ch) => [ch.id, ch])),
  settings: settings(),
  refused: new Set(),
  now: T0,
  ...overrides,
});

const targetOf = (i: PlanInput) => {
  const t = plan(i);
  return typeof t === "string" ? t : `${t.campaign.id}/${t.drop.id}@${t.channel.id}`;
};

describe("plan", () => {
  it("prefers configured game priority, then the campaign ending first", () => {
    const soon = campaign("soon", { endsAt: T0 + HOUR, game: game("g2") });
    const late = campaign("late", { endsAt: T0 + 10 * HOUR });
    const channels = [channel("a", { gameId: "game-1" }), channel("b", { gameId: "g2" })];
    assert.strictEqual(targetOf(input([late, soon], channels)), "soon/soon-d1@b");
    const prioritised = input([late, soon], channels, {
      settings: settings({ games: [game("game-1").id, game("g2").id] }),
    });
    assert.strictEqual(targetOf(prioritised), "late/late-d1@a");
  });

  it("skips a better campaign that has no live channel", () => {
    const listed = campaign("listed", { endsAt: T0 + HOUR, allowedChannels: [channel("x").id] });
    const open = campaign("open");
    assert.strictEqual(targetOf(input([listed, open], [channel("a")])), "open/open-d1@a");
  });

  it("picks the drop closest to completion, not the campaign's first", () => {
    const c = campaign("c", {
      drops: [drop("d1", { requiredMinutes: 120 }), drop("d2", { requiredMinutes: 30 })],
    });
    assert.strictEqual(targetOf(input([c], [channel("a")])), "c/d2@a");
  });

  it("watches the channel with the most viewers", () => {
    const channels = [channel("a", { viewers: 10 }), channel("b", { viewers: 500 })];
    assert.strictEqual(targetOf(input([campaign("c")], channels)), "c/c-d1@b");
  });

  it("tells nothing-to-mine apart from no-live-channel", () => {
    const c = campaign("c");
    const done = new Map([[c.drops[0]!.id, progress(c, "c-d1", { minutes: 60, claimed: true })]]);
    assert.strictEqual(targetOf(input([c], [channel("a")], { progress: done })), "nothing-to-mine");
    assert.strictEqual(targetOf(input([c], [channel("a", "offline")])), "no-live-channel");
  });
});
