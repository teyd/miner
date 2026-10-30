import { Duration, Effect } from "effect";
import type { ChannelId, DropInstanceId } from "../core/model.ts";
import { Actuator, WatchFailure, type ClaimAnswer } from "./Actuator.ts";
import { TwitchDrift, TwitchUnavailable, type TwitchError } from "./errors.ts";
import { single, type Gql } from "./gql.ts";
import type { WatchMethod, WatchSession } from "./hls.ts";
import { CLAIM_ALREADY, CLAIM_GRANTED, Mutations } from "./identity.ts";
import { ClaimDropRewards } from "./wire.ts";

/** A claim that hasn't answered by then may still land: its outcome is unknown. */
export const CLAIM_TIMEOUT = Duration.seconds(30);

/**
 * `DropsPage_ClaimDropRewards`, sent once and never retried (AGENTS.md: a lost answer may still
 * have succeeded). Every failure, the timeout included, reaches the executor, which reports the
 * outcome as `unknown` and lets inventory decide.
 */
export const claimDrop =
  (gql: Gql) =>
  (instanceId: DropInstanceId): Effect.Effect<ClaimAnswer, TwitchError> => {
    const operation = Mutations.ClaimDrop.operationName;
    return gql
      .request(Mutations.ClaimDrop, [{ input: { dropInstanceID: instanceId } }], ClaimDropRewards)
      .pipe(
        Effect.flatMap((results) => single(operation, results)),
        Effect.timeoutOrElse({
          duration: CLAIM_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new TwitchUnavailable({
                operation,
                detail: `no answer within ${Duration.toSeconds(CLAIM_TIMEOUT)} s`,
              }),
            ),
        }),
        Effect.flatMap(({ claimDropRewards: payload }) => {
          if (payload === null) {
            return Effect.fail(new TwitchDrift({ operation, detail: "Twitch answered no claim" }));
          }
          if (payload.status === CLAIM_ALREADY) return Effect.succeed("already-claimed" as const);
          if (payload.status !== CLAIM_GRANTED) {
            const detail = `Twitch answered status ${payload.status}`;
            return Effect.fail(new TwitchDrift({ operation, detail }));
          }
          // Twitch keeps an unlinked in-game reward and grants it once the game account is
          // linked (just-mining `docs/claims.md`). Sending the claim again changes nothing.
          return payload.isUserAccountConnected
            ? Effect.succeed("claimed" as const)
            : Effect.as(
                Effect.logWarning(
                  `claim: ${instanceId} accepted, but the game account isn't linked; Twitch grants it on linking`,
                ),
                "claimed" as const,
              );
        }),
        Effect.tap((answer) => Effect.logInfo(`claim: ${instanceId} ${answer}`)),
        Effect.tapError((e) =>
          Effect.logWarning(`claim: ${instanceId} outcome unknown (${e._tag}), inventory decides`),
        ),
      );
  };

/**
 * The actuator of a real run: one watch session at a time through `method`, claims through the
 * API. `watch` and `stopWatching` send nothing; the session's first tick resolves the stream.
 * `subscribe` does nothing here: listening is read-only and goes to PubSub for any actuator
 * (`withListening` in `src/runtime/listen.ts`).
 */
export const liveActuator = (deps: {
  readonly gql: Gql;
  readonly method: WatchMethod;
}): Actuator["Service"] => {
  let session: { readonly channelId: ChannelId; readonly watch: WatchSession } | undefined;

  const watch = (channelId: ChannelId, login: string) =>
    Effect.gen(function* () {
      const opened = yield* deps.method.open({ channelId, login });
      session = { channelId, watch: opened };
      yield* Effect.logDebug(`watch: opened ${login} (${deps.method.name})`);
    });

  const stopWatching = Effect.sync(() => {
    session = undefined;
  });

  // A tick for a channel no longer watched is a leftover of a switch: `network` changes nothing.
  const watchTick = (channelId: ChannelId) =>
    Effect.suspend(() =>
      session?.channelId === channelId
        ? session.watch.tick
        : Effect.fail(new WatchFailure({ channelId, reason: "network" })),
    );

  return Actuator.of({
    watch,
    watchTick,
    stopWatching,
    claim: claimDrop(deps.gql),
    subscribe: () => Effect.void,
  });
};
