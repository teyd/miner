import { Clock, Effect, Layer, Queue } from "effect";
import * as Socket from "effect/socket/Socket";
import type { ChannelId, GameId, Millis } from "../core/model.ts";
import { channelTopics, dropsTopic } from "../twitch/frames.ts";
import { PUBSUB_BACKOFF_MS, PUBSUB_TOPICS_PER_CONNECTION, PUBSUB_URL } from "../twitch/identity.ts";
import { SIM_EPOCH } from "./scenario.ts";
import { TWITCH_SOCKETS, schedule, type Twin } from "./twin.ts";
import {
  ACCOUNT,
  channelOf,
  findDrop,
  framesDownAt,
  gameAt,
  isRevoked,
  type Frame,
} from "./world.ts";

/**
 * Twitch's PubSub edge at wire level (research 02 §5): websockets that answer LISTEN and UNLISTEN
 * with a `RESPONSE` carrying the nonce, PING with Twitch's padded PONG, and deliver `MESSAGE`
 * frames to the sockets listening to their topic. The real `Connector.webSocket` and `PubSub`
 * run over it.
 */

/** About 10 websockets per IP (`TWITCH_SOCKETS`). The edge refuses the 11th. */
export const SOCKETS_PER_IP = TWITCH_SOCKETS;

/**
 * A socket must PING at least every 5 minutes or the edge closes it (Twitch's former PubSub docs,
 * research 02 §5); 10 s of grace for the PONG's way.
 */
export const PING_DEADLINE: Millis = 5 * 60_000 + 10_000;

/** `RECONNECT`s of one fault reach the sockets this far apart (live: five within four minutes). */
export const RECONNECT_STAGGER: Millis = 5_000;

/**
 * A socket asked to reconnect must be closed, and a new one opened, this soon: the next
 * `RECONNECT`'s stagger, plus the client's first backoff and its jitter of up to a second
 * (`PubSub.ts`). Twitch closes a socket that stays some time after its `RECONNECT` (inference).
 */
export const RECONNECT_GRACE: Millis = RECONNECT_STAGGER + PUBSUB_BACKOFF_MS.first + 1_000;

const PONG = '{ "type": "PONG" }\r\n';
const RECONNECT = '{ "type": "RECONNECT" }\r\n';

type Listener = (event: never) => void;
type EventType = "open" | "message" | "error" | "close";

/** One websocket as the edge holds it, and as the client's `Socket` sees it. */
export class TwinWebSocket implements Socket.WebSocketLike {
  readyState: number;
  readonly topics = new Set<string>();
  /** The edge gave the client a reason to close this socket: a `RECONNECT` or an error. */
  excused = false;
  /** The last PING, or the opening. */
  lastPing = 0;
  private readonly listeners: Array<{
    readonly type: EventType;
    readonly listener: Listener;
    readonly once: boolean;
  }> = [];

  private readonly twin: Twin;
  readonly id: number;

  constructor(twin: Twin, id: number, open: boolean) {
    this.twin = twin;
    this.id = id;
    this.readyState = open ? 1 : 3;
  }

  addEventListener(type: EventType, listener: Listener, options?: { readonly once?: boolean }) {
    this.listeners.push({ type, listener, once: options?.once === true });
  }

  removeEventListener(type: EventType, listener: Listener) {
    const i = this.listeners.findIndex((l) => l.type === type && l.listener === listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  private dispatch(type: EventType, event: object) {
    for (const entry of this.listeners.filter((l) => l.type === type)) {
      if (entry.once) this.removeEventListener(type, entry.listener);
      entry.listener(event as never);
    }
  }

  /** The client closes it. */
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.twin.edge.sockets.delete(this.id);
    this.twin.activity.closes.push({
      at: this.twin.now(),
      socket: this.id,
      excused: this.excused || this.twin.edge.stopping,
      remaining: this.twin.edge.sockets.size,
    });
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    if (this.readyState !== 1) throw new Error("the twin socket is closed");
    receive(this.twin, this, typeof data === "string" ? data : new TextDecoder().decode(data));
  }

  /** The edge sends a frame. */
  deliver(text: string) {
    if (this.readyState === 1) this.dispatch("message", { data: text });
  }

  /** The edge drops the connection. */
  drop() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.twin.edge.sockets.delete(this.id);
    this.dispatch("close", { code: 1006, reason: "the twin edge dropped the socket" });
  }
}

