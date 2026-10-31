import { Clock, Context, Effect, Layer, Option, Semaphore } from "effect";
import type { Millis } from "../core/model.ts";
import { BudgetExhausted } from "./errors.ts";

/**
 * Request budgets, one per class of traffic (critique 08 CF-5): Twitch's API (GQL, and the hourly
 * token validation with it) and its CDN (usher, media playlists, segment `HEAD`s). The third
 * class, sockets, is static: the core follows at most `WATCHLIST_LIMIT` channels and PubSub opens
 * at most `PUBSUB_MAX_CONNECTIONS` (`budget.test.ts` checks the one fits the other).
 *
 * Rate and concurrency are separate limits (TDM `utils.py:348-378` caps both). A request waits
 * for its turn at most `maxWait`, and only when the turn is known to come by then; otherwise it
 * fails at once with `BudgetExhausted`, unsent, and the core reschedules the command (`Throttled`).
 * So a budget never holds a command past its deadline, and never hangs a simulated clock.
 */
export interface Limits {
  /** Request starts at least this far apart. */
  readonly gap: Millis;
  /** At most `max` request starts in any `window`. */
  readonly window: Millis;
  readonly max: number;
  /** Requests started and not yet answered, at most. */
  readonly concurrency: number;
  /** The longest a request waits for its turn before it is refused. */
  readonly maxWait: Millis;
  /** After Twitch answers 429, every request is refused this long. */
  readonly cooldown: Millis;
}

export type BudgetName = BudgetExhausted["budget"];

/**
 * Twitch allows about 5 GQL requests per second per IP (DevilXD, TDM #1153, 2026-08-29), shared by
 * everything on the host. Starts 300 ms apart (at most 4 in any second) are what the live runs of
 * 2026-10-30 sent: 313 requests in 4 h, at most 27 in a minute, all in the startup burst
 * (`fixtures/rates-2026-10-30.json`, research 02 §4b). Four in flight covers 300 ms apart with
 * room for a hung request. 15 s of turns hold 50 requests, the largest burst seen (19) twice over.
 */
export const GQL_LIMITS: Limits = {
  gap: 300,
  window: 1_000,
  max: 4,
  concurrency: 4,
  maxWait: 15_000,
  cooldown: 60_000,
};

/**
 * The CDN publishes no limit. One request at a time, as TDM sends a tick's `HEAD`s, and at most
 * 480 a minute. A tick is a media playlist and a `HEAD` per segment: 16 or 17 requests for most
 * of the live runs of 2026-10-30, 31 or 32 for an hour of the 4 h one, and once four growing
 * ticks of 23 to 54 (research 02 §4b). The busiest minute held 155, about a third of 480
 * (`budget.test.ts`), so only a runaway loop reaches it. A request waits at most a CDN request's
 * own timeout (`hls.ts`) for the one before it.
 */
export const CDN_LIMITS: Limits = {
  gap: 0,
  window: 60_000,
  max: 480,
  concurrency: 1,
  maxWait: 10_000,
  cooldown: 60_000,
};

export interface Budget {
  readonly name: BudgetName;
  readonly limits: Limits;
  /**
   * Runs `effect` as `cost` requests of this class: waits for a turn, at most `maxWait`, or fails
   * with `BudgetExhausted` without running it. The turn's concurrency slot is held until `effect`
   * ends.
   */
  readonly run: <A, E, R>(
    operation: string,
    effect: Effect.Effect<A, E, R>,
    cost?: number,
  ) => Effect.Effect<A, E | BudgetExhausted, R>;
  /** Twitch answered 429: refuse everything until the cooldown has passed. */
  readonly backOff: Effect.Effect<void>;
}

/**
 * The time a request asking at `now` may start: `gap` after the last start, and no more than
 * `max` starts in any `window` counting it. Windows are closed: a start exactly one window
 * before still counts, as Twitch's count may (its exact window is unknown), so the next turn is
 * a millisecond past it. `starts` are ascending and include turns already promised to requests
 * still waiting.
 */
