import { assert, describe, it } from "@effect/vitest";
import {
  badge,
  campaign,
  channel,
  chid,
  did,
  drop,
  emote,
  game,
  games,
  goal,
  iid,
  progress,
  settings,
  T0,
} from "./fixtures.ts";
import { HOUR, MINUTE, type Campaign, type Channel, type Millis } from "./model.ts";
import { Command, Event, readKey } from "./protocol.ts";
import {
  CAMPAIGN_SKIP,
  CATALOG_OPENING_GAP,
  CATALOG_RETRY,
  CLAIM_RECHECK,
  READ_GAP,
  READ_WORST_CASE,
  discoverySettle,
  initial,
  nextDeadline,
  ONLINE_DELAY,
  STALL_AFTER,
  SUBSCRIBE_SETTLE,
  THROTTLE_FLOOR,
  VALIDATE_INTERVAL,
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

/** A channel read's answer. The default key answers the directory read of `game-1`. */
const read = (channels: ReadonlyArray<Channel>, key = "directory:game-1") =>
  Event.ChannelsRead({ channels, read: key });

const reads = (commands: ReadonlyArray<Command>) =>
  commands.flatMap((c) => (c._tag === "ReadDirectory" || c._tag === "ReadChannels" ? [c] : []));

/** Started → token valid → catalog → its channel reads answered: the miner is watching. */
const startedWatching = (campaigns: ReadonlyArray<Campaign>, channels: ReadonlyArray<Channel>) => {
  const d = driver();
  d.send(Event.Started());
  d.send(Event.TokenValid());
  for (const [i, command] of reads(d.send(Event.CatalogRead({ campaigns }))).entries()) {
    d.send(read(i === 0 ? channels : [], readKey(command)));
  }
  return d;
};

/** Lets a pending change of the followed channels go out. */
const settle = (d: ReturnType<typeof driver>) => d.send(Event.Tick(), d.now + SUBSCRIBE_SETTLE);

const subscribes = (commands: ReadonlyArray<Command>) =>
  commands.flatMap((c) => (c._tag === "Subscribe" ? [c.channelIds] : []));

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
      ["ReadDirectory", "ReadChannels"],
    );
    assert.deepStrictEqual(tags(d.send(read([channel("a")]))), []);
    assert.strictEqual(watchedChannel(d.state), "discovering");
    const commands = d.send(read([channel("x", "offline")], "channels:x"));
    assert.deepStrictEqual(tags(commands), ["Watch"]);
    assert.strictEqual(watchedChannel(d.state), "a");
    assert.deepStrictEqual(subscribes(settle(d)), [[chid("a"), chid("x")]]);
  });

  it("plans on every discovery answer, not the first one in (the live startup flip)", () => {
    const top = campaign("top", { game: game("top") });
    const low = campaign("low", { game: game("low") });
    const d = driver(initial(settings({ games: games(["top", "low"]) })));
    d.send(Event.Started());
    d.send(Event.TokenValid());
    const issued = reads(d.send(Event.CatalogRead({ campaigns: [low, top] })));
    assert.deepStrictEqual(issued.map(readKey), ["directory:top", "directory:low"]);
    assert.strictEqual(nextDeadline(d.state), T0 + discoverySettle(issued));
    // The lower-ranked game answers first: nothing starts on half the picture.
    assert.deepStrictEqual(
      tags(d.send(read([channel("b", { gameId: "low" })], "directory:low"))),
      [],
    );
    assert.strictEqual(watchedChannel(d.state), "discovering");
    const commands = d.send(read([channel("a", { gameId: "top" })], "directory:top"));
    assert.deepStrictEqual(tags(commands), ["Watch"]);
    assert.strictEqual(watchedChannel(d.state), "a");
    assert.isUndefined(d.state.discovery);
  });

  it("reads the catalog again when a wanted drop opens its window, to find its channels", () => {
    const later = campaign("later", {
      drops: [
        drop("soon", { startsAt: T0 + 20 * MINUTE }),
        drop("much-later", { startsAt: T0 + 2 * HOUR }),
      ],
    });
    const d = driver();
    d.send(Event.Started());
    d.send(Event.TokenValid());
    // Nothing earns yet, so no channel is read for it.
    assert.deepStrictEqual(reads(d.send(Event.CatalogRead({ campaigns: [later] }))), []);
    assert.strictEqual(d.state.deadlines.catalog, T0 + 20 * MINUTE);
    assert.include(tags(d.send(Event.Tick(), T0 + 20 * MINUTE)), "ReadCatalog");
    const issued = reads(d.send(Event.CatalogRead({ campaigns: [later] })));
    assert.deepStrictEqual(issued.map(readKey), ["directory:game-1"]);
    // The next opening is past the regular interval: the regular read finds it.
    assert.strictEqual(d.state.deadlines.catalog, T0 + 20 * MINUTE + HOUR);
  });

  it("reads the catalog at most four times an hour, however many drops open", () => {
    // A drop opens every 5 minutes for 4 hours, in two games: each catalog read also reads
    // their directories, so the rate of both is bounded by the catalog's.
    const opening = (name: string, g: string) =>
      campaign(name, {
        game: game(g),
        endsAt: T0 + 6 * HOUR,
        drops: Array.from({ length: 48 }, (_, i) =>
          drop(`${name}-${i}`, { startsAt: T0 + (i + 1) * 5 * MINUTE, endsAt: T0 + 6 * HOUR }),
        ),
      });
    const campaigns = [opening("x", "gx"), opening("y", "gy")];
    const d = driver();
    d.send(Event.Started());
    d.send(Event.TokenValid());
    const catalogReads: Array<Millis> = [T0];
    let directoryReads = reads(d.send(Event.CatalogRead({ campaigns }))).length;
    while (d.now < T0 + 4 * HOUR) {
      const commands = d.send(Event.Tick(), nextDeadline(d.state) ?? d.now + HOUR);
      if (!tags(commands).includes("ReadCatalog")) continue;
      catalogReads.push(d.now);
      const started = reads(d.send(Event.CatalogRead({ campaigns })));
      directoryReads += started.length;
      for (const r of started) d.send(read([], readKey(r)));
    }
    for (const at of catalogReads) {
      assert.isAtMost(catalogReads.filter((t) => t >= at && t < at + HOUR).length, 4);
    }
    assert.isAtMost(directoryReads, 2 * catalogReads.length);
    assert.isAtLeast(catalogReads.length, 4 * 4 - 1);
  });

  it("stops waiting for a read that failed", () => {
    const top = campaign("top", { game: game("top") });
    const low = campaign("low", { game: game("low") });
    const d = driver();
    d.send(Event.Started());
    d.send(Event.TokenValid());
    d.send(Event.CatalogRead({ campaigns: [low, top] }));
    d.send(read([channel("b", { gameId: "low" })], "directory:low"), T0 + 1_000);
    assert.strictEqual(watchedChannel(d.state), "discovering");
    const commands = d.send(Event.ChannelsReadFailed({ read: "directory:top" }), T0 + 135_000);
    assert.include(tags(commands), "Watch");
    assert.strictEqual(watchedChannel(d.state), "b");
    assert.isUndefined(d.state.discovery);
  });

  it("stops waiting for a read that never answers once no read can still be running", () => {
    const top = campaign("top", { game: game("top") });
    const low = campaign("low", { game: game("low") });
    const d = driver();
    d.send(Event.Started());
    d.send(Event.TokenValid());
    const issued = reads(d.send(Event.CatalogRead({ campaigns: [low, top] })));
    d.send(read([channel("b", { gameId: "low" })], "directory:low"), T0 + 1_000);
    const settle = discoverySettle(issued);
    // A read that fails every attempt answers only after its worst case: still waiting then.
    assert.isAbove(settle, READ_WORST_CASE);
    const watches = (commands: ReadonlyArray<Command>) =>
      tags(commands).filter((t) => t === "Watch");
    assert.deepStrictEqual(watches(d.send(Event.Tick(), T0 + READ_WORST_CASE)), []);
    assert.deepStrictEqual(watches(d.send(Event.Tick(), T0 + settle - 1)), []);
    assert.deepStrictEqual(watches(d.send(Event.Tick(), T0 + settle)), ["Watch"]);
    assert.strictEqual(watchedChannel(d.state), "b");
  });

  it("waits longer for more reads: every attempt queues at the pacer", () => {
    const directories = (n: number) =>
      Array.from({ length: n }, (_, i) => Command.ReadDirectory({ gameId: game(`g${i}`).id }));
    assert.strictEqual(
      discoverySettle(directories(50)) - discoverySettle(directories(10)),
      40 * 4 * READ_GAP,
    );
    const many = Command.ReadChannels({
      channelIds: Array.from({ length: 100 }, (_, i) => chid(`c${i}`)),
    });
    // 100 channels are three stream-info requests, one after the other.
    assert.isAbove(discoverySettle([many]), 3 * READ_WORST_CASE);
  });

  it("keeps a working watch through a catalog reread, and switches once it has every answer", () => {
    const low = campaign("low", { game: game("low") });
    const d = driver(initial(settings({ games: games(["top", "low"]) })));
    d.send(Event.Started());
    d.send(Event.TokenValid());
    d.send(Event.CatalogRead({ campaigns: [low] }));
    d.send(read([channel("b", { gameId: "low" })], "directory:low"));
    assert.strictEqual(watchedChannel(d.state), "b");
    const top = campaign("top", { game: game("top") });
    const later = T0 + HOUR;
    d.send(Event.CatalogRead({ campaigns: [low, top] }), later);
    d.send(read([channel("b", { gameId: "low" })], "directory:low"), later + 500);
    assert.strictEqual(watchedChannel(d.state), "b");
    const commands = d.send(read([channel("a", { gameId: "top" })], "directory:top"), later + 900);
    assert.deepStrictEqual(tags(commands), ["Watch"]);
    assert.strictEqual(watchedChannel(d.state), "a");
  });

  it("stops a watch that can't earn any more while discovery runs", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    d.send(Event.CatalogRead({ campaigns: [campaign("c")] }), T0 + HOUR);
    assert.deepStrictEqual(tags(d.send(Event.StreamDown({ channelId: chid("a") }))), [
      "StopWatching",
    ]);
    assert.strictEqual(watchedChannel(d.state), "discovering");
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
    settle(d);
    assert.deepStrictEqual(tags(d.send(read([channel("b", { viewers: 9000 })], "channels:b"))), []);
    assert.strictEqual(watchedChannel(d.state), "a");
  });

  it("stays subscribed to a channel that goes offline, to hear when it's back", () => {
    const d = startedWatching([campaign("c")], [channel("a"), channel("b")]);
    settle(d);
    assert.deepStrictEqual(tags(d.send(Event.StreamDown({ channelId: chid("b") }))), []);
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
      Event.InventoryRead({
        progress: [progress(c, "c-d1", { minutes: 60, claimed: true })],
        awarded: [],
      }),
    );
    assert.include(tags(commands), "StopWatching");
    assert.strictEqual(watchedChannel(d.state), "nothing-to-mine");
  });
});

