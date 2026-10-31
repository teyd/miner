import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { WATCHLIST_LIMIT } from "../core/state.ts";
import { CDN_LIMITS, GQL_LIMITS, makeBudget, turnAt, type Budget, type Limits } from "./budget.ts";
import rates from "./fixtures/rates-2026-10-30.json" with { type: "json" };
import { PUBSUB_MAX_CONNECTIONS, PUBSUB_TOPICS_PER_CONNECTION } from "./identity.ts";

/** Twitch's limit (research 02 §4b), which the GQL budget must stay under. */
const TWITCH_GQL_PER_SECOND = 5;

/** The most starts in any window of `size` ms. */
const peak = (starts: ReadonlyArray<number>, size: number): number => {
  const sorted = starts.toSorted((a, b) => a - b);
  let most = 0;
  let from = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (sorted[i]! - sorted[from]! >= size) from++;
    most = Math.max(most, i - from + 1);
  }
  return most;
};

/** Asks `budget` for one turn per entry of `at` (ms from now), all forked; returns what ran. */
const askAt = (
  budget: Budget,
  at: ReadonlyArray<number>,
  hold: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const t0 = yield* Clock.currentTimeMillis;
    const starts: Array<number> = [];
    const fibers = yield* Effect.forEach(at, (offset, i) =>
      Effect.forkChild(
        Effect.gen(function* () {
          if (offset > 0) yield* Effect.sleep(offset);
          const asked = yield* Clock.currentTimeMillis;
          const ran = Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.andThen(
              Effect.sync(() => starts.push(now - t0)),
              hold,
            ),
          );
          const exit = yield* Effect.exit(budget.run(`op${i}`, ran));
          return { asked: asked - t0, at: (yield* Clock.currentTimeMillis) - t0, exit };
        }),
      ),
    );
    return { starts, fibers };
  });

const limits = (patch: Partial<Limits>): Limits => ({ ...GQL_LIMITS, ...patch });

describe("turnAt", () => {
  it("waits the gap after the last start and keeps at most `max` in a window", () => {
    const l = limits({ gap: 300, window: 1_000, max: 4 });
    assert.strictEqual(turnAt(l, [], 50), 50);
    assert.strictEqual(turnAt(l, [0], 100), 300);
    assert.strictEqual(turnAt(l, [0], 900), 900);
    // Four starts in the window ending at 900: the fifth waits until the first leaves it.
    assert.strictEqual(turnAt(l, [0, 300, 600, 900], 900), 1_200);
    // Windows are closed: the fifth may not start exactly a window after the first.
    assert.strictEqual(turnAt(limits({ gap: 0, window: 1_000, max: 4 }), [0, 1, 2, 3], 3), 1_001);
    // A cost counts as that many starts.
    const cdn = limits({ gap: 0, window: 60_000, max: 40 });
    assert.strictEqual(
      turnAt(
        cdn,
        Array.from({ length: 17 }, () => 0),
        20_000,
        17,
      ),
      20_000,
    );
    assert.strictEqual(
      turnAt(
        cdn,
        Array.from({ length: 34 }, () => 0),
        20_000,
        17,
      ),
      60_001,
    );
  });
});