interface ClientFrame {
  readonly type?: unknown;
  readonly nonce?: unknown;
  readonly data?: { readonly topics?: unknown; readonly auth_token?: unknown };
}

const parse = (text: string): ClientFrame | undefined => {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as ClientFrame) : undefined;
  } catch {
    return undefined;
  }
};

const response = (ws: TwinWebSocket, nonce: unknown, error: string) => {
  if (error !== "") ws.excused = true;
  return JSON.stringify({ type: "RESPONSE", error, nonce: typeof nonce === "string" ? nonce : "" });
};

/**
 * A frame from the client. Twitch's former PubSub docs: at most 50 topics per connection, a
 * LISTEN with a bad token answers `ERR_BADAUTH`; past the topic limit the twin answers
 * `ERR_BADMESSAGE` (inference) and records the breach.
 */
const receive = (twin: Twin, ws: TwinWebSocket, text: string) => {
  const now = twin.now();
  const frame = parse(text);
  const type = typeof frame?.type === "string" ? frame.type : "malformed";
  twin.activity.calls.push({ kind: "pubsub", at: now, socket: ws.id, frame: type });
  if (frame === undefined) return;
  if (type === "PING") {
    ws.lastPing = now;
    watchPings(twin, ws);
    return ws.deliver(PONG);
  }
  if (type !== "LISTEN" && type !== "UNLISTEN")
    return ws.deliver(response(ws, frame.nonce, "ERR_BADMESSAGE"));
  const topics = Array.isArray(frame.data?.topics)
    ? frame.data.topics.filter((t): t is string => typeof t === "string")
    : [];
  const token = frame.data?.auth_token;
  if (token !== twin.token) {
    twin.activity.wrongTokens.push(
      `${type} on socket ${ws.id} sent ${typeof token === "string" && token !== "" ? "a token the twin never issued" : "no token"}`,
    );
    return ws.deliver(response(ws, frame.nonce, "ERR_BADAUTH"));
  }
  if (isRevoked(twin.world, now)) return ws.deliver(response(ws, frame.nonce, "ERR_BADAUTH"));
  if (type === "UNLISTEN") {
    for (const t of topics) ws.topics.delete(t);
    return ws.deliver(response(ws, frame.nonce, ""));
  }
  const after = new Set([...ws.topics, ...topics]);
  if (after.size > PUBSUB_TOPICS_PER_CONNECTION) {
    twin.activity.budget.push(`socket ${ws.id} asked for ${after.size} topics`);
    return ws.deliver(response(ws, frame.nonce, "ERR_BADMESSAGE"));
  }
  for (const t of topics) ws.topics.add(t);
  ws.deliver(response(ws, frame.nonce, ""));
};

/** Closes `ws` once it has gone `PING_DEADLINE` without a PING, and records the client's lapse. */
const watchPings = (twin: Twin, ws: TwinWebSocket) =>
  schedule(twin, ws.lastPing + PING_DEADLINE, (t, now) => {
    if (ws.readyState !== 1 || now - ws.lastPing < PING_DEADLINE) return;
    t.activity.budget.push(`socket ${ws.id} sent no PING for ${PING_DEADLINE / 1000} s`);
    ws.drop();
  });

const outageAt = (twin: Twin, now: Millis) =>
  twin.world.faults.some(
    (f) =>
      f.kind === "pubsub-outage" &&
      SIM_EPOCH + f.atMinute * 60_000 <= now &&
      now < SIM_EPOCH + f.atMinute * 60_000 + f.durationSeconds * 1000,
  );