describe("progress", () => {
  it("ticks every watch interval and wakes for it", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    settle(d);
    assert.strictEqual(nextDeadline(d.state), T0 + WATCH_INTERVAL);
    assert.deepStrictEqual(tags(d.send(Event.Tick(), T0 + WATCH_INTERVAL)), ["WatchTick"]);
  });

  it("never ticks a watch the same step stops (a drop's window closing at a tick)", () => {
    const c = campaign("c", { drops: [drop("short", { endsAt: T0 + 10 * MINUTE })] });
    const d = startedWatching([c], [channel("a")]);
    settle(d);
    const due = d.state.deadlines.tick!;
    assert.isAtMost(due, T0 + 10 * MINUTE);
    let at = due;
    while (at < T0 + 10 * MINUTE) {
      assert.include(tags(d.send(Event.Tick(), at)), "WatchTick");
      at = d.state.deadlines.tick!;
    }
    const commands = tags(d.send(Event.Tick(), at));
    assert.include(commands, "StopWatching");
    assert.notInclude(commands, "WatchTick");
  });

  it("asks which drop is credited once its estimate runs 15 minutes ahead of Twitch", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    settle(d);
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
    const d = driver(initial(settings({ games: games([wanted.game.id]) })));
    d.send(Event.Started());
    d.send(Event.TokenValid());
    d.send(Event.CatalogRead({ campaigns: [wanted, other] }));
    d.send(read([channel("x")]));
    d.send(Event.DropProgress({ dropId: did("b-d1"), minutes: 5 }), T0 + 5 * MINUTE);
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? w.campaignId : "", "a");
  });

  it("doesn't adopt a credit only a goal excluding the watched channel wants", () => {
    const badges = campaign("a", { drops: [drop("a-d1", { benefits: [badge] })] });
    const items = campaign("b");
    const goals = [
      goal({ rewards: ["badge"] }),
      goal({ rewards: ["item"], excludeChannels: [chid("x")] }),
    ];
    const d = driver(initial({ goals }));
    d.send(Event.Started());
    d.send(Event.TokenValid());
    d.send(Event.CatalogRead({ campaigns: [badges, items] }));
    d.send(read([channel("x")]));
    assert.strictEqual(watchedChannel(d.state), "x");
    d.send(Event.DropProgress({ dropId: did("b-d1"), minutes: 5 }), T0 + 5 * MINUTE);
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? `${w.campaignId}:${w.credited}` : "", "a:false");
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
    d.send(Event.InventoryRead({ progress: [progress(c, "c-d1", { minutes: 25 })], awarded: [] }));
    assert.strictEqual(d.state.progress.get(did("c-d1"))?.minutes, 30);
  });
});

