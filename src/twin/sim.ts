import fc from "fast-check";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Random,
  Ref,
  References,
  Scope,
  Stream,
} from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { MINUTE, type Millis } from "../core/model.ts";
import { Event, coalesceThrottled, type Command } from "../core/protocol.ts";
import { initial, nextDeadline, type State } from "../core/state.ts";
import { step } from "../core/step.ts";
import type { Actuator } from "../twitch/Actuator.ts";
import { Budgets, GQL_LIMITS, type Limits } from "../twitch/budget.ts";
import { PubSub } from "../twitch/PubSub.ts";
import type { Twitch } from "../twitch/Twitch.ts";
import { canonical, decodeState, encodeState } from "../store/codec.ts";
import { emptyMemory, execute, type Memory } from "../runtime/execute.ts";
import { nextEdgeAt, runEdge, scheduleFaults, sendFrames } from "./edge.ts";
import { checkStep, initialChecker, violation, type InFlight } from "./invariants.ts";
import { twinProcess, type Plant } from "./process.ts";
import {
  SIM_EPOCH,
  scenarioArbitrary,
  type Capsule,
  type Scenario,
  type Violation,
} from "./scenario.ts";
import {
  Issued,
  bindClock,
  drainActivity,
  makeTwin,
  takeDue,
  type Activity,
  type TickView,
} from "./twin.ts";
import { buildWorld, channelFrames, edges, faultWindows, type World } from "./world.ts";

/** The decision functions under test. Injectable, so tests can plant bugs and watch them caught. */
export interface Core {
  readonly step: typeof step;
  readonly nextDeadline: typeof nextDeadline;
}

export const realCore: Core = { step, nextDeadline };

export interface RunOptions {
  readonly core?: Core;
  /** Replaces part of the miner's wiring, to plant a bug the twin must catch. */
  readonly plant?: Plant;
  /** Caps the scenario's horizon, to keep test runs short. */
  readonly maxHorizonMinutes?: number;
  /** The miner's request budgets; the real ones by default. Tests plant `UNLIMITED`. */
  readonly limits?: { readonly gql?: Limits; readonly cdn?: Limits };
  /**
   * Runs between steps once virtual time reaches each multiple of `everyMinutes`, with the minutes
   * since the start: `heap.ts` samples memory there. It must not touch the run.
   */
  readonly probe?: {
    readonly everyMinutes: number;
    readonly run: (minute: number) => Effect.Effect<void>;
  };
}

export interface RunResult {
  readonly digest: string;
  readonly steps: number;
  readonly restarts: number;
  /** Minutes the twin credited, and claims it applied: zero for both means nothing was earned. */
  readonly creditedMinutes: number;
  readonly claimsApplied: number;
  /** The commands a request budget refused at least once. */
  readonly refused: ReadonlyArray<Command["_tag"]>;
  /** What crossed the wire: requests by operation, sockets opened, frames delivered, beats. */
  readonly wire: Readonly<Record<string, number>>;
  readonly violation: Violation | undefined;
  /** The last trace lines. */
  readonly tail: ReadonlyArray<string>;
  /** The twin's world at the end. */
  readonly world: World;
}

const TAIL = 200;
/** While a command runs, the loop looks again this often: retry sleeps are invisible from outside. */
const POLL: Millis = 1_000;

/**
 * Scheduler turns the loop yields before it moves virtual time. A frame the edge delivers inside
 * a `send` reaches the client over several hops (the socket's reader, then a queue's wake-up task
 * on the dispatcher of the fiber that made the queue), and `TestClock` waits only for tasks a
 * woken sleep scheduled. Without these turns, one `adjust` passed a PubSub answer still on its
 * way and the client's 10 s answer timeout fired in virtual time (seed 6, B1 review).
 */
const SETTLE_TURNS = 8;
const settle = Effect.gen(function* () {
  for (let i = 0; i < SETTLE_TURNS; i++) yield* Effect.yieldNow;
});

