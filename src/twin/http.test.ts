import { Budgets, UNLIMITED, type Limits } from "../twitch/budget.ts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import type { ChannelId } from "../core/model.ts";
import { Journal } from "../twitch/journal.ts";
import { Credentials, Twitch } from "../twitch/Twitch.ts";
import { twinHttp, twinTwitch } from "./http.ts";
import { DEFAULT_GOAL_SPEC, SIM_EPOCH, type Fault, type Scenario } from "./scenario.ts";
import { TWITCH_GQL_PER_SECOND, makeTwin, type Twin } from "./twin.ts";
import { ACCOUNT, buildWorld, openSession, tick } from "./world.ts";

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
const read = <A, E>(
  twin: Twin,
  use: (twitch: Twitch["Service"]) => Effect.Effect<A, E>,
  limits?: { readonly gql: Limits },
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(SIM_EPOCH + MINUTE_ONE);
    const fiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        return yield* use(yield* Twitch);
      }).pipe(Effect.provide(twinTwitch(twin, yield* Budgets.make(limits)))),
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
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
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
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
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
      const first = v.inventory.progress.find((p) => p.dropId === "c0-d0");
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
      const twin = makeTwin(buildWorld(scenario([blip])), { direct: true });
      const exit = yield* read(twin, (t) => t.inventory);
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepStrictEqual(
        requests(twin, "Inventory").map((r) => r.status),
        [503, 503, 200],
      );
    }),
  );

  it.effect("gives up with TwitchUnavailable after a longer 5xx window", () =>
    Effect.gen(function* () {
      const storm: Fault = {
        kind: "http-5xx",
        operation: "any",
        atMinute: 1,
        durationSeconds: 600,
      };
      const twin = makeTwin(buildWorld(scenario([storm])), { direct: true });
      const exit = yield* read(twin, (t) => t.inventory);
      assert.deepStrictEqual(errorTag(exit), ["TwitchUnavailable"]);
      assert.strictEqual(requests(twin, "Inventory").length, 4);
    }),
  );

  it.effect("stops at the first 429: the budget cools down and refuses the retry unsent", () =>
    Effect.gen(function* () {
      const storm: Fault = {
        kind: "http-429",
        operation: "any",
        atMinute: 1,
        durationSeconds: 600,
      };
      const twin = makeTwin(buildWorld(scenario([storm])), { direct: true });
      const exit = yield* read(twin, (t) => t.inventory);
      assert.deepStrictEqual(errorTag(exit), ["BudgetExhausted"]);
      assert.strictEqual(requests(twin, "Inventory").length, 1);
    }),
  );

  it.effect("answers 429 above five GQL requests a second, and only then", () =>
    Effect.gen(function* () {
      const burst = (n: number) =>
        Effect.gen(function* () {
          const twin = makeTwin(buildWorld(scenario()), { direct: true });
          const exit = yield* read(
            twin,
            (t) =>
              Effect.all(
                Array.from({ length: n }, () => t.inventory),
                { concurrency: n },
              ),
            { gql: { ...UNLIMITED, cooldown: 60_000 } },
          );
          return { exit, twin };
        });
      const five = yield* burst(TWITCH_GQL_PER_SECOND);
      assert.isTrue(Exit.isSuccess(five.exit));
      const six = yield* burst(TWITCH_GQL_PER_SECOND + 1);
      assert.isTrue(Exit.isFailure(six.exit));
      const limited = six.twin.activity.requests.filter((r) => r.limited);
      assert.lengthOf(limited, 1);
      assert.strictEqual(limited[0]!.status, 429);
      // Within the real budget, the same six start 300 ms apart and all pass.
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const budgeted = yield* read(twin, (t) =>
        Effect.all(
          Array.from({ length: 6 }, () => t.inventory),
          { concurrency: 6 },
        ),
      );
      assert.isTrue(Exit.isSuccess(budgeted));
      assert.isFalse(twin.activity.requests.some((r) => r.limited));
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
      const exit = yield* read(makeTwin(buildWorld(scenario([nul])), { direct: true }), (t) =>
        t.catalog(account),
      );
      assert.deepStrictEqual(errorTag(exit), ["TwitchDrift"]);
    }),
  );

  it.effect("rejects a revoked token without retrying", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario([{ kind: "revoke-token", atMinute: 0 }])), {
        direct: true,
      });
      const exit = yield* read(twin, (t) => t.validate);
      assert.deepStrictEqual(errorTag(exit), ["AuthRejected"]);
      assert.strictEqual(requests(twin, "validate").length, 1);
    }),
  );

  // B1 review P2 (a): the API checks the token before a 5xx window can answer.
  it.effect("answers a revoked token 401 inside a 5xx window, so the client parks", () =>
    Effect.gen(function* () {
      const storm: Fault = {
        kind: "http-5xx",
        operation: "any",
        atMinute: 0,
        durationSeconds: 900,
      };
      const twin = makeTwin(buildWorld(scenario([storm, { kind: "revoke-token", atMinute: 0 }])), {
        direct: true,
      });
      const exit = yield* read(twin, (t) => t.inventory);
      assert.deepStrictEqual(errorTag(exit), ["AuthRejected"]);
      assert.deepStrictEqual(
        requests(twin, "Inventory").map((r) => r.status),
        [401],
      );
    }),
  );

  // B1 review P1-1: the twin took any token, so a miner wired to the wrong one passed.
  it.effect("answers 401 to a token it never issued, and records the request", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const other = Twitch.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, twinHttp(twin)),
            Layer.succeed(
              Credentials,
              Credentials.of({ token: Redacted.make("not-the-twin-token"), deviceId: "0" }),
            ),
            Budgets.layer,
            Journal.none,
          ),
        ),
      );
      yield* TestClock.setTime(SIM_EPOCH + MINUTE_ONE);
      const fiber = yield* Effect.forkChild(
        Effect.flatMap(Twitch, (t) => t.validate).pipe(Effect.provide(other)),
      );
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(errorTag(yield* Fiber.await(fiber)), ["AuthRejected"]);
      assert.deepStrictEqual(twin.activity.wrongTokens, [
        "validate sent a token the twin never issued",
      ]);
      // The twin's own token passes.
      assert.isTrue(Exit.isSuccess(yield* read(twin, (t) => t.validate)));
      assert.lengthOf(twin.activity.wrongTokens, 1);
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
      const twin = makeTwin(buildWorld(scenario([fault])), { direct: true });
      const exit = yield* read(twin, (t) => t.inventory);
      assert.isTrue(Exit.isSuccess(exit));
      assert.strictEqual(requests(twin, "Inventory").length, 3);
    }),
  );

  it.effect("times a hanging read out per request, within the bound of plan §3.3", () =>
    Effect.gen(function* () {
      const hang: Fault = { kind: "timeout", operation: "any", atMinute: 1, durationSeconds: 600 };
      const twin = makeTwin(buildWorld(scenario([hang])), { direct: true });
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
