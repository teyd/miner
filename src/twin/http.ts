import { Clock, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { ChannelId } from "../core/model.ts";
import { GQL_URL, VALIDATE_URL } from "../twitch/identity.ts";
import { Journal } from "../twitch/journal.ts";
import { Credentials, Twitch } from "../twitch/Twitch.ts";
import * as Answers from "./answers.ts";
import type { Operation } from "./scenario.ts";
import { latency, type Twin } from "./twin.ts";
import { isRevoked, windowFaultAt } from "./world.ts";

interface Sent {
  readonly operationName: string;
  readonly variables: Record<string, unknown>;
}

const parse = (request: HttpClientRequest.HttpClientRequest): ReadonlyArray<Sent> =>
  request.body._tag === "Uint8Array"
    ? (JSON.parse(new TextDecoder().decode(request.body.body)) as ReadonlyArray<Sent>)
    : [];

const respond = (request: HttpClientRequest.HttpClientRequest, status: number, body: unknown) =>
  HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }));

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
    default:
      return { errors: [{ message: "PersistedQueryNotFound" }] };
  }
};

/**
 * Twitch's HTTP surface for the reads: `oauth2/validate` and the GQL operations, answered from
 * the world with seeded latency, the scenario's fault windows and a revoked token.
 */
export const twinHttp = (twin: Twin): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const sent = parse(request);
      const operation: Operation =
        request.url === VALIDATE_URL
          ? "validate"
          : ((sent[0]?.operationName ?? "validate") as Operation);
      const log = (status: number | "timeout") =>
        Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
          Effect.sync(() =>
            twin.activity.requests.push({ at: startedAt, endedAt, operation, status }),
          ),
        );
      const fault = windowFaultAt(twin.world, operation, startedAt);
      // A hung connection: no answer ever. The client's own `REQUEST_TIMEOUT` must give up.
      if (fault?.kind === "timeout")
        return yield* Effect.onInterrupt(Effect.never, () => log("timeout"));
      yield* latency;
      const now = yield* Clock.currentTimeMillis;
      const reply = (status: number, body: unknown) =>
        Effect.as(log(status), respond(request, status, body));
      if (isRevoked(twin.world, startedAt)) {
        return yield* reply(401, { status: 401, message: "invalid access token" });
      }
      if (fault?.kind === "http-5xx")
        return yield* reply(503, "<html>503 Service Unavailable</html>");
      if (fault?.kind === "http-429") return yield* reply(429, { error: "Too Many Requests" });
      if (operation === "validate") return yield* reply(200, Answers.validation());
      if (request.url !== GQL_URL) return yield* reply(404, null);
      if (fault?.kind === "service-error") {
        return yield* reply(
          200,
          sent.map(() => ({ errors: [{ message: "service error" }], data: null })),
        );
      }
      const withheld = fault?.kind === "null-catalog";
      return yield* reply(
        200,
        sent.map((entry) => answer(twin, entry, withheld, now)),
      );
    }),
  );

/** The real `Twitch` client over the twin, with fixed credentials and no journal. */
export const twinTwitch = (twin: Twin): Layer.Layer<Twitch> =>
  Twitch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, twinHttp(twin)),
        Layer.succeed(
          Credentials,
          Credentials.of({ token: Redacted.make("twin-token"), deviceId: "0".repeat(32) }),
        ),
        Journal.none,
      ),
    ),
  );