/**
 * The twin's `WebSocketConstructor`: a socket to the edge, open at once, or closed at once when
 * the edge refuses it (an outage, or the client already holds `SOCKETS_PER_IP`).
 */
export const webSocketConstructor = (twin: Twin): Layer.Layer<Socket.WebSocketConstructor> =>
  Layer.succeed(Socket.WebSocketConstructor, (url: string) => {
    const now = twin.now();
    const id = twin.edge.nextSocket++;
    twin.activity.calls.push({ kind: "pubsub", at: now, socket: id, frame: "connect" });
    const full = twin.edge.sockets.size >= SOCKETS_PER_IP;
    if (full) twin.activity.budget.push(`socket ${id} opened past ${SOCKETS_PER_IP} open sockets`);
    const ws = new TwinWebSocket(twin, id, url === PUBSUB_URL && !full && !outageAt(twin, now));
    if (ws.readyState === 1) {
      twin.edge.sockets.set(id, ws);
      ws.lastPing = now;
      watchPings(twin, ws);
    }
    return ws;
  });

const gameField = (id: GameId | undefined): number | string =>
  id === undefined ? 0 : /^\d+$/.test(id) ? Number(id) : id;

/** A frame in Twitch's wire shape: its topic and its message (research 02 §5, fixtures). */
export const wireOf = (
  twin: Twin,
  frame: Frame,
): ReadonlyArray<{ readonly topic: string; readonly message: unknown }> => {
  const world = twin.world;
  const e = frame.event;
  const serverTime = Math.floor(frame.at / 1000);
  switch (e._tag) {
    case "DropProgress": {
      // Shape from the live run of 2026-10-30 (recording, ids replaced).
      const required = findDrop(world, e.dropId)?.drop.requiredMinutes ?? 0;
      return [
        {
          topic: dropsTopic(ACCOUNT.userId),
          message: {
            type: "drop-progress",
            data: {
              drop_id: e.dropId,
              channel_id: frame.channelId ?? "",
              current_progress_min: e.minutes,
              required_progress_min: required,
              current_progress: e.minutes,
              required_progress: required,
              progress_type: "minutes_watched",
              is_sitewide: false,
            },
          },
        },
      ];
    }
    case "DropClaimable":
      return [
        {
          topic: dropsTopic(ACCOUNT.userId),
          message: {
            type: "drop-claim",
            data: {
              drop_id: e.dropId,
              drop_instance_id: e.instanceId,
              channel_id: frame.channelId ?? "",
            },
          },
        },
      ];
    case "StreamUp": {
      const [playback] = channelTopics(e.channelId);
      const viewers = channelOf(world, e.channelId)?.viewers ?? 0;
      return [
        {
          topic: playback!,
          message: { server_time: serverTime, play_delay: 0, type: "stream-up" },
        },
        // `viewcount` follows a live channel about every 30 s; one is enough to be ignored.
        { topic: playback!, message: { type: "viewcount", server_time: frame.at / 1000, viewers } },
      ];
    }
    case "StreamDown": {
      const [playback] = channelTopics(e.channelId);
      return [{ topic: playback!, message: { server_time: serverTime, type: "stream-down" } }];
    }
    case "GameChanged": {
      const [, settings] = channelTopics(e.channelId);
      const old = gameAt(world, e.channelId, frame.at - 1_001);
      return [
        {
          topic: settings!,
          message: {
            channel_id: e.channelId,
            type: "broadcast_settings_update",
            channel: channelOf(world, e.channelId)?.login ?? "",
            old_status: "Old title",
            status: "New title",
            old_game: "",
            game: "",
            old_game_id: gameField(old),
            game_id: gameField(e.gameId),
          },
        },
      ];
    }
    default:
      return [];
  }
};

const channelOfFrame = (frame: Frame): ChannelId | undefined =>
  frame.event._tag === "StreamUp" ||
  frame.event._tag === "StreamDown" ||
  frame.event._tag === "GameChanged"
    ? frame.event.channelId
    : undefined;

