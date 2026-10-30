import { Clock, Effect, Layer, Semaphore } from "effect";
import { HttpClient } from "effect/http";
import type { Millis } from "../core/model.ts";

/**
 * Twitch allows about 5 GQL requests per second per IP (research 02). Starting requests at least
 * this far apart keeps one account well under it, at the pace a browser tab would cause.
 */
export const REQUEST_GAP: Millis = 300;

/** Spaces the starts of requests `gap` apart. Requests still overlap once started. */
export const pace = (client: HttpClient.HttpClient, gap: Millis = REQUEST_GAP) =>
  Effect.map(Semaphore.make(1), (lock) => {
    let last = -Infinity;
    const turn = lock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const wait = last + gap - now;
        if (wait > 0) yield* Effect.sleep(wait);
        last = yield* Clock.currentTimeMillis;
      }),
    );
    return HttpClient.make((request) => Effect.andThen(turn, client.execute(request)));
  });

/** Replaces the `HttpClient` in context with a paced one. */
export const paced = (gap?: Millis) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.flatMap(HttpClient.HttpClient, (client) => pace(client, gap)),
  );
