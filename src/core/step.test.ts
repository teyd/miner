import { assert, describe, it } from "@effect/vitest";
import { campaign, channel, chid, did, game, iid, progress, settings, T0 } from "./fixtures.ts";
import { HOUR, MINUTE, type Campaign, type Channel, type Millis } from "./model.ts";
import { Event, type Command } from "./protocol.ts";
import {
  CATALOG_RETRY,
  CLAIM_RECHECK,
  initial,
  nextDeadline,
  ONLINE_DELAY,
  STALL_AFTER,
  WATCH_INTERVAL,
  type State,
} from "./state.ts";
import { step } from "./step.ts";

/** Drives the core like the runtime does: one event at a time, time only moves forward. */
const driver = (state: State = initial(settings())) => {
  let current = state;
  let now: Millis = T0;
  const send = (event: Event, at: Millis = now): ReadonlyArray<Command> => {
    now = at;
    const result = step(current, event, now);
    current = result.state;
    return result.commands;
  };
  return {
    send,
    get state() {
      return current;
    },
    get now() {
      return now;
    },
  };
};

const tags = (commands: ReadonlyArray<Command>) => commands.map((c) => c._tag);

/** Started → token valid → catalog → channels: the miner is watching. */
const startedWatching = (campaigns: ReadonlyArray<Campaign>, channels: ReadonlyArray<Channel>) => {
  const d = driver();
  d.send(Event.Started());
  d.send(Event.TokenValid());
  d.send(Event.CatalogRead({ campaigns }));
  d.send(Event.ChannelsRead({ channels }));
  return d;
};

const watchedChannel = (s: State) =>
  s.watch._tag === "Watching" ? s.watch.channelId : s.watch.reason;

describe("start-up", () => {
  it("validates the token, reads catalog and inventory, discovers channels, then watches", () => {
    const d = driver();
    assert.deepStrictEqual(tags(d.send(Event.Started())), ["ValidateToken"]);
    assert.deepStrictEqual(tags(d.send(Event.TokenValid())), ["ReadCatalog", "ReadInventory"]);
    const listed = campaign("listed", { allowedChannels: [chid("x")] });
    assert.deepStrictEqual(
      tags(d.send(Event.CatalogRead({ campaigns: [campaign("c"), listed] }))),
      ["ReadDirectory", "ReadChannels", "Subscribe"],
    );
    const commands = d.send(Event.ChannelsRead({ channels: [channel("a")] }));
    assert.deepStrictEqual(tags(commands), ["Watch", "Subscribe"]);
    assert.strictEqual(watchedChannel(d.state), "a");
  });

  it("tells a broken catalog apart from an empty one", () => {
    const d = driver();
    d.send(Event.Started());
    d.send(Event.TokenValid());
    d.send(Event.CatalogUnavailable({ reason: "dropCampaigns was null" }));
    assert.strictEqual(watchedChannel(d.state), "catalog-unavailable");
    d.send(Event.CatalogRead({ campaigns: [] }));
    assert.strictEqual(watchedChannel(d.state), "nothing-to-mine");
  });
});

describe("switching", () => {
  it("moves to another channel when the watched one goes offline", () => {
    const d = startedWatching([campaign("c")], [channel("a", { viewers: 500 }), channel("b")]);
    assert.strictEqual(watchedChannel(d.state), "a");
    assert.deepStrictEqual(tags(d.send(Event.StreamDown({ channelId: chid("a") }))), ["Watch"]);
    assert.strictEqual(watchedChannel(d.state), "b");
  });

  it("leaves a channel that changes game, and one that refuses playback", () => {
    const d = startedWatching(
      [campaign("c")],
      [channel("a", { viewers: 500 }), channel("b", { viewers: 300 }), channel("c")],
    );
    d.send(Event.GameChanged({ channelId: chid("a"), gameId: undefined }));
    assert.strictEqual(watchedChannel(d.state), "b");
    d.send(Event.WatchFailed({ channelId: chid("b"), reason: "refused" }));
    assert.strictEqual(watchedChannel(d.state), "c");
  });

  it("doesn't hop to a busier channel of the same campaign", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    assert.deepStrictEqual(
      tags(d.send(Event.ChannelsRead({ channels: [channel("b", { viewers: 9000 })] }))),
      ["Subscribe"],
    );
    assert.strictEqual(watchedChannel(d.state), "a");
  });

  it("stays subscribed to a channel that goes offline, to hear when it's back", () => {
    const d = startedWatching([campaign("c")], [channel("a"), channel("b")]);
    d.send(Event.StreamDown({ channelId: chid("b") }));
    assert.deepStrictEqual(d.state.subscriptions, [chid("a"), chid("b")]);
  });

  it("re-reads a channel only after its stream data had time to appear", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    d.send(Event.StreamUp({ channelId: chid("b") }), T0);
    assert.notInclude(tags(d.send(Event.Tick(), T0 + ONLINE_DELAY - 1)), "ReadChannels");
    const commands = d.send(Event.Tick(), T0 + ONLINE_DELAY);
    assert.deepStrictEqual(
      commands.filter((c) => c._tag === "ReadChannels"),
      [{ _tag: "ReadChannels", channelIds: [chid("b")] }],
    );
  });

  it("stops watching when nothing is left to mine", () => {
    const c = campaign("c");
    const d = startedWatching([c], [channel("a")]);
    const commands = d.send(
      Event.InventoryRead({ progress: [progress(c, "c-d1", { minutes: 60, claimed: true })] }),
    );
    assert.include(tags(commands), "StopWatching");
    assert.strictEqual(watchedChannel(d.state), "nothing-to-mine");
  });
});

