import { assert, describe, it } from "@effect/vitest";
import {
  MINUTE,
  type CampaignId,
  type ChannelId,
  type DropId,
  type Progress,
  type GameId,
  type Millis,
} from "../core/model.ts";
import { Command, Event } from "../core/protocol.ts";
import {
  CAMPAIGN_SKIP,
  CATALOG_INTERVAL,
  CLAIM_RECHECK,
  ONLINE_DELAY,
  READ_BATCH,
  READ_WORST_CASE,
  THROTTLE_FLOOR,
  WATCHLIST_LIMIT,
  STALL_AFTER,
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
  FLIP_WINDOW,
  IN_FLIGHT_LIMIT,
  MOST_REQUESTS,
  checkStep,
  claimLiveness,
  inFlightCap,
  initialChecker,
  opportunities,
  type Observation,
  type StepRecord,
} from "./invariants.ts";
import { DEFAULT_GOAL_SPEC, SIM_EPOCH, type Fault, type Scenario } from "./scenario.ts";
import { CDN_LIMITS, GQL_LIMITS } from "../twitch/budget.ts";
import {
  TICK_REQUESTS,
  TWITCH_SOCKETS,
  socketsFor,
  type Activity,
  type ActuatorCall,
  type TwinRequest,
} from "./twin.ts";
import { buildWorld, instanceOf, openSession, tick, type World } from "./world.ts";

const scenario = (faults: ReadonlyArray<Fault> = []): Scenario => ({
  latencySeed: 1,
  horizonMinutes: 600,
  inventoryLagMinutes: 0,
  settings: { goals: [DEFAULT_GOAL_SPEC] },
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
    wasted: undefined,
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
  requests: TICK_REQUESTS,
});

