import { assert, describe, it } from "@effect/vitest";
import { campaign, channel, cid, drop, game, games, goal, progress, T0 } from "../core/fixtures.ts";
import { HOUR, MINUTE, type Campaign, type Channel, type Settings } from "../core/model.ts";
import { SLACK_HYSTERESIS } from "../core/plan.ts";
import { allowedPicks, type View } from "./oracle.ts";

const view = (
  catalog: ReadonlyArray<Campaign>,
  channels: ReadonlyArray<Channel>,
  overrides: Partial<View> = {},
): View => ({
  catalog,
  progress: new Map(),
  channels: new Map(channels.map((ch) => [ch.id, ch])),
  avoid: new Set(),
  now: T0,
  ...overrides,
});

const picks = (settings: Settings, v: View, watched: ReadonlyArray<string> = []) =>
  [...allowedPicks(settings, v, watched.map(cid))].toSorted();

describe("the goal oracle", () => {
  const slack: Settings = { goals: [goal({ order: "least-slack" })] };

  it("ranks least-slack by drops that earn now (review P1-1)", () => {
    const a = campaign("a", {
      drops: [
        drop("a0", { requiredMinutes: 60 }),
        drop("a1", { startsAt: T0 + 2 * HOUR, endsAt: T0 + 3 * HOUR, requiredMinutes: 55 }),
      ],
    });
    const b = campaign("b", {
      endsAt: T0 + 2 * HOUR,
      drops: [drop("b1", { endsAt: T0 + 2 * HOUR, requiredMinutes: 100 })],
    });
    assert.deepStrictEqual(picks(slack, view([a, b], [channel("x")])), ["b"]);
  });

  it("puts what can finish first, across goals (review P1-2)", () => {
    const doomed = campaign("doomed", {
      game: game("ga"),
      endsAt: T0 + 6 * HOUR,
      drops: [drop("d", { endsAt: T0 + 6 * HOUR, requiredMinutes: 720 })],
    });
    const fine = campaign("fine", {
      game: game("gb"),
      endsAt: T0 + 6 * HOUR,
      drops: [drop("f", { endsAt: T0 + 6 * HOUR, requiredMinutes: 30 })],
    });
    const settings = { goals: [goal({ games: games(["ga"]) }), goal({ games: games(["gb"]) })] };
    const both = [channel("x", { gameId: "ga" }), channel("y", { gameId: "gb" })];
    assert.deepStrictEqual(picks(settings, view([doomed, fine], both)), ["fine"]);
    // Only the doomed one has a live channel: it is still better than idling.
    const one = [both[0]!];
    assert.deepStrictEqual(picks(settings, view([doomed, fine], one)), ["doomed"]);
  });

  it("goes by goal, then game order, and allows ties either way", () => {
    const a = campaign("a", { game: game("ga") });
    const b = campaign("b", { game: game("gb") });
    const both = [channel("x", { gameId: "ga" }), channel("y", { gameId: "gb" })];
    const listed = { goals: [goal({ games: games(["gb", "ga"]) })] };
    assert.deepStrictEqual(picks(listed, view([a, b], both)), ["b"]);
    const goals = { goals: [goal({ games: games(["ga"]) }), goal({ games: games(["gb"]) })] };
    assert.deepStrictEqual(picks(goals, view([a, b], both)), ["a"]);
    assert.deepStrictEqual(picks({ goals: [goal()] }, view([a, b], both)), ["a", "b"]);
  });

  it("gives the watched campaign the switching margin, and only that", () => {
    const a = campaign("a", { drops: [drop("a1", { requiredMinutes: 600 })] });
    const b = campaign("b", { drops: [drop("b1", { requiredMinutes: 590 })] });
    const v = view([a, b], [channel("x")]);
    assert.deepStrictEqual(picks(slack, v), ["a"]);
    assert.deepStrictEqual(picks(slack, v, ["b"]), ["a", "b"]);
    const minutes = SLACK_HYSTERESIS / MINUTE;
    const earned = new Map([[drop("b1").id, progress(b, "b1", { minutes })]]);
    assert.deepStrictEqual(picks(slack, { ...v, progress: earned }, ["b"]), ["a"]);
  });

  it("wants nothing it isn't asked for: excluded games, unlinked items, excluded channels", () => {
    const a = campaign("a", { game: game("ga") });
    const ch = [channel("x", { gameId: "ga" })];
    const settingsOf = (overrides: Parameters<typeof goal>[0]) => ({ goals: [goal(overrides)] });
    assert.deepStrictEqual(picks(settingsOf({ excludeGames: [game("ga").id] }), view([a], ch)), []);
    assert.deepStrictEqual(picks(settingsOf({}), view([{ ...a, linked: false }], ch)), []);
    assert.deepStrictEqual(
      picks(settingsOf({ linkedOnly: false }), view([{ ...a, linked: false }], ch)),
      ["a"],
    );
    assert.deepStrictEqual(picks(settingsOf({ excludeChannels: [ch[0]!.id] }), view([a], ch)), []);
  });
});
