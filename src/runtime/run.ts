import { Cause, Clock, Effect, FiberSet, Option, Queue, Ref, Schema } from "effect";
import type { Config } from "../config/schema.ts";
import type { Campaign, Channel } from "../core/model.ts";
import { Event, type Command } from "../core/protocol.ts";
import { initial, nextDeadline, type State } from "../core/state.ts";
import { step } from "../core/step.ts";
import { canonical } from "../store/codec.ts";
import { Store } from "../store/Store.ts";
import { emptyMemory, execute, type Memory } from "./execute.ts";
import { forwardFrames } from "./listen.ts";
import { describeWatch, discoveryExpired, progressLines } from "./narrate.ts";
import { toSettings, unresolvedGames } from "./settings.ts";
import { makeReporter } from "./status.ts";
import { observe, startFacts } from "../status/snapshot.ts";

/**
 * A deadline the core never moves would make the loop step forever at one instant (the sim's
 * `BusyWake`, plan 09 §4 s2). The sim catches it in tests; this stops a real run instead of
 * spinning a CPU against Twitch. 100 is far above what one instant legitimately holds.
 */
export const MAX_STEPS_AT_INSTANT = 100;

/** The core stepped `MAX_STEPS_AT_INSTANT` times without time moving: a core bug. */
export class RunStuck extends Schema.TaggedError<RunStuck, { readonly brand: unique symbol }>()(
  "RunStuck",
  { at: Schema.Finite, steps: Schema.Finite },
) {}

/** Counts steps at one instant: `[instant, count]` after a step at `now`. */
export const countAt = (
  [at, count]: readonly [number, number],
  now: number,
): readonly [number, number] => (now === at ? [at, count + 1] : [now, 1]);

/**
 * The runtime: one scheduler fiber that owns the state. It takes the next event, or a `Tick` when
 * `nextDeadline(state)` comes first, steps the core, saves the new state, and only then starts
 * the step's commands. Commands run on their own fibers and come back as events, PubSub frames
 * arrive as events too, so a slow read never delays the scheduler; the deadlines live in `State`, so there are no other timers
 * (critique 08 §6.1). The one other wake-up is the status heartbeat, which writes
 * `status.json` without stepping the core.
 */
export const run = (config: Config) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const events = yield* Queue.unbounded<Event>();
    yield* forwardFrames(events);
    const commands = yield* FiberSet.make<void>();
    const memory = yield* Ref.make<Memory>(emptyMemory);
    const settingsFor = (state: State, event: Event) =>
      toSettings(config, catalogOf(state, event), channelsOf(state, event));

    const loaded = yield* store.load;
    let state = Option.getOrElse(loaded, () => initial(toSettings(config, [], [])));
    let saved = durable(state);
    yield* Effect.logInfo(
      Option.isSome(loaded) ? "runtime: resumed from saved state" : "runtime: starting fresh",
    );
    yield* Queue.offer(events, Event.Started());
    let instant: readonly [number, number] = [-1, 0];
    let unresolved = new Set<string>();
    let facts = startFacts(yield* Clock.currentTimeMillis);
    const reporter = yield* makeReporter;
    yield* Effect.addFinalizer(() => Effect.suspend(() => reporter.stop(state, facts)));

    const start = (command: Command) =>
      FiberSet.run(
        commands,
        execute(memory, command).pipe(
          Effect.flatMap((out) => Queue.offerAll(events, out)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError(`runtime: ${command._tag} failed`, cause),
          ),
          Effect.asVoid,
        ),
      );

    while (true) {
      const event = yield* next(events, nextDeadline(state), reporter.due());
      const now = yield* Clock.currentTimeMillis;
      if (event === HEARTBEAT) {
        yield* reporter.update(state, facts, now);
        continue;
      }
      instant = countAt(instant, now);
      if (instant[1] > MAX_STEPS_AT_INSTANT) {
        return yield* new RunStuck({ at: now, steps: instant[1] });
      }
      const before = { ...state, settings: settingsFor(state, event) };
      const result = step(before, event, now);
      // Save when what a restart keeps has changed: a tick every 20 s would otherwise rewrite
      // the whole catalog each time.
      if (durableChanged(state, result.state)) {
        const key = durable(result.state);
        if (key !== saved) {
          yield* store.save(result.state);
          saved = key;
        }
      }
      yield* report(state, result.state);
      const expired = discoveryExpired(state, result.state, event, now);
      if (expired !== undefined) yield* Effect.logWarning(`runtime: ${expired}`);
      if (event._tag === "CatalogRead") {
        const notes = unresolvedGames(config, event.campaigns);
        for (const note of notes) {
          if (!unresolved.has(note)) yield* Effect.logWarning(`config: ${note}`);
        }
        unresolved = new Set(notes);
      }
      facts = observe(facts, state, result.state, event, now);
      state = result.state;
      yield* reporter.update(state, facts, now);
      for (const command of result.commands) yield* start(command);
    }
  }).pipe(Effect.scoped);

const HEARTBEAT = "heartbeat";

/**
 * The next event, a `Tick` once the core's deadline passes, or `HEARTBEAT` once the status is due
 * first. Queued events go first.
 */
const next = (
  events: Queue.Queue<Event>,
  deadline: number | undefined,
  statusDue: number,
): Effect.Effect<Event | typeof HEARTBEAT> =>
  Effect.gen(function* () {
    const queued = yield* Queue.poll(events);
    if (Option.isSome(queued)) return queued.value;
    const wake = Math.min(deadline ?? Infinity, statusDue);
    const wait = wake - (yield* Clock.currentTimeMillis);
    if (wait > 0) {
      const taken = yield* Queue.take(events).pipe(Effect.timeoutOption(wait));
      if (Option.isSome(taken)) return taken.value;
    }
    const now = yield* Clock.currentTimeMillis;
    return deadline !== undefined && now >= deadline ? Event.Tick() : HEARTBEAT;
  });

const catalogOf = (state: State, event: Event): ReadonlyArray<Campaign> =>
  event._tag === "CatalogRead" ? event.campaigns : (state.catalog ?? []);

const channelsOf = (state: State, event: Event): Iterable<Channel> =>
  event._tag === "ChannelsRead"
    ? [...state.channels.values(), ...event.channels]
    : state.channels.values();

/**
 * The fields a restart keeps. `Started` and the `TokenValid` after it reset the rest, deadlines
 * included, and settings are mapped from the config again on every step.
 */
const durable = (state: State): string =>
  canonical([state.catalog, state.catalogStatus, state.progress, state.claims]);

/** The core replaces a field only when it changes it, so most steps skip `durable`. */
const durableChanged = (before: State, after: State): boolean =>
  before.catalog !== after.catalog ||
  before.catalogStatus !== after.catalogStatus ||
  before.progress !== after.progress ||
  before.claims !== after.claims;

const report = (before: State, after: State) =>
  Effect.gen(function* () {
    const a = describeWatch(before, before.watch);
    const b = describeWatch(after, after.watch);
    if (a !== b) yield* Effect.logInfo(`runtime: ${b}`);
    for (const line of progressLines(before, after)) yield* Effect.logInfo(line);
  });
