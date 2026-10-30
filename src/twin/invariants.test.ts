import { assert, describe, it } from "@effect/vitest";
import {
  MINUTE,
  type CampaignId,
  type ChannelId,
  type DropId,
  type GameId,
  type Millis,
} from "../core/model.ts";
import { Command, Event } from "../core/protocol.ts";
import {
  CATALOG_INTERVAL,
  CLAIM_RECHECK,
  ONLINE_DELAY,
  SUBSCRIBE_SETTLE,
  WATCH_INTERVAL,
  initial,
  type ClaimIntent,
  type State,
} from "../core/state.ts";
import { encodeState } from "../store/codec.ts";
import {
  BUSY_STEPS,
  COMMAND_DEADLINE,
  IN_FLIGHT_LIMIT,
  checkStep,
  initialChecker,
  type Observation,
  type StepRecord,
} from "./invariants.ts";
import { SIM_EPOCH, type Fault, type Scenario } from "./scenario.ts";
import type { Activity, ActuatorCall } from "./twin.ts";
import { buildWorld, instanceOf, openSession, tick, type World } from "./world.ts";

const scenario = (faults: ReadonlyArray<Fault> = []): Scenario => ({
  latencySeed: 1,
  horizonMinutes: 600,
  inventoryLagMinutes: 0,
  settings: { games: [], exclude: [], badgesAndEmotes: true },
  campaigns: [
    {
      game: 0,
      startMinute: -10,
      durationMinutes: 600,
      linked: true,
      allowList: [],
      drops: [{ requiredMinutes: 1, after: null, benefit: "DIRECT_ENTITLEMENT" }],
    },
  ],
  channels: [
    { game: 0, viewers: 50, dropsEnabled: true, refuses: false, liveAtStart: true, changes: [] },
    { game: 0, viewers: 10, dropsEnabled: true, refuses: false, liveAtStart: true, changes: [] },
  ],
  faults,
});

const ch0 = "ch0" as ChannelId;
const ch1 = "ch1" as ChannelId;
const c0 = "c0" as CampaignId;
const d0 = "c0-d0" as DropId;
const key = "c0/c0-d0";
const claimD0 = Command.Claim({ campaignId: c0, dropId: d0, instanceId: instanceOf(d0) });
const at = (seconds: number): Millis => SIM_EPOCH + seconds * 1000;

const world0 = buildWorld(scenario());
const idle: State = initial(world0.settings);
const watching: State = {
  ...idle,
  auth: "valid",
  watch: {
    _tag: "Watching",
    channelId: ch0,
    campaignId: c0,
    dropId: d0,
    credited: true,
    confirmedAt: SIM_EPOCH,
    confirmedMinutes: 0,
    estimatedMinutes: 0,
    lastCurrentDropRead: undefined,
  },
};

/** The world after a session on `ch0` credited the 1-minute drop by `SIM_EPOCH + 1m`. */
const completed = (from: World = world0): World => {
  let world = openSession(from, ch0, SIM_EPOCH);
  for (let i = 1; i <= 3; i++) world = tick(world, ch0, at(i * 20)).world;
  return world;
};

const noActivity = (): Activity => ({ requests: [], calls: [], credits: [] });

const record = (
  event: Event,
  commands: ReadonlyArray<Command>,
  before: State = watching,
  after: State = before,
): StepRecord => ({ event, before, after, commands, persisted: encodeState(after) });

const observation = (now: Millis, o: Partial<Observation> = {}): Observation => ({
  now,
  step: undefined,
  state: o.step?.after ?? watching,
  world: completed(),
  activity: noActivity(),
  defects: [],
  inFlight: [],
  restart: undefined,
  ...o,
});

/** Folds the observations through the checker and lists every violation kind found. */
const kinds = (observations: ReadonlyArray<Observation>): ReadonlyArray<string> => {
  let checker = initialChecker;
  const found: Array<string> = [];
  for (const o of observations) {
    const [next, violations] = checkStep(checker, o);
    checker = next;
    found.push(...violations.map((v) => v.kind));
  }
  return found;
};

const tickCall = (channelId: ChannelId, endedAt: Millis): ActuatorCall => ({
  kind: "tick",
  at: endedAt - 200,
  endedAt,
  channelId,
  result: "ticked",
});

