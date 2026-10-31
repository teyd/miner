import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { CampaignId, ChannelId, DropId, GameId } from "../core/model.ts";
import { Command, Event, readKey } from "../core/protocol.ts";
import { emptyMemory, execute, type Memory } from "./execute.ts";
import { twinProcess } from "../twin/process.ts";
import {
  DEFAULT_GOAL_SPEC,
  SIM_EPOCH,
  type Fault,
  type Operation,
  type Scenario,
} from "../twin/scenario.ts";
import { bindClock, makeTwin, type Twin } from "../twin/twin.ts";
import { buildWorld, instanceOf, openSession, tick } from "../twin/world.ts";

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
  ],
  faults,
});

const ch0 = "ch0" as ChannelId;
/** What a directory read leaves behind: playback goes by login. */
const knowsCh0: Memory = { ...emptyMemory, logins: new Map([[ch0, "chan0"]]) };
const dropId = "c0-d0" as DropId;
const claimCommand = Command.Claim({
  campaignId: "c0" as CampaignId,
  dropId,
  instanceId: instanceOf(dropId),
});

/** A twin whose one drop is complete: a session on `ch0` credited a minute before `SIM_EPOCH + 1m`. */
const completed = (faults: ReadonlyArray<Fault> = []): Twin => {
  const twin = makeTwin(buildWorld(scenario(faults)), { direct: true });
  let world = openSession(twin.world, ch0, SIM_EPOCH);
  for (let i = 1; i <= 3; i++) world = tick(world, ch0, SIM_EPOCH + i * 20_000).world;
  twin.world = world;
  return twin;
};

/**
 * Runs commands one after another from `SIM_EPOCH + 1m`, with one executor memory, over the live
 * wiring (`liveServices`) on the twin's wire.
 */
const run = (twin: Twin, commands: ReadonlyArray<Command>, memory: Memory = emptyMemory) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(SIM_EPOCH + 60_000);
    yield* bindClock(twin);
    const ref = yield* Ref.make(memory);
    const fiber = yield* Effect.forkChild(
      Effect.forEach(commands, (c) => execute(ref, c)).pipe(Effect.provide(twinProcess(twin))),
    );
    yield* TestClock.adjust("30 minutes");
    const events = yield* Fiber.join(fiber);
    return { events, memory: yield* Ref.get(ref) };
  });

const tags = (events: ReadonlyArray<ReadonlyArray<Event>>) =>
  events.map((es) => es.map((e) => e._tag));

const claims = (twin: Twin) => twin.activity.calls.filter((c) => c.kind === "claim");

const storm = (operation: Operation | "any" = "any"): Fault => ({
  kind: "http-5xx",
  operation,
  atMinute: 1,
  durationSeconds: 1800,
});