/** Delivers `frame` to every open socket listening to its topic; lost while frames are down. */
export const deliver = (twin: Twin, frame: Frame, now: Millis): void => {
  if (framesDownAt(twin.world, now)) return;
  let reached = false;
  for (const { topic, message } of wireOf(twin, frame)) {
    const text = JSON.stringify({
      type: "MESSAGE",
      data: { topic, message: JSON.stringify(message) },
    });
    for (const ws of twin.edge.sockets.values()) {
      if (!ws.topics.has(topic)) continue;
      ws.deliver(text);
      reached = true;
    }
  }
  const channelId = channelOfFrame(frame);
  if (reached && channelId !== undefined) twin.activity.delivered.push({ at: now, channelId });
};

export const sendFrames = (twin: Twin, frames: ReadonlyArray<Frame>): void => {
  for (const frame of frames) schedule(twin, frame.at, (t, now) => deliver(t, frame, now));
};

/**
 * After a `RECONNECT`, the client must close the socket and open another within
 * `RECONNECT_GRACE`, unless its process stopped meanwhile. A socket that stays is closed by the
 * edge and recorded.
 */
const expectReconnect = (twin: Twin, ws: TwinWebSocket, sentAt: Millis) => {
  const sockets = twin.edge.nextSocket;
  const stops = twin.edge.stops;
  schedule(twin, sentAt + RECONNECT_GRACE, (t, now) => {
    if (t.edge.stops !== stops) return;
    const closed = ws.readyState !== 1;
    const reconnected = t.edge.nextSocket > sockets;
    if (closed && reconnected) return;
    const remaining = [...t.edge.sockets.values()].filter((s) => s.readyState === 1).length;
    t.activity.reconnects.push({
      socket: ws.id,
      at: sentAt,
      checkedAt: now,
      closed,
      reconnected,
      remaining,
    });
    if (!closed) ws.drop();
  });
};

/** Schedules the scenario's socket faults. */
export const scheduleFaults = (twin: Twin): void => {
  for (const fault of twin.world.faults) {
    const at = SIM_EPOCH + fault.atMinute * 60_000;
    // A calibrated `reconnect` is the same `RECONNECT` on the wire; its `gapMillis` (what the live
    // client took to listen again) is the miner's own here, so the twin ignores it.
    if (fault.kind === "pubsub-reconnect" || fault.kind === "reconnect") {
      schedule(twin, at, (t) => {
        const sockets = [...t.edge.sockets.values()].toSorted((a, b) => a.id - b.id);
        for (const [i, ws] of sockets.entries()) {
          schedule(t, at + i * RECONNECT_STAGGER, (t2, sentAt) => {
            if (ws.readyState !== 1) return;
            ws.excused = true;
            ws.deliver(RECONNECT);
            expectReconnect(t2, ws, sentAt);
          });
        }
      });
    }
    if (fault.kind === "pubsub-outage") {
      schedule(twin, at, (t) => {
        for (const ws of Array.from(t.edge.sockets.values())) ws.drop();
      });
    }
  }
};

/**
 * Runs the edge's schedule for the run's life: each item at its time, so `TestClock` wakes the
 * edge exactly then and the client's fibers settle on what it sent before time moves on.
 */
export const runEdge = (twin: Twin) =>
  Effect.gen(function* () {
    const signal = yield* Queue.unbounded<void>();
    twin.edge.wake = () => Queue.offerUnsafe(signal, undefined);
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      while (twin.edge.pending.length > 0 && twin.edge.pending[0]!.at <= now) {
        twin.edge.pending.shift()!.run(twin, now);
      }
      const next = twin.edge.pending[0];
      const take = Queue.take(signal);
      yield* next === undefined ? take : Effect.timeoutOption(take, next.at - now);
      yield* Queue.clear(signal);
    }
  });

/** When the edge next does something, for the simulator's wake-ups. */
export const nextEdgeAt = (twin: Twin): Millis | undefined => twin.edge.pending[0]?.at;
