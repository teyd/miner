import { Schema } from "effect";
import type { HttpClientRequest } from "effect/http";
import type { ChannelId, Millis } from "../core/model.ts";
import { USHER_URL } from "../twitch/identity.ts";
import { PlaybackToken } from "../twitch/wire.ts";
import { sendFrames } from "./edge.ts";
import { SIM_EPOCH, type Operation } from "./scenario.ts";
import type { Issue, Label, Twin } from "./twin.ts";
import { ACCOUNT, channelOf, liveAt, tick, type TickResult } from "./world.ts";

/**
 * Twitch's playback path at wire level (research 02 §4, live 2026-10-30): a playback token over
 * GQL, usher's master playlist, the variants' media playlists and their segments. The twin
 * credits a watch when it sees the pattern Twitch credited live: a media playlist and a `HEAD`
 * of every segment it listed (`tick` in `world.ts`).
 */

/** Usher stops honouring a token 20 minutes after issue (live 2026-10-30). */
export const TOKEN_LIFETIME: Millis = 20 * 60_000;

/** Segments are 2 s long (live 2026-10-30). */
const SEGMENT: Millis = 2_000;

/**
 * After a stream ends, the media playlist of a channel at an even index ends with
 * `#EXT-X-ENDLIST` this long, then answers 404; at an odd index it answers 404 at once. Both are
 * how an HLS origin can end a stream; which Twitch does, and for how long, is unrecorded
 * (inference), so the twin serves both and the client must read both as offline.
 */
export const ENDED_FOR: Millis = 90_000;

/** The CDN keeps a segment this long (inference). */
const SEGMENT_KEPT: Millis = 5 * 60_000;

export const CDN_HOSTS = {
  playlist: "https://twin.playlist.ttvnw.net/v1/playlist/",
  segment: "https://twin.j.cloudfront.hls.ttvnw.net/v1/segment/",
} as const;

/** Variants as usher lists them live, best first (2026-10-30: 720p60 down to 160p30). */
const VARIANTS = [
  { name: "720p60", bandwidth: 3_422_999, resolution: "1280x720" },
  { name: "480p30", bandwidth: 1_427_999, resolution: "852x480" },
  { name: "360p30", bandwidth: 630_000, resolution: "640x360" },
  { name: "160p30", bandwidth: 230_000, resolution: "284x160" },
] as const;

/**
 * The IP usher's answers name: a documentation address (RFC 5737), never a viewer's. Named here,
 * so the playlist line below never reads as a real `USER-IP` to the secret guard.
 */
const VIEWER_IP = "192.0.2.1";

/** What the CDN answers, and how Twitch means it. */
export interface Served {
  readonly status: number;
  readonly body: string;
  readonly label: Label;
}

/** Which CDN operation a URL is, if any. */
export const cdnOperation = (url: string): Operation | undefined =>
  url.startsWith(`${USHER_URL}/`)
    ? "usher"
    : url.startsWith(CDN_HOSTS.playlist)
      ? "playlist"
      : url.startsWith(CDN_HOSTS.segment)
        ? "segment"
        : undefined;

const byLogin = (twin: Twin, login: string) => twin.world.channels.find((ch) => ch.login === login);

/**
 * `PlaybackAccessToken` for a login. An unknown login gets none; a refusing channel at an odd
 * index is forbidden here, one at an even index at usher. `hlsWatch` reads both as refused; which
 * one a sub-only or geo-blocked channel gets live is unrecorded (research 02 §4).
 */
export const playbackToken = (twin: Twin, login: string, now: Millis) => {
  const channel = byLogin(twin, login);
  if (channel === undefined) {
    return Schema.encodeSync(PlaybackToken)({ streamPlaybackAccessToken: null });
  }
  const forbidden = channel.refuses && Number(channel.id.slice(2)) % 2 === 1;
  const signature = (twin.cdn.nextToken++).toString(16).padStart(40, "0");
  const expiresAt = now + TOKEN_LIFETIME;
  const value = JSON.stringify({
    adblock: false,
    authorization: { forbidden, reason: forbidden ? "geoblock" : "" },
    blackout_enabled: false,
    channel: login,
    channel_id: channel.id,
    device_id: "twin-device",
    expires: Math.floor(expiresAt / 1000),
    platform: "web",
    player_type: "site",
    subscriber: false,
    user_id: Number(ACCOUNT.userId),
    user_ip: VIEWER_IP,
    version: 3,
  });
  twin.cdn.tokens.set(signature, { login, channelId: channel.id, expiresAt, value });
  return Schema.encodeSync(PlaybackToken)({
    streamPlaybackAccessToken: {
      value,
      signature,
      authorization: {
        isForbidden: forbidden,
        forbiddenReasonCode: forbidden ? "GEOBLOCKED" : "NONE",
      },
    },
  });
};