const claimCall = (
  endedAt: Millis,
  applied: boolean,
  alreadyApplied = false,
  limited = false,
): ActuatorCall => ({
  kind: "claim",
  at: endedAt - 200,
  endedAt,
  instanceId: instanceOf(d0),
  dropId: d0,
  alreadyApplied,
  applied,
  outcome: applied ? "claimed" : "unavailable",
  limited,
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

describe("invariant 2, blind: an item the inventory never shows claimed", () => {
  // An unlinked campaign's item: Twitch applies the claim and lists the drop unclaimed after.
  const unlinked = buildWorld({
    ...scenario(),
    campaigns: scenario().campaigns.map((c) => ({ ...c, linked: false, creditsUnlinked: true })),
  });
  const claimedWorld: World = { ...completed(unlinked), claimed: new Map([[d0, at(60)]]) };
  const lost: State = {
    ...watching,
    claims: new Map([
      [key, { campaignId: c0, dropId: d0, status: "unknown", recheckAt: at(60) + CLAIM_RECHECK }],
    ]),
  };
  const o = (seconds: number, step: StepRecord, world: World = claimedWorld) =>
    observation(at(seconds), { step, world });
  const first = o(60, record(Event.Tick(), [claimD0]), completed(unlinked));
  const settle = o(
    130,
    record(
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
        awarded: [],
      }),
      [],
      lost,
      lost,
    ),
  );
  const again = (seconds: number, claim: Command = claimD0) =>
    o(seconds, record(Event.Tick(), [claim]));

  it("excuses one re-claim after a lost answer settled by a read, and no second", () => {
    assert.deepStrictEqual(kinds([first, settle, again(140)]), []);
    assert.include(kinds([first, settle, again(140), again(400)]), "ClaimedTwice");
    // Even after another settled read.
    assert.include(kinds([first, settle, again(140), settle, again(400)]), "ClaimedTwice");
  });

  it("flags a re-claim nothing settled", () => {
    assert.include(kinds([first, again(140)]), "MutationRetried");
  });

  it("excuses the first claim of a drop claimed before the run, once", () => {
    const before: World = { ...claimedWorld, claimed: new Map([[d0, SIM_EPOCH - MINUTE]]) };
    assert.deepStrictEqual(kinds([o(60, record(Event.Tick(), [claimD0]), before)]), []);
    const twice = [
      o(60, record(Event.Tick(), [claimD0]), before),
      o(400, record(Event.Tick(), [claimD0]), before),
    ];
    assert.include(kinds(twice), "ClaimedTwice");
  });

  it("still checks the instance and the window", () => {
    const wrong = Command.Claim({
      campaignId: c0,
      dropId: d0,
      instanceId: instanceOf("x" as DropId),
    });
    assert.include(kinds([first, settle, again(140, wrong)]), "ClaimedEarly");
    assert.include(kinds([first, settle, again(36_000 + 25 * 3600, claimD0)]), "ClaimedEarly");
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
          awarded: [],
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
  it("counts as opportunities only what some goal wants, on a channel that goal may watch", () => {
    const withGoals = (goals: Scenario["settings"]["goals"]) =>
      opportunities(buildWorld({ ...scenario(), settings: { goals } }), SIM_EPOCH, new Set()).map(
        (o) => o.channelId,
      );
    assert.deepStrictEqual(withGoals([DEFAULT_GOAL_SPEC]), [ch0, ch1]);
    assert.deepStrictEqual(withGoals([{ ...DEFAULT_GOAL_SPEC, rewards: ["badge", "emote"] }]), []);
    const elsewhere = { ...DEFAULT_GOAL_SPEC, games: [{ game: 1, rewards: null }] };
    const notCh0 = { ...DEFAULT_GOAL_SPEC, exclude: [0] };
    assert.deepStrictEqual(withGoals([elsewhere, notCh0]), [ch1]);
    assert.deepStrictEqual(withGoals([{ ...DEFAULT_GOAL_SPEC, excludeGames: [0] }]), []);
  });

  const unwatched = (seconds: number) => observation(at(seconds), { state: idle, world: world0 });

  it("restarts the watching bound at a credit of a campaign the core's catalog lacks", () => {
    const state: State = { ...watching, catalog: world0.campaigns };
    const look = (seconds: number, campaignId?: string) =>
      observation(at(seconds), {
        state,
        world: world0,
        activity: {
          ...noActivity(),
          credits:
            campaignId === undefined
              ? []
              : [
                  {
                    at: at(seconds),
                    channelId: ch0,
                    campaignId: campaignId as CampaignId,
                    dropIds: [],
                  },
                ],
        },
      });
    const late = (STALL_AFTER + 3 * MINUTE) / 1000;
    assert.include(kinds([look(0), look(600), look(late)]), "Idle");
    assert.deepStrictEqual(kinds([look(0), look(600, "new"), look(late)]), []);
  });

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

  it("gives an idle core a GQL cooldown's news, as a fault window", () => {
    // An idle core hears only through GQL reads, which a cooldown refuses (seed 80053).
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
    const cooled: World = { ...world0, cooldowns: [{ from: at(0), to: at(240) }] };
    const known = (seconds: number, world: World) =>
      observation(at(seconds), { state: knowing, world });
    const bound = (ONLINE_DELAY + MINUTE) / 1000;
    assert.include(kinds([known(0, world0), known(bound + 1, world0)]), "Idle");
    assert.deepStrictEqual(kinds([known(0, cooled), known(bound + 1, cooled)]), []);
    // Still within the discovery bound.
    const late = (CATALOG_INTERVAL + 2 * MINUTE) / 1000 + 1;
    assert.include(kinds([known(0, cooled), known(late, cooled)]), "Idle");
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
    // A drop of 5 minutes, 1 credited: the channel still has something wanted to earn.
    const earning = completed(
      buildWorld({
        ...scenario(),
        campaigns: scenario().campaigns.map((c) => ({
          ...c,
          drops: [{ requiredMinutes: 5, after: null, benefit: "DIRECT_ENTITLEMENT" as const }],
        })),
      }),
    );
    const look = (now: Millis, o: Partial<Observation> = {}) =>
      observation(now, { world: earning, ...o });
    const credited = look(at(60), {
      activity: {
        ...noActivity(),
        credits: [{ at: at(60), channelId: ch0, campaignId: c0, dropIds: [d0] }],
      },
    });
    const avoided: State = { ...watching, avoid: new Set([ch0]) };
    const avoid = look(at(120), { step: record(Event.Tick(), [], watching, avoided) });
    // The frame of that minute reached the core: avoiding a minute later is unfair.
    const frame = look(at(61), {
      step: record(Event.DropProgress({ dropId: d0, minutes: 1 }), []),
    });
    assert.include(kinds([credited, frame, avoid]), "AvoidedUnfairly");
    // So is an inventory read that showed it.
    const shown = look(at(90), {
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
          awarded: [],
        }),
        [],
      ),
    });
    assert.include(kinds([credited, shown, avoid]), "AvoidedUnfairly");
    // A read that predates the credit tells the core nothing: within the time the news may
    // take (a frame a minute here), the credit is excused, never after.
    const stale = look(at(90), {
      step: record(Event.DropProgress({ dropId: d0, minutes: 0 }), []),
    });
    assert.notInclude(kinds([credited, stale, avoid]), "AvoidedUnfairly");
    const late = look(at(240), { step: record(Event.Tick(), [], watching, avoided) });
    assert.include(kinds([credited, stale, late]), "AvoidedUnfairly");
    // A channel with nothing wanted left to earn costs nothing to avoid (seed 22).
    const spent = [credited, frame, avoid].map((x) => ({ ...x, world: completed() }));
    assert.deepStrictEqual(kinds(spent), []);
    // A channel that refuses playback may be avoided at once.
    const refusing = buildWorld({
      ...scenario(),
      channels: scenario().channels.map((ch) => ({ ...ch, refuses: true })),
    });
    assert.deepStrictEqual(kinds([{ ...avoid, world: refusing }]), []);
  });
});

