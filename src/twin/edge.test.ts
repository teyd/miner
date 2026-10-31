import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import * as Socket from "effect/socket/Socket";
import { TestClock } from "effect/testing";
import type { ChannelId, DropId, DropInstanceId, GameId } from "../core/model.ts";
import { Event } from "../core/protocol.ts";
import { classify, decodeFrame, topicOf } from "../twitch/frames.ts";
import fixtures from "../twitch/fixtures/pubsub-frames.json" with { type: "json" };
import { PUBSUB_URL } from "../twitch/identity.ts";
import {
  PING_DEADLINE,
  RECONNECT_GRACE,
  RECONNECT_STAGGER,
  SOCKETS_PER_IP,
  deliver,
  runEdge,
  scheduleFaults,
  sendFrames,
  webSocketConstructor,
  wireOf,
  type TwinWebSocket,
} from "./edge.ts";
import { DEFAULT_GOAL_SPEC, SIM_EPOCH, type Fault, type Scenario } from "./scenario.ts";
import { bindClock, makeTwin, type Twin } from "./twin.ts";
import { buildWorld } from "./world.ts";

const scenario = (faults: ReadonlyArray<Fault> = []): Scenario => ({
  latencySeed: 1,
  horizonMinutes: 600,
  inventoryLagMinutes: 0,
  settings: { goals: [DEFAULT_GOAL_SPEC] },
  campaigns: [
    {
      game: 2,
      startMinute: -10,
      durationMinutes: 600,
      linked: true,
      allowList: [],
      drops: [{ requiredMinutes: 30, after: null, benefit: "DIRECT_ENTITLEMENT" }],
    },
  ],
  channels: [
    {
      game: 0,
      viewers: 10,
      dropsEnabled: true,
      refuses: false,
      liveAtStart: true,
      changes: [{ atMinute: 10, to: "game-2" }],
    },
  ],
  faults,
});

/** A socket from the twin's constructor, with what it received. */
const open = (twin: Twin) => {
  const make = Context.get(
    Effect.runSync(Layer.build(webSocketConstructor(twin)).pipe(Effect.scoped)),
    Socket.WebSocketConstructor,
  );
  const ws = make(PUBSUB_URL) as TwinWebSocket;
  const received: Array<string> = [];
  const closed: Array<number> = [];
  ws.addEventListener("message", (e: { readonly data: string }) => received.push(e.data));
  ws.addEventListener("close", (e: { readonly code: number }) => closed.push(e.code));
  return { ws, received, closed };
};

const listen = (topics: ReadonlyArray<string>, nonce = "n1", token = "twin-token") =>
  JSON.stringify({ type: "LISTEN", nonce, data: { topics, auth_token: token } });

const ch0 = "ch0" as ChannelId;