const claimCall = (endedAt: Millis, applied: boolean, alreadyApplied = false): ActuatorCall => ({
  kind: "claim",
  at: endedAt - 200,
  endedAt,
  instanceId: instanceOf(d0),
  dropId: d0,
  alreadyApplied,
  applied,
  outcome: applied ? "claimed" : "unavailable",
});

const calls = (...list: ReadonlyArray<ActuatorCall>): Activity => ({
  ...noActivity(),
  calls: [...list],
});

describe("invariant 1: at most one credited watch", () => {
  it("flags a tick for a channel the core never watched", () => {
    const tickCh0 = record(Event.Tick(), [Command.WatchTick({ channelId: ch0 })]);
    assert.include(kinds([observation(at(60), { step: tickCh0 })]), "TwoWatches");
    const watch = record(Event.TokenValid(), [Command.Watch({ channelId: ch0 })]);
    assert.deepStrictEqual(
      kinds([observation(at(60), { step: watch }), observation(at(80), { step: tickCh0 })]),
      [],
    );
  });

  it("flags two channels credited less than a tick apart; a switch 20 s apart is legal", () => {
    const first = observation(at(60), { activity: calls(tickCall(ch0, at(60))) });
    const quick = observation(at(70), { activity: calls(tickCall(ch1, at(70))) });
    const later = observation(at(80), {
      activity: calls(tickCall(ch1, at(60) + WATCH_INTERVAL)),
    });
    assert.include(kinds([first, quick]), "TwoWatches");
    assert.deepStrictEqual(kinds([first, later]), []);
  });
});

describe("invariant 2: never claim twice, early or late", () => {
  it("flags an attempt for a drop the twin already applied", () => {
    const claimed = record(Event.DropClaimable({ dropId: d0, instanceId: instanceOf(d0) }), [
      claimD0,
    ]);
    const o = observation(at(60), { step: claimed, activity: calls(claimCall(at(60), true)) });
    const again = observation(at(70), { activity: calls(claimCall(at(70), false, true)) });
    assert.include(kinds([o, again]), "ClaimedTwice");
  });

  it("flags a Claim command for a drop the twin holds as claimed", () => {
    const world = completed();
    const claimedWorld: World = { ...world, claimed: new Map([[d0, at(60)]]) };
    const step = record(Event.Tick(), [claimD0]);
    assert.include(kinds([observation(at(90), { step, world: claimedWorld })]), "ClaimedTwice");
  });

  it("flags a claim before the drop is complete, and accepts one right after", () => {
    const step = record(Event.Tick(), [claimD0]);
    assert.deepStrictEqual(kinds([observation(at(30), { step, world: world0 })]), ["ClaimedEarly"]);
    assert.deepStrictEqual(kinds([observation(at(60), { step })]), []);
  });
});

describe("invariant 4: mutations never retried", () => {
  const unknownIntent: ClaimIntent = {
    campaignId: c0,
    dropId: d0,
    status: "unknown",
    recheckAt: at(60) + CLAIM_RECHECK,
  };
  const waiting: State = { ...watching, claims: new Map([[key, unknownIntent]]) };
  const first = observation(at(60), {
    step: record(Event.Tick(), [claimD0]),
    activity: calls(claimCall(at(60), false)),
  });
  const read = (seconds: number) =>
    observation(at(seconds), {
      step: record(
        Event.InventoryRead({
          progress: [
            {
              dropId: d0,
              campaignId: c0,
              campaignEndsAt: at(36_000),
              minutes: 1,
              instanceId: instanceOf(d0),
              claimed: false,
            },
          ],
        }),
        [],
        waiting,
        waiting,
      ),
    });
  const resend = (seconds: number) =>
    observation(at(seconds), { step: record(Event.Tick(), [claimD0], waiting, waiting) });

  it("flags a second Claim before inventory settled the first", () => {
    assert.include(kinds([first, read(70), resend(80)]), "MutationRetried");
  });

  it("allows a resend after an inventory read past the recheck time shows it unclaimed", () => {
    assert.deepStrictEqual(kinds([first, read(60 + CLAIM_RECHECK / 1000), resend(130)]), []);
  });

  it("flags an executor that sends more claims than the core asked for", () => {
    const twice = observation(at(60), {
      step: record(Event.Tick(), [claimD0]),
      activity: calls(claimCall(at(60), false), claimCall(at(60), false)),
    });
    assert.include(kinds([twice]), "MutationRetried");
  });
});

