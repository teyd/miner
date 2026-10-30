import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { ChannelId } from "../core/model.ts";
import { Twitch } from "../twitch/Twitch.ts";
import { twinTwitch } from "./http.ts";
import { SIM_EPOCH, type Fault, type Scenario } from "./scenario.ts";
import { makeTwin, type Twin } from "./twin.ts";
import { ACCOUNT, buildWorld, openSession, tick } from "./world.ts";

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
      allowList: [1],
      drops: [
        { requiredMinutes: 1, after: null, benefit: "DIRECT_ENTITLEMENT" },
        { requiredMinutes: 30, after: 0, benefit: "BADGE" },
      ],
    },
    {
      game: 1,
      startMinute: 0,
      durationMinutes: 60,
      linked: false,
      allowList: [],
      drops: [{ requiredMinutes: 10, after: null, benefit: "EMOTE" }],
    },
    {
      game: 1,
      startMinute: 120,
      durationMinutes: 60,
      linked: false,
      allowList: [],
      drops: [{ requiredMinutes: 10, after: null, benefit: "EMOTE" }],
    },
  ],
  channels: [
    { game: 1, viewers: 50, dropsEnabled: true, refuses: false, liveAtStart: true, changes: [] },
    { game: 0, viewers: 500, dropsEnabled: false, refuses: false, liveAtStart: true, changes: [] },
    { game: 1, viewers: 900, dropsEnabled: true, refuses: false, liveAtStart: false, changes: [] },
  ],
  faults,
});

const account = { userId: ACCOUNT.userId, login: ACCOUNT.login };

/** Runs a read against the real client over the twin, moving virtual time until it settles. */
const read = <A, E>(twin: Twin, use: (twitch: Twitch["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(SIM_EPOCH + MINUTE_ONE);
    const fiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        return yield* use(yield* Twitch);
      }).pipe(Effect.provide(twinTwitch(twin))),
    );
    yield* TestClock.adjust("10 minutes");
    return yield* Fiber.await(fiber);
  });

const MINUTE_ONE = 60_000;

const errorTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => (r._tag === "Fail" ? r.error._tag : r._tag))
    : [];

const requests = (twin: Twin, operation: string) =>
  twin.activity.requests.filter((r) => r.operation === operation);

describe("twin http", () => {
  it.effect("serves the world's campaigns, equal after decoding: the encoding is conformant", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()));
      const exit = yield* read(twin, (t) => t.catalog(account));
      assert.isTrue(Exit.isSuccess(exit));
      if (!Exit.isSuccess(exit)) return;
      // Only active campaigns: c2 starts in two hours.
      assert.deepStrictEqual(exit.value.campaigns, twin.world.campaigns.slice(0, 2));
      assert.strictEqual(exit.value.logins.get("ch1" as ChannelId), "chan1");
    }),
  );

  it.effect("serves validate, inventory, directory, streams and the current drop", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()));
      let world = openSession(twin.world, "ch1" as ChannelId, SIM_EPOCH);
      for (let i = 1; i <= 3; i++)
        world = tick(world, "ch1" as ChannelId, SIM_EPOCH + i * 20_000).world;
      twin.world = world;
      const exit = yield* read(twin, (t) =>
        Effect.all({
          account: t.validate,
          inventory: t.inventory,
          directory: t.directory("game-1", 30),
          streams: t.streams(["chan0", "chan2", "nobody"]),
          current: t.currentDrop("ch1" as ChannelId),
        }),
      );
      assert.isTrue(Exit.isSuccess(exit));
      if (!Exit.isSuccess(exit)) return;
      const v = exit.value;
      assert.deepStrictEqual(v.account, account);
      const first = v.inventory.find((p) => p.dropId === "c0-d0");
      assert.deepStrictEqual<ReadonlyArray<unknown>>(
        [first?.minutes, first?.instanceId, first?.claimed],
        [1, "c0-d0#i", false],
      );
      assert.deepStrictEqual(
        v.directory.map((c) => c.id),
        ["ch0"],
      );
      assert.deepStrictEqual<ReadonlyArray<ReadonlyArray<unknown>>>(
        v.streams.map((c) => [c.id, c.gameId, c.live?.viewers]),
        [
          ["ch0", "g1", 50],
          ["ch2", "g1", undefined],
        ],
      );
      assert.deepStrictEqual(v.current, { dropId: undefined, minutes: 0 });
    }),
  );

  it.effect("absorbs a 5xx blip shorter than the retries", () =>
    Effect.gen(function* () {
      const blip: Fault = {
        kind: "http-5xx",
        operation: "Inventory",
        atMinute: 1,
        durationSeconds: 5,
      };
      const twin = makeTwin(buildWorld(scenario([blip])));
      const exit = yield* read(twin, (t) => t.inventory);
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepStrictEqual(
        requests(twin, "Inventory").map((r) => r.status),
        [503, 503, 200],
      );
    }),
  );

  it.effect("gives up with TwitchUnavailable after a longer 5xx window, and on 429s", () =>
    Effect.gen(function* () {
      for (const kind of ["http-5xx", "http-429"] as const) {
        const storm: Fault = { kind, operation: "any", atMinute: 1, durationSeconds: 600 };
        const twin = makeTwin(buildWorld(scenario([storm])));
        const exit = yield* read(twin, (t) => t.inventory);
        assert.deepStrictEqual(errorTag(exit), ["TwitchUnavailable"]);
        assert.strictEqual(requests(twin, "Inventory").length, 4);
      }
    }),
  );

  it.effect("withholds the catalog as TwitchDrift", () =>
    Effect.gen(function* () {
      const nul: Fault = {
        kind: "null-catalog",
        operation: "any",
        atMinute: 1,
        durationSeconds: 60,
      };
      const exit = yield* read(makeTwin(buildWorld(scenario([nul]))), (t) => t.catalog(account));
      assert.deepStrictEqual(errorTag(exit), ["TwitchDrift"]);
    }),
  );

  it.effect("rejects a revoked token without retrying", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario([{ kind: "revoke-token", atMinute: 0 }])));
      const exit = yield* read(twin, (t) => t.validate);
      assert.deepStrictEqual(errorTag(exit), ["AuthRejected"]);
      assert.strictEqual(requests(twin, "validate").length, 1);
    }),
  );

  it.effect("retries a service error on Inventory", () =>
    Effect.gen(function* () {
      const fault: Fault = {
        kind: "service-error",
        operation: "Inventory",
        atMinute: 1,
        durationSeconds: 3,
      };
      const twin = makeTwin(buildWorld(scenario([fault])));
      const exit = yield* read(twin, (t) => t.inventory);
      assert.isTrue(Exit.isSuccess(exit));
      assert.strictEqual(requests(twin, "Inventory").length, 3);
    }),
  );

  it.effect("times a hanging read out per request, within the bound of plan §3.3", () =>
    Effect.gen(function* () {
      const hang: Fault = { kind: "timeout", operation: "any", atMinute: 1, durationSeconds: 600 };
      const twin = makeTwin(buildWorld(scenario([hang])));
      const exit = yield* read(twin, (t) => t.inventory);
      assert.deepStrictEqual(errorTag(exit), ["TwitchUnavailable"]);
      const sent = requests(twin, "Inventory");
      assert.deepStrictEqual(
        sent.map((r) => [r.status, r.endedAt - r.at]),
        Array.from({ length: 4 }, () => ["timeout", 30_000]),
      );
      assert.strictEqual(sent.at(-1)!.endedAt - sent[0]!.at, 4 * 30_000 + 2_000 + 4_000 + 8_000);
    }),
  );
});
