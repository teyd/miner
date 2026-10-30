import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Option,
  Queue,
  Random,
  Redacted,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import type { Scope } from "effect";
import * as Socket from "effect/socket/Socket";
import type { ChannelId } from "../core/model.ts";
import type { Event } from "../core/protocol.ts";
import { channelTopics, classify, decodeFrame, dropsTopic, topicOf } from "./frames.ts";
import {
  PUBSUB_ANSWER_TIMEOUT_MS,
  PUBSUB_BACKOFF_MS,
  PUBSUB_MAX_CONNECTIONS,
  PUBSUB_OPEN_TIMEOUT_MS,
  PUBSUB_PING_INTERVAL_MS,
  PUBSUB_TOPICS_PER_CONNECTION,
  PUBSUB_TOPICS_PER_FRAME,
  PUBSUB_URL,
} from "./identity.ts";
import type { TwitchError } from "./errors.ts";
import { Journal } from "./journal.ts";
import { Credentials, Twitch } from "./Twitch.ts";

/** The socket closed, failed to open, or stopped answering. The connection reconnects. */
export class PubSubLost extends Schema.TaggedError<PubSubLost, { readonly brand: unique symbol }>()(
  "PubSubLost",
  { detail: Schema.String },
) {}

/** One open socket. Text frames only: PubSub sends JSON. */
export interface Connection {
  readonly send: (text: string) => Effect.Effect<void, PubSubLost>;
  /** The next frame; fails once the socket closes. */
  readonly receive: Effect.Effect<string, PubSubLost>;
}

/** Opens connections to the PubSub edge, each closed with its scope. Tests use a fake. */
export class Connector extends Context.Service<
  Connector,
  { readonly connect: Effect.Effect<Connection, PubSubLost, Scope.Scope> }
>()("miner/twitch/PubSub/Connector") {
  /**
   * The edge over an Effect WebSocket; the constructor comes from the IO shell. One `Socket` per
   * connection: an Effect `Socket` writes to the websocket it opened last, so connections sharing
   * one sent every PING and LISTEN down the newest socket (live shadow run, 2026-10-30).
   */
  static readonly webSocket: Layer.Layer<Connector, never, Socket.WebSocketConstructor> =
    Layer.effect(
      Connector,
      Effect.map(Socket.WebSocketConstructor, (constructor) =>
        Connector.of({
          connect: Socket.makeWebSocket(PUBSUB_URL, {
            openTimeout: Duration.millis(PUBSUB_OPEN_TIMEOUT_MS),
          }).pipe(
            Effect.provideService(Socket.WebSocketConstructor, constructor),
            Effect.flatMap(webSocketConnection),
          ),
        }),
      ),
    );
}

const lost = (error: { readonly message: string }) => new PubSubLost({ detail: error.message });

const webSocketConnection = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const pull = yield* Socket.readerString(socket).pipe(Effect.mapError(lost));
    const writer = yield* socket.writer;
    const pending: Array<string> = [];
    const receive = Effect.suspend(() => {
      const buffered = pending.shift();
      if (buffered !== undefined) return Effect.succeed(buffered);
      return pull.pipe(
        Effect.map(([first, ...rest]) => {
          pending.push(...rest);
          return first;
        }),
        Effect.mapError(lost),
      );
    });
    return {
      send: (text: string) => writer.write(text).pipe(Effect.mapError(lost)),
      receive,
    } satisfies Connection;
  });

/**
 * Twitch's real-time topics (research 02 §5): drop progress and claims for the account, and
 * live, offline and category changes for the channels the core follows. Listening is read-only,
 * so a shadow run listens too (research 04 §4).
 */
