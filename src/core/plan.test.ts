import { assert, describe, it } from "@effect/vitest";
import { HOUR, MINUTE, type Campaign, type Channel } from "./model.ts";
import {
  badge,
  campaign,
  channel,
  chid,
  cid,
  drop,
  emote,
  game,
  games,
  goal,
  progress,
  settings,
  T0,
} from "./fixtures.ts";
import { compareNumbers, minable, plan, SLACK_HYSTERESIS, type PlanInput } from "./plan.ts";

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
  watching: undefined,
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
      settings: settings({ games: games(["game-1", "g2"]) }),
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

describe("goals", () => {
  const a = campaign("a", { game: game("ga") });
  const b = campaign("b", { game: game("gb") });
  const channels = [channel("x", { gameId: "ga" }), channel("y", { gameId: "gb" })];

  it("works on the first goal with something to earn on a live channel", () => {
    const goals = [goal({ games: games(["gb"]) }), goal({ games: games(["ga"]) })];
    assert.strictEqual(targetOf(input([a, b], channels, { settings: { goals } })), "b/b-d1@y");
    const offline = [channels[0]!, channel("y", "offline")];
    assert.strictEqual(targetOf(input([a, b], offline, { settings: { goals } })), "a/a-d1@x");
  });

  it("falls through a goal that has nothing it wants", () => {
    const badges = campaign("b", {
      game: game("gb"),
      drops: [drop("b-d1", { benefits: [badge] })],
    });
    const goals = [goal({ games: games(["gb"], ["emote"]) }), goal({ games: games(["ga"]) })];
    assert.strictEqual(targetOf(input([a, badges], channels, { settings: { goals } })), "a/a-d1@x");
  });

  it("applies a goal's excluded channels to that goal only", () => {
    const goals = [goal({ excludeChannels: [chid("x")], games: games(["ga"]) }), goal()];
    assert.strictEqual(
      targetOf(input([a], [channel("x", { gameId: "ga" })], { settings: { goals } })),
      "a/a-d1@x",
    );
    const only = settings({ excludeChannels: [chid("x")] });
    assert.strictEqual(
      targetOf(input([a], [channel("x", { gameId: "ga" })], { settings: only })),
      "no-live-channel",
    );
  });

  it("leaves excluded games out of all", () => {
    const only = settings({ excludeGames: [game("gb").id] });
    assert.strictEqual(targetOf(input([b], channels, { settings: only })), "nothing-to-mine");
  });

  it("mines unlinked items only with linkedOnly off", () => {
    const unlinked = campaign("u", { linked: false });
    const ch = [channel("x")];
    assert.strictEqual(targetOf(input([unlinked], ch)), "nothing-to-mine");
    const loose = settings({ linkedOnly: false });
    assert.strictEqual(targetOf(input([unlinked], ch, { settings: loose })), "u/u-d1@x");
  });

  it("picks the wanted drop, not an unwanted one closer to completion", () => {
    const c = campaign("c", {
      linked: false,
      drops: [
        drop("item", { requiredMinutes: 10 }),
        drop("emote", { requiredMinutes: 90, benefits: [emote] }),
      ],
    });
    assert.strictEqual(targetOf(input([c], [channel("x")])), "c/emote@x");
  });
});

