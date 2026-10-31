import { assert, describe, it } from "@effect/vitest";
import { CLAIM_GRACE, HOUR, MINUTE, type ChannelId, type DropId } from "../core/model.ts";
import { WATCH_INTERVAL } from "../core/state.ts";
import { CLAIMED_FLAG_LAG_MAX, FRAME_GAPS } from "./calibration.ts";
import { DEFAULT_GOAL_SPEC, SIM_EPOCH, type Scenario } from "./scenario.ts";
import {
  GAMES,
  CLAIMED_FLAG_LAG,
  awardsAt,
  buildWorld,
  channelFrames,
  claim,
  creditedCampaign,
  currentDropView,
  instanceOf,
  inventoryView,
  minutesAt,
  openSession,
  sessionDrop,
  tick,
  type World,
} from "./world.ts";

type CampaignSpec = Scenario["campaigns"][number];
type ChannelSpec = Scenario["channels"][number];

const campaignSpec = (overrides: Partial<CampaignSpec> = {}): CampaignSpec => ({
  game: 0,
  startMinute: -10,
  durationMinutes: 600,
  linked: true,
  allowList: [],
  drops: [{ requiredMinutes: 2, after: null, benefit: "DIRECT_ENTITLEMENT" }],
  ...overrides,
});

const channelSpec = (overrides: Partial<ChannelSpec> = {}): ChannelSpec => ({
  game: 0,
  viewers: 100,
  dropsEnabled: true,
  refuses: false,
  liveAtStart: true,
  changes: [],
  ...overrides,
});

const world = (
  campaigns: ReadonlyArray<CampaignSpec>,
  channels: ReadonlyArray<ChannelSpec> = [channelSpec()],
  lag = 0,
  extra: Partial<Scenario> = {},
): World =>
  buildWorld({
    latencySeed: 1,
    horizonMinutes: 600,
    inventoryLagMinutes: lag,
    settings: { goals: [DEFAULT_GOAL_SPEC] },
    campaigns,
    channels,
    faults: [],
    ...extra,
  });

const ch = (i: number) => `ch${i}` as ChannelId;
const drop = (id: string) => id as DropId;
const T = SIM_EPOCH;

/** Opens a session on `channel` at `from` and ticks every 20 s for `minutes` minutes. */
const watchFor = (w: World, channel: ChannelId, minutes: number, from = T) => {
  let current = openSession(w, channel, from);
  const frames = [];
  for (let i = 1; i <= minutes * 3; i++) {
    const ticked = tick(current, channel, from + i * WATCH_INTERVAL);
    current = ticked.world;
    frames.push(...ticked.frames);
  }
  return { world: current, frames };
};

describe("goals", () => {
  it("maps goal specs as toSettings maps the file: exclusions win, first entry wins", () => {
    const w = buildWorld({
      latencySeed: 1,
      horizonMinutes: 600,
      inventoryLagMinutes: 0,
      settings: {
        goals: [
          {
            ...DEFAULT_GOAL_SPEC,
            games: [
              { game: 1, rewards: ["badge"] },
              { game: 0, rewards: null },
              { game: 1, rewards: null },
              { game: 2, rewards: null },
            ],
            rewards: ["emote"],
            excludeGames: [2],
            exclude: [3],
          },
        ],
      },
      campaigns: [campaignSpec()],
      channels: [channelSpec(), channelSpec()],
      faults: [],
    });
    assert.deepStrictEqual(w.settings.goals[0], {
      games: [
        { id: GAMES[1]!.id, rewards: ["badge"] },
        { id: GAMES[0]!.id, rewards: ["emote"] },
      ],
      rewards: ["emote"],
      excludeGames: [GAMES[2]!.id],
      excludeChannels: [ch(1)],
      linkedOnly: true,
      order: "ending-soonest",
    });
  });
});