export class PubSub extends Context.Service<
  PubSub,
  {
    /**
     * Replaces the followed channels; only the difference is sent. The account's drop topic rides
     * along while any channel is followed, and with none every connection closes: no watch can
     * credit a drop then, and a parked miner polls nothing (decision 11).
     */
    readonly subscribe: (channelIds: ReadonlyArray<ChannelId>) => Effect.Effect<void>;
    /**
     * What the frames say, as core events. Nothing is made up for a reconnect gap: the core's
     * own reads catch up on what the gap hid.
     */
    readonly events: Stream.Stream<Event>;
    /** The sockets now, for `status.json`. */
    readonly status: Effect.Effect<PubSubStatus>;
  }
>()("miner/twitch/PubSub") {
  /** Follows nothing and hears nothing, for runs without a socket. */
  static readonly none = Layer.succeed(
    PubSub,
    PubSub.of({
      subscribe: () => Effect.void,
      events: Stream.never,
      status: Effect.succeed({ connections: 0, listening: 0, topics: 0, dropped: 0 }),
    }),
  );

  /** The account comes from token validation, once; the token from `Credentials`. */
  static readonly layer: Layer.Layer<PubSub, never, Connector | Twitch | Credentials | Journal> =
    Layer.effect(
      PubSub,
      Effect.gen(function* () {
        const twitch = yield* Twitch;
        const { token } = yield* Credentials;
        return yield* make({
          token,
          userId: Effect.map(twitch.validate, (account) => account.userId),
          connector: yield* Connector,
          journal: yield* Journal,
        });
      }),
    );
}

export interface PubSubStatus {
  /** Connections wanted: slots with topics. */
  readonly connections: number;
  /** Connections whose socket is open and has had a LISTEN accepted. */
  readonly listening: number;
  readonly topics: number;
  /** Topics beyond the connection limit, not followed. */
  readonly dropped: number;
}

/** Where each topic lives: one set per connection slot, an empty slot has no connection. */
export type Slots = ReadonlyArray<ReadonlySet<string>>;

/**
 * Spreads `desired` over connections of at most `perConnection` topics. Topics stay where they
 * are, so a change only LISTENs and UNLISTENs the difference; new ones fill the first slot with
 * room. When the topics fit in one connection fewer, the last one hands its topics on and closes
 * (TDM `WebsocketPool.remove_topics`). Topics beyond `max` connections are `dropped`.
 */
export const assign = (
  current: Slots,
  desired: ReadonlyArray<string>,
  perConnection: number,
  max: number,
): { readonly slots: Slots; readonly dropped: ReadonlyArray<string> } => {
  const wanted = new Set(desired);
  const slots = current.map((slot) => new Set([...slot].filter((t) => wanted.has(t))));
  const placed = new Set(slots.flatMap((slot) => [...slot]));
  const dropped: Array<string> = [];
  const place = (topic: string, before: number) => {
    const room = slots.findIndex((slot, i) => i < before && slot.size < perConnection);
    if (room >= 0) return slots[room]!.add(topic);
    if (slots.length < Math.min(max, before)) return slots.push(new Set([topic]));
    dropped.push(topic);
  };
  for (const topic of desired) if (!placed.has(topic)) place(topic, max);
  const total = () => slots.reduce((n, slot) => n + slot.size, 0);
  const used = () => slots.filter((slot) => slot.size > 0).length;
  while (used() > 1 && total() <= (used() - 1) * perConnection) {
    const last = slots.findLastIndex((slot) => slot.size > 0);
    const moving = [...slots[last]!];
    slots[last] = new Set();
    for (const topic of moving) place(topic, last);
  }
  while (slots.length > 0 && slots.at(-1)!.size === 0) slots.pop();
  return { slots, dropped };
};

/** The reconnect delay after `failures` failed attempts in a row. */
export const backoff = (failures: number): number =>
  Math.min(PUBSUB_BACKOFF_MS.first * 2 ** failures, PUBSUB_BACKOFF_MS.max);

/** Messages the core has no event for and that come too often to log or record. */
const CHATTY = new Set(["viewcount", "commercial"]);