const json = (body: unknown) => JSON.stringify(body);

const offline = (): Served => ({
  status: 404,
  body: json([{ error: "Can not find channel" }]),
  label: "offline",
});
const refused = (detail: string): Served => ({
  status: 403,
  body: json([{ error: detail, error_code: "unauthorized_entitlements" }]),
  label: "refused",
});

/** When the channel's current offline phase began, if it is offline. */
const offlineSince = (twin: Twin, channelId: ChannelId, now: Millis): Millis | undefined => {
  const phases = channelOf(twin.world, channelId)?.phases ?? [];
  const current = phases.findLast((p) => p.at <= now) ?? phases[0];
  return current === undefined || current.live ? undefined : current.at;
};

/** The media sequence number of the segment that ends at `at`, counted from a day before. */
const sequenceAt = (at: Millis) => Math.floor((at - SIM_EPOCH + 86_400_000) / SEGMENT);

/**
 * Signed paths as Twitch's: one opaque segment of 64 or more URL-safe characters
 * (`/v1/playlist/CuUF….m3u8`, live 2026-10-30), which the recorder redacts. The twin's carry the
 * token's signature and what they name, padded.
 */
const signedPath = (kind: "C" | "S", signature: string, detail: string) =>
  `${kind}${signature}${detail}`.padEnd(64, "x");

const readPath = (url: string) => {
  const name = url.slice(url.lastIndexOf("/") + 1).replace(/\.(m3u8|ts)(\?.*)?$/, "");
  return { signature: name.slice(1, 41), detail: name.slice(41).replace(/x+$/, "") };
};

const master = (signature: string) =>
  [
    "#EXTM3U",
    `#EXT-X-TWITCH-INFO:NODE="twin",MANIFEST-NODE-TYPE="weaver_cluster",USER-IP="${VIEWER_IP}",B="false"`,
    ...VARIANTS.flatMap((v) => [
      `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${v.name}",NAME="${v.name}",AUTOSELECT=YES,DEFAULT=YES`,
      `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution},CODECS="avc1.4D401F,mp4a.40.2",VIDEO="${v.name}"`,
      `${CDN_HOSTS.playlist}${signedPath("C", signature, v.name)}.m3u8`,
    ]),
    "",
  ].join("\n");

/** 15 or 16 segments of 2 s, as live; the last one ends at `until`. */
const media = (signature: string, until: Millis, ended: boolean) => {
  const last = sequenceAt(until);
  const count = last % 2 === 0 ? 16 : 15;
  const segments = Array.from({ length: count }, (_, i) => last - count + 1 + i);
  const url = (n: number) =>
    `${CDN_HOSTS.segment}${signedPath("S", signature, String(n))}.ts?dna=${signature}`;
  return {
    urls: segments.map(url),
    text: [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:6",
      `#EXT-X-MEDIA-SEQUENCE:${segments[0]}`,
      ...segments.flatMap((n) => ["#EXTINF:2.000,live", url(n)]),
      ...(ended ? ["#EXT-X-ENDLIST"] : []),
      "",
    ].join("\n"),
  };
};

/**
 * One CDN request at `now`, sent at `startedAt` for `issued`. The CDN answers 403 to an `Origin`
 * with a path (just-mining `clients.ts`, live 2026-10-28), to a restricted channel and at usher
 * to a token past its expiry; 404 to an offline channel. It never needs the OAuth token.
 */
