import { assert, describe, it } from "@effect/vitest";
import fc from "fast-check";
import { Schema } from "effect";
import {
  CHANNEL_FRAMES_PER_HOUR,
  DOWN_BURST_SHARE,
  FRAME_GAPS,
  HIDDEN_DROP_MINUTES,
  INVENTORY_LAG_MINUTES,
  RECONNECT_GAP,
} from "./calibration.ts";
import {
  CLAIM_FLAG_LAG_SWEPT,
  Capsule,
  FRAMES_ALL_SWEPT,
  Scenario,
  scenarioArbitrary,
} from "./scenario.ts";
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

  it("gives about half the worlds each way for a budget to refuse", () => {
    const sample = fc.sample(scenarioArbitrary, { seed: 8, numRuns: 400 });
    const share = (f: (s: Scenario) => boolean) => sample.filter(f).length / sample.length;
    const has = (s: Scenario, kind: string, operation?: string) =>
      s.faults.some(
        (f) =>
          f.kind === kind &&
          (operation === undefined || ("operation" in f && f.operation === operation)),
      );
    for (const [name, p] of [
      ["a short wait for a turn", share((s) => s.gqlMaxWait !== undefined)],
      ["a cooldown over the first claim", share((s) => has(s, "gql-cooldown"))],
      [
        "a 429 on a discovery's directory read",
        share((s) => has(s, "http-429", "DirectoryPage_Game")),
      ],
      ["campaign 0 allow-listed", share((s) => s.campaigns[0]!.allowList.length > 0)],
    ] as const) {
      assert.isAbove(p, 0.35, name);
      assert.isBelow(p, 0.65, name);
    }
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

  it("draws timings from the 2026-10-30 measurements (`calibration.ts`)", () => {
    const scenarios = fc.sample(scenarioArbitrary, { seed: 11, numRuns: 1000 });
    const share = (xs: ReadonlyArray<boolean>) => xs.filter(Boolean).length / xs.length;
    const near = (actual: number, expected: number, tolerance: number) =>
      assert.isAtMost(Math.abs(actual - expected), tolerance, `${actual} vs ${expected}`);
    const gaps = scenarios.flatMap((s) => s.frameGaps ?? []);
    for (const gap of gaps) assert.include(FRAME_GAPS, gap);
    // The measured mean, 176 / 46 minutes, within sampling noise.
    near(gaps.reduce((a, b) => a + b, 0) / gaps.length, 176 / 46, 0.2);
    near(share(scenarios.map((s) => s.inventoryLagMinutes === INVENTORY_LAG_MINUTES)), 0.7, 0.05);
    for (const s of scenarios) assert.isAtMost(s.claimedFlagLagSeconds ?? 0, CLAIM_FLAG_LAG_SWEPT);
    // Core gap 5 (research 04 §2b): the sweep frames every credited drop until it is fixed.
    for (const s of scenarios) assert.strictEqual(s.framesAll ?? false, FRAMES_ALL_SWEPT);
    near(share(scenarios.map((s) => s.claimFrames === true)), 0.1, 0.03);
    const hidden = scenarios.flatMap((s) => s.campaigns.filter((c) => c.hidden === true));
    near(hidden.length / scenarios.length, 1 / 6, 0.04);
    // The measured 900-minute drop half the time.
    near(share(hidden.map((c) => c.drops[0]!.requiredMinutes === HIDDEN_DROP_MINUTES)), 0.5, 0.1);
    // Campaigns claimed in full before the run, which only `gameEventDrops` names, are drawn too.
    const histories = scenarios.flatMap((s) => s.campaigns.map((c) => c.claimedBefore ?? 0));
    const full = scenarios.flatMap((s) =>
      s.campaigns.filter((c) => (c.claimedBefore ?? 0) >= c.drops.length),
    );
    assert.isAbove(full.length, 0);
    assert.isBelow(full.length, histories.filter((n) => n > 0).length);
    const changes = scenarios.flatMap((s) => s.channels.flatMap((c) => c.changes));
    const { streamUp, streamDown, gameChange } = CHANNEL_FRAMES_PER_HOUR;
    near(
      share(changes.map((c) => c.to.startsWith("game"))),
      gameChange / (streamUp + streamDown + gameChange),
      0.02,
    );
    // Downs in the same minute as a down on the channel before, beyond chance; other changes
    // only by chance.
    const snapped = (down: boolean) =>
      scenarios.flatMap((s) =>
        s.channels.slice(1).flatMap((c, i) => {
          const downs = s.channels[i]!.changes.filter((x) => x.to === "down");
          const before = new Set(downs.map((x) => x.atMinute));
          return before.size === 0
            ? []
            : c.changes
                .filter((x) => (x.to === "down") === down)
                .map((x) => before.has(x.atMinute));
        }),
      );
    near(share(snapped(true)), DOWN_BURST_SHARE, 0.05);
    assert.isAtMost(share(snapped(false)), 0.01);
    const reconnects = scenarios.flatMap((s) =>
      s.faults.flatMap((f) => (f.kind === "reconnect" ? [f.gapMillis] : [])),
    );
    const outages = scenarios.flatMap((s) => s.faults.filter((f) => f.kind === "frames-down"));
    near(reconnects.length / (reconnects.length + outages.length), 0.8, 0.05);
    // Milliseconds across the measured range, not whole seconds.
    assert.isAtLeast(Math.min(...reconnects), RECONNECT_GAP.min);
    assert.isAtMost(Math.min(...reconnects), RECONNECT_GAP.min + 20);
    assert.isAtMost(Math.max(...reconnects), RECONNECT_GAP.max);
    assert.isAtLeast(Math.max(...reconnects), RECONNECT_GAP.max - 20);
    assert.isAbove(new Set(reconnects).size, 100);
  });
});