type Input =
  | { readonly _tag: "frame"; readonly session: number; readonly text: string }
  | { readonly _tag: "closed"; readonly session: number; readonly detail: string }
  | { readonly _tag: "changed" };

type End = "reconnect" | "empty";

interface Slot {
  topics: ReadonlySet<string>;
  readonly inbox: Queue.Queue<Input>;
  /** The current connection had a LISTEN accepted and hasn't ended since. */
  listening: boolean;
}

const NONCE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const nonce = Effect.gen(function* () {
  let out = "";
  for (let i = 0; i < 30; i++) out += NONCE_CHARS[yield* Random.nextIntBetween(0, 61)];
  return out;
});

const chunks = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

export const make = (options: {
  readonly token: Redacted.Redacted<string>;
  readonly userId: Effect.Effect<string, TwitchError>;
  readonly connector: Connector["Service"];
  readonly journal: Journal["Service"];
}): Effect.Effect<PubSub["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const { connector, journal } = options;
    const events = yield* Queue.unbounded<Event>();
    const fibers = yield* FiberMap.make<number>();
    const lock = yield* Semaphore.make(1);
    const slots: Array<Slot> = [];
    let userId: string | undefined;
    let dropped = 0;

    const record = (index: number, direction: "in" | "out", text: string) =>
      journal.frame({ connection: index, direction, text });

    /** Sends a frame. LISTEN and UNLISTEN carry the token: it goes to the socket and nowhere else. */
    const send = (index: number, connection: Connection, frame: Record<string, unknown>) =>
      Effect.gen(function* () {
        const data = frame["data"] as Record<string, unknown> | undefined;
        const wire =
          data === undefined
            ? frame
            : { ...frame, data: { ...data, auth_token: Redacted.value(options.token) } };
        yield* connection.send(JSON.stringify(wire));
        const shown =
          data === undefined ? frame : { ...frame, data: { ...data, auth_token: "REDACTED" } };
        yield* record(index, "out", JSON.stringify(shown));
      });

    const handleMessage = (topic: string, message: string, listened: ReadonlySet<string>) => {
      const parsed = topicOf(topic);
      // An UNLISTEN races frames already on the way; the core no longer follows that channel.
      if (parsed === undefined || !listened.has(topic)) {
        return Effect.logDebug(`pubsub: dropped a frame on ${topic}, not listened`);
      }
      const classified = classify(parsed, message);
      switch (classified._tag) {
        case "event":
          return Effect.andThen(
            Queue.offer(events, classified.event),
            Effect.logDebug(`pubsub: ${classified.event._tag} from ${topic}`),
          );
        case "ignored":
          return CHATTY.has(classified.type)
            ? Effect.void
            : Effect.logDebug(`pubsub: ignored ${classified.type} on ${topic}`);
        case "malformed":
          return Effect.logWarning(`pubsub: dropped a malformed message on ${topic}`, {
            detail: classified.detail,
          });
      }
    };

    /** One connection attempt for `index`. Fails with `PubSubLost`; ends on RECONNECT or no topics. */
    const session = (index: number, id: number, onListening: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const slot = slots[index]!;
        const connection = yield* connector.connect;
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.flatMap(connection.receive, (text) =>
              Queue.offer(slot.inbox, { _tag: "frame", session: id, text }),
            ),
          ).pipe(
            Effect.catch((e) =>
              Queue.offer(slot.inbox, { _tag: "closed", session: id, detail: e.detail }),
            ),
          ),
        );
        const listened = new Set<string>();
        const pending = new Map<string, number>();
        const opened = yield* Clock.currentTimeMillis;
        let pingAt = opened + PUBSUB_PING_INTERVAL_MS;
        let pongBy: number | undefined;

        const sync = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const removed = [...listened].filter((t) => !slot.topics.has(t));
          const added = [...slot.topics].filter((t) => !listened.has(t));
          for (const [type, topics] of [
            ["UNLISTEN", removed],
            ["LISTEN", added],
          ] as const) {
            for (const chunk of chunks(topics, PUBSUB_TOPICS_PER_FRAME)) {
              const n = yield* nonce;
              pending.set(n, now + PUBSUB_ANSWER_TIMEOUT_MS);
              yield* send(index, connection, { type, nonce: n, data: { topics: chunk } });
            }
          }
          for (const t of removed) listened.delete(t);
          for (const t of added) listened.add(t);
          if (added.length > 0 || removed.length > 0) {
            yield* Effect.logDebug(
              `pubsub[${index}]: +${added.length} -${removed.length} topics, ${listened.size} listened`,
            );
          }
        });
        yield* sync;

        while (true) {
          const now = yield* Clock.currentTimeMillis;
          const deadline = Math.min(pingAt, pongBy ?? Infinity, ...pending.values());
          const input = yield* Queue.take(slot.inbox).pipe(
            Effect.timeoutOption(Duration.millis(Math.max(0, deadline - now))),
          );
          if (Option.isNone(input)) {
            const at = yield* Clock.currentTimeMillis;
            if (pongBy !== undefined && at >= pongBy) {
              return yield* new PubSubLost({ detail: "no PONG within 10 s" });
            }
            if ([...pending.values()].some((by) => at >= by)) {
              return yield* new PubSubLost({ detail: "no RESPONSE to a LISTEN within 10 s" });
            }
            if (at >= pingAt) {
              yield* send(index, connection, { type: "PING" });
              pongBy = at + PUBSUB_ANSWER_TIMEOUT_MS;
              pingAt = at + PUBSUB_PING_INTERVAL_MS;
            }
            continue;
          }
          const value = input.value;
          if (value._tag === "changed") {
            if (slot.topics.size === 0) return "empty" satisfies End;
            yield* sync;
            continue;
          }
          // Inputs of an earlier connection of this slot are stale.
          if (value.session !== id) continue;
          if (value._tag === "closed") return yield* new PubSubLost({ detail: value.detail });
          const frame = decodeFrame(value.text);
          if (frame._tag === "malformed") {
            yield* record(index, "in", value.text);
            yield* Effect.logWarning(`pubsub[${index}]: dropped a malformed frame`, {
              detail: frame.detail,
            });
            continue;
          }
          const f = frame.value;
          if (!(f.type === "MESSAGE" && isChatty(f.message)))
            yield* record(index, "in", value.text);
          switch (f.type) {
            case "PONG":
              pongBy = undefined;
              break;
            case "RECONNECT":
              return "reconnect" satisfies End;
            case "RESPONSE": {
              if (!pending.delete(f.nonce)) {
                yield* Effect.logDebug(`pubsub[${index}]: RESPONSE to an unknown nonce`);
                break;
              }
              if (f.error === "") {
                yield* onListening;
                break;
              }
              if (f.error === "ERR_BADAUTH") {
                yield* Effect.logError(
                  "pubsub: Twitch refused the token for these topics (ERR_BADAUTH)",
                );
              }
              return yield* new PubSubLost({ detail: `Twitch answered ${f.error}` });
            }
            case "MESSAGE":
              yield* handleMessage(f.topic, f.message, listened);
              break;
            case "unknown":
              yield* Effect.logDebug(`pubsub[${index}]: ignored a ${f.name} frame`);
              break;
          }
        }
      }).pipe(Effect.scoped);

    /** Keeps slot `index` connected while it has topics, reconnecting with backoff. */
    const keep = (index: number) =>
      Effect.gen(function* () {
        let failures = 0;
        let id = 0;
        const listening = Effect.sync(() => {
          failures = 0;
          slots[index]!.listening = true;
        });
        while (slots[index]!.topics.size > 0) {
          id += 1;
          yield* Effect.logInfo(`pubsub[${index}]: connecting to ${PUBSUB_URL}`);
          const end = yield* session(index, id, listening).pipe(
            Effect.map((e): End | PubSubLost => e),
            Effect.catch((e) => Effect.succeed(e)),
            Effect.ensuring(
              Effect.sync(() => {
                slots[index]!.listening = false;
              }),
            ),
          );
          if (end === "empty") break;
          const jitter = yield* Random.nextIntBetween(0, 1000);
          if (end === "reconnect") {
            yield* Effect.logInfo(`pubsub[${index}]: Twitch asked to reconnect`);
            yield* Effect.sleep(Duration.millis(PUBSUB_BACKOFF_MS.first + jitter));
            continue;
          }
          const delay = backoff(failures) + jitter;
          failures += 1;
          yield* Effect.logWarning(
            `pubsub[${index}]: ${end.detail}; reconnecting in ${Math.round(delay / 1000)} s`,
          );
          yield* Effect.sleep(Duration.millis(delay));
        }
      });

    const resolveUser = Effect.gen(function* () {
      if (userId !== undefined) return userId;
      const id = yield* options.userId.pipe(Effect.option);
      if (Option.isNone(id)) {
        yield* Effect.logWarning(
          "pubsub: the account id is unknown (validation failed); drop events are not followed until the next change",
        );
        return undefined;
      }
      userId = id.value;
      return userId;
    });

    const subscribe = (channelIds: ReadonlyArray<ChannelId>) =>
      Effect.gen(function* () {
        const unique = [...new Set(channelIds)].toSorted();
        const user = unique.length === 0 ? undefined : yield* resolveUser;
        const desired = [
          ...(user === undefined ? [] : [dropsTopic(user)]),
          ...unique.flatMap(channelTopics),
        ];
        const { slots: next, dropped: droppedNow } = assign(
          slots.map((s) => s.topics),
          desired,
          PUBSUB_TOPICS_PER_CONNECTION,
          PUBSUB_MAX_CONNECTIONS,
        );
        dropped = droppedNow.length;
        if (droppedNow.length > 0) {
          yield* Effect.logWarning(
            `pubsub: ${droppedNow.length} topics don't fit in ${PUBSUB_MAX_CONNECTIONS} connections and are not followed`,
          );
        }
        for (let i = 0; i < Math.max(next.length, slots.length); i++) {
          const topics = next[i] ?? new Set<string>();
          if (slots[i] === undefined)
            slots[i] = {
              topics: new Set(),
              inbox: yield* Queue.unbounded<Input>(),
              listening: false,
            };
          const slot = slots[i]!;
          const changed =
            topics.size !== slot.topics.size || [...topics].some((t) => !slot.topics.has(t));
          if (!changed) continue;
          slot.topics = topics;
          if (topics.size === 0) {
            yield* FiberMap.remove(fibers, i);
          } else if (yield* FiberMap.has(fibers, i)) {
            yield* Queue.offer(slot.inbox, { _tag: "changed" });
          } else {
            yield* Queue.clear(slot.inbox);
            yield* FiberMap.run(
              fibers,
              i,
              keep(i).pipe(
                Effect.tapCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logError(`pubsub[${i}]: stopped by a defect`, cause),
                ),
              ),
            );
          }
        }
        yield* Effect.logInfo(
          `pubsub: following ${unique.length} channels${user === undefined ? "" : " and the account's drops"}`,
        );
      }).pipe((effect) => lock.withPermit(effect));

    const status = Effect.sync((): PubSubStatus => ({
      connections: slots.filter((s) => s.topics.size > 0).length,
      listening: slots.filter((s) => s.topics.size > 0 && s.listening).length,
      topics: slots.reduce((n, s) => n + s.topics.size, 0),
      dropped,
    }));

    return PubSub.of({ subscribe, events: Stream.fromQueue(events), status });
  });

const isChatty = (message: string): boolean => {
  const type = /^\{"type":"([a-z_-]+)"/.exec(message)?.[1];
  return type !== undefined && CHATTY.has(type);
};