describe("progress", () => {
  it("ticks every watch interval and wakes for it", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    assert.strictEqual(nextDeadline(d.state), T0 + WATCH_INTERVAL);
    assert.deepStrictEqual(tags(d.send(Event.Tick(), T0 + WATCH_INTERVAL)), ["WatchTick"]);
  });

  it("asks which drop is credited once its estimate runs 15 minutes ahead of Twitch", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    const ticks: Array<string> = [];
    for (let i = 1; i <= 45; i++)
      ticks.push(
        ...tags(d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + i * WATCH_INTERVAL)),
      );
    assert.deepStrictEqual(ticks, ["ReadCurrentDrop"]);
  });

  it("adopts the drop Twitch says it is crediting", () => {
    const c = campaign("c", {
      drops: [
        campaign("c").drops[0]!,
        { ...campaign("c").drops[0]!, id: did("c-d2"), requiredMinutes: 240 },
      ],
    });
    const d = startedWatching([c], [channel("a")]);
    assert.strictEqual(d.state.watch._tag === "Watching" ? d.state.watch.dropId : "", "c-d1");
    d.send(Event.CurrentDropRead({ channelId: chid("a"), dropId: did("c-d2"), minutes: 12 }));
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? `${w.dropId}:${w.confirmedMinutes}` : "", "c-d2:12");
  });

  it("ignores a current-drop read for a channel it no longer watches", () => {
    const c = campaign("c", {
      drops: [
        campaign("c").drops[0]!,
        { ...campaign("c").drops[0]!, id: did("c-d2"), requiredMinutes: 240 },
      ],
    });
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.CurrentDropRead({ channelId: chid("old"), dropId: did("c-d2"), minutes: 12 }));
    assert.strictEqual(d.state.watch._tag === "Watching" ? d.state.watch.dropId : "", "c-d1");
  });

  it("keeps the drop Twitch credits instead of swapping back to its own pick", () => {
    const better = campaign("a", { endsAt: T0 + 2 * HOUR });
    const other = campaign("b");
    const d = startedWatching([better, other], [channel("x")]);
    assert.strictEqual(d.state.watch._tag === "Watching" ? d.state.watch.campaignId : "", "a");
    d.send(Event.DropProgress({ dropId: did("b-d1"), minutes: 5 }), T0 + 5 * MINUTE);
    d.send(Event.Tick(), T0 + 6 * MINUTE);
    d.send(Event.DropProgress({ dropId: did("b-d1"), minutes: 6 }), T0 + 6 * MINUTE);
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? `${w.campaignId}:${w.confirmedMinutes}` : "", "b:6");
  });

  it("re-syncs its estimate to Twitch's number instead of latching", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    for (let i = 1; i <= 45; i++) {
      d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + i * WATCH_INTERVAL);
    }
    d.send(Event.CurrentDropRead({ channelId: chid("a"), dropId: did("c-d1"), minutes: 5 }));
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? w.estimatedMinutes : -1, 5);
  });

  it("doesn't blacklist a channel that credits another drop than planned", () => {
    const c = campaign("c", {
      drops: [
        campaign("c").drops[0]!,
        { ...campaign("c").drops[0]!, id: did("c-d2"), requiredMinutes: 240 },
      ],
    });
    const d = startedWatching([c], [channel("a", { viewers: 500 }), channel("b")]);
    for (let minute = 1; minute <= 40; minute++) {
      d.send(Event.DropProgress({ dropId: did("c-d2"), minutes: minute }), T0 + minute * MINUTE);
      d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + minute * MINUTE);
    }
    assert.strictEqual(watchedChannel(d.state), "a");
    assert.isFalse(d.state.avoid.has(chid("a")));
  });

  it("keeps a channel that credits a campaign newer than its catalog, and rereads the catalog", () => {
    const d = startedWatching([campaign("c")], [channel("a", { viewers: 500 }), channel("b")]);
    for (let minute = 1; minute <= 40; minute++) {
      d.send(Event.DropProgress({ dropId: did("new-d1"), minutes: minute }), T0 + minute * MINUTE);
      d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + minute * MINUTE);
    }
    assert.strictEqual(watchedChannel(d.state), "a");
    assert.isFalse(d.state.avoid.has(chid("a")));
    assert.strictEqual(d.state.deadlines.catalog, T0 + MINUTE + CATALOG_RETRY);
  });

  it("doesn't adopt a drop Twitch credits from a campaign the settings exclude", () => {
    const wanted = campaign("a");
    const other = campaign("b", { game: game("game-2") });
    const d = driver(initial(settings({ games: [wanted.game.id] })));
    d.send(Event.Started());
    d.send(Event.TokenValid());
    d.send(Event.CatalogRead({ campaigns: [wanted, other] }));
    d.send(Event.ChannelsRead({ channels: [channel("x")] }));
    d.send(Event.DropProgress({ dropId: did("b-d1"), minutes: 5 }), T0 + 5 * MINUTE);
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? w.campaignId : "", "a");
  });

  it("gives up on a channel that never credits", () => {
    const d = startedWatching([campaign("c")], [channel("a", { viewers: 500 }), channel("b")]);
    d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + STALL_AFTER);
    assert.strictEqual(watchedChannel(d.state), "b");
    assert.isTrue(d.state.avoid.has(chid("a")));
  });

  it("never moves minutes backwards when inventory lags PubSub", () => {
    const c = campaign("c");
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.DropProgress({ dropId: did("c-d1"), minutes: 30 }));
    d.send(Event.InventoryRead({ progress: [progress(c, "c-d1", { minutes: 25 })] }));
    assert.strictEqual(d.state.progress.get(did("c-d1"))?.minutes, 30);
  });
});

