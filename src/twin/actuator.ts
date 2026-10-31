import { Clock, Effect } from "effect";
import type { ChannelId, DropInstanceId } from "../core/model.ts";
import { Actuator, WatchFailure, type ClaimAnswer } from "../twitch/Actuator.ts";
import type { Budgets } from "../twitch/budget.ts";
import { AuthRejected, TwitchDrift, TwitchUnavailable } from "../twitch/errors.ts";
import {
  TICK_REQUESTS,
  TOKEN_REFRESH,
  TWIN_TIMEOUT,
  TWITCH_SOCKETS,
  TWITCH_TOPICS_PER_SOCKET,
  emit,
  latency,
  overGqlRate,
  socketsFor,
  takeDue,
  type Twin,
} from "./twin.ts";
import * as World from "./world.ts";

const now = Clock.currentTimeMillis;

/**
 * The twin's mutation surface. The fault table is the plan's §3.4: a claim is the GQL mutation
 * `ClaimDrop`, so HTTP faults on it or on `any` fail it before it applies; a watch tick is a CDN
 * request, which only a `timeout` window and a revoked token touch.
 *
 * The typed calls stand for requests, so they take turns at the miner's own budgets as the live
 * actuator's do: a claim is one GQL request (and over `TWITCH_GQL_PER_SECOND` Twitch answers it
 * 429, unapplied), a tick `TICK_REQUESTS` CDN requests. A subscription needing more than
 * `TWITCH_SOCKETS` sockets is cut to what fits.
 */
export const twinActuator = (twin: Twin, budgets: Budgets["Service"]): Actuator["Service"] => {
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

  // Two topics per channel plus the account's drop topic: what fits in `TWITCH_SOCKETS`.
  const fits = Math.floor((TWITCH_SOCKETS * TWITCH_TOPICS_PER_SOCKET - 1) / 2);
  const subscribe = (channelIds: ReadonlyArray<ChannelId>) =>
    Effect.flatMap(now, (at) =>
      Effect.sync(() => {
        twin.world = { ...twin.world, subscriptions: new Set(channelIds.slice(0, fits)) };
        const sockets = socketsFor(channelIds.length);
        twin.activity.calls.push({ kind: "subscribe", at, channelIds, sockets });
      }),
    );

  const watchTick = (channelId: ChannelId) =>
    Effect.gen(function* () {
      const session = twin.world.session;
      const stream = twin.stream;
      const resolving =
        stream === undefined ||
        session === undefined ||
        stream.channelId !== channelId ||
        stream.openedAt !== session.openedAt ||
        (yield* now) >= stream.until;
      if (resolving) {
        twin.stream = undefined;
        yield* budgets.gql.run("PlaybackAccessToken", playbackToken(channelId));
      }
      const requests = TICK_REQUESTS + (resolving ? 1 : 0);
      return yield* budgets.cdn.run("hls", tickOnce(channelId, requests, resolving), requests);
    });

  /** The token request of a tick that resolves the stream: a GQL request, latency and all. */
  const playbackToken = (channelId: ChannelId) =>
    Effect.gen(function* () {
      const startedAt = yield* now;
      const limited = yield* Effect.sync(() => overGqlRate(twin, startedAt));
      yield* latency;
      const endedAt = yield* now;
      const revoked = World.isRevoked(twin.world, startedAt);
      const status = limited ? 429 : revoked ? 401 : 200;
      twin.activity.requests.push({
        at: startedAt,
        endedAt,
        operation: "PlaybackAccessToken",
        status,
        limited,
      });
      if (limited) {
        yield* budgets.gql.backOff;
        return yield* new WatchFailure({ channelId, reason: "network" });
      }
      if (revoked) return yield* new AuthRejected({ reason: "watch: token answered 401" });
    });

  const tickOnce = (channelId: ChannelId, requests: number, resolving: boolean) =>
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
        requests,
      });
      // As `hls.ts`: a stream that failed (not the network) is resolved again at the next tick.
      const session = twin.world.session;
      if (ticked.result === "ticked" && resolving && session !== undefined) {
        twin.stream = { openedAt: session.openedAt, channelId, until: at + TOKEN_REFRESH };
      } else if (ticked.result !== "ticked" && ticked.result !== "network") {
        twin.stream = undefined;
      }
      switch (ticked.result) {
        case "ticked":
          return;
        case "auth":
          return yield* new AuthRejected({ reason: "watch: playback token answered 401" });
        default:
          return yield* new WatchFailure({ channelId, reason: ticked.result });
      }
    });

  const claim = (instanceId: DropInstanceId) => budgets.gql.run("ClaimDrop", claimOnce(instanceId));

  const claimOnce = (instanceId: DropInstanceId) =>
    Effect.gen(function* () {
      const operation = "ClaimDrop";
      const startedAt = yield* now;
      const limited = yield* Effect.sync(() => overGqlRate(twin, startedAt));
      const fault = limited ? undefined : World.windowFaultAt(twin.world, "ClaimDrop", startedAt);
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
          limited,
        });
      if (limited) {
        record(undefined, "429", false, false);
        yield* budgets.gql.backOff;
        return yield* new TwitchUnavailable({ operation, detail: "HTTP 429" });
      }
      if (World.isRevoked(twin.world, at)) {
        record(undefined, "auth", false, false);
        return yield* new AuthRejected({ reason: "claim answered 401" });
      }
      if (fault !== undefined && fault.kind !== "null-catalog") {
        record(undefined, fault.kind, false, false);
        // The live client backs off on any 429, a fault window's too (`gql.ts`).
        if (fault.kind === "http-429") yield* budgets.gql.backOff;
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
