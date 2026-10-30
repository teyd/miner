import { Clock, Effect } from "effect";
import type { ChannelId, DropInstanceId } from "../core/model.ts";
import { Actuator, WatchFailure, type ClaimAnswer } from "../twitch/Actuator.ts";
import { AuthRejected, TwitchDrift, TwitchUnavailable } from "../twitch/errors.ts";
import { TWIN_TIMEOUT, emit, latency, takeDue, type Twin } from "./twin.ts";
import * as World from "./world.ts";

const now = Clock.currentTimeMillis;

/**
 * The twin's mutation surface. The fault table is the plan's §3.4: a claim is the GQL mutation
 * `ClaimDrop`, so HTTP faults on it or on `any` fail it before it applies; a watch tick is a CDN
 * request, which only a `timeout` window and a revoked token touch.
 */
export const twinActuator = (twin: Twin): Actuator["Service"] => {
  const watch = (channelId: ChannelId) =>
    Effect.flatMap(now, (at) =>
      Effect.sync(() => {
        twin.world = World.openSession(twin.world, channelId, at);
        twin.activity.calls.push({ kind: "watch", at, channelId });
      }),
    );

  const stopWatching = Effect.flatMap(now, (at) =>
    Effect.sync(() => {
      twin.world = World.closeSession(twin.world);
      twin.activity.calls.push({ kind: "stop", at });
    }),
  );

  const subscribe = (channelIds: ReadonlyArray<ChannelId>) =>
    Effect.flatMap(now, (at) =>
      Effect.sync(() => {
        twin.world = { ...twin.world, subscriptions: new Set(channelIds) };
        twin.activity.calls.push({ kind: "subscribe", at, channelIds });
      }),
    );

  const watchTick = (channelId: ChannelId) =>
    Effect.gen(function* () {
      const startedAt = yield* now;
      // The request credits the session it left under, even if a `Watch` or `StopWatching`
      // issued in the same step lands first: the switch can't recall a request already sent.
      const sentUnder = twin.world.session;
      const timedOut = World.networkDownAt(twin.world, startedAt);
      yield* timedOut ? Effect.sleep(TWIN_TIMEOUT) : latency;
      const at = yield* now;
      const current = twin.world;
      const ticked = timedOut
        ? { world: current, result: "network" as const, frames: [], credits: [] }
        : World.tick({ ...current, session: sentUnder }, channelId, at);
      twin.world =
        current.session === sentUnder
          ? ticked.world
          : { ...ticked.world, session: current.session };
      emit(twin, ticked.frames);
      twin.activity.credits.push(...ticked.credits);
      twin.activity.calls.push({
        kind: "tick",
        at: startedAt,
        endedAt: at,
        channelId,
        result: ticked.result,
      });
      switch (ticked.result) {
        case "ticked":
          return;
        case "auth":
          return yield* new AuthRejected({ reason: "watch: playback token answered 401" });
        default:
          return yield* new WatchFailure({ channelId, reason: ticked.result });
      }
    });

  const claim = (instanceId: DropInstanceId) =>
    Effect.gen(function* () {
      const operation = "ClaimDrop";
      const startedAt = yield* now;
      const fault = World.windowFaultAt(twin.world, "ClaimDrop", startedAt);
      yield* fault?.kind === "timeout" ? Effect.sleep(TWIN_TIMEOUT) : latency;
      const at = yield* now;
      const record = (
        dropId: ReturnType<typeof World.claim>["dropId"],
        outcome: string,
        applied: boolean,
        alreadyApplied: boolean,
      ) =>
        twin.activity.calls.push({
          kind: "claim",
          at: startedAt,
          endedAt: at,
          instanceId,
          dropId,
          alreadyApplied,
          applied,
          outcome,
        });
      if (World.isRevoked(twin.world, at)) {
        record(undefined, "auth", false, false);
        return yield* new AuthRejected({ reason: "claim answered 401" });
      }
      if (fault !== undefined && fault.kind !== "null-catalog") {
        record(undefined, fault.kind, false, false);
        return yield* new TwitchUnavailable({ operation, detail: fault.kind });
      }
      const result = World.claim(twin.world, instanceId, at);
      twin.world = result.world;
      const applied = result.outcome === "claimed";
      record(result.dropId, result.outcome, applied, result.outcome === "already-claimed");
      if (applied && takeDue(twin.inClaimCrashes, at)) {
        // The process dies after Twitch applied the claim and before the answer arrives.
        twin.crashRequested = true;
        return yield* Effect.never;
      }
      if (applied && takeDue(twin.lostAnswers, at)) {
        return yield* new TwitchUnavailable({ operation, detail: "answer lost" });
      }
      switch (result.outcome) {
        case "claimed":
        case "already-claimed":
          return result.outcome satisfies ClaimAnswer;
        case "rejected":
          return yield* new TwitchDrift({ operation, detail: "claim rejected" });
        case "auth":
          return yield* new AuthRejected({ reason: "claim answered 401" });
      }
    });

  return Actuator.of({ watch, watchTick, stopWatching, claim, subscribe });
};
