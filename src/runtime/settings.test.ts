import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { Config } from "../config/schema.ts";
import { campaign, channel, chid } from "../core/fixtures.ts";
import type { GameId } from "../core/model.ts";
import { isEligible } from "../core/rules.ts";
import { toSettings, unmapped } from "./settings.ts";

const config = (input: unknown) => Schema.decodeUnknownSync(Config)(input);
const c = campaign("c");

describe("toSettings", () => {
  it("maps the default config to every game, badges and emotes on", () => {
    assert.deepStrictEqual(toSettings(config({}), [c], []), {
      games: [],
      excludeChannels: [],
      badgesAndEmotes: true,
    });
    assert.deepStrictEqual(unmapped(config({})), []);
  });

  it("resolves games by name or slug, case-insensitively, in priority order", () => {
    const other = { ...campaign("o"), game: { id: "g2", name: "Rust", slug: "rust" } } as never;
    const file = config({
      priorities: [{ type: "drops", games: [{ name: "RUST" }, { name: c.game.slug }] }],
    });
    assert.deepStrictEqual(toSettings(file, [c, other], []).games, ["g2" as GameId, c.game.id]);
  });

  it("never widens a game list it can't resolve to every game", () => {
    const file = config({ priorities: [{ type: "drops", games: [{ name: "Not On Twitch" }] }] });
    const settings = toSettings(file, [c], []);
    assert.strictEqual(settings.games.length, 1);
    assert.isFalse(isEligible({ ...c, linked: true }, settings));
  });

  it("excludes channels by login once their ids are known, from the goal and the top level", () => {
    const file = config({
      exclude: { channels: ["Forsen"] },
      priorities: [{ type: "drops", games: "all", exclude: { channels: ["other"] } }],
    });
    const forsen = { ...channel("a"), login: "forsen" };
    const other = { ...channel("b"), login: "other" };
    assert.deepStrictEqual(toSettings(file, [], [forsen, other, channel("c")]).excludeChannels, [
      chid("a"),
      chid("b"),
    ]);
  });

  it("mines nothing without a drops goal, and says so", () => {
    const file = config({ priorities: [{ type: "points", channels: ["forsen"] }] });
    assert.isFalse(isEligible({ ...c, linked: true }, toSettings(file, [c], [])));
    assert.include(unmapped(file).join("\n"), "no drops goal");
  });

  it("names every option the core can't follow yet", () => {
    const file = config({
      priorities: [
        {
          type: "drops",
          games: [{ name: "Rust", rewards: ["item"] }],
          order: "least-slack",
          linkedOnly: false,
          rewards: ["badge"],
        },
        { type: "drops", games: "all" },
        { type: "points", channels: ["forsen"] },
      ],
      streams: { max: 2 },
    });
    assert.strictEqual(unmapped(file).length, 8);
  });
});