describe("invariant 3: no idle time while an eligible live channel exists", () => {
  const unwatched = (seconds: number) => observation(at(seconds), { state: idle, world: world0 });

  it("flags idling past the discovery bound, and allows idling just under it", () => {
    const bound = (CATALOG_INTERVAL + 2 * MINUTE) / 1000;
    assert.deepStrictEqual(kinds([unwatched(0), unwatched(bound - 60)]), []);
    assert.include(kinds([unwatched(0), unwatched(bound + 60)]), "Idle");
  });

  it("flags idling past ONLINE_DELAY + 1 min once the core knows the campaign and the live channel", () => {
    const knowing: State = {
      ...idle,
      catalog: [world0.campaigns[0]!],
      channels: new Map([
        [
          ch0,
          {
            id: ch0,
            login: "chan0",
            gameId: "g0" as GameId,
            live: { viewers: 50, dropsEnabled: true },
          },
        ],
      ]),
    };
    const known = (seconds: number) => observation(at(seconds), { state: knowing, world: world0 });
    const bound = (ONLINE_DELAY + MINUTE) / 1000;
    assert.deepStrictEqual(kinds([known(0), known(ONLINE_DELAY / 1000), known(bound)]), []);
    assert.include(kinds([known(0), known(bound + 1)]), "Idle");
    // The core that doesn't know yet only answers to the discovery bound.
    assert.deepStrictEqual(kinds([unwatched(0), unwatched(bound + 1)]), []);
  });

  it("counts a channel as heard only when its change sends a frame", () => {
    const knowsCatalog: State = { ...idle, catalog: [world0.campaigns[0]!] };
    const subscribed = (changes: Scenario["channels"][number]["changes"]): World => {
      const [first, ...rest] = scenario().channels;
      const world = buildWorld({ ...scenario(), channels: [{ ...first!, changes }, ...rest] });
      return { ...world, subscriptions: new Set([ch0]) };
    };
    const o = (world: World, minutes: number) =>
      observation(at(minutes * 60), { state: knowsCatalog, world });
    // `up` while live sends no `stream-up`, so the core can't know before its catalog read.
    const noOp = subscribed([{ atMinute: 5, to: "up" }]);
    assert.deepStrictEqual(kinds([o(noOp, 0), o(noOp, 6), o(noOp, 10)]), []);
    const bounced = subscribed([
      { atMinute: 4, to: "down" },
      { atMinute: 5, to: "up" },
    ]);
    assert.include(kinds([o(bounced, 3), o(bounced, 6), o(bounced, 10)]), "Idle");
  });

  it("pauses the idle clock during a fault window", () => {
    const window: Fault = {
      kind: "http-5xx",
      operation: "any",
      atMinute: 0,
      durationSeconds: 1800,
    };
    const world = buildWorld(scenario([window]));
    const o = (minutes: number) => observation(at(minutes * 60), { state: idle, world });
    // The window closes at 30 min: the clock restarts at the first look after it.
    assert.deepStrictEqual(kinds([o(0), o(20), o(40), o(100)]), []);
    assert.include(kinds([o(0), o(20), o(40), o(105)]), "Idle");
  });

  it("flags a session the twin keeps while the core is idle", () => {
    const o = observation(at(60), { state: idle, world: openSession(world0, ch0, SIM_EPOCH) });
    assert.include(kinds([o]), "IdleButWatching");
  });

  it("flags avoiding a channel that credited minutes ago", () => {
    const credited = observation(at(60), {
      activity: {
        ...noActivity(),
        credits: [{ at: at(60), channelId: ch0, campaignId: c0, dropIds: [d0] }],
      },
    });
    const avoided: State = { ...watching, avoid: new Set([ch0]) };
    const avoid = observation(at(120), { step: record(Event.Tick(), [], watching, avoided) });
    assert.include(kinds([credited, avoid]), "AvoidedUnfairly");
    // A channel that refuses playback may be avoided at once.
    const refusing = buildWorld({
      ...scenario(),
      channels: scenario().channels.map((ch) => ({ ...ch, refuses: true })),
    });
    assert.deepStrictEqual(kinds([{ ...avoid, world: refusing }]), []);
  });
});

