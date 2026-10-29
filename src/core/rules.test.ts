import { assert, describe, it } from "@effect/vitest";
import { HOUR } from "./model.ts";
import { badge, campaign, channel, drop, game, item, progress, settings, T0 } from "./fixtures.ts";
import { canEarn, channelCanEarn, isClaimable, isEligible, remainingMinutes } from "./rules.ts";

describe("isEligible", () => {
  it("needs a link for in-game items", () => {
    assert.isFalse(isEligible(campaign("c", { linked: false }), settings()));
    assert.isTrue(isEligible(campaign("c", { linked: true }), settings()));
  });

  it("mines badge and emote campaigns unlinked only when enabled, per campaign", () => {
    const mixed = campaign("c", {
      linked: false,
      drops: [drop("d1", { benefits: [item] }), drop("d2", { benefits: [badge] })],
    });
    assert.isTrue(isEligible(mixed, settings({ badgesAndEmotes: true })));
    assert.isFalse(isEligible(mixed, settings({ badgesAndEmotes: false })));
  });

  it("limits to the configured games", () => {
    const c = campaign("c", { game: game("other") });
    assert.isFalse(isEligible(c, settings({ games: [game("game-1").id] })));
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
  const s = settings();
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
    assert.isFalse(
      channelCanEarn(c, channel("a"), settings({ excludeChannels: [channel("a").id] }), none),
    );
    assert.isFalse(channelCanEarn(c, channel("a"), s, new Set([channel("a").id])));
    assert.isFalse(channelCanEarn(c, channel("a", "offline"), s, none));
  });
});
