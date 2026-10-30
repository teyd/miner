import { Effect, Layer, Redacted } from "effect";
import { HttpClient } from "effect/http";
import { Store } from "../store/Store.ts";
import { Actuator } from "../twitch/Actuator.ts";
import { makeGql } from "../twitch/gql.ts";
import { hlsWatch } from "../twitch/hls.ts";
import { Journal, type Limits } from "../twitch/journal.ts";
import { liveActuator } from "../twitch/live.ts";
import { pace } from "../twitch/pace.ts";
import { PubSub } from "../twitch/PubSub.ts";
import { Credentials, Twitch } from "../twitch/Twitch.ts";
import { withListening } from "./listen.ts";
import { STATUS_FILE, StatusSink } from "./status.ts";

/** State of live runs. Shadow runs keep theirs apart (`SHADOW_STATE`). */
export const LIVE_STATE = "state.json";

/**
 * Everything `run` needs to mine for real, over a given HTTP client and credentials: the
 * `Twitch` reads and the live actuator share one pacer for the API, so mutations count against
 * the same request budget as reads, and one flight recorder in `$DATA_DIR/recordings`. Playlist
 * and segment requests go to Twitch's CDN unpaced, one after another, as TDM sends them.
 * PubSub (needs a `Connector` from outside) follows the channels the core subscribes to.
 */
export const liveLayer = (dataDir: string, limits?: Limits) => {
  const journal = Layer.unwrap(
    Effect.gen(function* () {
      const { token } = yield* Credentials;
      return Journal.rolling(`${dataDir}/recordings`, [Redacted.value(token)], limits);
    }),
  );
  const services = Layer.unwrap(
    Effect.gen(function* () {
      const cdn = yield* HttpClient.HttpClient;
      const api = yield* pace(cdn);
      const credentials = yield* Credentials;
      const recorder = yield* Journal;
      const gql = makeGql(api, credentials, recorder);
      const method = hlsWatch({ gql, cdn, deviceId: credentials.deviceId, journal: recorder });
      const twitch = Twitch.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, api),
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
  ).pipe(Layer.provide(journal));
  const status = StatusSink.file(`${dataDir}/${STATUS_FILE}`, "live");
  return Layer.mergeAll(services, Store.file(`${dataDir}/${LIVE_STATE}`), status);
};