describe("invariant 5: state survives a crash", () => {
  it("flags a resumed state that differs from the last save", () => {
    const restart = { saved: encodeState(watching), resumed: idle };
    assert.include(kinds([observation(at(60), { state: idle, restart })]), "StateLost");
    const same = { saved: encodeState(watching), resumed: watching };
    assert.deepStrictEqual(kinds([observation(at(60), { restart: same })]), []);
  });

  it("flags a save that doesn't round-trip", () => {
    const step = { ...record(Event.Tick(), []), persisted: '{"auth": "valid"}' };
    assert.include(kinds([observation(at(60), { step })]), "StateLost");
  });
});

describe("the supporting checks", () => {
  it("s1: flags a parked core that still polls", () => {
    const parked: State = { ...idle, auth: "needs-login" };
    const step = record(Event.Tick(), [Command.ReadInventory()], parked, parked);
    assert.include(kinds([observation(at(60), { step, state: parked })]), "ParkedButPolling");
  });

  it("flags a Subscribe of the same set, or one sooner than SUBSCRIBE_SETTLE after the last", () => {
    const subscribe = (now: Millis, ...ids: ReadonlyArray<ChannelId>) =>
      observation(now, {
        step: record(Event.Tick(), [Command.Subscribe({ channelIds: ids })]),
      });
    const t = at(60);
    assert.deepStrictEqual(
      // Unsubscribing on a refused token goes out at once.
      kinds([
        subscribe(t, ch0),
        subscribe(t + SUBSCRIBE_SETTLE, ch0, ch1),
        subscribe(t + SUBSCRIBE_SETTLE + 1),
      ]),
      [],
    );
    assert.deepStrictEqual(kinds([subscribe(t, ch0), subscribe(t + MINUTE, ch0)]), [
      "SubscribeChurn",
    ]);
    assert.deepStrictEqual(kinds([subscribe(t, ch0), subscribe(t + 1, ch1)]), ["SubscribeChurn"]);
    // A restart drops the sockets: following the same set again is right.
    const restart = { saved: undefined, resumed: watching };
    assert.deepStrictEqual(kinds([subscribe(t, ch0), { ...subscribe(t + 1, ch0), restart }]), []);
  });

  it("s2: flags more than BUSY_STEPS steps at one instant", () => {
    const o = observation(at(60), { step: record(Event.Tick(), []) });
    assert.deepStrictEqual(kinds(Array.from({ length: BUSY_STEPS }, () => o)), []);
    assert.include(kinds(Array.from({ length: BUSY_STEPS + 1 }, () => o)), "BusyWake");
  });

  it("s3: flags a defect, and a command in flight past its deadline", () => {
    assert.include(kinds([observation(at(60), { defects: ["Claim: boom"] })]), "Defect");
    const since = at(60);
    const stuck = [{ command: Command.ReadInventory(), since }];
    assert.deepStrictEqual(kinds([observation(since + COMMAND_DEADLINE, { inFlight: stuck })]), []);
    assert.include(
      kinds([observation(since + COMMAND_DEADLINE + 1_000, { inFlight: stuck })]),
      "Defect",
    );
  });

  it("s5: flags more than IN_FLIGHT_LIMIT commands of one kind in flight", () => {
    const reads = (n: number) =>
      Array.from({ length: n }, () => ({ command: Command.ReadInventory(), since: at(60) }));
    assert.deepStrictEqual(kinds([observation(at(60), { inFlight: reads(IN_FLIGHT_LIMIT) })]), []);
    assert.include(
      kinds([observation(at(60), { inFlight: reads(IN_FLIGHT_LIMIT + 1) })]),
      "TooManyInFlight",
    );
  });

  it("t: flags a twin that credits after the token was revoked", () => {
    const world = completed(buildWorld(scenario([{ kind: "revoke-token", atMinute: 0 }])));
    const activity: Activity = {
      ...noActivity(),
      credits: [{ at: at(60), channelId: ch0, campaignId: c0, dropIds: [d0] }],
    };
    assert.include(kinds([observation(at(60), { world, activity })]), "TwinBroken");
  });
});
