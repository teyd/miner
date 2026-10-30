import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { ChannelId, DropId } from "../core/model.ts";
import type { Actuator } from "../twitch/Actuator.ts";
import { twinActuator } from "./actuator.ts";
import { SIM_EPOCH, type Fault, type Scenario } from "./scenario.ts";
import { makeTwin, type Twin } from "./twin.ts";
import { buildWorld, instanceOf, minutesAt } from "./world.ts";

const scenario = (faults: ReadonlyArray<Fault> = [], refuses = false): Scenario => ({
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
    { game: 0, viewers: 50, dropsEnabled: true, refuses, liveAtStart: true, changes: [] },
    { game: 0, viewers: 50, dropsEnabled: true, refuses: false, liveAtStart: false, changes: [] },
  ],
  faults,
});

const ch = (i: number) => `ch${i}` as ChannelId;
const instance = instanceOf("c0-d0" as DropId);

/** Runs actuator calls from `SIM_EPOCH`, moving virtual time until they settle. */
const act = <A, E>(twin: Twin, use: (a: Actuator["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(use(twinActuator(twin)));
    yield* TestClock.adjust("10 minutes");
    return yield* Fiber.await(fiber);
  });

const errorOf = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) =>
        r._tag === "Fail"
          ? "reason" in r.error && r.error._tag === "WatchFailure"
            ? `WatchFailure:${String(r.error.reason)}`
            : r.error._tag
          : r._tag,
      )
    : [];

/** Watches channel 0 for three ticks, a minute of credit, completing the 1-minute drop. */
const completeDrop = (a: Actuator["Service"]) =>
  Effect.gen(function* () {
    yield* a.watch(ch(0));
    for (let i = 0; i < 3; i++) {
      yield* Effect.sleep("20 seconds");
      yield* a.watchTick(ch(0));
    }
  });

describe("twin actuator", () => {
  it.effect("switches the one session, and a tick without one credits nothing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const twin = makeTwin(buildWorld(scenario()));
      const exit = yield* act(twin, (a) =>
        Effect.gen(function* () {
          yield* a.watch(ch(0));
          yield* a.watch(ch(1));
          return yield* Effect.exit(a.watchTick(ch(0)));
        }),
      );
      assert.isTrue(Exit.isSuccess(exit));
      if (Exit.isSuccess(exit))
        assert.deepStrictEqual(errorOf(exit.value), ["WatchFailure:network"]);
      assert.strictEqual(twin.world.session?.channelId, ch(1));
      const stopped = yield* act(twin, (a) =>
        Effect.flatMap(a.stopWatching, () => Effect.exit(a.watchTick(ch(1)))),
      );
      if (Exit.isSuccess(stopped))
        assert.deepStrictEqual(errorOf(stopped.value), ["WatchFailure:network"]);
    }),
  );

  it.effect("reports offline and refusing channels", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const twin = makeTwin(buildWorld(scenario([], true)));
      const refused = yield* act(twin, (a) => Effect.andThen(a.watch(ch(0)), a.watchTick(ch(0))));
      assert.deepStrictEqual(errorOf(refused), ["WatchFailure:refused"]);
      const offline = yield* act(twin, (a) => Effect.andThen(a.watch(ch(1)), a.watchTick(ch(1))));
      assert.deepStrictEqual(errorOf(offline), ["WatchFailure:offline"]);
    }),
  );

  it.effect("claims once; a second attempt answers already-claimed and is logged as one", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const twin = makeTwin(buildWorld(scenario()));
      const exit = yield* act(twin, (a) =>
        Effect.gen(function* () {
          yield* completeDrop(a);
          return [yield* a.claim(instance), yield* a.claim(instance)];
        }),
      );
      assert.deepStrictEqual(exit, Exit.succeed(["claimed", "already-claimed"]));
      const claims = twin.activity.calls.filter((c) => c.kind === "claim");
      assert.deepStrictEqual(
        claims.map((c) => (c.kind === "claim" ? [c.applied, c.alreadyApplied] : [])),
        [
          [true, false],
          [false, true],
        ],
      );
    }),
  );

  const claimUnder = (fault: Fault) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const twin = makeTwin(buildWorld(scenario([fault])));
      const exit = yield* act(twin, (a) => Effect.andThen(completeDrop(a), a.claim(instance)));
      return { exit, twin };
    });

  it.effect("fails a claim before it applies during a 5xx, 429 or service-error window", () =>
    Effect.gen(function* () {
      for (const kind of ["http-5xx", "http-429", "service-error"] as const) {
        const { exit, twin } = yield* claimUnder({
          kind,
          operation: "ClaimDrop",
          atMinute: 0,
          durationSeconds: 600,
        });
        assert.deepStrictEqual(errorOf(exit), ["TwitchUnavailable"]);
        assert.isFalse(twin.world.claimed.has("c0-d0" as DropId));
      }
    }),
  );

  it.effect("delays ticks and claims by 30 s in a network timeout, crediting nothing", () =>
    Effect.gen(function* () {
      const fault: Fault = { kind: "timeout", operation: "any", atMinute: 0, durationSeconds: 600 };
      const { exit, twin } = yield* claimUnder(fault);
      assert.deepStrictEqual(errorOf(exit), ["WatchFailure:network"]);
      const tick = twin.activity.calls.find((c) => c.kind === "tick");
      assert.strictEqual(tick && tick.kind === "tick" ? tick.endedAt - tick.at : 0, 30_000);
      assert.strictEqual(minutesAt(twin.world, "c0-d0" as DropId, SIM_EPOCH + 60 * 60_000), 0);
    }),
  );

  it.effect("rejects ticks and claims after the token is revoked", () =>
    Effect.gen(function* () {
      const { exit, twin } = yield* claimUnder({ kind: "revoke-token", atMinute: 0 });
      assert.deepStrictEqual(errorOf(exit), ["AuthRejected"]);
      assert.strictEqual(twin.activity.credits.length, 0);
    }),
  );

  it.effect("applies a claim and loses its answer", () =>
    Effect.gen(function* () {
      const { exit, twin } = yield* claimUnder({ kind: "lose-claim-answer", atMinute: 0 });
      assert.deepStrictEqual(errorOf(exit), ["TwitchUnavailable"]);
      assert.isTrue(twin.world.claimed.has("c0-d0" as DropId));
    }),
  );

  it.effect("drops frames while PubSub is down", () =>
    Effect.gen(function* () {
      const up = yield* claimUnder({ kind: "lose-claim-answer", atMinute: 0 });
      assert.deepStrictEqual(
        up.twin.frames.map((f) => f.event._tag),
        ["DropProgress", "DropClaimable"],
      );
      const down = yield* claimUnder({ kind: "frames-down", atMinute: 0, durationSeconds: 600 });
      assert.deepStrictEqual(down.twin.frames, []);
      assert.isTrue(Exit.isSuccess(down.exit));
    }),
  );
});