/**
 * Real time `TestClock` waits for the fibers a sleep woke before it stops waiting and moves on.
 * Its default, 1 s, tripped under CPU load (two sweeps at once): seeds 140001-141000 claimed in
 * 878 worlds instead of 863. A wake settles in milliseconds; past this, something is spinning.
 * `TestClock` then logs a warning and moves on, which would make the seed's result depend on the
 * machine's speed, and a fiber that spins on every wake would cost a minute each: the logger
 * records it as an error (`PATIENCE`) and the run stops on it as a defect, so a pathological seed
 * fails within a minute of real time instead of hanging or passing by luck.
 */
const WAKE_PATIENCE = "1 minute";
const PATIENCE = "TestClock ran out of patience";

/** 64-bit FNV-1a as two 32-bit lanes with different offsets: pure and fast. */
class Digest {
  private a = 0x811c9dc5;
  private b = 0x050c5d1f;
  readonly tail: Array<string> = [];

  add(line: string): void {
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      this.a = Math.imul(this.a ^ code, 0x01000193);
      this.b = Math.imul(this.b ^ code, 0x01000193);
    }
    this.a = Math.imul(this.a ^ 10, 0x01000193);
    this.b = Math.imul(this.b ^ 10, 0x01000193);
    this.tail.push(line);
    if (this.tail.length > TAIL) this.tail.shift();
  }

  hex(): string {
    const lane = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
    return lane(this.a) + lane(this.b);
  }
}

const capHorizon = (scenario: Scenario, options: RunOptions | undefined): Scenario =>
  options?.maxHorizonMinutes === undefined || scenario.horizonMinutes <= options.maxHorizonMinutes
    ? scenario
    : { ...scenario, horizonMinutes: options.maxHorizonMinutes };

/** The event a `WatchTick` should have reported, by what the twin answered it. */
const expectedTick = (view: TickView): string => {
  if (view.label === "ok") return view.beat ? "WatchTicked" : "network";
  if (view.label === "auth") return "AuthFailed";
  return view.label ?? "network";
};

const reportedTick = (events: ReadonlyArray<Event>): string => {
  const e = events[0];
  if (e === undefined) return "nothing";
  if (e._tag === "WatchFailed") return e.reason;
  return e._tag;
};

/**
 * The twin's activity for the trace, as plain JSON of its values in a fixed order: a beat alone
 * is 17 requests, and `canonical` on them was a fifth of a run.
 */
const compact = (a: Activity): string =>
  JSON.stringify([
    a.requests.map((r) => [r.operation, r.status, r.at - SIM_EPOCH, r.endedAt - r.at]),
    a.calls.map((c) => Object.values(c)),
    a.credits.map((c) => [
      c.at - SIM_EPOCH,
      c.channelId,
      c.campaignId,
      c.dropIds,
      c.sentAt ?? null,
    ]),
    a.delivered.map((d) => [d.at - SIM_EPOCH, d.channelId]),
    a.orphans,
    a.leaks,
    a.wrongTokens,
    a.identity,
    a.reconnects.map((r) => Object.values(r)),
    a.budget,
    a.closes.map((c) => [c.at - SIM_EPOCH, c.socket, c.excused, c.remaining]),
    a.misreads,
  ]);

/**
 * The miner's error logs, kept for the trace: a defect in a background fiber logs one. Of the
 * warnings only `TestClock`'s busy warning is kept, raised to an error (`WAKE_PATIENCE`).
 */
const errorLogger = (into: Array<string>, pubsub: { accountUnknown: boolean }) =>
  Logger.make((options) => {
    const message = String(
      Array.isArray(options.message) ? options.message.join(" ") : options.message,
    );
    if (options.logLevel === "Error" || options.logLevel === "Fatal") into.push(message);
    else if (message.startsWith("A fiber woken by the test clock")) {
      into.push(`${PATIENCE} (${WAKE_PATIENCE}): ${message}`);
    } else if (message.startsWith(ACCOUNT_UNKNOWN)) pubsub.accountUnknown = true;
  });

/**
 * PubSub's warning when it subscribed without the account id (`resolveUser` in `PubSub.ts`): its
 * validation failed, or a request budget refused it, and the account's drops wait for the next
 * change of channels. The miner's own documented limit; `NotListening` excuses that topic only.
 */