describe("order", () => {
  // `tight` ends later but needs nearly all its time; `loose` ends first with hours to spare.
  const tight = campaign("tight", {
    endsAt: T0 + 5 * HOUR,
    drops: [drop("t", { endsAt: T0 + 5 * HOUR, requiredMinutes: 270 })],
  });
  const loose = campaign("loose", {
    endsAt: T0 + 4 * HOUR,
    drops: [drop("l", { endsAt: T0 + 4 * HOUR, requiredMinutes: 30 })],
  });
  const ch = [channel("x")];

  it("ranks by end time with ending-soonest, by slack with least-slack", () => {
    assert.strictEqual(targetOf(input([tight, loose], ch)), "loose/l@x");
    const slack = settings({ order: "least-slack" });
    assert.strictEqual(targetOf(input([tight, loose], ch, { settings: slack })), "tight/t@x");
  });

  it("puts a drop that can no longer finish after every feasible one", () => {
    const hopeless = campaign("hopeless", {
      endsAt: T0 + HOUR,
      drops: [drop("h", { endsAt: T0 + HOUR, requiredMinutes: 120 })],
    });
    const slack = settings({ order: "least-slack" });
    assert.strictEqual(targetOf(input([hopeless, loose], ch, { settings: slack })), "loose/l@x");
  });

  it("keeps the watched campaign until another's slack is SLACK_HYSTERESIS shorter", () => {
    const a = campaign("a", { drops: [drop("a1", { requiredMinutes: 600 })] });
    const b = campaign("b", { drops: [drop("b1", { requiredMinutes: 590 })] });
    const slack = settings({ order: "least-slack" });
    // `a` has 10 minutes less slack, but `b` is being watched.
    assert.strictEqual(
      targetOf(input([a, b], ch, { settings: slack, watching: cid("b") })),
      "b/b1@x",
    );
    // After `b` earned enough that `a` is behind by more than the margin, it switches.
    const minutes = SLACK_HYSTERESIS / MINUTE;
    const earned = new Map([[drop("b1").id, progress(b, "b1", { minutes })]]);
    assert.strictEqual(
      targetOf(input([a, b], ch, { settings: slack, watching: cid("b"), progress: earned })),
      "a/a1@x",
    );
  });
});

describe("feasibility and actionable drops", () => {
  const slack = settings({ order: "least-slack" });

  it("ranks least-slack by drops that earn now, not by one whose window opens later", () => {
    // Only a0 earns now, with hours to spare; a1's tight window opens in 2 h. b1 can't wait.
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
    const ch = [channel("x")];
    assert.strictEqual(targetOf(input([a, b], ch, { settings: slack })), "b/b1@x");
    // Once a1 earns, it is the emergency.
    const later = T0 + 2 * HOUR + 5 * MINUTE;
    const c = campaign("c", { drops: [drop("c1", { requiredMinutes: 60 })] });
    assert.strictEqual(targetOf(input([a, c], ch, { settings: slack, now: later })), "a/a1@x");
  });

  it("works on a lower goal that can finish before a higher goal that can't", () => {
    // Goal 1's campaign ends in 6 h and needs 12; goal 2's needs 30 minutes of the same 6 h.
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
    const goals = [goal({ games: games(["ga"]) }), goal({ games: games(["gb"]) })];
    const channels = [channel("x", { gameId: "ga" }), channel("y", { gameId: "gb" })];
    for (const order of ["ending-soonest", "least-slack"] as const) {
      const ordered = { goals: goals.map((g) => ({ ...g, order })) };
      assert.strictEqual(
        targetOf(input([doomed, fine], channels, { settings: ordered })),
        "fine/f@y",
        order,
      );
      // With nothing that can finish on a live channel, the doomed one still beats idling.
      const offline = [channels[0]!, channel("y", "offline")];
      assert.strictEqual(
        targetOf(input([doomed, fine], offline, { settings: ordered })),
        "doomed/d@x",
        order,
      );
    }
  });

  it("prefers a drop of the campaign that can still finish", () => {
    const c = campaign("c", {
      drops: [
        drop("short-window", { endsAt: T0 + 10 * MINUTE, requiredMinutes: 20 }),
        drop("long", { requiredMinutes: 90 }),
      ],
    });
    assert.strictEqual(targetOf(input([c], [channel("x")])), "c/long@x");
  });

  it("orders every pick totally, whatever order the catalog lists them in", () => {
    const hopeless = (id: string, endsAt: number) =>
      campaign(id, { endsAt, drops: [drop(`${id}-d`, { endsAt, requiredMinutes: 600 })] });
    const campaigns = [
      hopeless("h1", T0 + HOUR),
      hopeless("h2", T0 + HOUR),
      hopeless("h3", T0 + 2 * HOUR),
      campaign("ok"),
    ];
    for (const order of ["ending-soonest", "least-slack"] as const) {
      const orders = [
        campaigns,
        campaigns.toReversed(),
        [campaigns[2]!, campaigns[0]!, campaigns[3]!, campaigns[1]!],
      ]
        .map((cs) => minable(input(cs, [], { settings: settings({ order }) })))
        .map((picks) => picks.map((p) => p.campaign.id).join(","));
      assert.deepStrictEqual(orders, Array(3).fill("ok,h1,h2,h3"), order);
    }
    assert.strictEqual(compareNumbers(Infinity, Infinity), 0);
    assert.strictEqual(compareNumbers(1, Infinity), -1);
  });
});