describe("makeBudget", () => {
  it.effect("starts requests the gap apart and never more than four a second", () =>
    Effect.gen(function* () {
      const budget = yield* makeBudget("gql", GQL_LIMITS);
      const { starts, fibers } = yield* askAt(
        budget,
        Array.from({ length: 12 }, () => 0),
      );
      yield* TestClock.adjust("10 seconds");
      const results = yield* Fiber.joinAll(fibers);
      assert.isTrue(results.every((r) => Exit.isSuccess(r.exit)));
      assert.lengthOf(starts, 12);
      for (let i = 1; i < starts.length; i++) {
        assert.isAtLeast(starts[i]! - starts[i - 1]!, GQL_LIMITS.gap);
      }
      assert.isAtMost(peak(starts, 1_000), 4);
      assert.isBelow(peak(starts, 1_000), TWITCH_GQL_PER_SECOND);
    }),
  );

  it.effect("counts a start exactly one window old: the next turn is past it", () =>
    Effect.gen(function* () {
      const budget = yield* makeBudget("gql", limits({ gap: 0, window: 1_000, max: 4 }));
      const { starts, fibers } = yield* askAt(budget, [0, 0, 0, 0, 1_000]);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.joinAll(fibers);
      assert.deepStrictEqual(starts, [0, 0, 0, 0, 1_001]);
    }),
  );

  it.effect("refuses at once, unsent, a request whose turn would come after the longest wait", () =>
    Effect.gen(function* () {
      const budget = yield* makeBudget("gql", limits({ maxWait: 1_000 }));
      const { starts, fibers } = yield* askAt(budget, [0, 0, 0, 0, 0]);
      yield* TestClock.adjust("5 seconds");
      const results = yield* Fiber.joinAll(fibers);
      // Turns at 0, 300, 600 and 900; the fifth would start at 1200, past the 1 s wait.
      assert.deepStrictEqual(starts, [0, 300, 600, 900]);
      const refused = results[4]!;
      assert.strictEqual(refused.at, 0, "refused without waiting");
      assert.isTrue(Exit.isFailure(refused.exit));
      if (Exit.isFailure(refused.exit)) {
        const error = refused.exit.cause.reasons[0];
        assert.strictEqual(error?._tag, "Fail");
        if (error?._tag === "Fail") {
          assert.strictEqual(error.error._tag, "BudgetExhausted");
          assert.strictEqual(error.error.retryAt, 1_200);
          assert.strictEqual(error.error.budget, "gql");
        }
      }
    }),
  );

  it.effect("caps requests in flight apart from the rate, and refuses past the wait", () =>
    Effect.gen(function* () {
      const budget = yield* makeBudget("gql", limits({ gap: 0, concurrency: 1, maxWait: 5_000 }));
      // Each holds its slot 4 s: the second waits 3 s for it, the third would wait past 5 s.
      const { starts, fibers } = yield* askAt(budget, [0, 1_000, 2_000], Effect.sleep(4_000));
      yield* TestClock.adjust("30 seconds");
      const results = yield* Fiber.joinAll(fibers);
      assert.deepStrictEqual(starts, [0, 4_000]);
      assert.isTrue(Exit.isSuccess(results[1]!.exit));
      assert.isTrue(Exit.isFailure(results[2]!.exit));
      assert.strictEqual(results[2]!.at, 7_000, "refused after its 5 s wait");
      // The refused request left no slot behind: a later one runs.
      const later = yield* askAt(budget, [0]);
      yield* TestClock.adjust("1 second");
      assert.isTrue(Exit.isSuccess((yield* Fiber.join(later.fibers[0]!)).exit));
    }),
  );

  it.effect("after a 429 refuses everything until the cooldown passed, waiting turns too", () =>
    Effect.gen(function* () {
      const budget = yield* makeBudget("gql", GQL_LIMITS);
      const { starts, fibers } = yield* askAt(budget, [0, 0, 0]);
      yield* Effect.yieldNow;
      yield* budget.backOff;
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.joinAll(fibers);
      // The first had started; the two waiting for their turn are refused when it comes.
      assert.deepStrictEqual(starts, [0]);
      assert.deepStrictEqual(
        results.map((r) => Exit.isSuccess(r.exit)),
        [true, false, false],
      );
      const during = yield* askAt(budget, [0]);
      assert.isTrue(Exit.isFailure((yield* Fiber.join(during.fibers[0]!)).exit));
      yield* TestClock.adjust(GQL_LIMITS.cooldown);
      const after = yield* askAt(budget, [0]);
      yield* TestClock.adjust("1 second");
      assert.isTrue(Exit.isSuccess((yield* Fiber.join(after.fibers[0]!)).exit));
    }),
  );

  it.effect("CDN requests go one at a time", () =>
    Effect.gen(function* () {
      const budget = yield* makeBudget("cdn", CDN_LIMITS);
      const { starts, fibers } = yield* askAt(budget, [0, 0, 0], Effect.sleep(1_000));
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.joinAll(fibers);
      assert.deepStrictEqual(starts, [0, 1_000, 2_000]);
    }),
  );
});

describe("the live runs of 2026-10-30 (fixtures/rates-2026-10-30.json)", () => {
  for (const [name, run] of Object.entries(rates.runs)) {
    it.effect(`${name}: every API request fits the budget, under Twitch's rate`, () =>
      Effect.gen(function* () {
        const at = run.api.map(([t]) => Number(t));
        // As recorded: at most 27 a minute with validation (startup), answers bunched by
        // concurrency.
        assert.isAtMost(peak(at, 60_000), 27);
        const budget = yield* makeBudget("gql", GQL_LIMITS);
        const { starts, fibers } = yield* askAt(budget, at, Effect.sleep(200));
        yield* TestClock.adjust(at.at(-1)! + 60_000);
        const results = yield* Fiber.joinAll(fibers);
        assert.isTrue(
          results.every((r) => Exit.isSuccess(r.exit)),
          "no request refused",
        );
        assert.lengthOf(starts, at.length);
        assert.isAtMost(peak(starts, 1_000), GQL_LIMITS.max);
        assert.isBelow(peak(starts, 1_000), TWITCH_GQL_PER_SECOND);
        // The longest wait for a turn: a few seconds in the startup burst, far below the bound.
        const waits = results.map((r) => r.at - r.asked - 200);
        assert.isBelow(Math.max(...waits), GQL_LIMITS.maxWait / 2);
      }),
    );

    it(`${name}: CDN requests peak far below the CDN budget`, () => {
      const at = run.cdn.flatMap(([t, n]) => Array.from({ length: Number(n) }, () => Number(t)));
      assert.isAtMost(peak(at, CDN_LIMITS.window), CDN_LIMITS.max / 3);
      assert.isAtMost(run.sockets, PUBSUB_MAX_CONNECTIONS);
    });
  }
});

describe("the socket budget", () => {
  it("holds every channel the core may follow, under Twitch's ~10 sockets per IP", () => {
    // Two topics per channel and the account's drop topic (`PubSub.ts`).
    assert.isAtMost(2 * WATCHLIST_LIMIT + 1, PUBSUB_MAX_CONNECTIONS * PUBSUB_TOPICS_PER_CONNECTION);
    assert.isBelow(PUBSUB_MAX_CONNECTIONS, 10);
  });
});

describe("a request larger than the window", () => {
  it.effect("is refused unsent, never waited for", () =>
    Effect.gen(function* () {
      const budget = yield* makeBudget("cdn", { ...CDN_LIMITS, max: 10 });
      let ran = false;
      const exit = yield* Effect.exit(
        budget.run(
          "hls",
          Effect.sync(() => (ran = true)),
          11,
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.isFalse(ran);
    }),
  );
});
