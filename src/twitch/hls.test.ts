import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import type { ChannelId } from "../core/model.ts";
import media from "./fixtures/media-playlist.json" with { type: "json" };
import offline from "./fixtures/usher-offline.json" with { type: "json" };
import token from "./fixtures/playback-token.json" with { type: "json" };
import { CDN_LIMITS, UNLIMITED, makeBudget } from "./budget.ts";
import { makeGql } from "./gql.ts";
import { hlsWatch, TOKEN_MARGIN } from "./hls.ts";
import { DEFAULT_LIMITS, Journal, seal, type Answer } from "./journal.ts";
import { stubPlayback, type PlaybackStep, type PlaybackScript } from "./stub.ts";

const TOKEN = "oauthsecrettoken0123456789";
const DEVICE = "d".repeat(32);
/** When the recorded playback token was issued: it expires 20 minutes later. */
const ISSUED = 1_793_370_704_000;
const target = { channelId: "129405323" as ChannelId, login: "oilrats" };

const setup = (script: Partial<Omit<PlaybackScript, "down" | "slow">> = {}) => {
  const stub = stubPlayback(script);
  const recorded: Array<Answer> = [];
  const journal = Journal.of({
    record: (answer) => Effect.sync(() => void recorded.push(answer)),
    intent: () => Effect.void,
    frame: () => Effect.void,
  });
  const budget = (name: "gql" | "cdn") =>
    Effect.runSync(makeBudget(name, name === "gql" ? UNLIMITED : CDN_LIMITS));
  const credentials = { token: Redacted.make(TOKEN), deviceId: DEVICE };
  const gql = makeGql(stub.http, credentials, journal, budget("gql"));
  const cdn = budget("cdn");
  const method = hlsWatch({
    gql,
    cdn: stub.http,
    budget: cdn,
    deviceId: DEVICE,
    journal,
  });
  const count = (step: PlaybackStep) => stub.requests.filter((r) => r.step === step).length;
  return { ...stub, recorded, method, count, cdn };
};

const failure = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (e) =>
    e._tag === "WatchFailure" ? `WatchFailure:${(e as { reason?: string }).reason}` : e._tag,
  );

const forbidden = {
  status: 200,
  body: [
    {
      data: {
        streamPlaybackAccessToken: {
          ...token.body[0]!.data.streamPlaybackAccessToken,
          authorization: { isForbidden: true, forbiddenReasonCode: "GEOBLOCKED" },
        },
      },
    },
  ],
};