describe("invariants 8 and 9: no watch for a received drop, none that earns nothing", () => {
  /** A 60-minute drop, a session on `ch0`, and the core told to watch it at `SIM_EPOCH`. */
  const long = buildWorld({
    ...scenario(),
    campaigns: [
      {
        ...scenario().campaigns[0]!,
        drops: [{ requiredMinutes: 60, after: null, benefit: "BADGE" }],
      },
    ],
  });
  const session = openSession(long, ch0, SIM_EPOCH);
  // The core knows the campaign: a credit of one it doesn't know restarts the clock.
  const knowing: State = {
    ...watching,
    catalog: long.campaigns,
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
  const watch = (world: World) =>
    observation(at(0), {
      world,
      step: record(Event.Tick(), [Command.Watch({ channelId: ch0 })], knowing, knowing),
    });
  const look = (world: World, minutes: number, credit?: DropId) =>
    observation(at(minutes * 60), {
      world,
      state: knowing,
      activity: {
        ...noActivity(),
        credits:
          credit === undefined
            ? []
            : [{ at: at(minutes * 60), channelId: ch0, campaignId: c0, dropIds: [credit] }],
      },
    });
  const late = (STALL_AFTER + 3 * MINUTE) / MINUTE;

  it("flags a watch that earned nothing wanted for a stall's length", () => {
    assert.include(kinds([watch(session), look(session, late)]), "Unproductive");
    assert.deepStrictEqual(kinds([watch(session), look(session, 10, d0), look(session, late)]), []);
  });

  it("counts no credit past the requirement as earning (the 4 h live run)", () => {
    const past: World = { ...session, minutes: new Map([[d0, [{ at: SIM_EPOCH, minutes: 70 }]]]) };
    assert.include(
      kinds([watch(past), look(past, 10, d0), look(past, 20, d0), look(past, late)]),
      "Unproductive",
    );
  });

  it("flags giving up a campaign that credited minutes ago, and allows it after a stall", () => {
    const given: State = {
      ...knowing,
      avoidCampaigns: new Map([[c0, at((STALL_AFTER / MINUTE) * 60) + CAMPAIGN_SKIP]]),
      watch: { _tag: "Idle", reason: "nothing-to-mine" },
    };
    const giveUp = (minutes: number) =>
      observation(at(minutes * 60), {
        world: session,
        step: record(Event.WatchTicked({ channelId: ch0 }), [], knowing, given),
      });
    // Three minutes on: past `newsDelay`, when the core may not have heard the credit yet.
    assert.include(kinds([watch(session), look(session, 5, d0), giveUp(8)]), "AvoidedUnfairly");
    assert.notInclude(kinds([watch(session), look(session, 5, d0), giveUp(6)]), "AvoidedUnfairly");
    assert.deepStrictEqual(kinds([watch(session), giveUp(STALL_AFTER / MINUTE)]), []);
    // A skip longer than `CAMPAIGN_SKIP` could outlive its cause: Twitch may move on.
    const forever: State = { ...given, avoidCampaigns: new Map([[c0, at(24 * 3600)]]) };
    const longer = observation(at(STALL_AFTER / 1000), {
      world: session,
      step: record(Event.WatchTicked({ channelId: ch0 }), [], knowing, forever),
    });
    assert.include(kinds([watch(session), longer]), "AvoidedTooLong");
  });

  it("flags watching a drop the account has once an inventory read could show it", () => {
    const received: World = { ...long, claimed: new Map([[d0, SIM_EPOCH - MINUTE]]) };
    const inventory = (seconds: number) =>
      observation(at(seconds), {
        world: received,
        step: record(Event.InventoryRead({ progress: [], awarded: [] }), [], watching, watching),
      });
    assert.include(kinds([inventory(30)]), "WatchedClaimed");
    // A claim this read can't show yet (`CLAIMED_FLAG_LAG` and a minute of latency).
    const fresh: World = { ...long, claimed: new Map([[d0, at(0)]]) };
    assert.deepStrictEqual(kinds([{ ...inventory(30), world: fresh }]), []);
  });
});

describe("the unplaced-credit slack (review of A6)", () => {
  const madeProgress = (dropId: string, minutes: number): Progress => ({
    dropId: dropId as DropId,
    campaignId: c0,
    campaignEndsAt: SIM_EPOCH + 600 * MINUTE,
    minutes,
    instanceId: undefined,
    claimed: false,
  });
  // A credit to a real campaign (so it earns in the world) that the core's catalog lacks: only an
  // inventory read can place it.
  const credited = (creditsAt: Millis): ReadonlyArray<Observation> => [
    observation(at(0)),
    observation(creditsAt, {
      activity: {
        requests: [],
        calls: [],
        credits: [{ at: creditsAt, campaignId: c0, channelId: ch0, dropIds: [d0] }],
      },
    }),
  ];
  const read = (now: Millis, progress: ReadonlyArray<Progress>): Observation =>
    observation(now, { step: record(Event.InventoryRead({ progress, awarded: [] }), []) });
  const checkerAt = (observations: ReadonlyArray<Observation>) =>
    observations.reduce((c, o) => checkStep(c, o)[0], initialChecker);

  it("grants the slack from the first read that carries the credit's minutes", () => {
    const shown = checkerAt([...credited(at(20)), read(at(25), [madeProgress("c0-d0", 1)])]);
    assert.strictEqual(shown.unplacedHeardAt.get(ch0), at(25));
  });

  it("grants nothing when that one read omits the drop, or a later one shows it", () => {
    const omitted = checkerAt([
      ...credited(at(20)),
      read(at(25), []),
      read(at(600), [madeProgress("c0-d0", 1)]),
    ]);
    assert.isUndefined(omitted.unplacedHeardAt.get(ch0));
  });

  it("forgets both after a restart", () => {
    const shown = checkerAt([...credited(at(20)), read(at(25), [madeProgress("c0-d0", 1)])]);
    const restarted = checkStep(
      shown,
      observation(at(60), { restart: { saved: undefined, resumed: watching } } as never),
    )[0];
    assert.isUndefined(restarted.unplacedHeardAt.get(ch0));
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

describe("invariant 6: no watch switch without a cause", () => {
  const live = (id: ChannelId, viewers: number) =>
    [id, { id, login: id, gameId: "g0" as GameId, live: { viewers, dropsEnabled: true } }] as const;
  const known: State = { ...watching, channels: new Map([live(ch0, 50), live(ch1, 10)]) };
  const watchOn = (
    channelId: ChannelId,
    now: Millis,
    before: State = known,
    event = Event.Tick(),
  ) =>
    observation(now, {
      world: world0,
      step: record(event, [Command.Watch({ channelId })], before, {
        ...before,
        watch: { ...known.watch, channelId } as State["watch"],
      }),
    });

  it("flags a switch within FLIP_WINDOW of the last watch with nothing new", () => {
    assert.deepStrictEqual(kinds([watchOn(ch0, at(1)), watchOn(ch1, at(5))]), ["WatchFlip"]);
    assert.deepStrictEqual(kinds([watchOn(ch0, at(1)), watchOn(ch1, at(1) + FLIP_WINDOW)]), []);
  });

  it("allows one when the old channel went offline", () => {
    const offline: State = { ...known, channels: new Map([live(ch1, 10)]) };
    assert.deepStrictEqual(kinds([watchOn(ch0, at(1)), watchOn(ch1, at(5), offline)]), []);
  });

  it("allows one after a later catalog read: it may have found more", () => {
    const read = observation(at(3), {
      world: world0,
      step: record(Event.CatalogRead({ campaigns: [] }), [], known),
    });
    assert.deepStrictEqual(kinds([watchOn(ch0, at(1)), read, watchOn(ch1, at(5))]), []);
  });

  it("gives no cause for a catalog read that changed nothing", () => {
    const knowing: State = { ...known, catalog: world0.campaigns };
    const same = observation(at(3), {
      world: world0,
      step: record(Event.CatalogRead({ campaigns: world0.campaigns }), [], knowing),
    });
    assert.deepStrictEqual(
      kinds([watchOn(ch0, at(1), knowing), same, watchOn(ch1, at(5), knowing)]),
      ["WatchFlip"],
    );
  });

  it("forgets a previous run's read failures and catalog reads on a restart", () => {
    const failed = observation(at(1), {
      world: world0,
      step: record(Event.ChannelsReadFailed({ read: "directory:g0" }), [], known),
    });
    const changed = observation(at(1), {
      world: world0,
      step: record(Event.CatalogRead({ campaigns: [] }), [], known),
    });
    const restart = { saved: undefined, resumed: known };
    for (const before of [failed, changed]) {
      const first = { ...watchOn(ch0, at(3)), restart };
      assert.deepStrictEqual(kinds([before, first, watchOn(ch1, at(5))]), ["WatchFlip"]);
    }
  });

  it("allows leaving a campaign that can no longer finish anything (seeds 2011, 4664)", () => {
    // The twin still has minutes to give, but the drop ends before it can complete.
    const [c] = world0.campaigns;
    const doomed = {
      ...c!,
      drops: c!.drops.map((d) => ({ ...d, endsAt: at(5) + 30_000, requiredMinutes: 1 })),
    };
    const knowing: State = { ...known, catalog: [doomed] };
    assert.deepStrictEqual(kinds([watchOn(ch0, at(1), knowing), watchOn(ch1, at(5), knowing)]), []);
    const fine: State = { ...known, catalog: [c!] };
    assert.deepStrictEqual(kinds([watchOn(ch0, at(1), fine), watchOn(ch1, at(5), fine)]), [
      "WatchFlip",
    ]);
  });

  it("allows one once the old campaign has nothing left to earn", () => {
    const done = observation(at(70), {
      world: completed(),
      step: record(Event.Tick(), [Command.Watch({ channelId: ch1 })], known),
    });
    assert.deepStrictEqual(kinds([watchOn(ch0, at(1)), done]), []);
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

  it("s5: flags more than IN_FLIGHT_LIMIT of the same command in flight", () => {
    const reads = (n: number) =>
      Array.from({ length: n }, () => ({ command: Command.ReadInventory(), since: at(60) }));
    assert.deepStrictEqual(kinds([observation(at(60), { inFlight: reads(IN_FLIGHT_LIMIT) })]), []);
    assert.include(
      kinds([observation(at(60), { inFlight: reads(IN_FLIGHT_LIMIT + 1) })]),
      "TooManyInFlight",
    );
    // One directory read per game of a large catalog is discovery, not a storm.
    const games = Array.from({ length: 3 * IN_FLIGHT_LIMIT }, (_, i) => ({
      command: Command.ReadDirectory({ gameId: `g${i}` as GameId }),
      since: at(60),
    }));
    assert.deepStrictEqual(kinds([observation(at(60), { inFlight: games })]), []);
  });

  it("s3: gives a command as long as its requests take at their worst, one after the other", () => {
    // A stream read of a full watchlist sends three batches, each up to `READ_WORST_CASE`.
    assert.strictEqual(MOST_REQUESTS, Math.ceil(WATCHLIST_LIMIT / READ_BATCH));
    assert.isAbove(COMMAND_DEADLINE, MOST_REQUESTS * READ_WORST_CASE);
    const since = at(60);
    const full = Command.ReadChannels({
      channelIds: Array.from({ length: WATCHLIST_LIMIT }, (_, i) => `x${i}` as ChannelId),
    });
    const hung = [{ command: full, since }];
    const end = since + MOST_REQUESTS * READ_WORST_CASE;
    assert.deepStrictEqual(kinds([observation(end, { inFlight: hung })]), []);
  });

  it("s5: flags more commands in flight than two discoveries of the catalog's games need", () => {
    const games = new Set(world0.campaigns.map((x) => x.game.id)).size;
    const distinct = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        command: Command.ReadChannels({ channelIds: [ch0, `x${i}` as ChannelId] }),
        since: at(60),
      }));
    const cap = inFlightCap(games);
    assert.deepStrictEqual(kinds([observation(at(60), { inFlight: distinct(cap) })]), []);
    assert.include(
      kinds([observation(at(60), { inFlight: distinct(cap + 1) })]),
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

describe("invariant 8: within Twitch's limits and the request budgets", () => {
  const request = (start: Millis, end: Millis, limited = false): TwinRequest => ({
    at: start,
    endedAt: end,
    operation: "Inventory",
    status: limited ? 429 : 200,
    limited,
  });
  const requests = (...list: ReadonlyArray<TwinRequest>): Activity => ({
    ...noActivity(),
    requests: [...list],
  });

  it("flags a GQL request or a claim Twitch answered 429 for the rate, not a fault window's", () => {
    assert.deepStrictEqual(
      kinds([observation(at(60), { activity: requests(request(at(59), at(60), true)) })]),
      ["OverBudget"],
    );
    const limitedClaim = claimCall(at(60), false, false, true);
    assert.include(kinds([observation(at(60), { activity: calls(limitedClaim) })]), "OverBudget");
    const fault: TwinRequest = { ...request(at(59), at(60)), status: 429 };
    assert.deepStrictEqual(kinds([observation(at(60), { activity: requests(fault) })]), []);
  });

  it("flags more API requests in flight than the budget allows, across observations", () => {
    const n = GQL_LIMITS.concurrency;
    // A long request ends last: the overlap shows only once it is in.
    const short = Array.from({ length: n }, (_, i) => request(at(100) + i, at(101) + i));
    const long = request(at(100) - 1, at(130));
    assert.deepStrictEqual(kinds([observation(at(102), { activity: requests(...short) })]), []);
    assert.deepStrictEqual(
      kinds([
        observation(at(102), { activity: requests(...short) }),
        observation(at(130), { activity: requests(long) }),
      ]),
      ["OverBudget"],
    );
    // As many as allowed, one after the other, is fine.
    const serial = Array.from({ length: 3 * n }, (_, i) => request(at(100 + i), at(100.5 + i)));
    assert.deepStrictEqual(kinds([observation(at(140), { activity: requests(...serial) })]), []);
  });

  it("flags two watch ticks at once: CDN requests go one at a time", () => {
    const a = tickCall(ch0, at(60));
    const overlapping: ActuatorCall = { ...tickCall(ch0, at(61)), at: at(59) };
    assert.include(kinds([observation(at(61), { activity: calls(a, overlapping) })]), "OverBudget");
    const next = tickCall(ch0, at(80));
    assert.deepStrictEqual(kinds([observation(at(80), { activity: calls(a, next) })]), []);
  });

  it("flags more CDN requests in a window than the CDN budget allows", () => {
    const ticks = Math.ceil(CDN_LIMITS.max / TICK_REQUESTS) + 1;
    const burst = Array.from({ length: ticks }, (_, i) => tickCall(ch0, at(1 + i)));
    assert.include(
      kinds([observation(at(ticks + 1), { activity: calls(...burst) })]),
      "OverBudget",
    );
    const paced = Array.from({ length: ticks }, (_, i) => tickCall(ch0, at(20 * (i + 1))));
    assert.deepStrictEqual(kinds([observation(at(20 * ticks), { activity: calls(...paced) })]), []);
  });

  it("charges a tick what it cost: a tick that resolves the stream sends more", () => {
    // Ticks of 54 requests, as the largest seen live: nine in a minute pass the CDN budget,
    // where nine of the usual 17 would not.
    const ticks = (requests: number) =>
      Array.from({ length: 9 }, (_, i): ActuatorCall => ({
        kind: "tick",
        at: at(1 + 6 * i) - 200,
        endedAt: at(1 + 6 * i),
        channelId: ch0,
        result: "ticked",
        requests,
      }));
    assert.isAbove(9 * 54, CDN_LIMITS.max);
    assert.include(kinds([observation(at(60), { activity: calls(...ticks(54)) })]), "OverBudget");
    assert.deepStrictEqual(
      kinds([observation(at(60), { activity: calls(...ticks(TICK_REQUESTS)) })]),
      [],
    );
  });

  it("flags a subscription needing more sockets than Twitch allows per IP", () => {
    const channels = (n: number) => Array.from({ length: n }, (_, i) => `x${i}` as ChannelId);
    const subscribe = (n: number): ActuatorCall => ({
      kind: "subscribe",
      at: at(60),
      channelIds: channels(n),
      sockets: socketsFor(n),
    });
    assert.strictEqual(socketsFor(249), TWITCH_SOCKETS);
    assert.deepStrictEqual(kinds([observation(at(60), { activity: calls(subscribe(249)) })]), []);
    assert.include(kinds([observation(at(60), { activity: calls(subscribe(250)) })]), "OverBudget");
  });
});

describe("invariant 9: a claimable drop gets claimed", () => {
  const bound = claimLiveness(completed());

  it("flags a drop the twin would let the account claim, left unclaimed past the bound", () => {
    const from = at(60);
    assert.deepStrictEqual(kinds([observation(from), observation(from + bound)]), []);
    assert.deepStrictEqual(kinds([observation(from), observation(from + bound + 1)]), [
      "ClaimLate",
    ]);
  });

  it("stops the clock while the token is revoked or a fault window is open", () => {
    const from = at(60);
    const cooled = {
      ...completed(),
      cooldowns: [{ from: SIM_EPOCH + 5 * MINUTE, to: SIM_EPOCH + 15 * MINUTE }],
    };
    // The window resets the clock: the bound counts again from its end, at +15m.
    const end = SIM_EPOCH + 15 * MINUTE;
    const run = (world: World, until: Millis) =>
      kinds([
        observation(from, { world }),
        observation(SIM_EPOCH + 10 * MINUTE, { world }),
        observation(end, { world }),
        observation(until, { world }),
      ]);
    assert.deepStrictEqual(run(cooled, end + bound), []);
    assert.deepStrictEqual(run(cooled, end + bound + 1), ["ClaimLate"]);
    const revoked = completed(buildWorld(scenario([{ kind: "revoke-token", atMinute: 2 }])));
    assert.deepStrictEqual(
      kinds([
        observation(from, { world: revoked }),
        observation(from + 2 * bound, { world: revoked }),
      ]),
      [],
    );
  });

  it("counts a claim the twin applied as done", () => {
    const claimed = completed();
    const done: World = { ...claimed, claimed: new Map([[d0, at(90)]]) };
    assert.deepStrictEqual(
      kinds([
        observation(at(60)),
        observation(at(90), { world: done }),
        observation(at(90) + 2 * bound, { world: done }),
      ]),
      [],
    );
  });
});

describe("invariant 10: what a budget refused is sent again", () => {
  const refused = (command: Command, retryAt: Millis) =>
    Event.Throttled({ refusals: [{ command, budget: "gql", retryAt }] });

  it("flags a refused read the core never sends again, and accepts one sent at its retry time", () => {
    const retryAt = at(120);
    const due = retryAt + 1_000;
    const refusal = observation(at(60), {
      step: record(refused(Command.ReadInventory(), retryAt), []),
    });
    assert.deepStrictEqual(kinds([refusal, observation(due)]), []);
    assert.deepStrictEqual(kinds([refusal, observation(due + 1)]), ["RefusalDropped"]);
    const resent = observation(retryAt, {
      step: record(Event.Tick(), [Command.ReadInventory()]),
    });
    assert.deepStrictEqual(kinds([refusal, resent, observation(due + MINUTE)]), []);
  });

  it("waits at least THROTTLE_FLOOR, as the core does", () => {
    const refusal = observation(at(60), {
      step: record(refused(Command.ReadDirectory({ gameId: "g0" as GameId }), at(0)), []),
    });
    assert.deepStrictEqual(kinds([refusal, observation(at(60) + THROTTLE_FLOOR + 1_000)]), []);
    assert.deepStrictEqual(kinds([refusal, observation(at(60) + THROTTLE_FLOOR + 1_001)]), [
      "RefusalDropped",
    ]);
  });

  it("owes nothing after a restart, a refused token, or for a read refused without a token", () => {
    const refusal = observation(at(60), {
      step: record(refused(Command.ReadCatalog(), at(70)), []),
    });
    const restart = { saved: undefined, resumed: idle };
    assert.deepStrictEqual(
      kinds([refusal, observation(at(600), { restart, state: idle, world: world0 })]),
      [],
    );
    const parked: State = { ...watching, auth: "needs-login" };
    const parking = observation(at(61), { step: record(Event.AuthFailed(), [], watching, parked) });
    assert.deepStrictEqual(kinds([refusal, parking, observation(at(600), { state: parked })]), []);
    const tokenless = observation(at(60), {
      step: record(refused(Command.ReadCatalog(), at(70)), [], idle),
      world: world0,
    });
    assert.deepStrictEqual(
      kinds([tokenless, observation(at(600), { state: idle, world: world0 })]),
      [],
    );
  });
});
