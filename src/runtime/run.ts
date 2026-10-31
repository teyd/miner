import { Cause, Clock, Effect, FiberSet, Option, Queue, Ref, Schema } from "effect";
import type { Config } from "../config/schema.ts";
import type { Campaign, Channel, Millis } from "../core/model.ts";
import { Event, coalesceThrottled, type Command } from "../core/protocol.ts";
import { initial, nextDeadline, type State } from "../core/state.ts";
import { step } from "../core/step.ts";
import { canonical } from "../store/codec.ts";
import { Store } from "../store/Store.ts";
import { emptyMemory, execute, type Memory } from "./execute.ts";
import { forwardFrames } from "./listen.ts";
import {
  avoidLines,
  describeWatch,
  discoveryExpired,
  progressLines,
  receivedLines,
} from "./narrate.ts";
import { toSettings, unresolvedGames } from "./settings.ts";
import { RELOAD_EVERY, type ConfigWatch } from "./reload.ts";
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
 * arrive as events too, so a slow read never delays the scheduler; the deadlines live in `State`, so there are no other timers besides the status heartbeat and the 10 s config poll
 * (critique 08 §6.1). The one other wake-up is the status heartbeat, which writes
 * `status.json` without stepping the core.
 *
 * Given a `ConfigWatch` (`reload.ts`) rather than a fixed config, a fiber polls the file every
 * `reloadEvery` and a valid change reaches the loop as a `SettingsChanged` event: settings are
 * mapped from the current config before every step, so that step and every one after it plan
 * with the new goals.
 */
export const run = (source: Config | ConfigWatch, reloadEvery: Millis = RELOAD_EVERY) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const events = yield* Queue.unbounded<Event | typeof RELOADED>();
    yield* forwardFrames(events);
    const commands = yield* FiberSet.make<void>();
    const memory = yield* Ref.make<Memory>(emptyMemory);
    const configured: Pick<ConfigWatch, "config" | "facts"> =
      "poll" in source
        ? yield* reloading(source, reloadEvery, events)
        : { config: () => source, facts: () => startFacts(0).config };
    const settingsFor = (state: State, event: Event) =>
      toSettings(configured.config(), catalogOf(state, event), channelsOf(state, event));

    const loaded = yield* store.load;
    let state = Option.getOrElse(loaded, () => initial(toSettings(configured.config(), [], [])));
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
          Effect.tap((out) => Effect.forEach(out, logThrottled)),
          Effect.flatMap((out) => Queue.offerAll(events, out)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.andThen(
                  Effect.logError(`runtime: ${command._tag} failed`, cause),
                  // A claim that died may still have reached Twitch: report it unknown, so the
                  // next inventory read settles it, instead of leaving it "sent" forever.
                  command._tag === "Claim"
                    ? Queue.offer(
                        events,
                        Event.ClaimResult({
                          campaignId: command.campaignId,
                          dropId: command.dropId,
                          outcome: "unknown",
                        }),
                      )
                    : Effect.void,
                ),
          ),
          Effect.asVoid,
        ),
      );

    while (true) {
      const taken = yield* next(events, nextDeadline(state), reporter.due());
      const now = yield* Clock.currentTimeMillis;
      facts = { ...facts, config: configured.facts() };
      // The settings of the last step were mapped from the config before the reload.
      const event =
        taken === RELOADED ? Event.SettingsChanged({ previous: state.settings }) : taken;
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
      yield* report(state, result.state, now);
      const expired = discoveryExpired(state, result.state, event, now);
      if (expired !== undefined) yield* Effect.logWarning(`runtime: ${expired}`);
      if (event._tag === "CatalogRead" || event._tag === "SettingsChanged") {
        const notes = unresolvedGames(configured.config(), catalogOf(state, event));
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
/** The config watch applied a change; the loop makes it a `SettingsChanged`. */
const RELOADED = "reloaded";

/** Polls `watch` for the run's scope; each applied change is a `SettingsChanged` event. */
const reloading = (watch: ConfigWatch, every: Millis, events: Queue.Enqueue<typeof RELOADED>) =>
  Effect.gen(function* () {
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(every).pipe(
          Effect.andThen(watch.poll),
          Effect.flatMap((changed) => (changed ? Queue.offer(events, RELOADED) : Effect.void)),
        ),
      ),
    );
    return watch;
  });

