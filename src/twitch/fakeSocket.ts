import { Clock, Effect, Queue } from "effect";
import { Connector, PubSubLost, type Connection } from "./PubSub.ts";

/** One connection the fake edge accepted. */
export interface FakeConnection {
  readonly openedAt: number;
  /** Frames the client sent, as text. */
  readonly sent: Array<string>;
  closed: boolean;
  /** Delivers a frame to the client. */
  readonly push: (text: string) => void;
  /** Closes the socket from the server side. */
  readonly drop: (detail: string) => void;
}

export interface FakeEdge {
  readonly connector: Connector["Service"];
  readonly connections: Array<FakeConnection>;
  /** Answer LISTEN/UNLISTEN with `RESPONSE`, and PING with PONG. On by default. */
  answer: { listen: string | false; ping: boolean };
  /** Connection attempts left to refuse. */
  refuse: number;
  readonly attempts: Array<number>;
}

const CLOSED = Symbol("closed");

/**
 * An in-memory PubSub edge for tests: it records what the client sends, answers like Twitch
 * (`RESPONSE` with an empty error, PONG), and lets a test push frames or drop the socket.
 */
export const fakeEdge = (): FakeEdge => {
  const edge: FakeEdge = {
    connections: [],
    attempts: [],
    answer: { listen: "", ping: true },
    refuse: 0,
    connector: Connector.of({
      connect: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        edge.attempts.push(now);
        if (edge.refuse > 0) {
          edge.refuse -= 1;
          return yield* new PubSubLost({ detail: "refused by the fake edge" });
        }
        const inbox = yield* Queue.unbounded<string | { readonly [CLOSED]: string }>();
        const conn: FakeConnection = {
          openedAt: now,
          sent: [],
          closed: false,
          push: (text) => {
            if (!conn.closed) Queue.offerUnsafe(inbox, text);
          },
          drop: (detail) => {
            Queue.offerUnsafe(inbox, { [CLOSED]: detail });
            conn.closed = true;
          },
        };
        edge.connections.push(conn);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            conn.closed = true;
          }),
        );
        const connection: Connection = {
          send: (text) =>
            Effect.suspend(() => {
              if (conn.closed) return Effect.fail(new PubSubLost({ detail: "closed" }));
              conn.sent.push(text);
              const frame = JSON.parse(text) as { type: string; nonce?: string };
              if (frame.type === "PING" && edge.answer.ping) conn.push('{ "type": "PONG" }\r\n');
              if (
                (frame.type === "LISTEN" || frame.type === "UNLISTEN") &&
                edge.answer.listen !== false
              ) {
                conn.push(
                  JSON.stringify({
                    type: "RESPONSE",
                    error: edge.answer.listen,
                    nonce: frame.nonce,
                  }),
                );
              }
              return Effect.void;
            }),
          receive: Queue.take(inbox).pipe(
            Effect.filterOrFail(
              (item): item is string => typeof item === "string",
              (item) => new PubSubLost({ detail: typeof item === "string" ? item : item[CLOSED] }),
            ),
          ),
        };
        return connection;
      }),
    }),
  };
  return edge;
};

/** The topics a connection's LISTEN and UNLISTEN frames leave it on. */
export const listenedOn = (conn: FakeConnection): ReadonlySet<string> => {
  const topics = new Set<string>();
  for (const text of conn.sent) {
    const frame = JSON.parse(text) as { type: string; data?: { topics: Array<string> } };
    for (const t of frame.data?.topics ?? []) {
      if (frame.type === "LISTEN") topics.add(t);
      if (frame.type === "UNLISTEN") topics.delete(t);
    }
  }
  return topics;
};