const ACCOUNT_UNKNOWN = "pubsub: the account id is unknown";

interface Queued {
  readonly at: Millis;
  readonly seq: number;
  readonly event: Event;
}

/**
 * Runs one scenario under its own `TestClock` and seeded `Random`: step, persist, check, execute,
 * then move virtual time to the next wake-up. Stops at the first violation or the horizon.
 */
export const runScenario = (scenario: Scenario, options?: RunOptions): Effect.Effect<RunResult> => {
  const core = options?.core ?? realCore;
  const capped = capHorizon(scenario, options);
  const errors: Array<string> = [];
  /** Set when the last `Subscribe` went out without the account id (`ACCOUNT_UNKNOWN`). */
  const pubsub = { accountUnknown: false };
  return Effect.gen(function* () {
    yield* TestClock.setTime(SIM_EPOCH);
    const world0 = buildWorld(capped);
    const twin = makeTwin(world0);
    yield* bindClock(twin);
    // One set of budgets for the run, as one IP has: a restart keeps them, as Twitch's per-IP
    // count would. Each process of the miner charges them in its own code (`twinProcess`).
    const maxWait = capped.gqlMaxWait;
    const budgets = yield* Budgets.make({
      ...(maxWait === undefined ? {} : { gql: { ...GQL_LIMITS, maxWait } }),
      ...options?.limits,
    });
    const horizon = SIM_EPOCH + capped.horizonMinutes * MINUTE;
    // Twitch's own schedule: channel frames and socket faults, sent whatever the miner does.
    scheduleFaults(twin);
    sendFrames(twin, channelFrames(world0, SIM_EPOCH, horizon));
    yield* Effect.forkScoped(runEdge(twin));
    const memory = yield* Ref.make<Memory>(emptyMemory);
    const digest = new Digest();
    const trace = (at: Millis, kind: string, data: unknown) =>
      digest.add(canonical({ at: at - SIM_EPOCH, kind, data }));

    const wakeups = [
      ...edges(world0),
      ...faultWindows(world0).flatMap((w) => [w.from, w.to]),
      ...capped.faults.map((f) => SIM_EPOCH + f.atMinute * MINUTE),
    ]
      .filter((t) => t > SIM_EPOCH)
      .toSorted((a, b) => a - b);
    const crashes = (point: string) =>
      capped.faults
        .flatMap((f) =>
          f.kind === "crash" && f.point === point ? [SIM_EPOCH + f.atMinute * MINUTE] : [],
        )
        .toSorted((a, b) => a - b);
    const beforePersist = crashes("before-persist");
    const afterPersist = crashes("after-persist");

    let now: Millis = SIM_EPOCH;
    const probe = options?.probe;
    let nextProbe: Millis = SIM_EPOCH + (probe?.everyMinutes ?? 0) * MINUTE;
    let state: State = initial(world0.settings);
    let saved: string | undefined;
    let inbox: Array<Queued> = [];
    let seq = 0;
    const inFlight = new Map<number, InFlight & { readonly fiber: Fiber.Fiber<void> }>();
    let nextId = 0;
    const defects: Array<string> = [];
    let checker = initialChecker;
    let restart: { readonly saved: string | undefined; readonly resumed: State } | undefined;
    let steps = 0;
    let restarts = 0;
    let creditedMinutes = 0;
    let claimsApplied = 0;
    let found: Violation | undefined;
    const refused = new Set<Command["_tag"]>();
    const wire: Record<string, number> = {};
    const count = (key: string, n = 1) => {
      wire[key] = (wire[key] ?? 0) + n;
    };

    const enqueue = (at: Millis, event: Event) => {
      inbox.push({ at, seq: seq++, event });
      inbox.sort((a, b) => a.at - b.at || a.seq - b.seq);
    };

    /** The inbox's head, with the `Throttled` events right behind it merged in, as the runtime does. */
    const takeEvent = (): Event => {
      const first = inbox.shift()!.event;
      if (first._tag !== "Throttled") return first;
      const run: Array<Event> = [first];
      while (inbox[0] !== undefined && inbox[0].at <= now && inbox[0].event._tag === "Throttled") {
        run.push(inbox.shift()!.event);
      }
      return run.length === 1 ? first : coalesceThrottled(run);
    };

    /** One process of the miner: its services live in their own scope, which a crash closes. */
    const boot = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        twinProcess(twin, budgets, options?.plant),
        scope,
      );
      const pubsub = Context.get(context, PubSub);
      yield* Stream.runForEach(pubsub.events, (event) =>
        Effect.flatMap(Clock.currentTimeMillis, (at) =>
          Effect.sync(() => {
            count(`heard ${event._tag}`);
            enqueue(at, event);
          }),
        ),
      ).pipe(Effect.forkIn(scope));
      return { scope, context: context as Context.Context<Twitch | Actuator | PubSub> };
    });
    let process = yield* boot;

    const observe = (record: Parameters<typeof checkStep>[1]["step"]) => {
      const activity = drainActivity(twin);
      creditedMinutes += activity.credits.length;
      claimsApplied += activity.calls.filter((c) => c.kind === "claim" && c.applied).length;
      for (const r of activity.requests) count(r.operation);
      for (const c of activity.calls) {
        if (c.kind === "tick") count("beats");
        if (c.kind === "pubsub" && c.frame === "connect") count("sockets");
        if (c.kind === "pubsub" && c.frame === "LISTEN") count("listens");
      }
      count("delivered", activity.delivered.length);
      const open = [...twin.edge.sockets.values()];
      wire["peak sockets"] = Math.max(wire["peak sockets"] ?? 0, open.length);
      wire["peak topics"] = Math.max(
        wire["peak topics"] ?? 0,
        open.reduce((n, ws) => n + ws.topics.size, 0),
      );
      if (
        activity.requests.length +
          activity.calls.length +
          activity.credits.length +
          activity.delivered.length >
        0
      ) {
        digest.add(`${now - SIM_EPOCH} twin ${compact(activity)}`);
      }
      if (errors.length > 0) trace(now, "errors", errors.splice(0));
      const [next, violations] = checkStep(checker, {
        now,
        step: record,
        state,
        world: twin.world,
        activity,
        defects: defects.splice(0),
        inFlight: [...inFlight.values()],
        restart,
        listening: new Set([...twin.edge.sockets.values()].flatMap((ws) => [...ws.topics])),
        accountUnknown: pubsub.accountUnknown,
      });
      checker = next;
      restart = undefined;
      if (violations.length > 0 && found === undefined) {
        found = violations[0];
        trace(now, "violation", violations);
      }
    };

    const run = (command: Command) =>
      Effect.gen(function* () {
        const id = nextId++;
        twin.live.add(id);
        if (command._tag === "Subscribe") pubsub.accountUnknown = false;
        const view: TickView | undefined =
          command._tag === "WatchTick" ? { label: undefined, beat: false } : undefined;
        if (view !== undefined) twin.ticks.set(id, view);
        const fiber = yield* execute(memory, command).pipe(
          Effect.provideContext(process.context),
          Effect.provideService(Issued, { id, command, at: now }),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.flatMap(Clock.currentTimeMillis, (at) =>
              Effect.sync(() => {
                inFlight.delete(id);
                twin.live.delete(id);
                twin.ticks.delete(id);
                if (Exit.isSuccess(exit)) {
                  for (const event of exit.value) enqueue(at, event);
                  const reported = reportedTick(exit.value);
                  // A budget that refused a request of the tick stopped it unsent: that tick
                  // credited nothing, whatever the requests before it were answered.
                  const refused = reported === "Throttled" && view?.beat === false;
                  if (view !== undefined && !refused && expectedTick(view) !== reported) {
                    twin.activity.misreads.push(
                      `the twin answered ${view.label ?? "nothing"}${view.beat ? " after a whole beat" : ""}, ` +
                        `the tick reported ${reported}`,
                    );
                  }
                } else if (!Cause.hasInterruptsOnly(exit.cause)) {
                  defects.push(`${command._tag}: ${Cause.pretty(exit.cause)}`);
                }
              }),
            ),
          ),
          Effect.forkChild,
        );
        if (fiber.pollUnsafe() === undefined) inFlight.set(id, { command, since: now, fiber });
      });

    const crash = Effect.gen(function* () {
      yield* Fiber.interruptAll([...inFlight.values()].map((f) => f.fiber));
      inFlight.clear();
      twin.live.clear();
      twin.ticks.clear();
      inbox = [];
      yield* Ref.set(memory, emptyMemory);
      // The process loses its watch, its sockets and everything in transit; Twitch keeps the
      // account, and the view it counted ends on its own once the beats stop.
      twin.edge.stopping = true;
      yield* Scope.close(process.scope, Exit.void);
      twin.edge.stopping = false;
      twin.edge.stops++;
      twin.crashRequested = false;
      const resumed = saved === undefined ? initial(world0.settings) : decodeState(saved);
      restart = { saved, resumed };
      state = resumed;
      restarts++;
      trace(now, "crash", null);
      process = yield* boot;
      enqueue(now, Event.Started());
    });

    enqueue(now, Event.Started());
    while (found === undefined) {
      // A `gql-cooldown` the twin began (`startCooldown`): before the step its answer brings.
      while (twin.backOffs[0] !== undefined && twin.backOffs[0] <= now) {
        twin.backOffs.shift();
        yield* budgets.gql.backOff;
      }
      for (const error of errors) {
        if (error.includes("stopped by a defect") || error.startsWith(PATIENCE)) {
          defects.push(error);
        }
      }
      if (twin.crashRequested) {
        yield* crash;
        continue;
      }

      const head = inbox[0];
      const deadline = core.nextDeadline(state);
      const event =
        head !== undefined && head.at <= now
          ? takeEvent()
          : deadline !== undefined && deadline <= now
            ? Event.Tick()
            : undefined;

      if (event !== undefined) {
        const before = state;
        const result = core.step(state, event, now);
        steps++;
        if (event._tag === "Throttled") for (const r of event.refusals) refused.add(r.command._tag);
        count(`step ${event._tag}`);
        trace(now, "step", { event, commands: result.commands, watch: result.state.watch });
        if (takeDue(beforePersist, now)) {
          yield* crash;
          continue;
        }
        // A step that changed nothing returns the same state: its save is the last one.
        if (result.state !== state || saved === undefined) saved = encodeState(result.state);
        state = result.state;
        observe({ event, before, after: state, commands: result.commands, persisted: saved });
        if (found !== undefined) break;
        if (takeDue(afterPersist, now)) {
          yield* crash;
          continue;
        }
        for (const command of result.commands) yield* run(command);
        // Let the forked commands start, so instant ones land before the next step.
        yield* Effect.yieldNow;
        continue;
      }

      observe(undefined);
      if (probe !== undefined && now >= nextProbe) {
        yield* probe.run(Math.floor((now - SIM_EPOCH) / MINUTE));
        while (nextProbe <= now) nextProbe += probe.everyMinutes * MINUTE;
      }
      if (found !== undefined || now >= horizon) break;
      const edgeAt = nextEdgeAt(twin);
      const candidates = [
        horizon,
        ...(head === undefined ? [] : [head.at]),
        ...(deadline === undefined ? [] : [deadline]),
        ...(edgeAt === undefined ? [] : [edgeAt]),
        ...(inFlight.size > 0 ? [now + POLL] : []),
        ...twin.backOffs.slice(0, 1),
        wakeups.find((t) => t > now) ?? horizon,
      ];
      const wake = Math.max(now + 1, Math.min(...candidates));
      yield* settle;
      yield* TestClock.adjust(wake - now);
      now = yield* Clock.currentTimeMillis;
    }
    yield* Fiber.interruptAll([...inFlight.values()].map((f) => f.fiber));
    twin.edge.stopping = true;
    yield* Scope.close(process.scope, Exit.void);
    return {
      digest: digest.hex(),
      steps,
      restarts,
      creditedMinutes,
      claimsApplied,
      refused: [...refused].toSorted(),
      wire,
      violation: found,
      tail: [...digest.tail],
      world: twin.world,
    };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        TestClock.layer({ warningDelay: WAKE_PATIENCE }),
        Logger.layer([errorLogger(errors, pubsub)]),
      ),
    ),
    // Warnings reach the logger only for `TestClock`'s, which it raises to an error.
    Effect.provideService(References.MinimumLogLevel, "Warn"),
    // No spans: tens of thousands of CDN requests a run, and nothing reads them.
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Random.withSeed(capped.latencySeed),
  );
};