describe("claims", () => {
  const c = campaign("c");
  const claims = (commands: ReadonlyArray<Command>) =>
    commands.filter((x) => x._tag === "Claim").length;

  it("claims a completed drop exactly once", () => {
    const d = startedWatching([c], [channel("a")]);
    assert.strictEqual(
      claims(d.send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }))),
      1,
    );
    assert.strictEqual(d.state.claims.get("c/c-d1")?.status, "sent");
    const complete = progress(c, "c-d1", { minutes: 60, instanceId: iid("i1") });
    assert.strictEqual(claims(d.send(Event.InventoryRead({ progress: [complete] }))), 0);
    d.send(Event.ClaimResult({ campaignId: c.id, dropId: did("c-d1"), outcome: "claimed" }));
    assert.isTrue(d.state.progress.get(did("c-d1"))?.claimed);
    assert.strictEqual(d.state.claims.size, 0);
  });

  it("reads inventory before claiming again after a lost answer", () => {
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }));
    const lost = d.send(
      Event.ClaimResult({ campaignId: c.id, dropId: did("c-d1"), outcome: "unknown" }),
    );
    assert.deepStrictEqual(tags(lost), []);
    const unclaimed = progress(c, "c-d1", { minutes: 60, instanceId: iid("i1") });
    // Inventory lags a claim by seconds: an early read must not trigger a second claim.
    assert.strictEqual(claims(d.send(Event.InventoryRead({ progress: [unclaimed] }))), 0);
    assert.include(tags(d.send(Event.Tick(), T0 + CLAIM_RECHECK)), "ReadInventory");
    assert.strictEqual(claims(d.send(Event.InventoryRead({ progress: [unclaimed] }))), 1);
  });

  it("treats a lost claim as done when inventory shows it claimed", () => {
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }));
    d.send(Event.ClaimResult({ campaignId: c.id, dropId: did("c-d1"), outcome: "unknown" }));
    const claimed = progress(c, "c-d1", { minutes: 60, instanceId: iid("i1"), claimed: true });
    assert.strictEqual(claims(d.send(Event.InventoryRead({ progress: [claimed] }))), 0);
    assert.strictEqual(d.state.claims.size, 0);
  });

  it("doesn't resend a claim that was in flight when the process died", () => {
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }));
    const restarted = driver(d.state);
    assert.deepStrictEqual(tags(restarted.send(Event.Started(), T0 + MINUTE)), ["ValidateToken"]);
    assert.strictEqual(restarted.state.claims.get("c/c-d1")?.status, "unknown");
    assert.strictEqual(claims(restarted.send(Event.TokenValid())), 0);
    const unclaimed = progress(c, "c-d1", { minutes: 60, instanceId: iid("i1") });
    // Inventory shows a claim seconds late: a read right after the restart proves nothing.
    assert.strictEqual(claims(restarted.send(Event.InventoryRead({ progress: [unclaimed] }))), 0);
    const late = T0 + MINUTE + CLAIM_RECHECK;
    assert.include(tags(restarted.send(Event.Tick(), late)), "ReadInventory");
    assert.strictEqual(claims(restarted.send(Event.InventoryRead({ progress: [unclaimed] }))), 1);
  });

  it("never sets a deadline in the past while a claim waits for its recheck", () => {
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }));
    const restarted = driver(d.state);
    restarted.send(Event.Started(), T0 + MINUTE);
    restarted.send(Event.TokenValid(), T0 + MINUTE + 1_000);
    assert.isAbove(nextDeadline(restarted.state) ?? 0, restarted.now);
    // The recheck read fails: the next inventory read rechecks, nothing spins meanwhile.
    const recheck = T0 + MINUTE + CLAIM_RECHECK;
    assert.include(tags(restarted.send(Event.Tick(), recheck)), "ReadInventory");
    assert.isAbove(nextDeadline(restarted.state) ?? 0, recheck);
  });

  it("rechecks a lost claim answer through the inventory deadline", () => {
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }));
    d.send(Event.ClaimResult({ campaignId: c.id, dropId: did("c-d1"), outcome: "unknown" }));
    assert.strictEqual(d.state.deadlines.inventory, T0 + CLAIM_RECHECK);
    assert.strictEqual(nextDeadline(d.state), T0 + WATCH_INTERVAL);
    d.send(Event.Tick(), T0 + CLAIM_RECHECK);
    assert.isAbove(nextDeadline(d.state) ?? 0, T0 + CLAIM_RECHECK);
  });

  it("claims nothing before the token is validated", () => {
    const d = startedWatching([c], [channel("a")]);
    const saved = {
      ...d.state,
      progress: new Map([
        [did("c-d1"), progress(c, "c-d1", { minutes: 60, instanceId: iid("i1") })],
      ]),
    };
    const restarted = driver(saved);
    assert.deepStrictEqual(tags(restarted.send(Event.Started(), T0 + MINUTE)), ["ValidateToken"]);
    assert.strictEqual(claims(restarted.send(Event.TokenValid())), 1);
  });

  it("wakes only for validation after a restart, whatever deadlines were saved", () => {
    const d = startedWatching([c], [channel("a")]);
    const restarted = driver(d.state);
    restarted.send(Event.Started(), T0 + 3 * HOUR);
    assert.strictEqual(nextDeadline(restarted.state), T0 + 3 * HOUR + HOUR);
  });

  it("claims a drop from a campaign that already ended, within 24 h", () => {
    const ended = campaign("e", { endsAt: T0 - HOUR });
    const d = startedWatching([c], [channel("a")]);
    const done = progress(ended, "e-d1", { minutes: 60, instanceId: iid("i2") });
    assert.strictEqual(claims(d.send(Event.InventoryRead({ progress: [done] }))), 1);
    const late = progress(ended, "e-d2", {
      minutes: 60,
      instanceId: iid("i3"),
      campaignEndsAt: T0 - 25 * HOUR,
    });
    assert.strictEqual(claims(d.send(Event.InventoryRead({ progress: [late] }))), 0);
  });
});

describe("auth", () => {
  it("parks on a refused token: stops, unsubscribes, then does nothing", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    assert.deepStrictEqual(tags(d.send(Event.AuthFailed())), ["StopWatching", "Subscribe"]);
    assert.strictEqual(watchedChannel(d.state), "needs-login");
    assert.deepStrictEqual(d.send(Event.Tick(), T0 + 2 * HOUR), []);
    assert.deepStrictEqual(d.send(Event.StreamUp({ channelId: chid("a") })), []);
    assert.isUndefined(nextDeadline(d.state));
  });

  it("validates the token every hour", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    assert.include(tags(d.send(Event.Tick(), T0 + HOUR)), "ValidateToken");
  });
});
