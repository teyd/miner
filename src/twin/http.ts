import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import {
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import type { ChannelId, DropInstanceId, Millis } from "../core/model.ts";
import {
  CLAIM_GRANTED,
  GQL_URL,
  Mutations,
  VALIDATE_URL,
  playbackHeaders,
} from "../twitch/identity.ts";
import { Budgets } from "../twitch/budget.ts";
import { Journal } from "../twitch/journal.ts";
import { Credentials, Twitch } from "../twitch/Twitch.ts";
import { ClaimDropRewards } from "../twitch/wire.ts";
import * as Answers from "./answers.ts";
import { cdnOperation, playbackToken, serve } from "./cdn.ts";
import { respond, respondJson, transportError } from "./response.ts";
import type { Operation } from "./scenario.ts";
import {
  Issued,
  TWITCH_GQL_PER_SECOND,
  latency,
  latencyBetween,
  overGqlRate,
  takeDue,
  type Label,
  type Twin,
} from "./twin.ts";
import * as World from "./world.ts";

interface Sent {
  readonly operationName: string;
  readonly variables: Record<string, unknown>;
}

const parse = (request: HttpClientRequest.HttpClientRequest): ReadonlyArray<Sent> =>
  request.body._tag === "Uint8Array"
    ? (JSON.parse(new TextDecoder().decode(request.body.body)) as ReadonlyArray<Sent>)
    : [];

/** One GQL answer element, for the operation and variables of one batch entry. */
const answer = (twin: Twin, sent: Sent, withheld: boolean, now: number): unknown => {
  const world = twin.world;
  const v = sent.variables;
  switch (sent.operationName) {
    case "ViewerDropsDashboard":
      return { data: Answers.dashboard(world, now, withheld) };
    case "DropCampaignDetails":
      return { data: Answers.campaignDetails(world, String(v["dropID"])) };
    case "Inventory":
      return { data: Answers.inventory(world, now) };
    case "DirectoryPage_Game":
      return { data: Answers.directory(world, String(v["slug"]), Number(v["limit"]), now) };
    case "VideoPlayerStreamInfoOverlayChannel":
      return { data: Answers.streamInfo(world, String(v["channel"]), now) };
    case "DropCurrentSessionContext":
      return { data: Answers.currentDrop(world, String(v["channelID"]) as ChannelId, now) };
    case "PlaybackAccessToken":
      return { data: playbackToken(twin, String(v["login"]), now) };
    default:
      return { errors: [{ message: "PersistedQueryNotFound" }] };
  }
};

const operationOf = (request: HttpClientRequest.HttpClientRequest, sent: ReadonlyArray<Sent>) => {
  if (request.url === VALIDATE_URL) return "validate";
  const cdn = cdnOperation(request.url);
  if (cdn !== undefined) return cdn;
  const name = sent[0]?.operationName;
  return (name === Mutations.ClaimDrop.operationName ? "ClaimDrop" : name) as Operation;
};

/** How Twitch means a status, for a `WatchTick`'s view of its answers. */
const labelOf = (status: number): Label =>
  status === 401
    ? "auth"
    : status === 404
      ? "offline"
      : status === 403 || status === 410
        ? "refused"
        : status >= 200 && status < 300
          ? "ok"
          : "network";

/**
 * Twitch's HTTP surface: `oauth2/validate`, the GQL reads, `PlaybackAccessToken` and the claim
 * mutation, usher, playlists and segments, answered from the world with seeded latency, the
 * scenario's fault windows and a revoked token. A GQL request above `TWITCH_GQL_PER_SECOND` is
 * answered 429, whatever else holds. Every request is checked against the command it was sent for
 * (`Issued`). The twin charges no budget: the miner's own code does (`gql.ts`, `hls.ts`). Built with `makeWith`, not `make`: the twin is the server, and `make`'s
 * abort signal and span per request were a tenth of a run with 17 requests a beat.
 */
export const twinHttp = (twin: Twin): HttpClient.HttpClient =>
  HttpClient.makeWith<never, never, HttpClientError.HttpClientError, never>(
    (request) => Effect.flatMap(request, (r) => serveRequest(twin, r)),
    Effect.succeed,
  );

/** The browser player's identity, which every usher, playlist and segment request carries. */
const CDN_IDENTITY = ["client-id", "user-agent", "origin", "referer"] as const;
const expectedIdentity = Object.fromEntries(
  Object.entries(playbackHeaders("")).map(([k, v]) => [k.toLowerCase(), v]),
);

/**
 * What a CDN request must not carry and must carry: never the OAuth token (a header, a query
 * parameter, the `auth-token` cookie), always the player's identity headers (research 02 §4).
 */
const checkCdnRequest = (
  twin: Twin,
  request: HttpClientRequest.HttpClientRequest,
  operation: Operation,
) => {
  if (request.headers["authorization"] !== undefined) {
    twin.activity.leaks.push(`${operation} carried the OAuth token to the CDN`);
  }
  const params = [...new URL(request.url).searchParams.values()];
  if (params.some((v) => v.includes(twin.token))) {
    twin.activity.leaks.push(`${operation} carried the OAuth token in its query`);
  }
  const cookie = request.headers["cookie"] ?? "";
  if (cookie.includes(twin.token) || /\bauth-token=/.test(cookie)) {
    twin.activity.leaks.push(`${operation} carried the auth-token cookie to the CDN`);
  }
  const wrong = CDN_IDENTITY.filter((h) => request.headers[h] !== expectedIdentity[h]);
  if (wrong.length > 0) {
    twin.activity.identity.push(`${operation} without the player's ${wrong.join(", ")}`);
  }
};

const serveRequest = (twin: Twin, request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const issued = yield* Issued;
    const sent = request.url === GQL_URL ? parse(request) : [];
    const operation = operationOf(request, sent);
    const cdn = cdnOperation(request.url) !== undefined;
    const command = issued?.id;
    if (issued === undefined && !twin.direct) {
      twin.activity.orphans.push(`${operation} sent by no command`);
    }
    if (issued !== undefined && !twin.live.has(issued.id)) {
      twin.activity.orphans.push(`${operation} sent for ${issued.command._tag} after it finished`);
    }
    if (cdn) checkCdnRequest(twin, request, operation);
    const view = command === undefined ? undefined : twin.ticks.get(command);
    const label = (l: Label) => {
      if (view !== undefined) view.label = l;
    };
    // Twitch counts every GQL request against the IP's rate, the playback token's and claims too.
    const limited = request.url === GQL_URL && overGqlRate(twin, startedAt);
    const log = (status: number | "timeout" | "lost") =>
      Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
        Effect.sync(() =>
          twin.activity.requests.push({ at: startedAt, endedAt, operation, status, limited }),
        ),
      );
    const fault = limited ? undefined : World.windowFaultAt(twin.world, operation, startedAt);
    // A hung connection: no answer ever. The client's own timeout must give up.
    if (fault?.kind === "timeout") {
      label("network");
      if (operation === "ClaimDrop") recordClaim(twin, sent, startedAt, "timeout");
      return yield* Effect.onInterrupt(Effect.never, () => log("timeout"));
    }
    yield* cdn
      ? operation === "segment"
        ? latencyBetween(10, 60)
        : latencyBetween(50, 250)
      : latency;
    const now = yield* Clock.currentTimeMillis;
    const reply = (status: number, body: unknown, l: Label = labelOf(status)) =>
      Effect.sync((): HttpClientResponse.HttpClientResponse => {
        label(l);
        return typeof body === "string"
          ? respond(request, status, body)
          : respondJson(request, status, body);
      }).pipe(Effect.tap(log(status)));
    const refuse = (reason: string) => {
      if (operation === "ClaimDrop") recordClaim(twin, sent, startedAt, reason, now);
      return reply(401, { status: 401, message: "invalid access token" });
    };
    if (limited) {
      if (operation === "ClaimDrop") recordClaim(twin, sent, startedAt, "429", now, true);
      const message = `more than ${TWITCH_GQL_PER_SECOND} requests in a second`;
      return yield* reply(429, { error: "Too Many Requests", message });
    }
    // The API checks the token before anything behind it can fail: a revoked token answers 401
    // through a 5xx window too, and the client must park on it.
    if (!cdn) {
      const authorization = request.headers["authorization"];
      if (authorization !== `OAuth ${twin.token}`) {
        twin.activity.wrongTokens.push(
          `${operation} sent ${authorization === undefined ? "no token" : "a token the twin never issued"}`,
        );
        return yield* refuse("auth");
      }
      if (World.isRevoked(twin.world, startedAt)) return yield* refuse("auth");
    }
    if (fault?.kind === "http-5xx") {
      if (operation === "ClaimDrop") recordClaim(twin, sent, startedAt, "http-5xx", now);
      return yield* reply(503, "<html>503 Service Unavailable</html>");
    }
    if (fault?.kind === "http-429") {
      if (operation === "ClaimDrop") recordClaim(twin, sent, startedAt, "http-429", now);
      return yield* reply(429, { error: "Too Many Requests" });
    }
    if (cdn) {
      const served = serve(twin, request, operation, startedAt, now, issued);
      return yield* reply(served.status, served.body, served.label);
    }
    if (operation === "validate") return yield* reply(200, Answers.validation());
    if (request.url !== GQL_URL) return yield* reply(404, null, "offline");
    // A backend behind the mutation failed: Twitch applied nothing, and says so only as an error.
    if (fault?.kind === "service-error") {
      if (operation === "ClaimDrop") recordClaim(twin, sent, startedAt, "service-error", now);
      return yield* reply(
        200,
        sent.map(() => ({ errors: [{ message: "service error" }], data: null })),
        "network",
      );
    }
    if (operation === "ClaimDrop") return yield* claim(twin, request, sent, startedAt, now, log);
    const withheld = fault?.kind === "null-catalog";
    const body = sent.map((entry) => answer(twin, entry, withheld, now));
    if (operation === "Inventory") {
      const [world, calls] = World.startCooldown(
        twin.world,
        now,
        World.inventoryView(twin.world, now),
      );
      twin.world = world;
      twin.backOffs = [...twin.backOffs, ...calls].toSorted((a, b) => a - b);
    }
    return yield* reply(200, body, tokenLabel(body));
  });