/**
 * The 4 h live run of 2026-10-30, Witchspire: "Witchspire Logo" (60 min) and "Gold Stamp"
 * (240 min), both badges, received the day before and listed only in `gameEventDrops`. The
 * miner watched for the Logo while Twitch credited the Gold Stamp at 263 to 352 of 240 minutes.
 */
describe("rewards already received, and credit the plan can't use", () => {
  const logo = { id: "b-logo", name: "Witchspire Logo", distribution: "BADGE" } as const;
  const stamp = { id: "b-stamp", name: "Gold Stamp", distribution: "BADGE" } as const;
  const witch = campaign("w", {
    drops: [
      drop("w-logo", { benefits: [logo] }),
      drop("w-stamp", { requiredMinutes: 240, benefits: [stamp] }),
    ],
  });
  const other = campaign("o", { game: game("game-2"), endsAt: T0 + 48 * HOUR });
  const received = [
    { benefitId: logo.id, at: T0 - HOUR },
    { benefitId: stamp.id, at: T0 - HOUR },
  ];
  const watchedCampaign = (s: State) =>
    s.watch._tag === "Watching" ? s.watch.campaignId : s.watch.reason;

  /** Watching `a` for the Logo, `y` streaming game 2 for the other campaign. */
  const watchingWitch = () => {
    const d = driver();
    d.send(Event.Started());
    const commands = d.send(Event.TokenValid());
    assert.include(tags(commands), "ReadInventory");
    for (const command of reads(d.send(Event.CatalogRead({ campaigns: [witch, other] })))) {
      const answer =
        command._tag === "ReadDirectory" && command.gameId === "game-2"
          ? [channel("y", { gameId: "game-2" })]
          : [channel("a", { viewers: 500 }), channel("b")];
      d.send(read(answer, readKey(command)));
    }
    return d;
  };

  it("skips a campaign whose rewards the account already has (gameEventDrops)", () => {
    const d = watchingWitch();
    assert.strictEqual(watchedCampaign(d.state), "w");
    d.send(Event.InventoryRead({ progress: [], awarded: received }), T0 + MINUTE);
    assert.strictEqual(watchedCampaign(d.state), "o");
    assert.strictEqual(watchedChannel(d.state), "y");
  });

  it("keeps a received drop's progress as the inventory lists it (TDM reads `self` first)", () => {
    const d = watchingWitch();
    const listed = [progress(witch, "w-logo", { minutes: 10 })];
    d.send(Event.InventoryRead({ progress: listed, awarded: received }), T0 + MINUTE);
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? w.dropId : "", "w-logo");
  });

  it("counts an award from before the drop's window as another campaign's: the drop still earns", () => {
    const d = watchingWitch();
    const earlier = received.map((a) => ({ ...a, at: witch.drops[0]!.startsAt - MINUTE }));
    d.send(Event.InventoryRead({ progress: [], awarded: earlier }), T0 + MINUTE);
    assert.strictEqual(watchedCampaign(d.state), "w");
  });

  it("skips the campaign when Twitch only credits a drop past its requirement", () => {
    const d = watchingWitch();
    // Every 15 minutes the estimate runs ahead and the current drop is read: the Gold Stamp.
    for (let minute = 1; minute < 30; minute++) {
      const at = T0 + minute * MINUTE;
      d.send(Event.WatchTicked({ channelId: chid("a") }), at);
      if (minute % 15 === 0) {
        const minutes = 263 + minute;
        d.send(Event.CurrentDropRead({ channelId: chid("a"), dropId: did("w-stamp"), minutes }));
      }
    }
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? `${w.dropId}:${w.confirmedAt}` : "", `w-logo:${T0}`);
    assert.strictEqual(w._tag === "Watching" ? w.wasted : undefined, "w-stamp");
    const commands = d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + STALL_AFTER);
    // For an hour at most: Twitch may move off the drop.
    assert.strictEqual(d.state.avoidCampaigns.get(witch.id), T0 + STALL_AFTER + CAMPAIGN_SKIP);
    // Twitch credits the wrong drop wherever we watch: the channel itself isn't to blame.
    assert.isFalse(d.state.avoid.has(chid("a")));
    assert.deepStrictEqual(
      commands.filter((c) => c._tag === "Watch"),
      [Command.Watch({ channelId: chid("y") })],
    );
    d.send(Event.Started(), T0 + STALL_AFTER + MINUTE);
    assert.strictEqual(d.state.avoidCampaigns.size, 0);
  });

  /** Watching `y` for the other campaign, the Witchspire campaign skipped for the Gold Stamp. */
  const skippedWitch = () => {
    const d = watchingWitch();
    d.send(Event.CurrentDropRead({ channelId: chid("a"), dropId: did("w-stamp"), minutes: 300 }));
    d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + STALL_AFTER);
    assert.strictEqual(watchedCampaign(d.state), "o");
    return d;
  };

  /** A tick at `at`, with the catalog and channel reads it starts answered. */
  const tickAnswered = (d: ReturnType<typeof driver>, at: Millis) => {
    const commands = [...d.send(Event.Tick(), at)];
    if (commands.some((c) => c._tag === "ReadCatalog")) {
      for (const command of reads(d.send(Event.CatalogRead({ campaigns: [witch, other] })))) {
        const answer =
          command._tag === "ReadDirectory" && command.gameId === "game-2"
            ? [channel("y", { gameId: "game-2" })]
            : [channel("a", { viewers: 500 }), channel("b")];
        commands.push(...d.send(read(answer, readKey(command))));
      }
    }
    return commands;
  };

  it("tries a skipped campaign again once its skip ends, and gives it up at once on the same drop", () => {
    const d = skippedWitch();
    const until = d.state.avoidCampaigns.get(witch.id)!;
    assert.strictEqual(nextDeadline(d.state)! <= until, true);
    tickAnswered(d, until);
    assert.strictEqual(d.state.avoidCampaigns.size, 0);
    assert.strictEqual(watchedCampaign(d.state), "w");
    // Twitch still credits the Gold Stamp: the cause stands, no second stall.
    const at = until + MINUTE;
    d.send(Event.DropProgress({ dropId: did("w-stamp"), minutes: 400 }), at);
    assert.strictEqual(d.state.avoidCampaigns.get(witch.id), at + CAMPAIGN_SKIP);
    assert.strictEqual(watchedCampaign(d.state), "o");
  });

  it("doesn't skip again on a stale frame once the campaign has earned again", () => {
    // Review of A6: one stale frame for the old cause used to cost a fresh hour of a campaign
    // that had credited seconds before.
    const d = skippedWitch();
    const until = d.state.avoidCampaigns.get(witch.id)!;
    tickAnswered(d, until);
    assert.strictEqual(watchedCampaign(d.state), "w");
    // The Logo earns a minute: the skip's cause is gone.
    const earned = until + MINUTE;
    d.send(Event.DropProgress({ dropId: did("w-logo"), minutes: 1 }), earned);
    assert.strictEqual(d.state.skipCauses.has(witch.id), false);
    // A straggling frame for the Gold Stamp, with the same number, earns nothing and must not skip.
    d.send(Event.DropProgress({ dropId: did("w-stamp"), minutes: 400 }), earned + MINUTE);
    assert.strictEqual(d.state.avoidCampaigns.has(witch.id), false);
  });

  it("gives the channel a fresh stall for its next target after a campaign skip", () => {
    const d = watchingWitch();
    const third = campaign("t", { endsAt: T0 + 30 * HOUR });
    d.send(Event.CatalogRead({ campaigns: [witch, other, third] }), T0 + MINUTE);
    for (const command of reads(d.send(Event.Tick(), T0 + MINUTE))) {
      d.send(read([channel("a", { viewers: 500 })], readKey(command)));
    }
    d.send(Event.CurrentDropRead({ channelId: chid("a"), dropId: did("w-stamp"), minutes: 300 }));
    d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + STALL_AFTER);
    // `t` on `a`, the channel Twitch credited the skipped campaign on, keeps the channel for now.
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? `${w.campaignId}:${w.channelId}` : "", "t:a");
    assert.strictEqual(w._tag === "Watching" ? w.confirmedAt : 0, T0 + STALL_AFTER);
    d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + STALL_AFTER + WATCH_INTERVAL);
    assert.isFalse(d.state.avoid.has(chid("a")));
  });

  it("confirms the watch on a credit to a drop of the campaign the goal filters out", () => {
    // The goal wants the item; Twitch reports the badge drop, earning alongside it, and moves on
    // to the item once the badge completes. From 10 minutes in, the badge is within a stall of it.
    const both = campaign("p", {
      drops: [
        drop("p-badge", { requiredMinutes: 40, benefits: [badge] }),
        drop("p-item", { requiredMinutes: 120 }),
      ],
    });
    const d = driver(initial(settings({ rewards: ["item"] })));
    d.send(Event.Started());
    d.send(Event.TokenValid());
    for (const command of reads(d.send(Event.CatalogRead({ campaigns: [both] })))) {
      d.send(read([channel("a")], readKey(command)));
    }
    for (let minute = 1; minute <= 40; minute++) {
      const at = T0 + minute * MINUTE;
      d.send(Event.WatchTicked({ channelId: chid("a") }), at);
      d.send(Event.DropProgress({ dropId: did("p-badge"), minutes: minute }), at);
    }
    const w = d.state.watch;
    assert.strictEqual(
      w._tag === "Watching" ? `${w.dropId}:${w.confirmedAt}:${String(w.wasted)}` : "",
      `p-item:${T0 + 40 * MINUTE}:undefined`,
    );
    assert.strictEqual(d.state.avoidCampaigns.size, 0);
    assert.strictEqual(d.state.avoid.size, 0);
  });

  it("skips the campaign when the filtered drop Twitch credits is more than a stall from done", () => {
    // Twin seed 80578: Twitch credits only a 148-minute item of the campaign, the goal wants its
    // badge. Each frame used to confirm the watch, so the stall never came.
    const both = campaign("p", {
      drops: [
        drop("p-item", { requiredMinutes: 148 }),
        drop("p-badge", { requiredMinutes: 79, benefits: [badge] }),
      ],
    });
    const d = driver(initial(settings({ rewards: ["badge"] })));
    d.send(Event.Started());
    d.send(Event.TokenValid());
    for (const command of reads(d.send(Event.CatalogRead({ campaigns: [both] })))) {
      d.send(read([channel("a")], readKey(command)));
    }
    for (let minute = 1; minute < 30; minute++) {
      const at = T0 + minute * MINUTE;
      d.send(Event.WatchTicked({ channelId: chid("a") }), at);
      d.send(Event.DropProgress({ dropId: did("p-item"), minutes: minute }), at);
    }
    const w = d.state.watch;
    assert.strictEqual(
      w._tag === "Watching" ? `${w.dropId}:${w.confirmedAt}:${String(w.wasted)}` : "",
      `p-badge:${T0}:p-item`,
    );
    d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + STALL_AFTER);
    // The campaign is to blame, not the channel.
    assert.isTrue(d.state.avoidCampaigns.has(both.id));
    assert.isFalse(d.state.avoid.has(chid("a")));
  });

  it("keeps a channel crediting another wanted campaign's filtered drop a stall from done", () => {
    // Twin seed 270187: the core watches `x` (a special-events campaign any channel can credit),
    // and Twitch credits `y` here instead, its badge first and the emote the goal wants once the
    // badge completes. Giving the channel up 5 minutes short of the emote was unfair.
    const special = campaign("x", { game: game("509663") });
    const other = campaign("y", {
      drops: [
        drop("y-badge", { requiredMinutes: 35, benefits: [badge] }),
        drop("y-emote", { requiredMinutes: 13, benefits: [emote] }),
      ],
    });
    const goals = [
      goal({ games: games([special.game.id], ["item"]) }),
      goal({ games: games([other.game.id], ["emote"]) }),
    ];
    const d = driver(initial({ goals }));
    d.send(Event.Started());
    d.send(Event.TokenValid());
    for (const command of reads(d.send(Event.CatalogRead({ campaigns: [special, other] })))) {
      d.send(read([channel("a")], readKey(command)));
    }
    assert.strictEqual(watchedChannel(d.state), "a");
    for (let minute = 1; minute < 35; minute++) {
      const at = T0 + minute * MINUTE;
      d.send(Event.WatchTicked({ channelId: chid("a") }), at);
      d.send(Event.DropProgress({ dropId: did("y-badge"), minutes: minute }), at);
    }
    // Minutes 1-4 led nowhere yet; from 5 on the badge was within a stall of done.
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? w.confirmedAt : 0, T0 + 34 * MINUTE);
    assert.isFalse(d.state.avoid.has(chid("a")));
  });

  it("credits a wanted drop the inventory shows rising without a frame", () => {
    // Twitch frames only the drop closest to done in a campaign (run4h): `y`'s emote earns
    // silently beside the framed badge. Only the inventory shows it (twin seed 161).
    const x = campaign("x", { endsAt: T0 + 2 * HOUR });
    const y = campaign("y", {
      drops: [
        drop("y-emote", { requiredMinutes: 50, benefits: [emote] }),
        drop("y-badge", { requiredMinutes: 40, benefits: [badge] }),
      ],
    });
    const d = driver(initial(settings({ rewards: ["item", "emote"] })));
    d.send(Event.Started());
    d.send(Event.TokenValid());
    for (const command of reads(d.send(Event.CatalogRead({ campaigns: [x, y] })))) {
      d.send(read([channel("a")], readKey(command)));
    }
    assert.strictEqual(d.state.watch._tag === "Watching" ? d.state.watch.dropId : "", "x-d1");
    const at = T0 + 5 * MINUTE;
    const listed = [progress(y, "y-emote", { minutes: 5 }), progress(y, "y-badge", { minutes: 5 })];
    d.send(Event.InventoryRead({ progress: listed, awarded: [] }), at);
    const w = d.state.watch;
    assert.strictEqual(
      w._tag === "Watching" ? `${w.dropId}:${w.credited}:${w.confirmedAt}` : "",
      `y-emote:true:${at}`,
    );
  });

  it("only records a rise the inventory shows for a campaign the watched channel can't earn", () => {
    // Minutes the previous watch earned before a switch, shown late: no sign from this channel.
    const x = campaign("x");
    const y = campaign("y", { game: game("game-2") });
    const d = startedWatching([x, y], [channel("a")]);
    assert.strictEqual(d.state.watch._tag === "Watching" ? d.state.watch.dropId : "", "x-d1");
    const listed = [progress(y, "y-d1", { minutes: 5 })];
    d.send(Event.InventoryRead({ progress: listed, awarded: [] }), T0 + 5 * MINUTE);
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? `${w.dropId}:${w.confirmedAt}` : "", `x-d1:${T0}`);
    assert.strictEqual(d.state.progress.get(did("y-d1"))?.minutes, 5);
  });

  it("doesn't take minutes past a drop's requirement as progress, from any source", () => {
    const d = watchingWitch();
    d.send(Event.DropProgress({ dropId: did("w-stamp"), minutes: 300 }), T0 + MINUTE);
    const listed = [progress(witch, "w-stamp", { minutes: 301 })];
    d.send(Event.InventoryRead({ progress: listed, awarded: [] }), T0 + 2 * MINUTE);
    const w = d.state.watch;
    assert.strictEqual(w._tag === "Watching" ? `${w.dropId}:${w.confirmedAt}` : "", `w-logo:${T0}`);
  });

  it("reads the inventory once as a drop completes, not for every minute past it", () => {
    const d = watchingWitch();
    const progressAt = (minutes: number) =>
      tags(d.send(Event.DropProgress({ dropId: did("w-logo"), minutes }), T0 + minutes * MINUTE));
    assert.notInclude(progressAt(59), "ReadInventory");
    assert.include(progressAt(60), "ReadInventory");
    assert.notInclude(progressAt(61), "ReadInventory");
    assert.notInclude(progressAt(62), "ReadInventory");
  });

  it("follows Twitch to another drop of the campaign it can still use", () => {
    const d = watchingWitch();
    d.send(Event.DropProgress({ dropId: did("w-stamp"), minutes: 7 }), T0 + 7 * MINUTE);
    const w = d.state.watch;
    assert.strictEqual(
      w._tag === "Watching" ? `${w.dropId}:${w.confirmedAt}:${String(w.wasted)}` : "",
      `w-stamp:${T0 + 7 * MINUTE}:undefined`,
    );
  });

  it("avoids the channel, not the campaign, when the channel credits another campaign", () => {
    const d = watchingWitch();
    for (let minute = 1; minute < 30; minute++) {
      d.send(
        Event.DropProgress({ dropId: did("o-d1"), minutes: 60 + minute }),
        T0 + minute * MINUTE,
      );
    }
    d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + STALL_AFTER);
    assert.isTrue(d.state.avoid.has(chid("a")));
    assert.strictEqual(d.state.avoidCampaigns.size, 0);
    assert.strictEqual(watchedChannel(d.state), "b");
  });
});

