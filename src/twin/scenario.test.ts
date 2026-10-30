import { assert, describe, it } from "@effect/vitest";
import fc from "fast-check";
import { Schema } from "effect";
import { Capsule, Scenario, scenarioArbitrary } from "./scenario.ts";
import { isEligible } from "../core/rules.ts";
import { buildWorld, channelIdOf } from "./world.ts";

describe("scenario", () => {
  it("generates only values the Schema accepts", () => {
    for (const scenario of fc.sample(scenarioArbitrary, { seed: 3, numRuns: 100 })) {
      assert.deepStrictEqual(Schema.decodeSync(Scenario)(scenario), scenario);
    }
  });

  it("resolves every reference modulo its list, preconditions to earlier drops only", () => {
    for (const scenario of fc.sample(scenarioArbitrary, { seed: 4, numRuns: 100 })) {
      const world = buildWorld(scenario);
      const channelIds = new Set(world.channels.map((c) => c.id));
      for (const campaign of world.campaigns) {
        for (const id of campaign.allowedChannels) assert.isTrue(channelIds.has(id));
        for (const [j, drop] of campaign.drops.entries()) {
          for (const pre of drop.preconditions) {
            const index = campaign.drops.findIndex((d) => d.id === pre);
            assert.isAtLeast(index, 0);
            assert.isBelow(index, j);
          }
        }
      }
      for (const goal of world.settings.goals) {
        for (const id of goal.excludeChannels) assert.isTrue(channelIds.has(id));
      }
    }
  });

  it("covers every drops goal option, and always has a goal that wants campaign 0 on channel 0", () => {
    const seen = new Set<string>();
    for (const scenario of fc.sample(scenarioArbitrary, { seed: 7, numRuns: 200 })) {
      const goals = scenario.settings.goals;
      if (goals.length > 1) seen.add("several goals");
      for (const g of goals) {
        seen.add(g.order);
        seen.add(g.games === null ? "all" : "listed");
        if (!g.linkedOnly) seen.add("linkedOnly false");
        if (g.excludeGames.length > 0) seen.add("excluded games");
        if (g.games?.some((x) => x.rewards !== null) === true) seen.add("per-game rewards");
        if (g.rewards.length === 1) seen.add(`only ${g.rewards[0]}`);
      }
      if (scenario.campaigns.some((c) => c.creditsUnlinked === true)) seen.add("creditsUnlinked");
      const world = buildWorld(scenario);
      const wanted = world.settings.goals.some(
        (g) => isEligible(world.campaigns[0]!, g) && !g.excludeChannels.includes(channelIdOf(0)),
      );
      assert.isTrue(wanted);
    }
    assert.deepStrictEqual([...seen].toSorted(), [
      "all",
      "creditsUnlinked",
      "ending-soonest",
      "excluded games",
      "least-slack",
      "linkedOnly false",
      "listed",
      "only badge",
      "only emote",
      "only item",
      "per-game rewards",
      "several goals",
    ]);
  });

  it("rejects values outside the bounds", () => {
    const [scenario] = fc.sample(scenarioArbitrary, { seed: 5, numRuns: 1 });
    assert.throws(() => Schema.decodeUnknownSync(Scenario)({ ...scenario, horizonMinutes: 5 }));
    assert.throws(() => Schema.decodeUnknownSync(Scenario)({ ...scenario, campaigns: [] }));
  });

  it("round-trips a capsule through JSON", () => {
    const [scenario] = fc.sample(scenarioArbitrary, { seed: 6, numRuns: 1 });
    const capsule: Capsule = {
      seed: 6,
      scenario: scenario!,
      violation: { kind: "Idle", at: 61.5, detail: "ch0 could earn c0" },
      digest: "0123456789abcdef",
      tail: ['{"at":0}'],
    };
    const text = JSON.stringify(capsule);
    assert.deepStrictEqual(Schema.decodeUnknownSync(Capsule)(JSON.parse(text)), capsule);
  });
});
