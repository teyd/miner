import { Effect, Layer, Queue, Stream } from "effect";
import type { Event } from "../core/protocol.ts";
import { Actuator } from "../twitch/Actuator.ts";
import { PubSub } from "../twitch/PubSub.ts";

/**
 * The core's `Subscribe` goes to the PubSub socket whatever the actuator: listening is
 * read-only, so a shadow run listens for real and the live actuator needs no subscribe of its own.
 */
export const listening = (
  actuator: Actuator["Service"],
  pubsub: PubSub["Service"],
): Actuator["Service"] => Actuator.of({ ...actuator, subscribe: pubsub.subscribe });

/** Replaces the `subscribe` of the actuator a layer provides with `PubSub`'s. */
export const withListening = <E, R>(
  actuator: Layer.Layer<Actuator, E, R>,
): Layer.Layer<Actuator, E, R | PubSub> =>
  Layer.effect(
    Actuator,
    Effect.gen(function* () {
      return listening(yield* Actuator, yield* PubSub);
    }),
  ).pipe(Layer.provide(actuator));

/** Feeds what the frames say into the runtime's event queue, for as long as the scope lives. */
export const forwardFrames = (events: Queue.Enqueue<Event>) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub;
    yield* Effect.forkScoped(Stream.runForEach(pubsub.events, (e) => Queue.offer(events, e)));
  });