describe("world", () => {
  it("credits only the session's channel, and a new session closes the old one", () => {
    const w = world([campaignSpec()], [channelSpec(), channelSpec()]);
    const a = openSession(w, ch(0), T);
    assert.strictEqual(tick(a, ch(1), T + WATCH_INTERVAL).result, "network");
    const b = openSession(a, ch(1), T + 1_000);
    assert.strictEqual(tick(b, ch(0), T + WATCH_INTERVAL).result, "network");
    assert.strictEqual(minutesAt(watchFor(w, ch(1), 1).world, drop("c0-d0"), T + HOUR), 1);
  });

  it("credits elapsed time, not ticks: two ticks a second apart earn 21 s", () => {
    const w = openSession(world([campaignSpec()]), ch(0), T);
    const first = tick(w, ch(0), T + WATCH_INTERVAL).world;
    const second = tick(first, ch(0), T + WATCH_INTERVAL + 1_000).world;
    assert.strictEqual(second.session?.creditedSeconds, 21);
  });

  it("credits the newest campaign when several could progress on one stream", () => {
    const w = world([campaignSpec({ startMinute: -60 }), campaignSpec({ startMinute: -5 })]);
    assert.strictEqual(creditedCampaign(w, ch(0), T)?.id, "c1");
    const watched = watchFor(w, ch(0), 1).world;
    assert.strictEqual(minutesAt(watched, drop("c1-d0"), T + HOUR), 1);
    assert.strictEqual(minutesAt(watched, drop("c0-d0"), T + HOUR), 0);
  });

  it("credits nothing to a drop whose precondition is unclaimed", () => {
    const spec = campaignSpec({
      drops: [
        { requiredMinutes: 1, after: null, benefit: "DIRECT_ENTITLEMENT" },
        { requiredMinutes: 5, after: 0, benefit: "DIRECT_ENTITLEMENT" },
      ],
    });
    const watched = watchFor(world([spec]), ch(0), 3).world;
    assert.strictEqual(minutesAt(watched, drop("c0-d0"), T + HOUR), 1);
    assert.strictEqual(minutesAt(watched, drop("c0-d1"), T + HOUR), 0);
    const claimed = claim(watched, instanceOf(drop("c0-d0")), T + 3 * MINUTE).world;
    const more = watchFor(claimed, ch(0), 2, T + 3 * MINUTE).world;
    assert.strictEqual(minutesAt(more, drop("c0-d1"), T + HOUR), 2);
  });

  it("credits a special-game campaign on a channel streaming any game", () => {
    const w = world([campaignSpec({ game: 2 })], [channelSpec({ game: 1 })]);
    assert.strictEqual(creditedCampaign(w, ch(0), T)?.id, "c0");
    assert.isUndefined(
      creditedCampaign(world([campaignSpec()], [channelSpec({ game: 1 })]), ch(0), T),
    );
  });

  it("credits an unlinked campaign only with a badge or an emote, or when it credits unlinked", () => {
    const items = world([campaignSpec({ linked: false })]);
    assert.isUndefined(creditedCampaign(items, ch(0), T));
    const anyway = world([campaignSpec({ linked: false, creditsUnlinked: true })]);
    assert.strictEqual(creditedCampaign(anyway, ch(0), T)?.id, "c0");
    const badge = campaignSpec({
      linked: false,
      drops: [{ requiredMinutes: 2, after: null, benefit: "BADGE" }],
    });
    assert.strictEqual(creditedCampaign(world([badge]), ch(0), T)?.id, "c0");
  });

  it("credits a channel only on the allow-list, or drops-enabled without one", () => {
    const listed = world([campaignSpec({ allowList: [1] })], [channelSpec(), channelSpec()]);
    assert.isUndefined(creditedCampaign(listed, ch(0), T));
    assert.strictEqual(creditedCampaign(listed, ch(1), T)?.id, "c0");
    const disabled = world([campaignSpec()], [channelSpec({ dropsEnabled: false })]);
    assert.isUndefined(creditedCampaign(disabled, ch(0), T));
  });

  it("completes a drop with an instance id and a current-drop answer, and no drop-claim frame", () => {
    const { world: watched, frames } = watchFor(world([campaignSpec()]), ch(0), 2);
    assert.deepStrictEqual(
      frames.map((f) => f.event._tag),
      ["DropProgress", "DropProgress"],
    );
    assert.strictEqual(
      inventoryView(watched, T + 2 * MINUTE)[0]?.drops[0]?.instanceId,
      instanceOf(drop("c0-d0")),
    );
    const asked = watchFor(
      world([campaignSpec()], [channelSpec()], 0, { claimFrames: true }),
      ch(0),
      2,
    );
    const claimable = asked.frames.at(-1)?.event;
    assert.strictEqual(
      claimable?._tag === "DropClaimable" ? claimable.instanceId : "",
      instanceOf(drop("c0-d0")),
    );
    const midway = watchFor(
      world([campaignSpec({ drops: [{ requiredMinutes: 9, after: null, benefit: "BADGE" }] })]),
      ch(0),
      3,
    ).world;
    assert.deepStrictEqual(currentDropView(midway, ch(0), T + HOUR), {
      dropId: drop("c0-d0"),
      minutes: 3,
    });
    assert.isUndefined(currentDropView(watched, ch(1), T + HOUR));
  });

  it("claims once within 24 h of the campaign's end; a second claim is already-claimed", () => {
    const spec = campaignSpec({ startMinute: -10, durationMinutes: 30 });
    const watched = watchFor(world([spec]), ch(0), 2).world;
    const end = T + 20 * MINUTE;
    const instance = instanceOf(drop("c0-d0"));
    assert.strictEqual(claim(watched, instance, end + CLAIM_GRACE).outcome, "rejected");
    const first = claim(watched, instance, end + CLAIM_GRACE - 1);
    assert.strictEqual(first.outcome, "claimed");
    assert.strictEqual(
      claim(first.world, instance, end + CLAIM_GRACE - 1).outcome,
      "already-claimed",
    );
    assert.strictEqual(claim(world([spec]), instance, T + MINUTE).outcome, "rejected");
  });

  it("shows inventory minutes late by the lag, and the claimed flag late by the scenario's lag", () => {
    const two = campaignSpec({
      drops: [
        { requiredMinutes: 2, after: null, benefit: "DIRECT_ENTITLEMENT" },
        { requiredMinutes: 60, after: null, benefit: "DIRECT_ENTITLEMENT" },
      ],
    });
    const watched = watchFor(world([two], [channelSpec()], 2), ch(0), 2).world;
    const done = T + 2 * MINUTE;
    const at = (now: number) => inventoryView(watched, now)[0]?.drops[0];
    assert.isUndefined(at(done));
    assert.strictEqual(at(done + 2 * MINUTE)?.minutes, 2);
    assert.strictEqual(at(done + 2 * MINUTE)?.instanceId, instanceOf(drop("c0-d0")));
    for (const [lag, extra] of [
      [CLAIMED_FLAG_LAG, {}],
      [CLAIMED_FLAG_LAG_MAX, { claimedFlagLagSeconds: CLAIMED_FLAG_LAG_MAX / 1000 }],
    ] as const) {
      const w = watchFor(world([two], [channelSpec()], 2, extra), ch(0), 2).world;
      const claimed = claim(w, instanceOf(drop("c0-d0")), done + 2 * MINUTE).world;
      const view = (now: number) => inventoryView(claimed, now)[0]?.drops[0]?.claimed;
      assert.isFalse(view(done + 2 * MINUTE + lag - 1));
      assert.isTrue(view(done + 2 * MINUTE + lag));
    }
  });

  it("sends stream frames only for subscribed channels, a second after the change", () => {
    const spec = channelSpec({ liveAtStart: false, changes: [{ atMinute: 5, to: "up" }] });
    const w = world([campaignSpec()], [spec, spec]);
    const subscribed = { ...w, subscriptions: new Set([ch(1)]) };
    const frames = channelFrames(subscribed, T, T + 10 * MINUTE);
    assert.deepStrictEqual(
      frames.map((f) => [f.at - T, f.event._tag]),
      [[5 * MINUTE + 1_000, "StreamUp"]],
    );
  });
});