/** A `PlaybackAccessToken` answer: none means offline, a forbidden one refused. */
const tokenLabel = (body: ReadonlyArray<unknown>): Label => {
  const token = (body[0] as { data?: { streamPlaybackAccessToken?: unknown } } | undefined)?.data
    ?.streamPlaybackAccessToken;
  if (token === null) return "offline";
  const forbidden = (token as { authorization?: { isForbidden?: boolean } } | undefined)
    ?.authorization?.isForbidden;
  return forbidden === true ? "refused" : "ok";
};

const instanceIn = (sent: ReadonlyArray<Sent>) =>
  String(
    (sent[0]?.variables["input"] as { dropInstanceID?: unknown } | undefined)?.dropInstanceID,
  ) as DropInstanceId;

const recordClaim = (
  twin: Twin,
  sent: ReadonlyArray<Sent>,
  at: Millis,
  outcome: string,
  endedAt: Millis = at,
  limited = false,
) =>
  twin.activity.calls.push({
    kind: "claim",
    at,
    endedAt,
    instanceId: instanceIn(sent),
    dropId: undefined,
    alreadyApplied: false,
    applied: false,
    answered: false,
    outcome,
    limited,
  });

/**
 * `DropsPage_ClaimDropRewards`. A fresh claim and a claim of a claimed instance both answer
 * `ELIGIBLE_FOR_ALL`, an unlinked game account adds `isUserAccountConnected: false`, and an
 * instance Twitch doesn't know answers `claimDropRewards: null` (research 02 §4). The twin
 * answers `null` to a claim it refuses (incomplete, past the window); Twitch's answer there is
 * unrecorded.
 */
