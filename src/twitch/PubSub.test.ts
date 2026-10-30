import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { ChannelId } from "../core/model.ts";
import type { Event } from "../core/protocol.ts";
import { AuthRejected } from "./errors.ts";
import { fakeEdge, listenedOn, type FakeEdge } from "./fakeSocket.ts";
import fixtures from "./fixtures/pubsub-frames.json" with { type: "json" };
import { Journal, type Frame } from "./journal.ts";
import { assign, backoff, make } from "./PubSub.ts";
import { isSealed } from "./redact.ts";

const TOKEN = "pubsubsecrettoken0123456789";
const USER = "900000001";
const DROPS = `user-drop-events.${USER}`;

const ids = (...n: ReadonlyArray<number>) => n.map((i) => `${100000000 + i}` as ChannelId);
const topicsOf = (channels: ReadonlyArray<ChannelId>) =>
  channels.flatMap((c) => [`video-playback-by-id.${c}`, `broadcast-settings-update.${c}`]);

const fixture = (name: string) =>
  [...fixtures.live, ...fixtures.shapes].find((f) => f.name === name)!.text;

/** Lets forked fibers run and moves virtual time by `ms`. */
const pass = (ms = 0) =>
  Effect.gen(function* () {
    for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
    yield* TestClock.adjust(ms);
    for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
  });

const setup = (options: { userId?: Effect.Effect<string, AuthRejected> } = {}) =>
  Effect.gen(function* () {
    const edge = fakeEdge();
    const frames: Array<Frame> = [];
    const journal = Journal.of({
      record: () => Effect.void,
      intent: () => Effect.void,
      frame: (f) => Effect.sync(() => frames.push(f)),
    });
    let validations = 0;
    const pubsub = yield* make({
      token: Redacted.make(TOKEN),
      userId:
        options.userId ??
        Effect.sync(() => {
          validations += 1;
          return USER;
        }),
      connector: edge.connector,
      journal,
    });
    const events: Array<Event> = [];
    yield* Effect.forkScoped(
      Stream.runForEach(pubsub.events, (e) => Effect.sync(() => events.push(e))),
    );
    return { edge, frames, events, pubsub, validations: () => validations };
  });

const open = (edge: FakeEdge) => edge.connections.filter((c) => !c.closed);
const types = (edge: FakeEdge, i: number) =>
  edge.connections[i]!.sent.map((t) => (JSON.parse(t) as { type: string }).type);

describe("assign", () => {
  it("keeps topics where they are and fills the first connection with room", () => {
    const first = assign([], ["a", "b", "c"], 2, 8);
    assert.deepStrictEqual(
      first.slots.map((s) => [...s]),
      [["a", "b"], ["c"]],
    );
    const next = assign(first.slots, ["b", "c", "d"], 2, 8);
    assert.deepStrictEqual(
      next.slots.map((s) => [...s].toSorted()),
      [["b", "d"], ["c"]],
    );
  });

  it("closes the last connection once the topics fit in one fewer", () => {
    const { slots } = assign([new Set(["a", "b"]), new Set(["c", "d"])], ["a", "c", "d"], 2, 8);
    assert.deepStrictEqual(
      slots.map((s) => [...s].toSorted()),
      [["a"], ["c", "d"]],
    );
    const fewer = assign(slots, ["a", "d"], 2, 8);
    assert.deepStrictEqual(
      fewer.slots.map((s) => [...s].toSorted()),
      [["a", "d"]],
    );
    // An emptied first connection closes; the topics on the second stay put.
    const later = assign([new Set(["a"]), new Set(["c", "d"])], ["c", "d"], 2, 8);
    assert.deepStrictEqual(
      later.slots.map((s) => [...s]),
      [[], ["c", "d"]],
    );
    assert.deepStrictEqual(assign(later.slots, [], 2, 8).slots, []);
  });

  it("drops what doesn't fit in the connection limit", () => {
    const { slots, dropped } = assign([], ["a", "b", "c", "d", "e"], 2, 2);
    assert.lengthOf(slots, 2);
    assert.deepStrictEqual(dropped, ["e"]);
  });

  it("holds the core's 100 channels and the account in 5 connections of 50", () => {
    const desired = [DROPS, ...topicsOf(ids(...Array.from({ length: 100 }, (_, i) => i)))];
    const { slots, dropped } = assign([], desired, 50, 8);
    assert.lengthOf(slots, 5);
    assert.lengthOf(dropped, 0);
    for (const slot of slots) assert.isAtMost(slot.size, 50);
  });
});

