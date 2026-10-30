import { Clock, Data, Duration, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { ChannelId, Millis } from "../core/model.ts";
import { WatchFailure } from "./Actuator.ts";
import { AuthRejected } from "./errors.ts";
import { single, type Gql } from "./gql.ts";
import { Queries, USHER_URL, livePlayback, playbackHeaders } from "./identity.ts";
import type { Journal } from "./journal.ts";
import { lowest, parseMaster, parseMedia } from "./playlist.ts";
import { PlaybackToken, PlaybackTokenValue } from "./wire.ts";

export interface WatchTarget {
  readonly channelId: ChannelId;
  readonly login: string;
}

/** One open watch on one channel. Each `tick` is one `WATCH_INTERVAL` of watching. */
export interface WatchSession {
  readonly tick: Effect.Effect<void, WatchFailure | AuthRejected>;
}

/**
 * How the miner watches a stream. Twitch has changed what counts as watching four times in 2026
 * (research 02 §4), so the method sits behind this one interface and the actuator never knows
 * which it runs. Opening a session sends nothing: every request happens in `tick`, the only
 * place a failure can be reported.
 */
export interface WatchMethod {
  readonly name: string;
  readonly open: (target: WatchTarget) => Effect.Effect<WatchSession>;
}

/** Per request. A CDN that hasn't answered by then is treated as down for this tick. */
export const REQUEST_TIMEOUT = Duration.seconds(10);

/**
 * Usher stops honouring a playback token at its `expires` (20 minutes after issue, live
 * 2026-10-30). Fetch a new one this long before, so a tick never starts on a token about to die.
 */
export const TOKEN_MARGIN: Millis = 60_000;

/** When the token's `expires` can't be read, assume this lifetime. */
export const TOKEN_FALLBACK: Millis = 10 * 60_000;

type Step = "token" | "usher" | "media" | "segment";

/** One step's failure, before it becomes the core's `WatchFailure`. */
class HlsFailure extends Data.TaggedError("HlsFailure")<{
  readonly reason: "offline" | "refused" | "network";
  readonly step: Step;
  readonly detail: string;
}> {}

/** The resolved stream: what a session caches between ticks. */
interface Stream {
  readonly mediaUrl: string;
  readonly variant: number;
  /** When to fetch a fresh token and master playlist, in epoch ms. */
  readonly refreshAt: Millis;
}

/**
 * Status codes, the same at every step (just-mining `hls/Watcher.ts`, TDM `channel.py`): 404 is
 * an offline channel, 403 and 410 a channel that won't play for this account (sub-only, geo, a
 * signed URL no longer honoured), 401 the token. Anything else may pass on the next tick.
 */
const classify = (status: number): HlsFailure["reason"] | "ok" | "auth" => {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "auth";
  if (status === 404) return "offline";
  if (status === 403 || status === 410) return "refused";
  return "network";
};

/**
 * Watching over HLS, Twitch's own player path and the working method since 2026-10-09 (TDM
 * "Change the mining method to playlist HEAD requests"; just-mining the same): a playback token,
 * usher's master playlist, the lowest variant's media playlist, then a `HEAD` of every segment it
 * lists, once per tick. Bodies are never downloaded. The media playlist URL is cached for the
 * session; a 403, 404 or 410 on a cached URL resolves the stream again once before it counts.
 */
export const hlsWatch = (deps: {
  /** Twitch's API: the playback token goes through the paced, recorded GQL client. */
  readonly gql: Gql;
  /** Twitch's CDN: usher, playlists and segments. */
  readonly cdn: HttpClient.HttpClient;
  readonly deviceId: string;
  readonly journal: Journal["Service"];
}): WatchMethod => {
  const headers = playbackHeaders(deps.deviceId);

  const get = (target: WatchTarget, step: Step, request: HttpClientRequest.HttpClientRequest) =>
    deps.cdn.execute(HttpClientRequest.setHeaders(request, headers)).pipe(
      Effect.flatMap((response) =>
        request.method === "HEAD"
          ? Effect.succeed({ status: response.status, text: "" })
          : Effect.map(response.text, (text) => ({ status: response.status, text })),
      ),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new HlsFailure({ reason: "network", step, detail: `no answer for ${target.login}` }),
          ),
      }),
      Effect.catchTag("HttpClientError", (e) =>
        Effect.fail(new HlsFailure({ reason: "network", step, detail: e.message })),
      ),
    );

  const check = (step: Step, status: number) => {
    const kind = classify(status);
    if (kind === "ok") return Effect.void;
    if (kind === "auth") return Effect.fail(new AuthRejected({ reason: `${step} answered 401` }));
    return Effect.fail(
      new HlsFailure({ reason: kind, step, detail: `${step} answered ${status}` }),
    );
  };

  const token = (target: WatchTarget) =>
    deps.gql.request(Queries.PlaybackAccessToken, [livePlayback(target.login)], PlaybackToken).pipe(
      Effect.flatMap((results) => single("PlaybackAccessToken", results)),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(new HlsFailure({ reason: "network", step: "token", detail: "no answer" })),
      }),
      Effect.catchTags({
        TwitchUnavailable: (e) =>
          Effect.fail(new HlsFailure({ reason: "network", step: "token", detail: e.detail })),
        // A rotated hash or a moved field: nothing this channel did. `network` keeps the plan
        // and lets the core's stall detection judge; the error log says what broke.
        TwitchDrift: (e) =>
          Effect.andThen(
            Effect.logError(`watch: PlaybackAccessToken drifted: ${e.detail}`),
            Effect.fail(new HlsFailure({ reason: "network", step: "token", detail: e.detail })),
          ),
      }),
    );

  const resolve = (target: WatchTarget) =>
    Effect.gen(function* () {
      const answer = (yield* token(target)).streamPlaybackAccessToken;
      if (answer === null) {
        const detail = `Twitch issued no playback token for ${target.login}`;
        return yield* new HlsFailure({ reason: "offline", step: "token", detail });
      }
      if (answer.authorization.isForbidden) {
        const detail = `playback forbidden: ${answer.authorization.forbiddenReasonCode}`;
        return yield* new HlsFailure({ reason: "refused", step: "token", detail });
      }
      const now = yield* Clock.currentTimeMillis;
      const expires = Schema.decodeOption(PlaybackTokenValue)(answer.value);
      const refreshAt = Option.match(expires, {
        onNone: () => now + TOKEN_FALLBACK,
        onSome: (v) => Math.max(now, v.expires * 1000 - TOKEN_MARGIN),
      });

      const url = new URL(`${USHER_URL}/${encodeURIComponent(target.login)}.m3u8`);
      url.searchParams.set("sig", answer.signature);
      url.searchParams.set("token", answer.value);
      const master = yield* get(target, "usher", HttpClientRequest.get(url.toString()));
      yield* deps.journal.record({
        operation: "usher",
        variables: { login: target.login },
        status: master.status,
        body: master.text,
      });
      yield* check("usher", master.status);
      const variants = parseMaster(master.text, url.toString());
      if (!variants.ok) {
        return yield* new HlsFailure({ reason: "network", step: "usher", detail: variants.reason });
      }
      // `parseMaster` never returns an empty list.
      const variant = lowest(variants.value)!;
      return { mediaUrl: variant.url, variant: variant.bandwidth, refreshAt } satisfies Stream;
    });

  /** One media playlist read and a `HEAD` of every segment, stopping at the first failure. */
  const beat = (target: WatchTarget, stream: Stream) =>
    Effect.gen(function* () {
      const media = yield* get(target, "media", HttpClientRequest.get(stream.mediaUrl));
      const parsed = media.status === 200 ? parseMedia(media.text, stream.mediaUrl) : undefined;
      const heads: Array<number> = [];
      // A full media playlist every 20 s would fill the recording with segment names; the
      // counts and statuses are what replay needs. A failed answer is kept whole.
      const record = Effect.suspend(() =>
        deps.journal.record({
          operation: "hls",
          variables: { login: target.login },
          status: media.status,
          body:
            parsed?.ok === true
              ? { segments: parsed.value.segments.length, ended: parsed.value.ended, heads }
              : media.text,
        }),
      );
      return yield* Effect.gen(function* () {
        yield* check("media", media.status);
        if (parsed === undefined || !parsed.ok) {
          const detail = parsed?.ok === false ? parsed.reason : "no playlist";
          return yield* new HlsFailure({ reason: "network", step: "media", detail });
        }
        if (parsed.value.ended) {
          const detail = "the playlist ended";
          return yield* new HlsFailure({ reason: "offline", step: "media", detail });
        }
        for (const segment of parsed.value.segments) {
          const head = yield* get(target, "segment", HttpClientRequest.head(segment));
          heads.push(head.status);
          yield* check("segment", head.status);
        }
        return parsed.value.segments.length;
      }).pipe(Effect.ensuring(record));
    });

  const open = (target: WatchTarget) =>
    Effect.sync((): WatchSession => {
      let stream: Stream | undefined;
      let busy = false;
      let ticked = false;

      const run = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        let fresh = false;
        if (stream === undefined || now >= stream.refreshAt) {
          stream = undefined;
          stream = yield* resolve(target);
          fresh = true;
        }
        const current: Stream = stream;
        const segments = yield* beat(target, current).pipe(
          Effect.catchIf(
            (e): e is HlsFailure => !fresh && e._tag === "HlsFailure" && e.reason !== "network",
            (e) =>
              Effect.gen(function* () {
                yield* Effect.logDebug(`watch: ${e.detail}, resolving ${target.login} again`);
                stream = undefined;
                stream = yield* resolve(target);
                return yield* beat(target, stream);
              }),
          ),
        );
        if (!ticked) {
          ticked = true;
          yield* Effect.logInfo(
            `watch: watching ${target.login} over HLS at ${Math.round(current.variant / 1000)} kbit/s`,
          );
        }
        yield* Effect.logDebug(`watch: ticked ${target.login}, ${segments} segments`);
      }).pipe(
        Effect.tapError((e) =>
          e._tag === "HlsFailure" && e.reason !== "network"
            ? Effect.sync(() => (stream = undefined))
            : Effect.void,
        ),
        Effect.catchTag("HlsFailure", (e) =>
          Effect.andThen(
            Effect.logWarning(`watch: ${target.login}: ${e.detail} (${e.reason})`),
            Effect.fail(new WatchFailure({ channelId: target.channelId, reason: e.reason })),
          ),
        ),
      );

      // A tick still running when the next is due (a slow CDN) makes the next one fail
      // `network`: two overlapping beats would credit nothing more.
      const tick = Effect.suspend(() => {
        if (busy) {
          return Effect.fail(new WatchFailure({ channelId: target.channelId, reason: "network" }));
        }
        busy = true;
        return run.pipe(Effect.ensuring(Effect.sync(() => (busy = false))));
      });
      return { tick };
    });

  return { name: "hls", open };
};