describe("rewards received before the run, and Twitch crediting one drop only", () => {
  const witchspire = campaignSpec({
    startMinute: -24 * 60,
    durationMinutes: 48 * 60,
    drops: [
      { requiredMinutes: 60, after: null, benefit: "BADGE" },
      { requiredMinutes: 240, after: null, benefit: "BADGE", received: "in-window" },
    ],
    creditsOnly: 1,
  });

  it("credits only the chosen drop, past its requirement and claimed, never the other", () => {
    const watched = watchFor(world([witchspire]), ch(0), 5);
    assert.strictEqual(minutesAt(watched.world, drop("c0-d1"), T + HOUR), 245);
    assert.strictEqual(minutesAt(watched.world, drop("c0-d0"), T + HOUR), 0);
    // Claimed already: progress frames, never a claim frame.
    assert.deepStrictEqual(
      new Set(watched.frames.map((f) => f.event._tag)),
      new Set(["DropProgress"]),
    );
    assert.deepStrictEqual(currentDropView(watched.world, ch(0), T + 5 * MINUTE), {
      dropId: drop("c0-d1"),
      minutes: 245,
    });
  });

  it("lists a received drop in gameEventDrops only, as Twitch did for Witchspire", () => {
    const watched = watchFor(world([witchspire]), ch(0), 5).world;
    assert.deepStrictEqual(inventoryView(watched, T + HOUR), []);
    assert.deepStrictEqual(awardsAt(watched, T), [{ benefitId: "c0-d1-b", at: T - 24 * HOUR }]);
  });

  it("names a reward another campaign gave before the drop opened, and the drop still earns", () => {
    const repeat = campaignSpec({
      drops: [{ requiredMinutes: 2, after: null, benefit: "BADGE", received: "before-window" }],
    });
    const w = world([repeat]);
    assert.deepStrictEqual(awardsAt(w, T), [
      { benefitId: "c0-d0-b", at: T - 10 * MINUTE - 24 * HOUR },
    ]);
    assert.strictEqual(minutesAt(watchFor(w, ch(0), 2).world, drop("c0-d0"), T + HOUR), 2);
  });

  it("claims after the run show in gameEventDrops with the claimed flag's lag", () => {
    const watched = watchFor(world([campaignSpec()]), ch(0), 2).world;
    const claimed = claim(watched, instanceOf(drop("c0-d0")), T + 3 * MINUTE).world;
    assert.deepStrictEqual(awardsAt(claimed, T + 3 * MINUTE + CLAIMED_FLAG_LAG - 1), []);
    assert.deepStrictEqual(awardsAt(claimed, T + 3 * MINUTE + CLAIMED_FLAG_LAG), [
      { benefitId: "c0-d0-b", at: T + 3 * MINUTE },
    ]);
  });
});

