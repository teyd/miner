import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import { MINUTE, type ChannelId, type Millis } from "../core/model.ts";
import { Queries, USHER_URL, livePlayback, playbackHeaders } from "../twitch/identity.ts";
import { lowest, parseMaster, parseMedia } from "../twitch/playlist.ts";
import { PlaybackToken, PlaybackTokenValue } from "../twitch/wire.ts";
import { ENDED_FOR, TOKEN_LIFETIME } from "./cdn.ts";
import { twinHttp } from "./http.ts";
import { DEFAULT_GOAL_SPEC, SIM_EPOCH, type Fault, type Scenario } from "./scenario.ts";
import { Issued, makeTwin, type TickView, type Twin } from "./twin.ts";
import { buildWorld } from "./world.ts";

const live = { game: 0, viewers: 10, dropsEnabled: true, liveAtStart: true, changes: [] } as const;

/** Channels 0 and 1 end at minute 30; 2 and 3 refuse playback; 4 is live. */
const scenario = (faults: ReadonlyArray<Fault> = []): Scenario => ({
  latencySeed: 1,
  horizonMinutes: 600,
  inventoryLagMinutes: 0,
  settings: { goals: [DEFAULT_GOAL_SPEC] },
  campaigns: [
    {
      game: 0,
      startMinute: -10,
      durationMinutes: 600,
      linked: true,
      allowList: [],
      drops: [{ requiredMinutes: 60, after: null, benefit: "DIRECT_ENTITLEMENT" }],
    },
  ],
  channels: [
    { ...live, refuses: false, changes: [{ atMinute: 30, to: "down" }] },
    { ...live, refuses: false, changes: [{ atMinute: 30, to: "down" }] },
    { ...live, refuses: true },
    { ...live, refuses: true },
    { ...live, refuses: false },
  ],
  faults,
});

const headers = playbackHeaders("0".repeat(32));

interface Answer {
  readonly status: number;
  readonly text: string;
}

/** Sends one request at `at` and waits for its answer. */
const send = (twin: Twin, request: HttpClientRequest.HttpClientRequest, at: Millis) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const fiber = yield* Effect.forkChild(
      Effect.flatMap(twinHttp(twin).execute(request), (response) =>
        Effect.map(response.text, (text): Answer => ({ status: response.status, text })),
      ),
    );
    yield* TestClock.adjust(MINUTE);
    return yield* Fiber.await(fiber);
  });

const ok = (exit: Exit.Exit<Answer, unknown>): Answer => {
  assert.isTrue(Exit.isSuccess(exit));
  return Exit.isSuccess(exit) ? exit.value : { status: 0, text: "" };
};

const token = (twin: Twin, login: string, at: Millis) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post("https://gql.twitch.tv/gql").pipe(
      HttpClientRequest.setHeader("Authorization", "OAuth twin-token"),
      HttpClientRequest.bodyJsonUnsafe([
        {
          operationName: "PlaybackAccessToken",
          variables: livePlayback(login),
          extensions: {
            persistedQuery: { version: 1, sha256Hash: Queries.PlaybackAccessToken.sha256Hash },
          },
        },
      ]),
    );
    const answer = ok(yield* send(twin, request, at));
    const [{ data }] = JSON.parse(answer.text) as [{ data: unknown }];
    return (yield* Schema.decodeUnknownEffect(PlaybackToken)(data)).streamPlaybackAccessToken;
  });

const usher = (login: string, sig: string, value: string) => {
  const url = new URL(`${USHER_URL}/${login}.m3u8`);
  url.searchParams.set("sig", sig);
  url.searchParams.set("token", value);
  return HttpClientRequest.get(url.toString()).pipe(HttpClientRequest.setHeaders(headers));
};

/** A token, usher and the lowest variant's media playlist URL, at `at`. */
const resolve = (twin: Twin, login: string, at: Millis) =>
  Effect.gen(function* () {
    const t = (yield* token(twin, login, at))!;
    const master = ok(yield* send(twin, usher(login, t.signature, t.value), at));
    assert.strictEqual(master.status, 200);
    const variants = parseMaster(master.text, USHER_URL);
    assert.isTrue(variants.ok);
    return variants.ok ? lowest(variants.value)!.url : "";
  });