describe("execute", () => {
  it.effect("after a 429, reports the refused reads and claim as Throttled; the claim unsent", () =>
    Effect.gen(function* () {
      const limited: Fault = {
        kind: "http-429",
        operation: "Inventory",
        atMinute: 1,
        durationSeconds: 1800,
      };
      const twin = completed([limited]);
      const read = Command.ReadChannels({ channelIds: [ch0] });
      const { events } = yield* run(twin, [Command.ReadInventory(), claimCommand, read], knowsCh0);
      assert.deepStrictEqual(tags(events), [["Throttled"], ["Throttled"], ["Throttled"]]);
      const sent = [Command.ReadInventory(), claimCommand, read];
      for (const [i, command] of sent.entries()) {
        const event = events[i]![0]!;
        if (event._tag !== "Throttled") continue;
        assert.lengthOf(event.refusals, 1);
        const refusal = event.refusals[0]!;
        assert.deepStrictEqual(refusal.command, command);
        assert.strictEqual(refusal.budget, "gql");
        // The cooldown after the 429 at +1m.
        assert.isAtLeast(refusal.retryAt, SIM_EPOCH + 2 * 60_000);
      }
      // One Inventory request answered 429; nothing else reached Twitch, the claim least of all.
      assert.deepStrictEqual(
        twin.activity.requests.map((r) => [r.operation, r.status]),
        [["Inventory", 429]],
      );
      assert.lengthOf(claims(twin), 0);
      assert.strictEqual(twin.world.claimed.size, 0);
    }),
  );

  it.effect("validates, and reports a rejected token as AuthFailed and an outage as nothing", () =>
    Effect.gen(function* () {
      const ok = yield* run(makeTwin(buildWorld(scenario()), { direct: true }), [
        Command.ValidateToken(),
      ]);
      assert.deepStrictEqual(tags(ok.events), [["TokenValid"]]);
      assert.strictEqual(ok.memory.account?.login, "twin");
      const revoked = makeTwin(buildWorld(scenario([{ kind: "revoke-token", atMinute: 0 }])), {
        direct: true,
      });
      assert.deepStrictEqual(tags((yield* run(revoked, [Command.ValidateToken()])).events), [
        ["AuthFailed"],
      ]);
      const down = makeTwin(buildWorld(scenario([storm()])), { direct: true });
      assert.deepStrictEqual(tags((yield* run(down, [Command.ValidateToken()])).events), [[]]);
    }),
  );

  it.effect("reads the catalog, validating first without an account, and remembers logins", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const { events, memory } = yield* run(twin, [Command.ReadCatalog()]);
      assert.deepStrictEqual(tags(events), [["CatalogRead"]]);
      assert.deepStrictEqual(
        twin.activity.requests.map((r) => r.operation),
        ["validate", "ViewerDropsDashboard", "DropCampaignDetails"],
      );
      assert.strictEqual(memory.slugs.get("g0" as GameId), "game-0");
    }),
  );

  it.effect("reports an unreachable or withheld catalog as CatalogUnavailable", () =>
    Effect.gen(function* () {
      const withheld: Fault = {
        kind: "null-catalog",
        operation: "any",
        atMinute: 1,
        durationSeconds: 1800,
      };
      for (const fault of [withheld, storm("ViewerDropsDashboard")]) {
        const twin = makeTwin(buildWorld(scenario([fault])), { direct: true });
        const { events } = yield* run(twin, [Command.ReadCatalog()]);
        assert.deepStrictEqual(tags(events), [["CatalogUnavailable"]]);
      }
    }),
  );

  it.effect("reads inventory, the directory, channels and the current drop", () =>
    Effect.gen(function* () {
      const twin = completed();
      const { events } = yield* run(twin, [
        Command.ReadDirectory({ gameId: "g0" as GameId }),
        Command.ReadChannels({ channelIds: [ch0] }),
        Command.ReadCatalog(),
        Command.ReadDirectory({ gameId: "g0" as GameId }),
        Command.ReadChannels({ channelIds: [ch0, "unknown" as ChannelId] }),
        Command.ReadInventory(),
        Command.ReadCurrentDrop({ channelId: ch0 }),
      ]);
      // Without a slug or a login, nothing is asked: the catalog brings both. The core still
      // hears that the read is over, so discovery stops waiting for it.
      assert.deepStrictEqual(tags(events), [
        ["ChannelsReadFailed"],
        ["ChannelsReadFailed"],
        ["CatalogRead"],
        ["ChannelsRead"],
        ["ChannelsRead"],
        ["InventoryRead"],
        ["CurrentDropRead"],
      ]);
    }),
  );

  it.effect("turns a rejected token on any read into AuthFailed, and an outage into nothing", () =>
    Effect.gen(function* () {
      const reads = [Command.ReadInventory(), Command.ReadCurrentDrop({ channelId: ch0 })];
      const revoked = makeTwin(buildWorld(scenario([{ kind: "revoke-token", atMinute: 0 }])), {
        direct: true,
      });
      assert.deepStrictEqual(tags((yield* run(revoked, reads)).events), [
        ["AuthFailed"],
        ["AuthFailed"],
      ]);
      const down = makeTwin(buildWorld(scenario([storm()])), { direct: true });
      assert.deepStrictEqual(tags((yield* run(down, reads)).events), [[], []]);
    }),
  );

  it.effect("reports a channel read that gave up as ChannelsReadFailed, with its key", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario([storm()])), { direct: true });
      const memory: Memory = { ...knowsCh0, slugs: new Map([["g0" as GameId, "game-0"]]) };
      const directory = Command.ReadDirectory({ gameId: "g0" as GameId });
      const channels = Command.ReadChannels({ channelIds: [ch0] });
      const { events } = yield* run(twin, [directory, channels], memory);
      assert.deepStrictEqual(events, [
        [Event.ChannelsReadFailed({ read: readKey(directory) })],
        [Event.ChannelsReadFailed({ read: readKey(channels) })],
      ]);
    }),
  );

  it.effect("opens, ticks and stops the watch over HLS, and subscribes over PubSub", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const { events } = yield* run(
        twin,
        [
          Command.Subscribe({ channelIds: [ch0] }),
          Command.WatchTick({ channelId: ch0 }),
          Command.Watch({ channelId: ch0 }),
          Command.WatchTick({ channelId: ch0 }),
          Command.StopWatching(),
        ],
        knowsCh0,
      );
      assert.deepStrictEqual(tags(events), [[], ["WatchFailed"], [], ["WatchTicked"], []]);
      // One socket, one LISTEN; it closed with the process at the end of the run.
      assert.deepStrictEqual(
        twin.activity.calls.flatMap((c) => (c.kind === "pubsub" ? [c.frame] : [])),
        ["connect", "LISTEN"],
      );
      assert.deepStrictEqual(
        twin.activity.closes.map((c) => c.socket),
        [0],
      );
      // The tick: a token, usher, the 160p playlist and a HEAD of each segment, one beat.
      const operations = twin.activity.requests.map((r) => r.operation);
      assert.deepStrictEqual(operations.slice(0, 5), [
        "validate",
        "PlaybackAccessToken",
        "usher",
        "playlist",
        "segment",
      ]);
      assert.include([15, 16], operations.filter((o) => o === "segment").length);
      assert.deepStrictEqual(
        twin.activity.calls.filter((c) => c.kind === "tick").map((c) => c.channelId),
        [ch0],
      );
      // Stopping sends nothing: Twitch's view lasts until the beats stop for `SESSION_GAP`.
      assert.strictEqual(twin.world.session?.channelId, ch0);
    }),
  );

  it.effect("reports a tick after a revoked token as AuthFailed", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario([{ kind: "revoke-token", atMinute: 0 }])), {
        direct: true,
      });
      const { events } = yield* run(
        twin,
        [Command.Watch({ channelId: ch0 }), Command.WatchTick({ channelId: ch0 })],
        knowsCh0,
      );
      assert.deepStrictEqual(tags(events), [[], ["AuthFailed"]]);
    }),
  );

  it.effect("refuses to watch a channel whose login no read returned", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const { events } = yield* run(twin, [Command.Watch({ channelId: ch0 })]);
      assert.deepStrictEqual(tags(events), [["WatchFailed"]]);
      const [failed] = events[0]!;
      assert.strictEqual(failed?._tag === "WatchFailed" ? failed.reason : "", "refused");
      assert.isUndefined(twin.world.session);
    }),
  );

  it.effect("claims once and reports the answer", () =>
    Effect.gen(function* () {
      const twin = completed();
      const { events } = yield* run(twin, [claimCommand, claimCommand]);
      const outcomes = events.map((es) =>
        es.map((e) => (e._tag === "ClaimResult" ? e.outcome : "")),
      );
      // Twitch answers a claim of a claimed instance `ELIGIBLE_FOR_ALL` too (research 02 §4).
      assert.deepStrictEqual(outcomes, [["claimed"], ["claimed"]]);
      assert.deepStrictEqual(
        claims(twin).map((c) => (c.kind === "claim" ? [c.applied, c.alreadyApplied] : [])),
        [
          [true, false],
          [false, true],
        ],
      );
    }),
  );

  it.effect("makes one attempt during a 5xx window: none applied, the outcome unknown", () =>
    Effect.gen(function* () {
      const twin = completed([storm("ClaimDrop")]);
      const { events } = yield* run(twin, [claimCommand]);
      const [result] = events[0]!;
      assert.strictEqual(result?._tag === "ClaimResult" ? result.outcome : "", "unknown");
      assert.deepStrictEqual(
        claims(twin).map((c) => (c.kind === "claim" ? c.applied : undefined)),
        [false],
      );
      assert.isFalse(twin.world.claimed.has(dropId));
    }),
  );

  // Live, a mutation answered with a GQL error applied nothing (B1 review P1-2): the twin used to
  // apply it before it looked at the fault window.
  it.effect("applies no claim answered with a service error, and reports it unknown", () =>
    Effect.gen(function* () {
      const fault: Fault = {
        kind: "service-error",
        operation: "ClaimDrop",
        atMinute: 1,
        durationSeconds: 1800,
      };
      const twin = completed([fault]);
      const { events } = yield* run(twin, [claimCommand]);
      const [result] = events[0]!;
      assert.strictEqual(result?._tag === "ClaimResult" ? result.outcome : "", "unknown");
      assert.deepStrictEqual(
        claims(twin).map((c) => (c.kind === "claim" ? [c.applied, c.answered, c.outcome] : [])),
        [[false, false, "service-error"]],
      );
      assert.isFalse(twin.world.claimed.has(dropId));
    }),
  );

  it.effect("reports a lost answer as unknown while the twin holds the drop as claimed", () =>
    Effect.gen(function* () {
      const twin = completed([{ kind: "lose-claim-answer", atMinute: 0 }]);
      const { events } = yield* run(twin, [claimCommand]);
      const [result] = events[0]!;
      assert.strictEqual(result?._tag === "ClaimResult" ? result.outcome : "", "unknown");
      assert.strictEqual(claims(twin).length, 1);
      assert.isTrue(twin.world.claimed.has(dropId));
    }),
  );

  it.effect("reports a claim with a rejected token as unknown, then AuthFailed", () =>
    Effect.gen(function* () {
      const twin = completed([{ kind: "revoke-token", atMinute: 1 }]);
      const { events } = yield* run(twin, [claimCommand]);
      assert.deepStrictEqual(tags(events), [["ClaimResult", "AuthFailed"]]);
      assert.isFalse(twin.world.claimed.has(dropId));
    }),
  );
});