/** A command a request budget refused: what, which budget, and for how long. */
const logThrottled = (event: Event) =>
  event._tag === "Throttled"
    ? Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.forEach(event.refusals, (r) =>
          Effect.logWarning(
            `runtime: ${r.command._tag} not sent, the ${r.budget} request budget has room again in ${Math.ceil((r.retryAt - now) / 1000)} s`,
          ),
        ),
      )
    : Effect.void;

/**
 * The next event, a `Tick` once the core's deadline passes, or `HEARTBEAT` once the status is due
 * first. Queued events go first.
 */
const next = (
  events: Queue.Queue<Event | typeof RELOADED>,
  deadline: number | undefined,
  statusDue: number,
): Effect.Effect<Event | typeof RELOADED | typeof HEARTBEAT> =>
  Effect.gen(function* () {
    const queued = yield* Queue.poll(events);
    if (Option.isSome(queued)) return yield* coalesce(events, queued.value);
    const wake = Math.min(deadline ?? Infinity, statusDue);
    const wait = wake - (yield* Clock.currentTimeMillis);
    if (wait > 0) {
      const taken = yield* Queue.take(events).pipe(Effect.timeoutOption(wait));
      if (Option.isSome(taken)) return yield* coalesce(events, taken.value);
    }
    const now = yield* Clock.currentTimeMillis;
    return deadline !== undefined && now >= deadline ? Event.Tick() : HEARTBEAT;
  });

/**
 * A `Throttled` and the `Throttled` events queued right behind it, as one event: a budget in
 * cooldown refuses a whole discovery burst at once, and one step each would count against
 * `MAX_STEPS_AT_INSTANT`.
 */
export const coalesce = <A extends Event | typeof RELOADED>(
  events: Queue.Queue<A>,
  first: A,
): Effect.Effect<A | Event> =>
  Effect.gen(function* () {
    if (!isThrottled(first)) return first;
    const run: Array<Event> = [first];
    while ((yield* Queue.size(events)) > 0 && isThrottled(yield* Queue.peek(events))) {
      run.push((yield* Queue.take(events)) as Event);
    }
    return run.length === 1 ? first : coalesceThrottled(run);
  });

const isThrottled = (e: Event | typeof RELOADED): e is Extract<Event, { _tag: "Throttled" }> =>
  e !== RELOADED && e._tag === "Throttled";

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
  canonical([
    state.catalog,
    state.catalogStatus,
    state.progress,
    state.awarded,
    state.inventoried,
    state.claims,
  ]);

/** The core replaces a field only when it changes it, so most steps skip `durable`. */
const durableChanged = (before: State, after: State): boolean =>
  before.catalog !== after.catalog ||
  before.catalogStatus !== after.catalogStatus ||
  before.progress !== after.progress ||
  before.awarded !== after.awarded ||
  before.inventoried !== after.inventoried ||
  before.claims !== after.claims;

const report = (before: State, after: State, now: Millis) =>
  Effect.gen(function* () {
    const a = describeWatch(before, before.watch);
    const b = describeWatch(after, after.watch);
    if (a !== b) yield* Effect.logInfo(`runtime: ${b}`);
    for (const line of progressLines(before, after)) yield* Effect.logInfo(line);
    if (durableChanged(before, after)) {
      for (const line of receivedLines(before, after)) yield* Effect.logInfo(`runtime: ${line}`);
    }
    for (const line of avoidLines(before, after, now)) yield* Effect.logWarning(`runtime: ${line}`);
  });
