import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { Budgets, UNLIMITED } from "./budget.ts";
import { Credentials } from "./Twitch.ts";
import claimClaimed from "./fixtures/claim-claimed-instance.json" with { type: "json" };
import mediaPlaylist from "./fixtures/media-playlist.json" with { type: "json" };
import playbackToken from "./fixtures/playback-token.json" with { type: "json" };
import usherMaster from "./fixtures/usher-master.json" with { type: "json" };
import { GQL_URL, USHER_URL } from "./identity.ts";
import type { Answer as Recorded } from "./journal.ts";
import { Journal } from "./journal.ts";
import { Redacted } from "effect";

/** A recorded answer: what the fixture files hold. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** A connection that never answers, or answers headers and then never finishes the body. */
export type Hang = "hang" | "hang-body";

/**
 * A fake Twitch for tests: answers by GQL operation name (or `validate`) from a script of
 * answers, and counts requests. Each answer is used once, the last one repeats.
 */
export const stubTwitch = (script: Record<string, ReadonlyArray<Answer | Hang>>) => {
  const calls: Record<string, number> = {};
  const recorded: Array<Recorded> = [];
  const http = HttpClient.make((request) => {
    let operation = "validate";
    let size = 1;
    if (request.body._tag === "Uint8Array") {
      const sent = JSON.parse(new TextDecoder().decode(request.body.body)) as ReadonlyArray<{
        readonly operationName: string;
      }>;
      operation = sent[0]?.operationName ?? "?";
      size = sent.length;
    }
    const n = calls[operation] ?? 0;
    calls[operation] = n + 1;
    const answers = script[operation] ?? [{ status: 404, body: null }];
    const answer = answers[Math.min(n, answers.length - 1)]!;
    if (answer === "hang") return Effect.never;
    if (answer === "hang-body") {
      const body = new ReadableStream<Uint8Array>({ start: () => undefined });
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status: 200 })),
      );
    }
    // A GQL fixture holds one answer element; a batch gets it once per request.
    const raw: unknown = answer.body;
    const body =
      Array.isArray(raw) && raw.length === 1 && size > 1
        ? Array.from({ length: size }, () => raw[0] as unknown)
        : raw;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { status: answer.status }),
      ),
    );
  });
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    // Wire tests answer at once and don't move the clock: no budget waits (`budget.test.ts`).
    Layer.effect(Budgets, Budgets.make({ gql: UNLIMITED, cdn: UNLIMITED })),
    Layer.succeed(
      Credentials,
      Credentials.of({ token: Redacted.make("test-token"), deviceId: "d".repeat(32) }),
    ),
    Layer.succeed(
      Journal,
      Journal.of({
        record: (answer) => Effect.sync(() => recorded.push(answer)),
        intent: () => Effect.void,
        frame: () => Effect.void,
      }),
    ),
  );
  return { layer, calls, recorded };
};

/** A step of watching or claiming, as `stubPlayback` sees a request. */
export type PlaybackStep = "token" | "usher" | "media" | "segment" | "claim";

/** What the fake answers to each step. Tests change it between ticks. */
export interface PlaybackScript {
  token: Answer;
  usher: Answer;
  media: Answer;
  /** HEAD status of every segment. */
  segment: number;
  claim: Answer;
  /** Steps whose requests fail in transport, as a dropped connection does. */
  readonly down: Set<PlaybackStep>;
  /** Steps that answer only after this long, under `TestClock`. */
  readonly slow: Map<PlaybackStep, number>;
}

export interface SentRequest {
  readonly step: PlaybackStep;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * Twitch's playback and claim surface for tests: `PlaybackAccessToken` and the claim mutation at
 * the GQL URL, usher, media playlists and segments, from recorded answers. Anything else goes
 * to `fallback` (the twin's reads in runtime tests).
 */
export const stubPlayback = (
  script: Partial<Omit<PlaybackScript, "down" | "slow">> = {},
  fallback?: HttpClient.HttpClient,
) => {
  const state: PlaybackScript = {
    token: { status: 200, body: playbackToken.body },
    usher: { status: 200, body: usherMaster.body },
    media: { status: 200, body: mediaPlaylist.body },
    segment: 200,
    claim: { status: 200, body: claimClaimed.body },
    down: new Set(),
    slow: new Map(),
    ...script,
  };
  const requests: Array<SentRequest> = [];
  const http = HttpClient.make((request) => {
    let step: PlaybackStep | undefined;
    let body: unknown;
    if (request.url === GQL_URL && request.body._tag === "Uint8Array") {
      body = JSON.parse(new TextDecoder().decode(request.body.body));
      const name = (body as ReadonlyArray<{ readonly operationName: string }>)[0]?.operationName;
      if (name === "PlaybackAccessToken") step = "token";
      if (name === "DropsPage_ClaimDropRewards") step = "claim";
    } else if (request.url.startsWith(USHER_URL)) step = "usher";
    else if (request.url.includes("/v1/playlist/")) step = "media";
    else if (request.url.includes("/v1/segment/")) step = "segment";
    if (step === undefined) {
      return fallback === undefined
        ? Effect.die(new Error(`stubPlayback: unexpected ${request.method} ${request.url}`))
        : fallback.execute(request);
    }
    const at = step;
    requests.push({
      step: at,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    const answer: Answer =
      at === "segment" ? { status: state.segment, body: "" } : (state[at] as Answer);
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    const respond = state.down.has(at)
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: `${at} down` }),
          }),
        )
      : Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(request.method === "HEAD" ? null : text, { status: answer.status }),
          ),
        );
    const delay = state.slow.get(at);
    return delay === undefined ? respond : Effect.andThen(Effect.sleep(delay), respond);
  });
  return { state, requests, http };
};