export type SeedResult =
  | {
      readonly _tag: "Passed";
      readonly seed: number;
      readonly digest: string;
      readonly creditedMinutes: number;
      readonly claimsApplied: number;
      readonly refused: ReadonlyArray<Command["_tag"]>;
    }
  | {
      readonly _tag: "Failed";
      readonly capsule: Capsule;
      /** The scenario as first generated, before shrinking. */
      readonly initial: Scenario;
    };

export interface SeedOptions extends RunOptions {
  /** Shrink attempts before the smallest failure so far is kept. */
  readonly maxShrinks?: number;
}

/** Runs a scenario twice; a violation in either run, or two different digests, is a failure. */
export const runTwice = (scenario: Scenario, options?: RunOptions) =>
  Effect.gen(function* () {
    const first = yield* runScenario(scenario, options);
    if (first.violation !== undefined) return first;
    const second = yield* runScenario(scenario, options);
    if (second.violation !== undefined) return second;
    if (first.digest !== second.digest) {
      const detail = `digests ${first.digest} and ${second.digest}`;
      return { ...first, violation: violation("Nondeterministic", SIM_EPOCH, detail) };
    }
    return first;
  });

/**
 * fast-check generates one scenario from the seed and runs it twice. On a failure it shrinks the
 * scenario, keeping only candidates that fail with the same kind of violation, and the capsule
 * holds the smallest one. fast-check has no shrink cap: after `maxShrinks` attempts every
 * candidate passes, which ends shrinking with the smallest failure so far.
 */