describe("no live channel for what earns", () => {
  it("reads the catalog and directories again within CATALOG_OPENING_GAP, not the hour", () => {
    // Twin seed 50138: the only channel the core knew on the game was given up after a stall
    // (its change of game was lost with the frames); another turned to the game unheard.
    const c = campaign("c");
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.WatchTicked({ channelId: chid("a") }), T0 + STALL_AFTER);
    assert.strictEqual(watchedChannel(d.state), "no-live-channel");
    const due = T0 + STALL_AFTER + CATALOG_OPENING_GAP;
    assert.strictEqual(d.state.deadlines.catalog, due);
    assert.include(tags(d.send(Event.Tick(), due)), "ReadCatalog");
    const directory = reads(d.send(Event.CatalogRead({ campaigns: [c] }), due));
    assert.deepStrictEqual(tags(directory), ["ReadDirectory"]);
    d.send(read([channel("b")], readKey(directory[0]!)));
    assert.strictEqual(watchedChannel(d.state), "b");
  });

  it("wakes when a known drop opens and watches a channel it already knows", () => {
    // Twin seed 270057: the opening only brought the catalog read forward, to 15 minutes after
    // the last; the core started at the next inventory read, up to 5 minutes late.
    const opens = T0 + 7 * MINUTE;
    const now = campaign("now", { endsAt: T0 + 5 * MINUTE });
    const later = campaign("later", { drops: [drop("later-d1", { startsAt: opens })] });
    const d = startedWatching([now, later], [channel("a")]);
    assert.strictEqual(watchedChannel(d.state), "a");
    d.send(Event.Tick(), T0 + 5 * MINUTE);
    assert.strictEqual(watchedChannel(d.state), "nothing-to-mine");
    assert.strictEqual(d.state.deadlines.tick, opens);
    assert.deepStrictEqual(tags(d.send(Event.Tick(), opens)), ["Watch"]);
    assert.strictEqual(watchedChannel(d.state), "a");
  });

  it("reads the channels of a drop that opens on an allow-list it never read", () => {
    // Twin seed 280753: discovery read channels only for what earned at the catalog read.
    const opens = T0 + 7 * MINUTE;
    const listed = campaign("listed", {
      allowedChannels: [chid("z")],
      drops: [drop("listed-d1", { startsAt: opens })],
    });
    const d = startedWatching([listed], []);
    assert.strictEqual(watchedChannel(d.state), "nothing-to-mine");
    assert.strictEqual(d.state.deadlines.tick, opens);
    const issued = reads(d.send(Event.Tick(), opens));
    assert.deepStrictEqual(issued.map(readKey), ["channels:z"]);
    assert.strictEqual(watchedChannel(d.state), "discovering");
    d.send(read([channel("z")], "channels:z"));
    assert.strictEqual(watchedChannel(d.state), "z");
  });

  it("keeps the hourly catalog read while nothing is wanted", () => {
    const d = startedWatching([], []);
    assert.strictEqual(watchedChannel(d.state), "nothing-to-mine");
    assert.strictEqual(d.state.deadlines.catalog, T0 + HOUR);
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
    assert.strictEqual(
      claims(d.send(Event.InventoryRead({ progress: [complete], awarded: [] }))),
      0,
    );
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
    assert.strictEqual(
      claims(d.send(Event.InventoryRead({ progress: [unclaimed], awarded: [] }))),
      0,
    );
    assert.include(tags(d.send(Event.Tick(), T0 + CLAIM_RECHECK)), "ReadInventory");
    assert.strictEqual(
      claims(d.send(Event.InventoryRead({ progress: [unclaimed], awarded: [] }))),
      1,
    );
  });

  it("keeps a lost claim's intent when the recheck read doesn't show the drop at all", () => {
    // Twin seed 4647: the merged progress still knew the drop, so a read that omitted it
    // settled the intent and the claim went out again.
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }));
    d.send(Event.ClaimResult({ campaignId: c.id, dropId: did("c-d1"), outcome: "unknown" }));
    d.send(Event.Tick(), T0 + CLAIM_RECHECK);
    assert.strictEqual(claims(d.send(Event.InventoryRead({ progress: [], awarded: [] }))), 0);
    assert.strictEqual(d.state.claims.get("c/c-d1")?.status, "unknown");
    const unclaimed = progress(c, "c-d1", { minutes: 60, instanceId: iid("i1") });
    assert.strictEqual(
      claims(d.send(Event.InventoryRead({ progress: [unclaimed], awarded: [] }))),
      1,
    );
  });

  it("keeps a claim in flight when a read omits its drop", () => {
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }));
    assert.strictEqual(
      claims(d.send(Event.InventoryRead({ progress: [], awarded: [] }), T0 + HOUR)),
      0,
    );
    assert.strictEqual(d.state.claims.get("c/c-d1")?.status, "sent");
  });

  it("treats a lost claim as done when inventory shows it claimed", () => {
    const d = startedWatching([c], [channel("a")]);
    d.send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }));
    d.send(Event.ClaimResult({ campaignId: c.id, dropId: did("c-d1"), outcome: "unknown" }));
    const claimed = progress(c, "c-d1", { minutes: 60, instanceId: iid("i1"), claimed: true });
    assert.strictEqual(
      claims(d.send(Event.InventoryRead({ progress: [claimed], awarded: [] }))),
      0,
    );
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
    assert.strictEqual(
      claims(restarted.send(Event.InventoryRead({ progress: [unclaimed], awarded: [] }))),
      0,
    );
    const late = T0 + MINUTE + CLAIM_RECHECK;
    assert.include(tags(restarted.send(Event.Tick(), late)), "ReadInventory");
    assert.strictEqual(
      claims(restarted.send(Event.InventoryRead({ progress: [unclaimed], awarded: [] }))),
      1,
    );
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
    settle(d);
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
    assert.strictEqual(claims(d.send(Event.InventoryRead({ progress: [done], awarded: [] }))), 1);
    const late = progress(ended, "e-d2", {
      minutes: 60,
      instanceId: iid("i3"),
      campaignEndsAt: T0 - 25 * HOUR,
    });
    assert.strictEqual(claims(d.send(Event.InventoryRead({ progress: [late], awarded: [] }))), 0);
  });
});