export const turnAt = (
  limits: Limits,
  starts: ReadonlyArray<Millis>,
  now: Millis,
  cost = 1,
): Millis => {
  const last = starts.at(-1);
  let turn = last === undefined ? now : Math.max(now, last + limits.gap);
  // Counting this request's `cost` starts, the window ending at `turn` holds at most `max`, so
  // the (max - cost + 1)-th latest start must lie more than a full window before it.
  const bound = starts.length - (limits.max - cost) - 1;
  if (bound >= 0) turn = Math.max(turn, starts[bound]! + limits.window + 1);
  return turn;
};

export const makeBudget = (name: BudgetName, limits: Limits): Effect.Effect<Budget> =>
  Effect.gen(function* () {
    const slots = yield* Semaphore.make(limits.concurrency);
    // Start times (one per unit of cost) within the last window, and turns promised.
    let starts: Array<Millis> = [];
    let coolUntil = -Infinity;

    const refuse = (operation: string, detail: string, retryAt: Millis) =>
      Effect.fail(new BudgetExhausted({ budget: name, operation, detail, retryAt }));

    const run = <A, E, R>(
      operation: string,
      effect: Effect.Effect<A, E, R>,
      cost = 1,
    ): Effect.Effect<A, E | BudgetExhausted, R> =>
      Effect.gen(function* () {
        const asked = yield* Clock.currentTimeMillis;
        if (cost > limits.max) {
          const detail = `${cost} requests at once, more than ${limits.max} a window`;
          return yield* refuse(operation, detail, asked + limits.window);
        }
        if (asked < coolUntil) {
          return yield* refuse(operation, "Twitch answered 429, cooling down", coolUntil);
        }
        const slot = yield* slots.take(1).pipe(Effect.timeoutOption(limits.maxWait));
        if (Option.isNone(slot)) {
          const detail = `${limits.concurrency} requests in flight for ${limits.maxWait} ms`;
          return yield* refuse(operation, detail, asked + limits.maxWait);
        }
        return yield* Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          starts = starts.filter((t) => t >= now - limits.window);
          const turn = turnAt(limits, starts, now, cost);
          if (turn - asked > limits.maxWait) {
            const detail = `no turn within ${limits.maxWait} ms`;
            return yield* refuse(operation, detail, turn);
          }
          for (let i = 0; i < cost; i++) starts.push(turn);
          if (turn > now) yield* Effect.sleep(turn - now);
          // A 429 that came while this request waited stops it too.
          if (turn < coolUntil) {
            return yield* refuse(operation, "Twitch answered 429, cooling down", coolUntil);
          }
          return yield* effect;
        }).pipe(Effect.ensuring(slots.release(1)));
      });

    const backOff = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => {
        coolUntil = Math.max(coolUntil, now + limits.cooldown);
      }),
    );

    return { name, limits, run, backOff };
  });

/** A budget that limits nothing: for the simulator's planted-bug tests and wire tests only. */
export const UNLIMITED: Limits = {
  gap: 0,
  window: 1,
  max: Number.MAX_SAFE_INTEGER,
  concurrency: Number.MAX_SAFE_INTEGER,
  maxWait: 3_600_000,
  cooldown: 0,
};

/** One budget per class, shared by every reader and writer of one process. */
export class Budgets extends Context.Service<
  Budgets,
  { readonly gql: Budget; readonly cdn: Budget }
>()("miner/twitch/Budgets") {
  static readonly make = (limits?: { readonly gql?: Limits; readonly cdn?: Limits }) =>
    Effect.gen(function* () {
      const gql = yield* makeBudget("gql", limits?.gql ?? GQL_LIMITS);
      const cdn = yield* makeBudget("cdn", limits?.cdn ?? CDN_LIMITS);
      return Budgets.of({ gql, cdn });
    });

  static readonly layer = Layer.effect(Budgets, Budgets.make());
}
