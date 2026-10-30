import { Cause, Clock, Effect, FiberSet, Option, Queue, Ref, Schema } from "effect";
import type { Config } from "../config/schema.ts";
import type { Campaign, Channel } from "../core/model.ts";
import { Event, type Command } from "../core/protocol.ts";
import { initial, nextDeadline, type State, type Watch } from "../core/state.ts";
import { step } from "../core/step.ts";
import { canonical } from "../store/codec.ts";
import { Store } from "../store/Store.ts";
import { emptyMemory, execute, type Memory } from "./execute.ts";
import { forwardFrames } from "./listen.ts";
import { toSettings } from "./settings.ts";

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
 * (critique 08 §6.1).
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
      const event = yield* next(events, nextDeadline(state));
      const now = yield* Clock.currentTimeMillis;
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
      yield* report(state.watch, result.state.watch);
      state = result.state;
      for (const command of result.commands) yield* start(command);
    }
  }).pipe(Effect.scoped);

/** The next event, or a `Tick` once the deadline passes. Queued events go first. */
const next = (events: Queue.Queue<Event>, deadline: number | undefined) =>
  Effect.gen(function* () {
    const queued = yield* Queue.poll(events);
    if (Option.isSome(queued)) return queued.value;
    if (deadline === undefined) return yield* Queue.take(events);
    const wait = deadline - (yield* Clock.currentTimeMillis);
    if (wait <= 0) return Event.Tick();
    const taken = yield* Queue.take(events).pipe(Effect.timeoutOption(wait));
    return Option.getOrElse(taken, () => Event.Tick());
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

const describeWatch = (watch: Watch): string =>
  watch._tag === "Idle"
    ? `idle (${watch.reason})`
    : `watching ${watch.channelId} for drop ${watch.dropId} of campaign ${watch.campaignId}`;

const report = (before: Watch, after: Watch) => {
  const a = describeWatch(before);
  const b = describeWatch(after);
  return a === b ? Effect.void : Effect.logInfo(`runtime: ${b}`);
};