export const runProperty = (
  arbitrary: fc.Arbitrary<Scenario>,
  seed: number,
  options?: SeedOptions,
): Effect.Effect<SeedResult> =>
  Effect.gen(function* () {
    const maxShrinks = options?.maxShrinks ?? 100;
    let calls = 0;
    let first: { readonly scenario: Scenario; readonly result: RunResult } | undefined;
    const runPromise = Effect.runPromiseWith(yield* Effect.context());
    const property = fc.asyncProperty(arbitrary, async (scenario) => {
      calls++;
      if (calls > maxShrinks + 1) return true;
      const result = await runPromise(runTwice(scenario, options));
      first ??= { scenario, result };
      return (
        result.violation === undefined || result.violation.kind !== first.result.violation?.kind
      );
    });
    const details = yield* Effect.promise(() => fc.check(property, { seed, numRuns: 1 }));
    if (!details.failed || details.counterexample === null || first === undefined) {
      return {
        _tag: "Passed",
        seed,
        digest: first?.result.digest ?? "",
        creditedMinutes: first?.result.creditedMinutes ?? 0,
        claimsApplied: first?.result.claimsApplied ?? 0,
        refused: first?.result.refused ?? [],
      } as const;
    }
    const shrunk = capHorizon(details.counterexample[0], options);
    const capsule = yield* capsuleOf(seed, shrunk, options);
    return { _tag: "Failed", capsule, initial: first.scenario } as const;
  });

export const runSeed = (seed: number, options?: SeedOptions): Effect.Effect<SeedResult> =>
  runProperty(scenarioArbitrary, seed, options);

const capsuleOf = (seed: number | null, scenario: Scenario, options?: RunOptions) =>
  Effect.map(runTwice(scenario, options), (result): Capsule => ({
    seed,
    scenario,
    violation: result.violation ?? violation("Flaky", SIM_EPOCH, "the shrunk scenario passed"),
    digest: result.digest,
    tail: result.tail,
  }));

export const runSeeds = (
  first: number,
  count: number,
  options?: SeedOptions,
): Effect.Effect<ReadonlyArray<SeedResult>> =>
  Effect.forEach(
    Array.from({ length: count }, (_, i) => first + i),
    (seed) => runSeed(seed, options),
  );
