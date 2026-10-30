import { assert, describe, it } from "@effect/vitest";
import { HOUR, MINUTE } from "./model.ts";
import {
  badge,
  campaign,
  channel,
  drop,
  emote,
  game,
  games,
  goal,
  item,
  progress,
  T0,
} from "./fixtures.ts";
import {
  canEarn,
  channelCanEarn,
  isClaimable,
  isEligible,
  remainingMinutes,
  rewardOf,
  slackOf,
  wantedDrops,
} from "./rules.ts";

describe("isEligible", () => {
  it("needs a link for in-game items", () => {
    assert.isFalse(isEligible(campaign("c", { linked: false }), goal()));
    assert.isTrue(isEligible(campaign("c", { linked: true }), goal()));
  });

  it("takes unlinked items with linkedOnly off", () => {
    assert.isTrue(isEligible(campaign("c", { linked: false }), goal({ linkedOnly: false })));
  });

  it("mines badge and emote drops unlinked when the goal lists them", () => {
    const mixed = campaign("c", {
      linked: false,
      drops: [drop("d1", { benefits: [item] }), drop("d2", { benefits: [badge] })],
    });
    assert.isTrue(isEligible(mixed, goal()));
    assert.isFalse(isEligible(mixed, goal({ rewards: ["item", "emote"] })));
  });

  it("limits to the listed games, and leaves out excluded ones with all", () => {
    const c = campaign("c", { game: game("other") });
    assert.isFalse(isEligible(c, goal({ games: games(["game-1"]) })));
    assert.isTrue(isEligible(c, goal({ games: games(["game-1", "other"]) })));
    assert.isFalse(isEligible(c, goal({ excludeGames: [c.game.id] })));
  });

  it("uses a listed game's own rewards over the goal's", () => {
    const badges = campaign("c", { drops: [drop("d1", { benefits: [badge] })] });
    const own = goal({ games: games(["game-1"], ["item"]), rewards: ["badge"] });
    assert.isFalse(isEligible(badges, own));
    assert.isTrue(isEligible(badges, goal({ games: games(["game-1"], ["badge"]) })));
  });
});

describe("wantedDrops", () => {
  it("filters badges and emotes separately", () => {
    const c = campaign("c", {
      drops: [drop("b", { benefits: [badge] }), drop("e", { benefits: [emote] })],
    });
    assert.deepStrictEqual([...wantedDrops(goal({ rewards: ["emote"] }), c, new Map())], ["e"]);
    assert.deepStrictEqual([...wantedDrops(goal({ rewards: ["badge"] }), c, new Map())], ["b"]);
  });

  it("wants an unwanted drop that a wanted one waits on, until it is claimed", () => {
    const c = campaign("c", {
      linked: false,
      drops: [
        drop("first", { benefits: [item] }),
        drop("second", { benefits: [badge], preconditions: [drop("first").id] }),
      ],
    });
    assert.deepStrictEqual([...wantedDrops(goal(), c, new Map())].toSorted(), ["first", "second"]);
    const claimed = new Map([[drop("first").id, progress(c, "first", { claimed: true })]]);
    assert.deepStrictEqual([...wantedDrops(goal(), c, claimed)], ["second"]);
  });

  it("treats a reward type Twitch added since as an item", () => {
    assert.strictEqual(rewardOf({ id: "x", name: "x", distribution: "UNKNOWN" }), "item");
  });
});

describe("slackOf", () => {
  it("is the time to the drop's end minus the minutes still needed, chain included", () => {
    const c = campaign("c", {
      drops: [
        drop("d1", { endsAt: T0 + 3 * HOUR }),
        drop("d2", { endsAt: T0 + 3 * HOUR, preconditions: [drop("d1").id] }),
      ],
    });
    assert.strictEqual(slackOf(c, c.drops[0]!, new Map(), T0), 2 * HOUR);
    assert.strictEqual(slackOf(c, c.drops[1]!, new Map(), T0), HOUR);
    const half = new Map([[drop("d1").id, progress(c, "d1", { minutes: 30 })]]);
    assert.strictEqual(slackOf(c, c.drops[1]!, half, T0), HOUR + 30 * MINUTE);
  });
});

describe("canEarn", () => {
  const c = campaign("c", {
    drops: [drop("d1"), drop("d2", { preconditions: [drop("d1").id] })],
  });
  const [d1, d2] = c.drops;

  it("waits for precondition drops to be claimed", () => {
    const none = new Map();
    assert.isTrue(canEarn(d1!, none, T0));
    assert.isFalse(canEarn(d2!, none, T0));
    const claimed = new Map([[d1!.id, progress(c, "d1", { minutes: 60, claimed: true })]]);
    assert.isTrue(canEarn(d2!, claimed, T0));
  });

  it("counts the precondition chain in the remaining minutes", () => {
    assert.strictEqual(remainingMinutes(c, d2!, new Map()), 120);
  });

  it("survives a precondition cycle in Twitch's data", () => {
    const looped = campaign("l", {
      drops: [
        drop("x", { preconditions: [drop("y").id] }),
        drop("y", { preconditions: [drop("x").id] }),
      ],
    });
    assert.strictEqual(remainingMinutes(looped, looped.drops[0]!, new Map()), 120);
  });

  it("stops at the required minutes and outside the drop window", () => {
    const done = new Map([[d1!.id, progress(c, "d1", { minutes: 60 })]]);
    assert.isFalse(canEarn(d1!, done, T0));
    assert.isFalse(canEarn(d1!, new Map(), T0 + 25 * HOUR));
  });
});

describe("isClaimable", () => {
  const c = campaign("c", { endsAt: T0 });
  const complete = progress(c, "d1", { minutes: 60, instanceId: "i1" as never });

  it("stays claimable until 24 h after the campaign ends", () => {
    assert.isTrue(isClaimable(complete, T0 + 23 * HOUR));
    assert.isFalse(isClaimable(complete, T0 + 24 * HOUR));
  });

  it("needs an instance id and an unclaimed drop", () => {
    assert.isFalse(isClaimable({ ...complete, instanceId: undefined }, T0));
    assert.isFalse(isClaimable({ ...complete, claimed: true }, T0));
  });
});

describe("channelCanEarn", () => {
  const s: ReadonlyArray<never> = [];
  const none = new Set<never>();

  it("needs the campaign's game and drops enabled, unless the game is special", () => {
    const c = campaign("c");
    assert.isTrue(channelCanEarn(c, channel("a"), s, none));
    assert.isFalse(channelCanEarn(c, channel("a", { gameId: "other" }), s, none));
    assert.isFalse(channelCanEarn(c, channel("a", { dropsEnabled: false }), s, none));
    const special = campaign("s", { game: game("509663") });
    assert.isTrue(channelCanEarn(special, channel("a", { gameId: "other" }), s, none));
  });

  it("honours the allow-list, exclusions, refusals and offline streams", () => {
    const listed = campaign("c", { allowedChannels: [channel("a").id] });
    assert.isTrue(channelCanEarn(listed, channel("a", { dropsEnabled: false }), s, none));
    assert.isFalse(channelCanEarn(listed, channel("b"), s, none));
    const c = campaign("c");
    assert.isFalse(channelCanEarn(c, channel("a"), [channel("a").id], none));
    assert.isFalse(channelCanEarn(c, channel("a"), s, new Set([channel("a").id])));
    assert.isFalse(channelCanEarn(c, channel("a", "offline"), s, none));
  });
});