describe("twin PubSub edge", () => {
  it("answers PING with Twitch's padded PONG, and LISTEN with the nonce", () => {
    const twin = makeTwin(buildWorld(scenario()));
    const { ws, received } = open(twin);
    ws.send(JSON.stringify({ type: "PING" }));
    ws.send(listen(["video-playback-by-id.ch0"], "abc"));
    ws.send(listen(["video-playback-by-id.ch0"], "def", ""));
    assert.deepStrictEqual(received, [
      '{ "type": "PONG" }\r\n',
      '{"type":"RESPONSE","error":"","nonce":"abc"}',
      '{"type":"RESPONSE","error":"ERR_BADAUTH","nonce":"def"}',
    ]);
    assert.deepStrictEqual([...ws.topics], ["video-playback-by-id.ch0"]);
    for (const text of received) assert.strictEqual(decodeFrame(text)._tag, "ok");
  });

  // B1 review P1-1: any non-empty token was accepted.
  it("answers ERR_BADAUTH to a LISTEN with a token the twin never issued, and records it", () => {
    const twin = makeTwin(buildWorld(scenario()), { token: "the-account-token" });
    const { ws, received } = open(twin);
    ws.send(listen(["video-playback-by-id.ch0"], "a", "twin-token"));
    ws.send(listen(["video-playback-by-id.ch0"], "b", "the-account-token"));
    assert.deepStrictEqual(received, [
      '{"type":"RESPONSE","error":"ERR_BADAUTH","nonce":"a"}',
      '{"type":"RESPONSE","error":"","nonce":"b"}',
    ]);
    assert.deepStrictEqual(twin.activity.wrongTokens, [
      "LISTEN on socket 0 sent a token the twin never issued",
    ]);
  });

  it("holds 50 topics per socket and 10 sockets per IP, and records a client past them", () => {
    const twin = makeTwin(buildWorld(scenario()));
    const { ws, received } = open(twin);
    const topics = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => `video-playback-by-id.${from + i}`);
    ws.send(listen(topics(50)));
    ws.send(listen(topics(1, 50), "over"));
    assert.strictEqual(ws.topics.size, 50);
    assert.include(received.at(-1)!, "ERR_BADMESSAGE");
    assert.lengthOf(twin.activity.budget, 1);
    for (let i = 1; i < SOCKETS_PER_IP; i++) assert.strictEqual(open(twin).ws.readyState, 1);
    assert.strictEqual(open(twin).ws.readyState, 3);
    assert.lengthOf(twin.activity.budget, 2);
  });

  it("delivers frames only to sockets listening to their topic, unless frames are down", () => {
    const twin = makeTwin(
      buildWorld(scenario([{ kind: "frames-down", atMinute: 20, durationSeconds: 60 }])),
    );
    const a = open(twin);
    const b = open(twin);
    a.ws.send(listen(["broadcast-settings-update.ch0"]));
    const changed = {
      at: SIM_EPOCH + 10 * 60_000 + 1_000,
      event: Event.GameChanged({ channelId: ch0, gameId: "509663" as GameId }),
    };
    deliver(twin, changed, changed.at);
    assert.lengthOf(a.received, 2);
    assert.lengthOf(b.received, 0);
    assert.deepStrictEqual(twin.activity.delivered, [{ at: changed.at, channelId: ch0 }]);
    deliver(twin, { ...changed, at: SIM_EPOCH + 20 * 60_000 }, SIM_EPOCH + 20 * 60_000);
    assert.lengthOf(a.received, 2);
  });

  it("writes every frame so the miner's decoder reads back the event it stands for", () => {
    const twin = makeTwin(buildWorld(scenario()));
    const at = SIM_EPOCH + 10 * 60_000 + 1_000;
    const events = [
      Event.DropProgress({ dropId: "c0-d0" as DropId, minutes: 7 }),
      Event.DropClaimable({ dropId: "c0-d0" as DropId, instanceId: "c0-d0#i" as DropInstanceId }),
      Event.StreamUp({ channelId: ch0 }),
      Event.StreamDown({ channelId: ch0 }),
      Event.GameChanged({ channelId: ch0, gameId: "509663" as GameId }),
    ];
    for (const event of events) {
      const decoded = wireOf(twin, { at, event, channelId: ch0 }).flatMap(({ topic, message }) => {
        const c = classify(topicOf(topic)!, JSON.stringify(message));
        return c._tag === "event" ? [c.event] : [];
      });
      // A `stream-up` comes with a `viewcount`, which the miner ignores.
      assert.deepStrictEqual(decoded, [event]);
    }
    // Field for field the shape recorded live on 2026-10-30.
    const recorded = (name: string) => fixtures.live.find((f) => f.name === name)!.text;
    const live = JSON.parse(
      (JSON.parse(recorded("drop-progress-live")) as { data: { message: string } }).data.message,
    ) as { data: object };
    const progress = wireOf(twin, { at, event: events[0]!, channelId: ch0 })[0]!.message as {
      type: string;
      data: object;
    };
    assert.strictEqual(progress.type, "drop-progress");
    assert.deepStrictEqual(Object.keys(progress.data), Object.keys(live.data));
    assert.deepInclude(progress.data, { channel_id: "ch0", required_progress_min: 30 });
    assert.strictEqual(recorded("RECONNECT"), '{ "type": "RECONNECT" }\r\n');
  });

  it.effect("closes a socket that went five minutes without a PING, and records it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const twin = makeTwin(buildWorld(scenario()));
      yield* bindClock(twin);
      yield* Effect.forkScoped(runEdge(twin));
      const quiet = open(twin);
      const pinging = open(twin);
      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust(4 * 60_000);
        pinging.ws.send(JSON.stringify({ type: "PING" }));
      }
      assert.deepStrictEqual([quiet.closed, pinging.closed], [[1006], []]);
      assert.deepStrictEqual(twin.activity.budget, [
        `socket 0 sent no PING for ${PING_DEADLINE / 1000} s`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("sends scheduled frames at their time, RECONNECTs a few seconds apart, outages", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const twin = makeTwin(
        buildWorld(
          scenario([
            { kind: "pubsub-reconnect", atMinute: 5 },
            { kind: "pubsub-outage", atMinute: 20, durationSeconds: 60 },
          ]),
        ),
      );
      yield* bindClock(twin);
      yield* Effect.forkScoped(runEdge(twin));
      scheduleFaults(twin);
      const a = open(twin);
      const b = open(twin);
      a.ws.send(listen(["broadcast-settings-update.ch0"]));
      sendFrames(twin, [
        {
          at: SIM_EPOCH + 10 * 60_000 + 1_000,
          event: Event.GameChanged({ channelId: ch0, gameId: "509663" as GameId }),
        },
      ]);
      yield* TestClock.adjust(5 * 60_000);
      assert.include(a.received.at(-1)!, "RECONNECT");
      assert.notInclude(b.received.join(), "RECONNECT");
      yield* TestClock.adjust(RECONNECT_STAGGER);
      assert.strictEqual(b.received.at(-1), '{ "type": "RECONNECT" }\r\n');
      // A socket the edge asked to reconnect closes without blame.
      a.ws.close();
      assert.deepStrictEqual(twin.activity.closes.at(-1), {
        at: SIM_EPOCH + 5 * 60_000 + RECONNECT_STAGGER,
        socket: 0,
        excused: true,
        remaining: 1,
      });
      const c = open(twin);
      c.ws.send(listen(["broadcast-settings-update.ch0"]));
      yield* TestClock.adjust(5 * 60_000 + 1_000);
      assert.include(c.received.at(-1)!, "broadcast_settings_update");
      // The outage drops every socket and refuses new ones until it ends.
      yield* TestClock.adjust(10 * 60_000);
      assert.deepStrictEqual([b.closed, c.closed], [[1006], [1006]]);
      assert.strictEqual(open(twin).ws.readyState, 3);
      yield* TestClock.adjust(60_000);
      assert.strictEqual(open(twin).ws.readyState, 1);
      // A socket closed with no cause is the client's doing.
      const d = open(twin);
      d.ws.close();
      assert.isFalse(twin.activity.closes.at(-1)!.excused);
      // Both obeyed their RECONNECT: a closes and c opened in time, b had already reconnected.
      assert.deepStrictEqual(twin.activity.reconnects, []);
    }).pipe(Effect.scoped),
  );

  // B1 review P2 (b): a client could ignore RECONNECT forever.
  it.effect("records a socket that stays after its RECONNECT, and closes it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIM_EPOCH);
      const twin = makeTwin(buildWorld(scenario([{ kind: "pubsub-reconnect", atMinute: 5 }])));
      yield* bindClock(twin);
      yield* Effect.forkScoped(runEdge(twin));
      scheduleFaults(twin);
      const stays = open(twin);
      const obeys = open(twin);
      yield* TestClock.adjust(5 * 60_000 + RECONNECT_STAGGER);
      obeys.ws.close();
      open(twin);
      yield* TestClock.adjust(RECONNECT_GRACE);
      assert.deepStrictEqual(twin.activity.reconnects, [
        {
          socket: 0,
          at: SIM_EPOCH + 5 * 60_000,
          checkedAt: SIM_EPOCH + 5 * 60_000 + RECONNECT_GRACE,
          closed: false,
          reconnected: true,
          remaining: 2,
        },
      ]);
      assert.deepStrictEqual(stays.closed, [1006]);
    }).pipe(Effect.scoped),
  );
});