/** Rules measured on the 2026-10-30 recordings (`calibration.ts`, research 04 §2b). */
describe("calibrated rules", () => {
  const apex = campaignSpec({
    drops: [
      { requiredMinutes: 15, after: null, benefit: "DIRECT_ENTITLEMENT" },
      { requiredMinutes: 60, after: null, benefit: "DIRECT_ENTITLEMENT" },
    ],
  });
  const progress = (frames: ReadonlyArray<{ readonly event: { readonly _tag: string } }>) =>
    frames.flatMap((f) =>
      f.event._tag === "DropProgress"
        ? [f.event as unknown as { dropId: string; minutes: number }]
        : [],
    );

  it("progresses every earnable drop of the campaign each minute (APEX Pack and Holospray)", () => {
    const watched = watchFor(world([apex]), ch(0), 9).world;
    assert.strictEqual(minutesAt(watched, drop("c0-d0"), T + HOUR), 9);
    assert.strictEqual(minutesAt(watched, drop("c0-d1"), T + HOUR), 9);
  });

  it("frames only the drop closest to done, on its gap schedule and at completion", () => {
    const gaps = { frameGaps: [3, 5] };
    const { frames } = watchFor(world([apex], [channelSpec()], 0, gaps), ch(0), 25);
    assert.deepStrictEqual(
      progress(frames).map((f) => [f.dropId, f.minutes]),
      [
        // 3, then 5 later, then 3; completion at 15 is framed whatever the schedule says.
        ["c0-d0", 3],
        ["c0-d0", 8],
        ["c0-d0", 11],
        ["c0-d0", 15],
        // Holospray's frames start once APEX Pack is done, at 3 + 15 = 18 and 18 + 5.
        ["c0-d1", 18],
        ["c0-d1", 23],
      ],
    );
    assert.strictEqual(sessionDrop(world([apex]), world([apex]).campaigns[0]!, T)?.id, "c0-d0");
  });

  it("frames about one minute in four with the measured gaps", () => {
    const long = campaignSpec({
      drops: [{ requiredMinutes: 240, after: null, benefit: "DIRECT_ENTITLEMENT" }],
    });
    const cycle = FRAME_GAPS.reduce((a, b) => a + b, 0);
    const w = world([long], [channelSpec()], 0, { frameGaps: FRAME_GAPS });
    const { frames } = watchFor(w, ch(0), cycle);
    // One frame per measured gap: 46 frames in 176 minutes.
    assert.deepStrictEqual([progress(frames).length, cycle], [FRAME_GAPS.length, 176]);
  });

  it("drops a campaign from the inventory once every drop shows claimed", () => {
    const one = campaignSpec({
      drops: [{ requiredMinutes: 2, after: null, benefit: "DIRECT_ENTITLEMENT" }],
    });
    const watched = watchFor(world([one]), ch(0), 2).world;
    const claimed = claim(watched, instanceOf(drop("c0-d0")), T + 2 * MINUTE).world;
    assert.strictEqual(inventoryView(claimed, T + 2 * MINUTE).length, 1);
    assert.strictEqual(inventoryView(claimed, T + 2 * MINUTE + CLAIMED_FLAG_LAG).length, 0);
  });

  it("never shows an unlinked item claimed, though the claim went through", () => {
    const item = campaignSpec({ linked: false, creditsUnlinked: true });
    const watched = watchFor(world([item]), ch(0), 2).world;
    const first = claim(watched, instanceOf(drop("c0-d0")), T + 2 * MINUTE);
    assert.strictEqual(first.outcome, "claimed");
    const shown = inventoryView(first.world, T + 3 * HOUR)[0]?.drops[0];
    assert.deepStrictEqual([shown?.claimed, shown?.instanceId], [false, instanceOf(drop("c0-d0"))]);
    assert.strictEqual(
      claim(first.world, instanceOf(drop("c0-d0")), T + HOUR).outcome,
      "already-claimed",
    );
  });

  it("holds drops claimed before the run, which list no campaign until it earns again", () => {
    const three = campaignSpec({
      startMinute: -300,
      drops: [
        { requiredMinutes: 60, after: null, benefit: "BADGE" },
        { requiredMinutes: 120, after: null, benefit: "BADGE" },
        { requiredMinutes: 240, after: null, benefit: "BADGE" },
      ],
    });
    // Witchspire had a drop left and still wasn't listed: only `gameEventDrops` names the
    // claimed one, until a credited minute lists the campaign.
    const partly = world([{ ...three, claimedBefore: 1 }]);
    assert.deepStrictEqual(inventoryView(partly, T), []);
    assert.deepStrictEqual(awardsAt(partly, T), [{ benefitId: "c0-d0-b", at: T - 4 * HOUR }]);
    const watched = watchFor(partly, ch(0), 1).world;
    assert.deepStrictEqual(
      inventoryView(watched, T + HOUR)[0]?.drops.map((d) => [d.minutes, d.claimed]),
      [
        [60, true],
        [1, false],
        [1, false],
      ],
    );
    assert.strictEqual(claim(partly, instanceOf(drop("c0-d0")), T).outcome, "already-claimed");
    const spent = world([{ ...three, claimedBefore: 3 }]);
    assert.deepStrictEqual(inventoryView(spent, T), []);
    assert.isUndefined(creditedCampaign(spent, ch(0), T));
  });

  it("claims before the run only what could be earned by then, after the drop started", () => {
    const drops = [
      { requiredMinutes: 60, after: null, benefit: "BADGE" as const },
      { requiredMinutes: 240, after: null, benefit: "BADGE" as const },
      { requiredMinutes: 10, after: 1, benefit: "BADGE" as const },
    ];
    // Started 100 minutes before the run: the 60-minute drop fits, the 240 one can't, and the
    // 10-minute one waits for it.
    const recent = world([campaignSpec({ startMinute: -100, drops, claimedBefore: 3 })]);
    assert.deepStrictEqual([...recent.claimed], [[drop("c0-d0"), T - 40 * MINUTE]]);
    // Claimed a day before the run at the earliest, never before it was earned.
    const old = world([campaignSpec({ startMinute: -2880, drops, claimedBefore: 1 })]);
    assert.deepStrictEqual([...old.claimed], [[drop("c0-d0"), T - 24 * HOUR]]);
    // A campaign that hasn't started has no history, and lists nothing before it starts.
    const future = world([campaignSpec({ startMinute: 60, drops, claimedBefore: 3 })]);
    assert.deepStrictEqual([...future.claimed], []);
    const early: World = { ...future, claimed: new Map([[drop("c0-d0"), T]]) };
    assert.deepStrictEqual(inventoryView(early, T + 59 * MINUTE), []);
    assert.lengthOf(inventoryView(early, T + 60 * MINUTE), 1);
  });

  it("reports a spent campaign's longest drop past its requirement (Golden Stamp, 263 of 240)", () => {
    const witchspire = campaignSpec({
      startMinute: -600,
      durationMinutes: 900,
      linked: false,
      drops: [
        { requiredMinutes: 60, after: null, benefit: "BADGE" },
        { requiredMinutes: 240, after: null, benefit: "BADGE" },
      ],
      claimedBefore: 2,
    });
    const { world: watched, frames } = watchFor(world([witchspire]), ch(0), 23);
    assert.deepStrictEqual(frames, []);
    assert.deepStrictEqual(currentDropView(watched, ch(0), T + 23 * MINUTE), {
      dropId: drop("c0-d1"),
      minutes: 263,
    });
  });

  it("credits a hidden campaign beside the listed one, framed, and lists it nowhere", () => {
    const hidden = campaignSpec({
      startMinute: -60,
      drops: [{ requiredMinutes: 240, after: null, benefit: "DIRECT_ENTITLEMENT" }],
      hidden: true,
    });
    const w = world([apex, hidden]);
    assert.strictEqual(creditedCampaign(w, ch(0), T)?.id, "c0");
    const { world: watched, frames } = watchFor(w, ch(0), 6);
    assert.strictEqual(minutesAt(watched, drop("c1-d0"), T + HOUR), 6);
    assert.strictEqual(minutesAt(watched, drop("c0-d0"), T + HOUR), 6);
    assert.includeMembers(
      progress(frames).map((f) => f.dropId),
      ["c0-d0", "c1-d0"],
    );
    assert.deepStrictEqual(
      inventoryView(watched, T + HOUR).map((c) => c.campaign.id),
      ["c0"],
    );
  });

  it("keeps crediting a hidden campaign once the listed one is spent", () => {
    const hidden = campaignSpec({
      startMinute: -60,
      drops: [{ requiredMinutes: 900, after: null, benefit: "DIRECT_ENTITLEMENT" }],
      hidden: true,
    });
    // The listed drop completes at 2 minutes; nothing listed is left to earn after it.
    const w = world([campaignSpec(), hidden]);
    const { world: watched } = watchFor(w, ch(0), 6);
    assert.isUndefined(creditedCampaign(watched, ch(0), T + 6 * MINUTE));
    assert.strictEqual(minutesAt(watched, drop("c0-d0"), T + HOUR), 2);
    assert.strictEqual(minutesAt(watched, drop("c1-d0"), T + HOUR), 6);
  });
});