describe("backoff", () => {
  it("starts at 1 s, doubles and stops at 2 minutes", () => {
    assert.deepStrictEqual(
      [0, 1, 2, 6, 7, 20].map(backoff),
      [1000, 2000, 4000, 64_000, 120_000, 120_000],
    );
  });
});

describe("PubSub", () => {
  it.effect("listens to the account and the channels, sending the token only on the wire", () =>
    Effect.gen(function* () {
      const { edge, frames, pubsub } = yield* setup();
      yield* pubsub.subscribe(ids(1, 2));
      yield* pass();
      assert.lengthOf(edge.connections, 1);
      const conn = edge.connections[0]!;
      assert.deepStrictEqual(
        [...listenedOn(conn)].toSorted(),
        [DROPS, ...topicsOf(ids(1, 2))].toSorted(),
      );
      const listen = JSON.parse(conn.sent[0]!) as { data: { auth_token: string }; nonce: string };
      assert.strictEqual(listen.data.auth_token, TOKEN);
      assert.lengthOf(listen.nonce, 30);
      // Recorded both ways, never with the token.
      assert.isTrue(frames.some((f) => f.direction === "out" && f.text.includes("LISTEN")));
      assert.isTrue(frames.some((f) => f.direction === "in" && f.text.includes("RESPONSE")));
      for (const f of frames) {
        assert.notInclude(f.text, TOKEN);
        assert.isTrue(isSealed(JSON.stringify(f), [TOKEN]), f.text);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("sends only the difference when the channel set changes", () =>
    Effect.gen(function* () {
      const { edge, pubsub, validations } = yield* setup();
      yield* pubsub.subscribe(ids(1, 2));
      yield* pass();
      const conn = edge.connections[0]!;
      const before = conn.sent.length;
      yield* pubsub.subscribe(ids(2, 3));
      yield* pass();
      const changes = conn.sent
        .slice(before)
        .map((t) => JSON.parse(t) as never as { type: string; data: { topics: Array<string> } });
      assert.deepStrictEqual(
        changes.map((c) => [c.type, c.data.topics.toSorted()]),
        [
          ["UNLISTEN", topicsOf(ids(1)).toSorted()],
          ["LISTEN", topicsOf(ids(3)).toSorted()],
        ],
      );
      // The same set again sends nothing; the account id was asked for once.
      yield* pubsub.subscribe(ids(3, 2));
      yield* pass();
      assert.strictEqual(conn.sent.length, before + 2);
      assert.lengthOf(edge.connections, 1);
      assert.strictEqual(validations(), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("closes every connection when nothing is followed", () =>
    Effect.gen(function* () {
      const { edge, pubsub } = yield* setup();
      yield* pubsub.subscribe(ids(1));
      yield* pass();
      yield* pubsub.subscribe([]);
      yield* pass();
      assert.lengthOf(open(edge), 0);
      yield* pass(3_600_000);
      assert.lengthOf(edge.connections, 1, "no reconnect while nothing is followed");
    }).pipe(Effect.scoped),
  );

  it.effect("spreads over connections of 50 topics, and gives one back when the set shrinks", () =>
    Effect.gen(function* () {
      const { edge, pubsub } = yield* setup();
      const many = ids(...Array.from({ length: 30 }, (_, i) => i));
      yield* pubsub.subscribe(many);
      yield* pass();
      assert.lengthOf(open(edge), 2);
      const all = open(edge).flatMap((c) => [...listenedOn(c)]);
      assert.strictEqual(new Set(all).size, 61);
      assert.lengthOf(all, 61, "no topic on two connections");
      for (const c of open(edge)) assert.isAtMost(listenedOn(c).size, 50);
      for (const c of open(edge)) {
        for (const text of c.sent) {
          const topics = (JSON.parse(text) as { data?: { topics: Array<string> } }).data?.topics;
          assert.isAtMost(topics?.length ?? 0, 20);
        }
      }

      yield* pubsub.subscribe(many.slice(0, 10));
      yield* pass();
      assert.lengthOf(open(edge), 1);
      assert.deepStrictEqual(
        [...listenedOn(open(edge)[0]!)].toSorted(),
        [DROPS, ...topicsOf(many.slice(0, 10))].toSorted(),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reports its sockets: wanted, listening, topics, and those that didn't fit", () =>
    Effect.gen(function* () {
      const { edge, pubsub } = yield* setup();
      assert.deepStrictEqual(yield* pubsub.status, {
        connections: 0,
        listening: 0,
        topics: 0,
        dropped: 0,
      });
      yield* pubsub.subscribe(ids(...Array.from({ length: 30 }, (_, i) => i)));
      yield* pass();
      assert.deepStrictEqual(yield* pubsub.status, {
        connections: 2,
        listening: 2,
        topics: 61,
        dropped: 0,
      });
      // A socket that drops is wanted but not listening until it reconnects.
      edge.refuse = 1;
      open(edge)[0]!.drop("gone");
      yield* pass();
      assert.include(yield* pubsub.status, { connections: 2, listening: 1 });
      yield* pass(5_000);
      assert.include(yield* pubsub.status, { connections: 2, listening: 2 });
      yield* pubsub.subscribe([]);
      yield* pass();
      assert.include(yield* pubsub.status, { connections: 0, listening: 0, topics: 0 });
      // 8 connections of 50 topics hold 199 channels and the account; the rest are dropped.
      yield* pubsub.subscribe(ids(...Array.from({ length: 205 }, (_, i) => i)));
      yield* pass();
      assert.include(yield* pubsub.status, { connections: 8, topics: 400, dropped: 11 });
    }).pipe(Effect.scoped),
  );

  it.effect("PINGs every 4 minutes and reconnects and resubscribes when no PONG comes", () =>
    Effect.gen(function* () {
      const { edge, pubsub } = yield* setup();
      yield* pubsub.subscribe(ids(1));
      yield* pass();
      yield* pass(4 * 60_000);
      assert.include(types(edge, 0), "PING");
      assert.isFalse(edge.connections[0]!.closed, "answered PING keeps the connection");

      edge.answer.ping = false;
      yield* pass(4 * 60_000);
      yield* pass(9_999);
      assert.isFalse(edge.connections[0]!.closed);
      yield* pass(1);
      assert.isTrue(edge.connections[0]!.closed, "no PONG within 10 s");
      yield* pass(2_000); // backoff 1 s plus up to 1 s of jitter
      assert.lengthOf(edge.connections, 2);
      assert.deepStrictEqual(
        [...listenedOn(edge.connections[1]!)].toSorted(),
        [DROPS, ...topicsOf(ids(1))].toSorted(),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reconnects when Twitch asks to, and when the socket drops", () =>
    Effect.gen(function* () {
      const { edge, pubsub } = yield* setup();
      yield* pubsub.subscribe(ids(1, 2));
      yield* pass();
      edge.connections[0]!.push(fixture("RECONNECT"));
      yield* pass();
      assert.isTrue(edge.connections[0]!.closed);
      yield* pass(2_000);
      assert.lengthOf(edge.connections, 2);
      assert.strictEqual(listenedOn(edge.connections[1]!).size, 5);

      edge.connections[1]!.drop("1006");
      yield* pass(2_000);
      assert.lengthOf(edge.connections, 3);
      assert.strictEqual(listenedOn(edge.connections[2]!).size, 5);
    }).pipe(Effect.scoped),
  );

  it.effect("backs off 1, 2, 4 s while connecting fails, and resets once listening", () =>
    Effect.gen(function* () {
      const { edge, pubsub } = yield* setup();
      edge.refuse = 3;
      yield* pubsub.subscribe(ids(1));
      for (let i = 0; i < 10; i++) yield* pass(1_000);
      assert.lengthOf(edge.attempts, 4);
      const gaps = edge.attempts.slice(1).map((t, i) => t - edge.attempts[i]!);
      for (const [gap, base] of gaps.map((g, i) => [g, backoff(i)] as const)) {
        assert.isAtLeast(gap, base);
        assert.isAtMost(gap, base + 1_000);
      }
      assert.lengthOf(open(edge), 1);
      // Listening reset the count: the next drop reconnects after 1 s, not 8.
      edge.connections[0]!.drop("1006");
      yield* pass(2_000);
      assert.lengthOf(edge.attempts, 5);
    }).pipe(Effect.scoped),
  );

  it.effect("reconnects when a LISTEN goes unanswered or is refused", () =>
    Effect.gen(function* () {
      const { edge, pubsub } = yield* setup();
      edge.answer.listen = false;
      yield* pubsub.subscribe(ids(1));
      yield* pass(10_000);
      assert.isTrue(edge.connections[0]!.closed, "no RESPONSE within 10 s");
      edge.answer.listen = "ERR_BADAUTH";
      yield* pass(2_000);
      assert.lengthOf(edge.connections, 2);
      yield* pass();
      assert.isTrue(edge.connections[1]!.closed, "ERR_BADAUTH");
      edge.answer.listen = "";
      yield* pass(5_000);
      assert.lengthOf(open(edge), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("tells the core what the frames say, and only that", () =>
    Effect.gen(function* () {
      const { edge, events, frames, pubsub } = yield* setup();
      // The fixtures' channel is 100000001.
      yield* pubsub.subscribe(ids(1));
      yield* pass();
      const conn = edge.connections[0]!;
      const drops = (name: string) => fixture(name);
      conn.push(drops("drop-progress"));
      conn.push(drops("drop-claim"));
      conn.push(fixture("stream-up"));
      conn.push(fixture("viewcount"));
      conn.push(fixture("commercial"));
      conn.push(fixture("broadcast_settings_update"));
      conn.push(fixture("stream-down"));
      // Unknown, malformed, and a frame for a channel nobody follows: dropped, no crash.
      conn.push('{"type":"SOMETHING_NEW"}');
      conn.push("{not json");
      conn.push(
        '{"type":"MESSAGE","data":{"topic":"video-playback-by-id.100000001","message":"{\\"type\\":\\"stream-up\\""}}',
      );
      conn.push(fixture("stream-up").replace("100000001", "100000099"));
      conn.push(fixture("stream-down"));
      yield* pass();
      assert.deepStrictEqual(
        events.map((e) => e._tag),
        ["DropProgress", "DropClaimable", "StreamUp", "GameChanged", "StreamDown", "StreamDown"],
      );
      assert.isFalse(conn.closed);
      // viewcount comes every ~30 s per channel: never recorded.
      assert.isFalse(frames.some((f) => f.text.includes("viewcount")));
      assert.isTrue(
        frames.some((f) => f.text.includes("commercial") === false && f.text.includes("stream-up")),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("makes nothing up for a reconnect gap", () =>
    Effect.gen(function* () {
      const { edge, events, pubsub } = yield* setup();
      yield* pubsub.subscribe(ids(1));
      yield* pass();
      edge.refuse = 5;
      edge.connections[0]!.drop("1006");
      yield* pass(60_000);
      assert.lengthOf(open(edge), 0, "still refused");
      yield* pass(120_000);
      assert.lengthOf(open(edge), 1);
      assert.strictEqual(listenedOn(open(edge)[0]!).size, 3, "listening again");
      // The channel may have gone live or offline meanwhile; nothing is guessed.
      assert.lengthOf(events, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("follows the channels without the account when its id can't be read", () =>
    Effect.gen(function* () {
      const { edge, pubsub } = yield* setup({
        userId: Effect.fail(new AuthRejected({ reason: "401" })),
      });
      yield* pubsub.subscribe(ids(1));
      yield* pass();
      assert.deepStrictEqual(
        [...listenedOn(edge.connections[0]!)].toSorted(),
        topicsOf(ids(1)).toSorted(),
      );
    }).pipe(Effect.scoped),
  );
});