const claim = (
  twin: Twin,
  request: HttpClientRequest.HttpClientRequest,
  sent: ReadonlyArray<Sent>,
  startedAt: Millis,
  now: Millis,
  log: (status: number | "lost") => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const instanceId = instanceIn(sent);
    const result = World.claim(twin.world, instanceId, now);
    twin.world = result.world;
    const applied = result.outcome === "claimed";
    // The process dies after Twitch applied the claim and before the answer arrives.
    const crashed = applied && takeDue(twin.inClaimCrashes, now);
    const lost = applied && !crashed && takeDue(twin.lostAnswers, now);
    twin.activity.calls.push({
      kind: "claim",
      at: startedAt,
      endedAt: now,
      instanceId,
      dropId: result.dropId,
      alreadyApplied: result.outcome === "already-claimed",
      applied,
      answered: !crashed && !lost,
      outcome: result.outcome,
      limited: false,
    });
    if (crashed) {
      twin.crashRequested = true;
      return yield* Effect.never;
    }
    if (lost) {
      yield* log("lost");
      return yield* transportError(request, "the answer was lost");
    }
    const linked =
      result.dropId === undefined
        ? true
        : (World.findDrop(twin.world, result.dropId)?.campaign.linked ?? true);
    const payload =
      result.outcome === "claimed" || result.outcome === "already-claimed"
        ? { status: CLAIM_GRANTED, isUserAccountConnected: linked }
        : null;
    const data = yield* Schema.encodeEffect(ClaimDropRewards)({ claimDropRewards: payload }).pipe(
      Effect.orDie,
    );
    yield* log(200);
    return respondJson(request, 200, [{ data }]);
  });

/**
 * The real `Twitch` client over the twin, with the twin's token and no journal, within `budgets`
 * (the real limits unless given).
 */
export const twinTwitch = (twin: Twin, budgets?: Budgets["Service"]): Layer.Layer<Twitch> =>
  Twitch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, twinHttp(twin)),
        budgets === undefined ? Budgets.layer : Layer.succeed(Budgets, budgets),
        twinCredentials(twin),
        Journal.none,
      ),
    ),
  );

/** The credentials of the account the twin serves. */
export const twinCredentials = (twin: Twin) =>
  Layer.succeed(
    Credentials,
    Credentials.of({ token: Redacted.make(twin.token), deviceId: "0".repeat(32) }),
  );
