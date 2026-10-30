import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { Config } from "../config/schema.ts";
import { campaign, channel, chid } from "../core/fixtures.ts";
import { DEFAULT_GOAL, type Campaign, type GameId } from "../core/model.ts";
import { isEligible } from "../core/rules.ts";
import { toSettings, unmapped, unresolvedGames } from "./settings.ts";

const config = (input: unknown) => Schema.decodeUnknownSync(Config)(input);
const c = campaign("c");
const rust: Campaign = {
  ...campaign("o"),
  game: { id: "g2" as GameId, name: "Rust", slug: "rust" },
};

describe("toSettings", () => {
  it("maps the default config to the default goal", () => {
    assert.deepStrictEqual(toSettings(config({}), [c], []), { goals: [DEFAULT_GOAL] });
    assert.deepStrictEqual(
      unmapped(config({ priorities: [{ type: "drops", games: "all", claimBonus: false }] })),
      [],
    );
  });

  it("resolves games by name or slug, case-insensitively, in priority order", () => {
    const file = config({
      priorities: [
        { type: "drops", games: [{ name: "RUST" }, { name: c.game.slug, rewards: ["badge"] }] },
      ],
    });
    assert.deepStrictEqual(toSettings(file, [c, rust], []).goals[0]!.games, [
      { id: "g2" as GameId, rewards: ["item", "badge", "emote"] },
      { id: c.game.id, rewards: ["badge"] },
    ]);
  });

  it("never widens a game list it can't resolve to every game", () => {
    const file = config({ priorities: [{ type: "drops", games: [{ name: "Not On Twitch" }] }] });
    const goal = toSettings(file, [c], []).goals[0]!;
    assert.deepStrictEqual(goal.games, []);
    assert.isFalse(isEligible({ ...c, linked: true }, goal));
  });

  it("drops an excluded game from the list, and resolves exclusions for all", () => {
    const file = config({
      exclude: { games: ["rust"] },
      priorities: [
        { type: "drops", games: [{ name: "Rust" }, { name: c.game.name }] },
        { type: "drops", games: "all", exclude: { games: [c.game.name, "Unknown Game"] } },
      ],
    });
    const [listed, all] = toSettings(file, [c, rust], []).goals;
    assert.deepStrictEqual(listed!.games, [{ id: c.game.id, rewards: ["item", "badge", "emote"] }]);
    assert.deepStrictEqual(all!.excludeGames, [c.game.id, "g2" as GameId].toSorted());
    assert.isFalse(isEligible(rust, all!));
  });

  it("keeps every drops goal in order with its own options", () => {
    const file = config({
      priorities: [
        { type: "drops", games: [{ name: "Rust" }], rewards: ["emote"], order: "least-slack" },
        { type: "points", channels: ["forsen"] },
        { type: "drops", games: "all", linkedOnly: false },
      ],
    });
    const goals = toSettings(file, [c, rust], []).goals;
    assert.strictEqual(goals.length, 2);
    assert.deepStrictEqual(goals[0]!.games, [{ id: "g2" as GameId, rewards: ["emote"] }]);
    assert.strictEqual(goals[0]!.order, "least-slack");
    assert.isTrue(goals[0]!.linkedOnly);
    assert.strictEqual(goals[1]!.games, "all");
    assert.isFalse(goals[1]!.linkedOnly);
  });

  it("excludes channels by login once their ids are known, per goal plus the top level", () => {
    const file = config({
      exclude: { channels: ["Forsen"] },
      priorities: [
        { type: "drops", games: "all", exclude: { channels: ["other"] } },
        { type: "drops", games: "all" },
      ],
    });
    const forsen = { ...channel("a"), login: "forsen" };
    const other = { ...channel("b"), login: "other" };
    const goals = toSettings(file, [], [forsen, other, channel("c")]).goals;
    assert.deepStrictEqual(goals[0]!.excludeChannels, [chid("a"), chid("b")]);
    assert.deepStrictEqual(goals[1]!.excludeChannels, [chid("a")]);
  });

  it("mines nothing without a drops goal, and says so", () => {
    const file = config({ priorities: [{ type: "points", channels: ["forsen"] }] });
    assert.deepStrictEqual(toSettings(file, [c], []).goals, []);
    assert.include(unmapped(file).join("\n"), "no drops goal");
  });

  it("names only what the core can't follow yet: points goals and a second stream", () => {
    const file = config({
      priorities: [
        {
          type: "drops",
          games: [{ name: "Rust", rewards: ["item"] }],
          order: "least-slack",
          linkedOnly: false,
          rewards: ["badge"],
        },
        { type: "drops", games: "all", exclude: { games: ["Rust"] } },
        { type: "points", channels: ["forsen"] },
      ],
      streams: { max: 2 },
    });
    assert.deepStrictEqual(unmapped(file), [
      "points goals are not supported yet and are skipped",
      "claimBonus is not supported yet: channel point bonuses are not claimed",
      "streams.max 2 is not supported yet: one stream is watched",
    ]);
  });

  it("names claimBonus, on by default, as not followed yet", () => {
    assert.deepStrictEqual(unmapped(config({})), [
      "claimBonus is not supported yet: channel point bonuses are not claimed",
    ]);
  });
});

describe("unresolvedGames", () => {
  it("names a listed game the catalog doesn't hold, with the closest match when it looks like a typo", () => {
    const file = config({
      priorities: [
        {
          type: "drops",
          games: [{ name: "Rsut" }, { name: "rust" }, { name: "Not On Twitch" }],
          exclude: { games: ["Rusty"] },
        },
      ],
      exclude: { games: ["Elden Ring"] },
    });
    assert.deepStrictEqual(unresolvedGames(file, [c, rust]), [
      'game "Rsut" matches no game with an active campaign; did you mean "Rust"?',
      'game "Not On Twitch" matches no game with an active campaign',
      'excluded game "Rusty" matches no game; did you mean "Rust"?',
    ]);
    assert.deepStrictEqual(unresolvedGames(config({}), [c, rust]), []);
  });
});