describe("hlsWatch", () => {
  it.effect("resolves the lowest variant, then HEADs every segment with the client's headers", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ISSUED);
      const t = setup();
      const session = yield* t.method.open(target);
      assert.lengthOf(t.requests, 0, "opening sends nothing");
      yield* session.tick;

      assert.deepStrictEqual(
        t.requests.slice(0, 3).map((r) => r.step),
        ["token", "usher", "media"],
      );
      assert.strictEqual(t.count("segment"), 16);
      const usher = new URL(t.requests[1]!.url);
      assert.strictEqual(usher.pathname, "/api/channel/hls/oilrats.m3u8");
      assert.strictEqual(usher.searchParams.get("sig"), "0".repeat(40));
      assert.include(usher.searchParams.get("token") ?? "", '"expires":1793371904');
      assert.include(t.requests[2]!.url, "REDACTED-160p30");
      for (const r of t.requests.slice(1)) {
        assert.strictEqual(r.headers["origin"], "https://www.twitch.tv");
        assert.strictEqual(r.headers["referer"], "https://www.twitch.tv/");
        assert.strictEqual(r.headers["client-id"], "kd1unb4b3q4t58fwlpcbzcbnm76a8fp");
        assert.strictEqual(r.headers["x-device-id"], DEVICE);
        assert.isUndefined(r.headers["authorization"], "the OAuth token never goes to the CDN");
      }
      assert.isTrue(
        t.requests.filter((r) => r.step === "segment").every((r) => r.method === "HEAD"),
      );
      const body = t.requests[0]!.body as ReadonlyArray<{ variables: unknown }>;
      assert.deepStrictEqual(body[0]!.variables, {
        isLive: true,
        login: "oilrats",
        isVod: false,
        vodID: "",
        playerType: "site",
        platform: "web",
      });
    }),
  );

  it.effect("reuses the media playlist, and fetches a new token before the old one expires", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ISSUED);
      const t = setup();
      const session = yield* t.method.open(target);
      yield* session.tick;
      yield* TestClock.adjust("20 seconds");
      yield* session.tick;
      assert.strictEqual(t.count("token"), 1);
      assert.strictEqual(t.count("usher"), 1);
      assert.strictEqual(t.count("media"), 2);
      yield* TestClock.setTime(1_793_371_904_000 - TOKEN_MARGIN);
      yield* session.tick;
      assert.strictEqual(t.count("token"), 2);
      assert.strictEqual(t.count("usher"), 2);
    }),
  );

  it.effect("resolves again once when the cached playlist answers 403, then succeeds", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ISSUED);
      const t = setup();
      const session = yield* t.method.open(target);
      yield* session.tick;
      t.state.media = { status: 403, body: "" };
      // The stub answers every media request alike, so the fresh URL is refused too.
      assert.strictEqual(yield* failure(session.tick), "WatchFailure:refused");
      assert.strictEqual(t.count("token"), 2, "one re-resolve, not a loop");
      t.state.media = media;
      yield* session.tick;
      assert.strictEqual(t.count("token"), 3, "a refused stream is resolved afresh next tick");
    }),
  );

  it.effect("maps usher's answers: 404 offline, 403 and 410 refused, 401 the token", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ISSUED);
      const cases: ReadonlyArray<[PlaybackScript["usher"], string]> = [
        [offline, "WatchFailure:offline"],
        [{ status: 403, body: '[{"error":"Unauthorized"}]' }, "WatchFailure:refused"],
        [{ status: 410, body: "" }, "WatchFailure:refused"],
        [{ status: 401, body: "" }, "AuthRejected"],
        [{ status: 502, body: "<html>" }, "WatchFailure:network"],
        [{ status: 200, body: "<html>" }, "WatchFailure:network"],
      ];
      for (const [usher, expected] of cases) {
        const t = setup({ usher });
        const session = yield* t.method.open(target);
        assert.strictEqual(yield* failure(session.tick), expected, String(usher.status));
        assert.strictEqual(t.count("media"), 0);
      }
    }),
  );

  it.effect("maps the playback token: forbidden refused, none offline, 401 the token", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ISSUED);
      const none = { status: 200, body: [{ data: { streamPlaybackAccessToken: null } }] };
      const cases: ReadonlyArray<[PlaybackScript["token"], string]> = [
        [forbidden, "WatchFailure:refused"],
        [none, "WatchFailure:offline"],
        [{ status: 401, body: { error: "Unauthorized" } }, "AuthRejected"],
        [
          { status: 200, body: [{ errors: [{ message: "service error" }] }] },
          "WatchFailure:network",
        ],
        [
          { status: 200, body: [{ errors: [{ message: "PersistedQueryNotFound" }] }] },
          "WatchFailure:network",
        ],
      ];
      for (const [answer, expected] of cases) {
        const t = setup({ token: answer });
        const session = yield* t.method.open(target);
        assert.strictEqual(yield* failure(session.tick), expected);
        assert.strictEqual(t.count("token"), 1, "a token read is never retried within a tick");
        assert.strictEqual(t.count("usher"), 0);
      }
    }),
  );

  it.effect("counts an ended playlist as offline and a failed segment by its status", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ISSUED);
      const ended = setup({ media: { status: 200, body: "#EXTM3U\n#EXT-X-ENDLIST\n" } });
      const s1 = yield* ended.method.open(target);
      assert.strictEqual(yield* failure(s1.tick), "WatchFailure:offline");

      const gone = setup({ segment: 404 });
      const s2 = yield* gone.method.open(target);
      assert.strictEqual(yield* failure(s2.tick), "WatchFailure:offline");
      assert.strictEqual(gone.count("segment"), 1, "stops at the first failed segment");
    }),
  );

  it.effect("keeps the stream on a transport failure, and a revoked token surfaces anywhere", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ISSUED);
      const t = setup();
      const session = yield* t.method.open(target);
      yield* session.tick;
      t.state.down.add("segment");
      assert.strictEqual(yield* failure(session.tick), "WatchFailure:network");
      t.state.down.delete("segment");
      yield* session.tick;
      assert.strictEqual(t.count("token"), 1, "a network failure keeps the cached playlist");
      t.state.media = { status: 401, body: "" };
      assert.strictEqual(yield* failure(session.tick), "AuthRejected");
    }),
  );

  it.effect("gives up on a CDN that doesn't answer, and never overlaps two ticks", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ISSUED);
      const t = setup();
      t.state.slow.set("usher", 60_000);
      const session = yield* t.method.open(target);
      const first = yield* Effect.forkChild(failure(session.tick));
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* failure(session.tick), "WatchFailure:network");
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(yield* Fiber.join(first), "WatchFailure:network");
      assert.strictEqual(t.count("usher"), 1);
    }),
  );

  it.effect("backs the CDN budget off on a 429, and the next tick sends nothing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ISSUED);
      const t = setup({ segment: 429 });
      const session = yield* t.method.open(target);
      assert.strictEqual(yield* failure(session.tick), "WatchFailure:network");
      const sent = t.requests.length;
      assert.strictEqual(yield* failure(session.tick), "BudgetExhausted");
      assert.strictEqual(t.requests.length, sent);
      yield* TestClock.adjust(CDN_LIMITS.cooldown);
      t.state.segment = 200;
      yield* Effect.forkChild(session.tick);
      yield* TestClock.adjust("1 second");
      assert.isAbove(t.requests.length, sent);
    }),
  );

  it.effect("records answers a recording can keep: no signature, no signed URL", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ISSUED);
      const t = setup();
      const session = yield* t.method.open(target);
      yield* session.tick;
      assert.deepStrictEqual(
        t.recorded.map((a) => a.operation),
        ["PlaybackAccessToken", "usher", "hls"],
      );
      assert.deepStrictEqual(t.recorded[2]!.body, {
        segments: 16,
        ended: false,
        heads: Array.from({ length: 16 }, () => 200),
      });
      for (const answer of t.recorded) {
        const line = seal(
          { kind: "answer", at: 0, ...answer },
          [TOKEN],
          DEFAULT_LIMITS.maxBodyChars,
        );
        assert.notInclude(line, "omitted");
        assert.notInclude(line, "0".repeat(40));
      }
    }),
  );
});