const get = (url: string) => HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers));
const head = (url: string) =>
  HttpClientRequest.head(url).pipe(HttpClientRequest.setHeaders(headers));

/** A media playlist and a `HEAD` of every segment, at `at`. */
const beat = (twin: Twin, mediaUrl: string, at: Millis) =>
  Effect.gen(function* () {
    const media = ok(yield* send(twin, get(mediaUrl), at));
    const parsed = parseMedia(media.text, mediaUrl);
    const segments = parsed.ok ? parsed.value.segments : [];
    for (const segment of segments) {
      assert.strictEqual(ok(yield* send(twin, head(segment), at + 1_000)).status, 200);
    }
    return { media, ended: parsed.ok && parsed.value.ended, segments: segments.length };
  });

const T = SIM_EPOCH;

describe("twin CDN", () => {
  it.effect("serves a token, usher's variants and playlists, and credits whole beats", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const t = (yield* token(twin, "chan4", T))!;
      const value = yield* Schema.decodeEffect(PlaybackTokenValue)(t.value);
      // Issued when the request lands, after its latency.
      assert.closeTo(value.expires * 1000, T + TOKEN_LIFETIME, 1_000);
      const mediaUrl = yield* resolve(twin, "chan4", T);
      // The lowest variant, signed in its path the way the recorder redacts.
      assert.match(mediaUrl, /\/v1\/playlist\/[A-Za-z0-9_-]{64,}\.m3u8$/);
      assert.include(mediaUrl, "160p30");
      const first = yield* beat(twin, mediaUrl, T + 20_000);
      assert.include([15, 16], first.segments);
      assert.isFalse(first.ended);
      // The first beat opens the view and credits nothing; the next one credits the time since,
      // at most one 20 s interval.
      assert.strictEqual(twin.world.session?.channelId, "ch4" as ChannelId);
      assert.strictEqual(twin.world.session?.creditedSeconds, 0);
      yield* beat(twin, mediaUrl, T + 40_000);
      assert.closeTo(twin.world.session?.creditedSeconds ?? 0, 20, 0.5);
      const ticks = twin.activity.calls.filter((c) => c.kind === "tick");
      assert.lengthOf(ticks, 2);
    }),
  );

  it.effect("credits nothing for a playlist whose segments were not all asked for", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const mediaUrl = yield* resolve(twin, "chan4", T);
      yield* beat(twin, mediaUrl, T + 20_000);
      const media = ok(yield* send(twin, get(mediaUrl), T + 40_000));
      const parsed = parseMedia(media.text, mediaUrl);
      const first = parsed.ok ? parsed.value.segments[0]! : "";
      ok(yield* send(twin, head(first), T + 41_000));
      assert.strictEqual(twin.world.session?.creditedSeconds, 0);
    }),
  );

  it.effect("answers an offline channel 404, and ends its playlist by its index", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const down = T + 30 * MINUTE;
      const even = yield* resolve(twin, "chan0", down - MINUTE);
      const odd = yield* resolve(twin, "chan1", down - MINUTE);
      // Even: `#EXT-X-ENDLIST` for a while, then 404. Odd: 404 at once.
      const ended = yield* beat(twin, even, down + 10_000);
      assert.isTrue(ended.ended);
      assert.strictEqual(ok(yield* send(twin, get(even), down + ENDED_FOR)).status, 404);
      assert.strictEqual(ok(yield* send(twin, get(odd), down + 10_000)).status, 404);
      // Usher: Twitch issues a token for an offline channel, usher answers 404.
      const t = (yield* token(twin, "chan0", down + 20_000))!;
      const offline = ok(yield* send(twin, usher("chan0", t.signature, t.value), down + 20_000));
      assert.deepStrictEqual(offline, {
        status: 404,
        text: JSON.stringify([{ error: "Can not find channel" }]),
      });
    }),
  );

  it.effect("refuses a restricted channel at usher or in the token, and an expired token", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const even = (yield* token(twin, "chan2", T))!;
      assert.isFalse(even.authorization.isForbidden);
      assert.strictEqual(
        ok(yield* send(twin, usher("chan2", even.signature, even.value), T)).status,
        403,
      );
      const odd = (yield* token(twin, "chan3", T))!;
      assert.isTrue(odd.authorization.isForbidden);
      // A token past its 20 minutes: usher and its playlists refuse it.
      const t = (yield* token(twin, "chan4", T))!;
      const late = T + TOKEN_LIFETIME + 1_000;
      assert.strictEqual(
        ok(yield* send(twin, usher("chan4", t.signature, t.value), late)).status,
        403,
      );
      const mediaUrl = yield* resolve(twin, "chan4", T);
      assert.strictEqual(ok(yield* send(twin, get(mediaUrl), late + MINUTE * 2)).status, 410);
      // An unknown login gets no token.
      assert.isNull(yield* token(twin, "nobody", T));
    }),
  );

  it.effect("refuses an Origin with a path, and records the OAuth token sent to the CDN", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const mediaUrl = yield* resolve(twin, "chan4", T);
      const pathed = get(mediaUrl).pipe(
        HttpClientRequest.setHeader("Origin", "https://www.twitch.tv/chan4"),
      );
      assert.strictEqual(ok(yield* send(twin, pathed, T)).status, 403);
      const leaky = get(mediaUrl).pipe(
        HttpClientRequest.setHeader("Authorization", "OAuth twin-token"),
      );
      ok(yield* send(twin, leaky, T));
      assert.lengthOf(twin.activity.leaks, 1);
    }),
  );

  it.effect("hangs, or answers 5xx, in the scenario's fault windows", () =>
    Effect.gen(function* () {
      const twin = makeTwin(
        buildWorld(
          scenario([
            { kind: "timeout", operation: "segment", atMinute: 1, durationSeconds: 60 },
            { kind: "http-5xx", operation: "playlist", atMinute: 3, durationSeconds: 60 },
          ]),
        ),
        { direct: true },
      );
      const mediaUrl = yield* resolve(twin, "chan4", T);
      const media = ok(yield* send(twin, get(mediaUrl), T + MINUTE));
      const parsed = parseMedia(media.text, mediaUrl);
      const segment = parsed.ok ? parsed.value.segments[0]! : "";
      yield* TestClock.setTime(T + MINUTE);
      const hung = yield* Effect.forkChild(twinHttp(twin).execute(head(segment)));
      yield* TestClock.adjust(10 * MINUTE);
      assert.isUndefined(hung.pollUnsafe());
      yield* Fiber.interrupt(hung);
      assert.strictEqual(ok(yield* send(twin, get(mediaUrl), T + 3 * MINUTE)).status, 503);
      assert.deepStrictEqual(
        twin.activity.requests
          .filter((r) => r.operation !== "PlaybackAccessToken")
          .map((r) => r.status),
        [200, 200, "timeout", 503],
      );
    }),
  );

  // B1 review P2 (d): a beat the twin did not credit counted as one.
  it.effect("tells the tick of a whole beat it didn't credit: no beat, and why", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario([{ kind: "revoke-token", atMinute: 1 }])), {
        direct: true,
      });
      const mediaUrl = yield* resolve(twin, "chan4", T);
      const view: TickView = { label: undefined, beat: false };
      twin.live.add(1);
      twin.ticks.set(1, view);
      const issued = { id: 1, command: { _tag: "WatchTick" } as never, at: T + 2 * MINUTE };
      const media = ok(
        yield* send(twin, get(mediaUrl), T + 2 * MINUTE).pipe(
          Effect.provideService(Issued, issued),
        ),
      );
      const parsed = parseMedia(media.text, mediaUrl);
      const segments = parsed.ok ? parsed.value.segments : [];
      const statuses: Array<number> = [];
      for (const segment of segments) {
        const answer = yield* send(twin, head(segment), T + 2 * MINUTE + 1_000).pipe(
          Effect.provideService(Issued, issued),
        );
        statuses.push(ok(answer).status);
      }
      // The revoked token credits nothing, and the last HEAD says so the way the miner reads.
      const call = twin.activity.calls.at(-1);
      assert.deepStrictEqual(call?.kind === "tick" ? [call.channelId, call.result] : [], [
        "ch4" as ChannelId,
        "auth",
      ]);
      assert.strictEqual(statuses.at(-1), 401);
      assert.deepStrictEqual(view, { label: "auth", beat: false });
    }),
  );

  // B1 review P2 (g): usher's `token` and a segment's `dna` went unchecked.
  it.effect("refuses usher without its token's value, and a segment without its dna", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const t = (yield* token(twin, "chan4", T))!;
      const wrong = ok(yield* send(twin, usher("chan4", t.signature, "{}"), T));
      assert.strictEqual(wrong.status, 403);
      const mediaUrl = yield* resolve(twin, "chan4", T);
      const media = ok(yield* send(twin, get(mediaUrl), T + 20_000));
      const parsed = parseMedia(media.text, mediaUrl);
      const segment = parsed.ok ? parsed.value.segments[0]! : "";
      assert.strictEqual(ok(yield* send(twin, head(segment), T + 21_000)).status, 200);
      const forged = segment.replace(/dna=[0-9a-f]+/, `dna=${"f".repeat(40)}`);
      assert.strictEqual(ok(yield* send(twin, head(forged), T + 21_000)).status, 403);
    }),
  );

  // B1 review P2 (h, i): the token in a query or a cookie went unseen, and so did a request
  // without the player's identity.
  it.effect(
    "records the token in a CDN query or cookie, and a request without the player's identity",
    () =>
      Effect.gen(function* () {
        const twin = makeTwin(buildWorld(scenario()), { direct: true });
        const mediaUrl = yield* resolve(twin, "chan4", T);
        assert.deepStrictEqual([twin.activity.leaks, twin.activity.identity], [[], []]);
        ok(yield* send(twin, get(`${mediaUrl}?auth_token=${twin.token}`), T));
        ok(
          yield* send(
            twin,
            get(mediaUrl).pipe(HttpClientRequest.setHeader("Cookie", `auth-token=${twin.token}`)),
            T,
          ),
        );
        assert.deepStrictEqual(twin.activity.leaks, [
          "playlist carried the OAuth token in its query",
          "playlist carried the auth-token cookie to the CDN",
        ]);
        const bare = HttpClientRequest.get(mediaUrl).pipe(
          HttpClientRequest.setHeaders({ "User-Agent": headers["User-Agent"]! }),
        );
        ok(yield* send(twin, bare, T));
        assert.deepStrictEqual(twin.activity.identity, [
          "playlist without the player's client-id, origin, referer",
        ]);
      }),
  );

  // B1 review P2 (c): only a request sent for a finished command was an orphan.
  it.effect("records a request no command sent, unless the twin serves a direct test client", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()));
      yield* resolve(twin, "chan4", T);
      assert.deepStrictEqual(twin.activity.orphans, [
        "PlaybackAccessToken sent by no command",
        "usher sent by no command",
      ]);
    }),
  );

  it.effect("records a request sent for a command no longer in flight", () =>
    Effect.gen(function* () {
      const twin = makeTwin(buildWorld(scenario()), { direct: true });
      const mediaUrl = yield* resolve(twin, "chan4", T);
      twin.live.add(1);
      const issue = (id: number) => ({ id, command: { _tag: "WatchTick" } as never, at: T });
      yield* send(twin, get(mediaUrl), T).pipe(Effect.provideService(Issued, issue(1)));
      assert.lengthOf(twin.activity.orphans, 0);
      yield* send(twin, get(mediaUrl), T).pipe(Effect.provideService(Issued, issue(2)));
      assert.lengthOf(twin.activity.orphans, 1);
    }),
  );
});
