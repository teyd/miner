import { Effect, Layer, Redacted } from "effect";
import { HttpClient } from "effect/http";
import { Store } from "../store/Store.ts";
import { Actuator } from "../twitch/Actuator.ts";
import { Budgets } from "../twitch/budget.ts";
import { makeGql } from "../twitch/gql.ts";
import { hlsWatch } from "../twitch/hls.ts";
import { Journal, type Limits } from "../twitch/journal.ts";
import { liveActuator } from "../twitch/live.ts";
import { PubSub } from "../twitch/PubSub.ts";
import { Credentials, Twitch } from "../twitch/Twitch.ts";
import { withListening } from "./listen.ts";
import { STATUS_FILE, StatusSink } from "./status.ts";

/** State of live runs. Shadow runs keep theirs apart (`SHADOW_STATE`). */
export const LIVE_STATE = "state.json";

/**
 * Everything `run` needs to mine for real, over a given HTTP client and credentials: the
 * `Twitch` reads and the live actuator share one set of request budgets (`budget.ts`), so
 * mutations count against the same API budget as reads and playlists and segments against the
 * CDN's, and one flight recorder in `$DATA_DIR/recordings`.
 * PubSub (needs a `Connector` from outside) follows the channels the core subscribes to.
 */
export const liveLayer = (dataDir: string, limits?: Limits) => {
  const journal = Layer.unwrap(
    Effect.gen(function* () {
      const { token } = yield* Credentials;
      return Journal.rolling(`${dataDir}/recordings`, [Redacted.value(token)], limits);
    }),
  );
  const status = StatusSink.file(`${dataDir}/${STATUS_FILE}`, "live");
  return Layer.mergeAll(
    liveServices.pipe(Layer.provide(Layer.merge(journal, Budgets.layer))),
    Store.file(`${dataDir}/${LIVE_STATE}`),
    status,
  );
};

/**
 * The reads, the live actuator and PubSub over one HTTP client and one set of request budgets,
 * as a real run wires them; the simulator runs the same wiring over the twin, with budgets that
 * outlive a simulated crash as Twitch's per-IP count does.
 */
export const liveServices = Layer.unwrap(
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const budgets = yield* Budgets;
    const credentials = yield* Credentials;
    const recorder = yield* Journal;
    const gql = makeGql(http, credentials, recorder, budgets.gql);
    const method = hlsWatch({
      gql,
      cdn: http,
      budget: budgets.cdn,
      deviceId: credentials.deviceId,
      journal: recorder,
    });
    const twitch = Twitch.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(Budgets, budgets),
          Layer.succeed(Credentials, credentials),
          Layer.succeed(Journal, recorder),
        ),
      ),
    );
    const pubsub = PubSub.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          twitch,
          Layer.succeed(Credentials, credentials),
          Layer.succeed(Journal, recorder),
        ),
      ),
    );
    const actuator = withListening(Layer.succeed(Actuator, liveActuator({ gql, method }))).pipe(
      Layer.provide(pubsub),
    );
    return Layer.mergeAll(twitch, pubsub, actuator);
  }),
);