export const serve = (
  twin: Twin,
  request: HttpClientRequest.HttpClientRequest,
  operation: Operation,
  startedAt: Millis,
  now: Millis,
  issued: Issue | undefined,
): Served => {
  const origin = request.headers["origin"];
  if (origin !== undefined && !/^https?:\/\/[^/]+\/?$/.test(origin)) return refused("bad origin");
  switch (operation) {
    case "usher": {
      const url = new URL(request.url);
      const login = decodeURIComponent(
        url.pathname
          .split("/")
          .at(-1)!
          .replace(/\.m3u8$/, ""),
      );
      const token = twin.cdn.tokens.get(url.searchParams.get("sig") ?? "");
      if (
        token === undefined ||
        token.login !== login ||
        url.searchParams.get("token") !== token.value ||
        now >= token.expiresAt
      ) {
        return refused("invalid playback token");
      }
      const channel = channelOf(twin.world, token.channelId)!;
      if (!liveAt(twin.world, channel.id, now)) return offline();
      if (channel.refuses) return refused("channel restricted");
      return { status: 200, body: master(url.searchParams.get("sig")!), label: "ok" };
    }
    case "playlist": {
      const { signature } = readPath(request.url);
      const token = twin.cdn.tokens.get(signature);
      if (token === undefined) return offline();
      // A signed URL past its token: 410, "no longer honoured" (hls.ts; the code is inference).
      if (now >= token.expiresAt) return { ...refused("expired playback token"), status: 410 };
      const since = offlineSince(twin, token.channelId, now);
      const endsWithList = Number(token.channelId.slice(2)) % 2 === 0;
      if (since !== undefined && (!endsWithList || now - since >= ENDED_FOR)) return offline();
      const playlist = media(signature, since ?? now, since !== undefined);
      if (since === undefined) {
        twin.cdn.beats.set(token.channelId, {
          startedAt,
          remaining: new Set(playlist.urls),
          issued,
        });
      }
      return { status: 200, body: playlist.text, label: since === undefined ? "ok" : "offline" };
    }
    case "segment": {
      const { signature, detail } = readPath(request.url);
      const token = twin.cdn.tokens.get(signature);
      const n = Number(detail);
      if (token === undefined || n > sequenceAt(now) || n < sequenceAt(now - SEGMENT_KEPT)) {
        return { status: 404, body: "", label: "offline" };
      }
      // The edge signs each segment URL with its token's `dna` (live 2026-10-30).
      if (new URL(request.url).searchParams.get("dna") !== signature) {
        return refused("bad segment signature");
      }
      switch (completeBeat(twin, token.channelId, request.url, now, issued)) {
        case "offline":
          return offline();
        case "refused":
          return refused("channel restricted");
        // The twin credits nothing on a revoked token; the CDN says so the one way the miner
        // reads, rather than answer a beat it didn't count (inference: Twitch's CDN is unrecorded).
        case "auth":
          return { status: 401, body: "", label: "auth" };
        default:
          return { status: 200, body: "", label: "ok" };
      }
    }
    default:
      return offline();
  }
};

/**
 * A `HEAD` of the last segment the latest playlist listed completes a beat, which credits.
 * Returns what the twin made of the beat; `undefined` for a segment that completed none.
 */
const completeBeat = (
  twin: Twin,
  channelId: ChannelId,
  url: string,
  now: Millis,
  issued: Issue | undefined,
): TickResult | undefined => {
  const beat = twin.cdn.beats.get(channelId);
  if (beat === undefined || !beat.remaining.delete(url) || beat.remaining.size > 0) {
    return undefined;
  }
  twin.cdn.beats.delete(channelId);
  const ticked = tick(twin.world, channelId, now);
  twin.world = ticked.world;
  sendFrames(twin, ticked.frames);
  const sentAt = beat.issued?.at;
  twin.activity.credits.push(
    ...ticked.credits.map((c) => (sentAt === undefined ? c : { ...c, sentAt })),
  );
  twin.activity.calls.push({
    kind: "tick",
    at: beat.startedAt,
    endedAt: now,
    channelId,
    result: ticked.result,
  });
  const view = issued === undefined ? undefined : twin.ticks.get(issued.id);
  if (view !== undefined && beat.issued?.id === issued?.id && ticked.result === "ticked") {
    view.beat = true;
  }
  return ticked.result;
};