describe("request budgets (Throttled)", () => {
  const c = campaign("c");
  const throttled = (command: Command, retryAt: Millis) =>
    Event.Throttled({ refusals: [{ command, budget: "gql", retryAt }] });

  it("moves a refused read's deadline to when the budget has room, not a whole interval", () => {
    const d = driver();
    d.send(Event.Started());
    // A refused validation at start-up is tried again in seconds, not in an hour.
    assert.deepStrictEqual(tags(d.send(throttled(Command.ValidateToken(), T0 + 30_000))), []);
    assert.strictEqual(nextDeadline(d.state), T0 + 30_000);
    assert.deepStrictEqual(tags(d.send(Event.Tick(), T0 + 30_000)), ["ValidateToken"]);
    d.send(Event.TokenValid());
    const at = d.now + 60_000;
    d.send(throttled(Command.ReadCatalog(), at));
    d.send(throttled(Command.ReadInventory(), at));
    // A refusal is not a broken catalog.
    assert.strictEqual(d.state.catalogStatus, "unknown");
    assert.strictEqual(watchedChannel(d.state), "starting");
    assert.strictEqual(nextDeadline(d.state), at);
    assert.deepStrictEqual(tags(d.send(Event.Tick(), at)), ["ReadCatalog", "ReadInventory"]);
  });

  it("never wakes sooner than THROTTLE_FLOOR, whatever retryAt says", () => {
    const d = startedWatching([c], [channel("a")]);
    d.send(throttled(Command.ReadInventory(), d.now - 1_000));
    assert.strictEqual(d.state.deadlines.inventory, d.now + THROTTLE_FLOOR);
  });

  it("sends a refused channel read again, and discovery waits for its answer", () => {
    const top = campaign("top", { game: game("top") });
    const low = campaign("low", { game: game("low") });
    const d = driver(initial(settings({ games: games(["top", "low"]) })));
    d.send(Event.Started());
    d.send(Event.TokenValid());
    const issued = reads(d.send(Event.CatalogRead({ campaigns: [low, top] })));
    const until = d.state.discovery!.until;
    d.send(read([channel("b", { gameId: "low" })], "directory:low"));
    const retryAt = T0 + 20_000;
    d.send(throttled(issued[0]!, retryAt));
    // The refused read stays pending: no watch on the half picture, and discovery waits longer.
    assert.strictEqual(watchedChannel(d.state), "discovering");
    assert.deepStrictEqual(d.state.discovery?.pending, ["directory:top"]);
    assert.isAbove(d.state.discovery!.until, until);
    assert.strictEqual(d.state.deadlines.deferred.get("directory:top"), retryAt);
    assert.deepStrictEqual(reads(d.send(Event.Tick(), retryAt - 1)), []);
    assert.deepStrictEqual(reads(d.send(Event.Tick(), retryAt)), [issued[0]!]);
    assert.strictEqual(d.state.deadlines.deferred.size, 0);
    const commands = d.send(read([channel("a", { gameId: "top" })], "directory:top"));
    assert.deepStrictEqual(tags(commands), ["Watch"]);
    assert.strictEqual(watchedChannel(d.state), "a");
  });

  it("sends a refused re-read of a channel that went live again, by its key", () => {
    const d = startedWatching([c], [channel("a")]);
    const again = Command.ReadChannels({ channelIds: [chid("x"), chid("y")] });
    d.send(throttled(again, d.now + 10_000));
    assert.deepStrictEqual(reads(d.send(Event.Tick(), d.now + 10_000)), [again]);
  });

  it("forgets deferred reads on a restart and on a refused token", () => {
    const d = startedWatching([c], [channel("a")]);
    d.send(throttled(Command.ReadDirectory({ gameId: game("c").id }), d.now + 10_000));
    assert.strictEqual(d.state.deadlines.deferred.size, 1);
    d.send(Event.Started());
    assert.strictEqual(d.state.deadlines.deferred.size, 0);
    const e = startedWatching([c], [channel("a")]);
    e.send(throttled(Command.ReadDirectory({ gameId: game("c").id }), e.now + 10_000));
    e.send(Event.AuthFailed());
    assert.strictEqual(e.state.deadlines.deferred.size, 0);
  });

  it("settles a refused claim through inventory, as a lost answer: never blindly resent", () => {
    const d = startedWatching([c], [channel("a")]);
    const claim = d
      .send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }))
      .find((x) => x._tag === "Claim")!;
    const retryAt = T0 + 2 * MINUTE;
    assert.deepStrictEqual(tags(d.send(throttled(claim, retryAt))), []);
    const intent = d.state.claims.get("c/c-d1");
    assert.strictEqual(intent?.status, "unknown");
    assert.strictEqual(intent?.recheckAt, retryAt);
    assert.strictEqual(d.state.deadlines.inventory, retryAt);
    const unclaimed = progress(c, "c-d1", { minutes: 60, instanceId: iid("i1") });
    // A read before the budget has room sends nothing.
    assert.lengthOf(
      d
        .send(Event.InventoryRead({ progress: [unclaimed], awarded: [] }))
        .filter((x) => x._tag === "Claim"),
      0,
    );
    assert.deepStrictEqual(tags(d.send(Event.Tick(), retryAt)), ["ReadInventory"]);
    const again = d.send(Event.InventoryRead({ progress: [unclaimed], awarded: [] }));
    assert.deepStrictEqual(
      again.filter((x) => x._tag === "Claim"),
      [claim],
    );
    // Inventory showing it claimed (the refusal was wrong about nothing) sends none.
    const e = startedWatching([c], [channel("a")]);
    const sent = e
      .send(Event.DropClaimable({ dropId: did("c-d1"), instanceId: iid("i1") }))
      .find((x) => x._tag === "Claim")!;
    e.send(throttled(sent, retryAt));
    e.send(Event.Tick(), retryAt);
    const done = progress(c, "c-d1", { minutes: 60, instanceId: iid("i1"), claimed: true });
    const none = e.send(Event.InventoryRead({ progress: [done], awarded: [] }));
    assert.lengthOf(
      none.filter((x) => x._tag === "Claim"),
      0,
    );
    assert.strictEqual(e.state.claims.size, 0);
  });

  it("needs nothing for a refused watch tick: the next one is due on its own", () => {
    const d = startedWatching([c], [channel("a")]);
    const before = d.state;
    assert.deepStrictEqual(
      d.send(throttled(Command.WatchTick({ channelId: chid("a") }), d.now + 10_000)),
      [],
    );
    assert.strictEqual(d.state.deadlines, before.deadlines);
    assert.isBelow(d.state.deadlines.validate, d.now + VALIDATE_INTERVAL + 1);
  });

  it("asks again for a refused current-drop read once the budget has room, not 5 min later", () => {
    const d = startedWatching([c], [channel("a")]);
    settle(d);
    const asked: Array<Millis> = [];
    let refused = false;
    for (let i = 1; i <= 50; i++) {
      const at = T0 + i * WATCH_INTERVAL;
      const commands = d.send(Event.WatchTicked({ channelId: chid("a") }), at);
      for (const command of commands.filter((x) => x._tag === "ReadCurrentDrop")) {
        asked.push(at);
        if (!refused) {
          refused = true;
          d.send(throttled(command, at + 30_000));
        }
      }
    }
    assert.lengthOf(asked, 2);
    // The first tick at or after the refusal's retry time asks again.
    assert.strictEqual(asked[1]! - asked[0]!, 2 * WATCH_INTERVAL);
  });

  it("sends a refused subscription again once the budget has room", () => {
    const d = startedWatching([c], [channel("a"), channel("b")]);
    const sent = d.send(Event.Tick(), d.now + SUBSCRIBE_SETTLE);
    const subscribe = sent.find((x) => x._tag === "Subscribe")!;
    assert.deepStrictEqual(subscribe.channelIds, [chid("a"), chid("b")]);
    const retryAt = d.now + 20_000;
    assert.deepStrictEqual(d.send(throttled(subscribe, retryAt)), []);
    assert.strictEqual(d.state.deadlines.subscribe, retryAt);
    assert.deepStrictEqual(subscribes(d.send(Event.Tick(), retryAt - 1)), []);
    assert.deepStrictEqual(subscribes(d.send(Event.Tick(), retryAt)), [subscribe.channelIds]);
    // A refusal of a set already replaced by a newer one changes nothing.
    const e = startedWatching([c], [channel("a")]);
    e.send(Event.Tick(), e.now + SUBSCRIBE_SETTLE);
    const before = e.state;
    e.send(throttled(Command.Subscribe({ channelIds: [chid("z")] }), e.now + 20_000));
    assert.strictEqual(e.state.subscriptions, before.subscriptions);
  });

  it("steps once for refusals that arrive together, each handled", () => {
    const d = startedWatching([c], [channel("a")]);
    const at = d.now + 60_000;
    const refusals = [Command.ReadInventory(), Command.ReadDirectory({ gameId: game("c").id })].map(
      (command) => ({ command, budget: "gql" as const, retryAt: at }),
    );
    d.send(Event.Throttled({ refusals }));
    assert.strictEqual(d.state.deadlines.inventory, at);
    assert.strictEqual(d.state.deadlines.deferred.get(`directory:${game("c").id}`), at);
  });
});

