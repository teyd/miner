import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { CampaignId, ChannelId, DropId, GameId } from "../core/model.ts";
import { Command, type Event } from "../core/protocol.ts";
import { Actuator } from "../twitch/Actuator.ts";
import { twinActuator } from "./actuator.ts";
import { emptyMemory, execute, type Memory } from "./execute.ts";
import { twinTwitch } from "./http.ts";
import { SIM_EPOCH, type Fault, type Operation, type Scenario } from "./scenario.ts";
import { makeTwin, type Twin } from "./twin.ts";
import { buildWorld, instanceOf, openSession, tick } from "./world.ts";

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
  ],
  faults,
});

const ch0 = "ch0" as ChannelId;
const dropId = "c0-d0" as DropId;
const claimCommand = Command.Claim({
  campaignId: "c0" as CampaignId,
  dropId,
  instanceId: instanceOf(dropId),
});

/** A twin whose one drop is complete: a session on `ch0` credited a minute before `SIM_EPOCH + 1m`. */
const completed = (faults: ReadonlyArray<Fault> = []): Twin => {
  const twin = makeTwin(buildWorld(scenario(faults)));
  let world = openSession(twin.world, ch0, SIM_EPOCH);
  for (let i = 1; i <= 3; i++) world = tick(world, ch0, SIM_EPOCH + i * 20_000).world;
  twin.world = world;
  return twin;
};

/** Runs commands one after another from `SIM_EPOCH + 1m`, with one executor memory. */
const run = (twin: Twin, commands: ReadonlyArray<Command>, memory: Memory = emptyMemory) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(SIM_EPOCH + 60_000);
    const ref = yield* Ref.make(memory);
    const services = Layer.merge(twinTwitch(twin), Layer.succeed(Actuator, twinActuator(twin)));
    const fiber = yield* Effect.forkChild(
      Effect.forEach(commands, (c) => execute(ref, c)).pipe(Effect.provide(services)),
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
  it.effect("validates, and reports a rejected token as AuthFailed and an outage as nothing", () =>
    Effect.gen(function* () {
      const ok = yield* run(makeTwin(buildWorld(scenario())), [Command.ValidateToken()]);
      assert.deepStrictEqual(tags(ok.events), [["TokenValid"]]);
      assert.strictEqual(ok.memory.account?.login, "twin");
      const revoked = makeTwin(buildWorld(scenario([{ kind: "revoke-token", atMinute: 0 }])));
      assert.deepStrictEqual(tags((yield* run(revoked, [Command.ValidateToken()])).events), [
        ["AuthFailed"],
      ]);
      const down = makeTwin(buildWorld(scenario([storm()])));
      assert.deepStrictEqual(tags((yield* run(down, [Command.ValidateToken()])).events), [[]]);
    }),
  );

  it.effect("reads the catalog, validating first without an account, and remembers logins", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()));
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
        const twin = makeTwin(buildWorld(scenario([fault])));
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
      // Without a slug or a login, nothing is asked: the catalog brings both.
      assert.deepStrictEqual(tags(events), [
        [],
        [],
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
      const revoked = makeTwin(buildWorld(scenario([{ kind: "revoke-token", atMinute: 0 }])));
      assert.deepStrictEqual(tags((yield* run(revoked, reads)).events), [
        ["AuthFailed"],
        ["AuthFailed"],
      ]);
      const down = makeTwin(buildWorld(scenario([storm()])));
      assert.deepStrictEqual(tags((yield* run(down, reads)).events), [[], []]);
    }),
  );

  it.effect("opens, ticks and stops the watch, and subscribes, through the actuator", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()));
      const { events } = yield* run(twin, [
        Command.Subscribe({ channelIds: [ch0] }),
        Command.WatchTick({ channelId: ch0 }),
        Command.Watch({ channelId: ch0 }),
        Command.WatchTick({ channelId: ch0 }),
        Command.StopWatching(),
      ]);
      assert.deepStrictEqual(tags(events), [[], ["WatchFailed"], [], ["WatchTicked"], []]);
      assert.deepStrictEqual([...twin.world.subscriptions], [ch0]);
      assert.isUndefined(twin.world.session);
    }),
  );

  it.effect("reports a tick after a revoked token as AuthFailed", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario([{ kind: "revoke-token", atMinute: 0 }])));
      const { events } = yield* run(twin, [
        Command.Watch({ channelId: ch0 }),
        Command.WatchTick({ channelId: ch0 }),
      ]);
      assert.deepStrictEqual(tags(events), [[], ["AuthFailed"]]);
    }),
  );

  it.effect("claims once and reports the answer", () =>
    Effect.gen(function* () {
      const twin = completed();
      const { events } = yield* run(twin, [claimCommand, claimCommand]);
      const outcomes = events.map((es) =>
        es.map((e) => (e._tag === "ClaimResult" ? e.outcome : "")),
      );
      assert.deepStrictEqual(outcomes, [["claimed"], ["already-claimed"]]);
      assert.strictEqual(claims(twin).length, 2);
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
