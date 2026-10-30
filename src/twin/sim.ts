import fc from "fast-check";
import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Random, Ref } from "effect";
import { TestClock } from "effect/testing";
import { MINUTE, type Millis } from "../core/model.ts";
import { Event, type Command } from "../core/protocol.ts";
import { initial, nextDeadline, type State } from "../core/state.ts";
import { step } from "../core/step.ts";
import { Actuator } from "../twitch/Actuator.ts";
import type { Twitch } from "../twitch/Twitch.ts";
import { twinActuator } from "./actuator.ts";
import { canonical, decodeState, encodeState } from "./durable.ts";
import { emptyMemory, execute, type Memory } from "./execute.ts";
import { twinTwitch } from "./http.ts";
import { checkStep, initialChecker, violation, type InFlight } from "./invariants.ts";
import {
  SIM_EPOCH,
  scenarioArbitrary,
  type Capsule,
  type Scenario,
  type Violation,
} from "./scenario.ts";
import { drainActivity, drainFrames, emit, makeTwin, takeDue } from "./twin.ts";
import { buildWorld, channelFrames, closeSession, edges, faultWindows } from "./world.ts";

/** The decision functions under test. Injectable, so tests can plant bugs and watch them caught. */
export interface Core {
  readonly step: typeof step;
  readonly nextDeadline: typeof nextDeadline;
}

export const realCore: Core = { step, nextDeadline };

export interface RunOptions {
  readonly core?: Core;
  /** Caps the scenario's horizon, to keep test runs short. */
  readonly maxHorizonMinutes?: number;
}

export interface RunResult {
  readonly digest: string;
  readonly steps: number;
  readonly restarts: number;
  /** Minutes the twin credited, and claims it applied: zero for both means nothing was earned. */
  readonly creditedMinutes: number;
  readonly claimsApplied: number;
  readonly violation: Violation | undefined;
  /** The last trace lines. */
  readonly tail: ReadonlyArray<string>;
}

const TAIL = 200;
/** While a command runs, the loop looks again this often: retry sleeps are invisible from outside. */
const POLL: Millis = 1_000;

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
  return Effect.gen(function* () {
    yield* TestClock.setTime(SIM_EPOCH);
    const world0 = buildWorld(capped);
    const twin = makeTwin(world0);
    const services = yield* Layer.build(
      Layer.merge(twinTwitch(twin), Layer.succeed(Actuator, twinActuator(twin))),
    );
    const horizon = SIM_EPOCH + capped.horizonMinutes * MINUTE;
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
    let lastEdgeAt = SIM_EPOCH;
    let found: Violation | undefined;

    const enqueue = (at: Millis, event: Event) => {
      inbox.push({ at, seq: seq++, event });
      inbox.sort((a, b) => a.at - b.at || a.seq - b.seq);
    };

    const observe = (record: Parameters<typeof checkStep>[1]["step"]) => {
      const activity = drainActivity(twin);
      creditedMinutes += activity.credits.length;
      claimsApplied += activity.calls.filter((c) => c.kind === "claim" && c.applied).length;
      if (activity.requests.length + activity.calls.length + activity.credits.length > 0) {
        trace(now, "twin", activity);
      }
      const [next, violations] = checkStep(checker, {
        now,
        step: record,
        state,
        world: twin.world,
        activity,
        defects: defects.splice(0),
        inFlight: [...inFlight.values()],
        restart,
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
        const fiber = yield* execute(memory, command).pipe(
          Effect.provideContext(services as Context.Context<Twitch | Actuator>),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.flatMap(Clock.currentTimeMillis, (at) =>
              Effect.sync(() => {
                inFlight.delete(id);
                if (Exit.isSuccess(exit)) for (const event of exit.value) enqueue(at, event);
                else if (!Cause.hasInterruptsOnly(exit.cause)) {
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
      inbox = [];
      yield* Ref.set(memory, emptyMemory);
      // Twitch keeps the account; the process loses its watch, sockets and everything in transit.
      twin.world = { ...closeSession(twin.world), subscriptions: new Set() };
      twin.frames = [];
      twin.crashRequested = false;
      const resumed = saved === undefined ? initial(world0.settings) : decodeState(saved);
      restart = { saved, resumed };
      state = resumed;
      restarts++;
      trace(now, "crash", null);
      enqueue(now, Event.Started());
    });

    enqueue(now, Event.Started());
    while (found === undefined) {
      emit(twin, channelFrames(twin.world, lastEdgeAt, now));
      lastEdgeAt = now;
      for (const frame of drainFrames(twin)) enqueue(frame.at, frame.event);
      if (twin.crashRequested) {
        yield* crash;
        continue;
      }

      const head = inbox[0];
      const deadline = core.nextDeadline(state);
      const event =
        head !== undefined && head.at <= now
          ? inbox.shift()!.event
          : deadline !== undefined && deadline <= now
            ? Event.Tick()
            : undefined;

      if (event !== undefined) {
        const before = state;
        const result = core.step(state, event, now);
        steps++;
        trace(now, "step", { event, commands: result.commands, watch: result.state.watch });
        if (takeDue(beforePersist, now)) {
          yield* crash;
          continue;
        }
        state = result.state;
        saved = encodeState(state);
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
      if (found !== undefined || now >= horizon) break;
      const candidates = [
        horizon,
        ...(head === undefined ? [] : [head.at]),
        ...(deadline === undefined ? [] : [deadline]),
        ...(inFlight.size > 0 ? [now + POLL] : []),
        wakeups.find((t) => t > now) ?? horizon,
      ];
      const wake = Math.max(now + 1, Math.min(...candidates));
      yield* TestClock.adjust(wake - now);
      now = yield* Clock.currentTimeMillis;
    }
    yield* Fiber.interruptAll([...inFlight.values()].map((f) => f.fiber));
    return {
      digest: digest.hex(),
      steps,
      restarts,
      creditedMinutes,
      claimsApplied,
      violation: found,
      tail: [...digest.tail],
    };
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Random.withSeed(capped.latencySeed));
};

export type SeedResult =
  | {
      readonly _tag: "Passed";
      readonly seed: number;
      readonly digest: string;
      readonly creditedMinutes: number;
      readonly claimsApplied: number;
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