describe("following", () => {
  const c = campaign("c");

  it("sends nothing when a read leaves the followed set as it is", () => {
    const d = startedWatching([c], [channel("a"), channel("b")]);
    settle(d);
    assert.deepStrictEqual(tags(d.send(read([channel("b")], "channels:b"))), []);
    assert.deepStrictEqual(tags(d.send(Event.CatalogRead({ campaigns: [c] }))), ["ReadDirectory"]);
    assert.isUndefined(d.state.deadlines.subscribe);
  });

  it("coalesces a burst of reads into one Subscribe, at most SUBSCRIBE_SETTLE after the first", () => {
    const d = startedWatching([c], [channel("a")]);
    settle(d);
    const start = d.now;
    const sent: Array<ReadonlyArray<string>> = [];
    for (const [i, id] of ["b", "c", "d"].entries()) {
      // Each answer moves the set; none extends the wait.
      const at = start + i * 4_000;
      sent.push(...subscribes(d.send(read([channel(id)], `channels:${id}`), at)));
      assert.strictEqual(nextDeadline(d.state), start + SUBSCRIBE_SETTLE);
    }
    sent.push(...subscribes(d.send(Event.Tick(), start + SUBSCRIBE_SETTLE)));
    assert.deepStrictEqual(sent, [[chid("a"), chid("b"), chid("c"), chid("d")]]);
    assert.isUndefined(d.state.deadlines.subscribe);
    assert.deepStrictEqual(subscribes(d.send(Event.Tick(), start + 2 * SUBSCRIBE_SETTLE)), []);
  });

  it("drops a change that undoes itself before it goes out", () => {
    const d = startedWatching([c], [channel("a")]);
    settle(d);
    d.send(read([channel("b")], "channels:b"));
    assert.isDefined(d.state.deadlines.subscribe);
    d.send(Event.GameChanged({ channelId: chid("b"), gameId: undefined }));
    assert.isUndefined(d.state.deadlines.subscribe);
    assert.deepStrictEqual(subscribes(settle(d)), []);
  });

  it("follows again, once, after a restart: the sockets died with the process", () => {
    const d = startedWatching([c], [channel("a"), channel("b")]);
    assert.deepStrictEqual(subscribes(settle(d)), [[chid("a"), chid("b")]]);
    const restarted = driver(d.state);
    restarted.send(Event.Started(), d.now + MINUTE);
    assert.deepStrictEqual(restarted.state.subscriptions, []);
    restarted.send(Event.TokenValid());
    restarted.send(Event.CatalogRead({ campaigns: [c] }));
    const commands = [
      ...restarted.send(read([channel("a")])),
      ...restarted.send(read([channel("b")], "channels:b")),
      ...settle(restarted),
    ];
    assert.deepStrictEqual(subscribes(commands), [[chid("a"), chid("b")]]);
  });

  it("forgets a pending change on a refused token, and sends nothing never followed", () => {
    const d = startedWatching([c], [channel("a")]);
    assert.isDefined(d.state.deadlines.subscribe);
    assert.deepStrictEqual(tags(d.send(Event.AuthFailed())), ["StopWatching"]);
    assert.isUndefined(d.state.deadlines.subscribe);
  });
});

describe("auth", () => {
  it("parks on a refused token: stops, unsubscribes, then does nothing", () => {
    const d = startedWatching([campaign("c")], [channel("a")]);
    settle(d);
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
