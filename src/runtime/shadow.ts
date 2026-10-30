import { Effect, Layer, Redacted } from "effect";
import { Store } from "../store/Store.ts";
import { Actuator, WatchFailure } from "../twitch/Actuator.ts";
import { Journal, type Limits } from "../twitch/journal.ts";
import { paced } from "../twitch/pace.ts";
import { Credentials, Twitch } from "../twitch/Twitch.ts";

/**
 * The actuator of `miner run --shadow` (research 04 §4, lane C): it records and logs what the
 * miner would do and sends nothing, so a shadow run costs Twitch reads only.
 */
export const shadowActuator = (journal: Journal["Service"]): Actuator["Service"] => {
  const would = (command: string, detail: unknown, message: string) =>
    Effect.andThen(journal.intent(command, detail), Effect.logInfo(`shadow: would ${message}`));
  return Actuator.of({
    watch: (channelId) => would("Watch", { channelId }, `watch channel ${channelId}`),
    stopWatching: would("StopWatching", null, "stop watching"),
    subscribe: (channelIds) =>
      would("Subscribe", { channelIds }, `follow ${channelIds.length} channels`),
    // No watch runs, so a tick credits nothing. `network` is the one failure after which the
    // core neither counts a minute nor gives up on the channel, so the plan stays put.
    watchTick: (channelId) => Effect.fail(new WatchFailure({ channelId, reason: "network" })),
    // A claim that never answers: the core keeps its intent as sent, so each claim is recorded
    // once per run, and no lost-answer recheck starts a loop of inventory reads.
    claim: (instanceId) =>
      Effect.andThen(
        would("Claim", { instanceId }, `claim drop instance ${instanceId}`),
        Effect.never,
      ),
  });
};

/** State of shadow runs. Never the live state: a shadow claim intent would block a real claim. */
export const SHADOW_STATE = "state.shadow.json";

/**
 * Everything `run` needs in shadow mode, over a given HTTP client and credentials: the real
 * `Twitch` client, paced and recording into `$DATA_DIR/recordings`, the shadow actuator, and
 * the state file.
 */
export const shadowLayer = (dataDir: string, limits?: Limits) => {
  const journal = Layer.unwrap(
    Effect.gen(function* () {
      const { token } = yield* Credentials;
      return Journal.rolling(`${dataDir}/recordings`, [Redacted.value(token)], limits);
    }),
  );
  const twitch = Twitch.layer.pipe(Layer.provide(Layer.merge(paced(), journal)));
  const actuator = Layer.effect(
    Actuator,
    Effect.gen(function* () {
      return shadowActuator(yield* Journal);
    }),
  ).pipe(Layer.provide(journal));
  return Layer.mergeAll(twitch, actuator, Store.file(`${dataDir}/${SHADOW_STATE}`));
};
