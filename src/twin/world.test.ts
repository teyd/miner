import { assert, describe, it } from "@effect/vitest";
import { CLAIM_GRACE, HOUR, MINUTE, type ChannelId, type DropId } from "../core/model.ts";
import { WATCH_INTERVAL } from "../core/state.ts";
import { SIM_EPOCH, type Scenario } from "./scenario.ts";
import {
  CLAIMED_FLAG_LAG,
  buildWorld,
  channelFrames,
  claim,
  creditedCampaign,
  currentDropView,
  instanceOf,
  inventoryView,
  minutesAt,
  openSession,
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
): World =>
  buildWorld({
    latencySeed: 1,
    horizonMinutes: 600,
    inventoryLagMinutes: lag,
    settings: { games: [], exclude: [], badgesAndEmotes: true },
    campaigns,
    channels,
    faults: [],
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

  it("credits an unlinked campaign only when it has a badge or an emote", () => {
    const items = world([campaignSpec({ linked: false })]);
    assert.isUndefined(creditedCampaign(items, ch(0), T));
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

  it("completes a drop with an instance id, a drop-claim frame and a current-drop answer", () => {
    const w = world([campaignSpec()]);
    const { world: watched, frames } = watchFor(w, ch(0), 2);
    assert.deepStrictEqual(
      frames.map((f) => f.event._tag),
      ["DropProgress", "DropProgress", "DropClaimable"],
    );
    const claimable = frames.at(-1)?.event;
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

  it("shows inventory minutes late by the lag, and the claimed flag 10 s after the claim", () => {
    const w = world([campaignSpec()], [channelSpec()], 2);
    const watched = watchFor(w, ch(0), 2).world;
    const done = T + 2 * MINUTE;
    const at = (now: number) => inventoryView(watched, now)[0]?.drops[0];
    assert.isUndefined(at(done));
    assert.strictEqual(at(done + 2 * MINUTE)?.minutes, 2);
    assert.strictEqual(at(done + 2 * MINUTE)?.instanceId, instanceOf(drop("c0-d0")));
    const claimed = claim(watched, instanceOf(drop("c0-d0")), done + 2 * MINUTE).world;
    const view = (now: number) => inventoryView(claimed, now)[0]?.drops[0]?.claimed;
    assert.isFalse(view(done + 2 * MINUTE + CLAIMED_FLAG_LAG - 1));
    assert.isTrue(view(done + 2 * MINUTE + CLAIMED_FLAG_LAG));
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
