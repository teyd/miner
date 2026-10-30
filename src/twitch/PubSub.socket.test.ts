import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Socket } from "effect/socket";
import { Connector } from "./PubSub.ts";

type Listener = (event: never) => void;

/** A websocket that is open at once, keeps what was sent, and can deliver a message. */
class FakeWs implements Socket.WebSocketLike {
  readonly readyState = 1;
  readonly sent: Array<string> = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  close() {}
  send(data: string | Uint8Array<ArrayBuffer>) {
    this.sent.push(String(data));
  }
  deliver(data: string) {
    for (const l of this.listeners.get("message") ?? []) l({ data } as never);
  }
}

describe("Connector.webSocket", () => {
  // Regression: one shared Effect `Socket` routed every connection's writes to the websocket
  // opened last, so PINGs and LISTENs of the other connections were answered on the wrong one.
  it.effect("keeps each connection on its own websocket", () =>
    Effect.gen(function* () {
      const opened: Array<FakeWs> = [];
      const constructor = Layer.succeed(Socket.WebSocketConstructor, () => {
        const ws = new FakeWs();
        opened.push(ws);
        return ws;
      });
      const connector = yield* Effect.provide(
        Connector,
        Connector.webSocket.pipe(Layer.provide(constructor)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const a = yield* connector.connect;
          const b = yield* connector.connect;
          assert.strictEqual(opened.length, 2);
          yield* a.send("from a");
          yield* b.send("from b");
          assert.deepStrictEqual(opened[0]!.sent, ["from a"]);
          assert.deepStrictEqual(opened[1]!.sent, ["from b"]);
          opened[0]!.deliver("to a");
          opened[1]!.deliver("to b");
          assert.strictEqual(yield* a.receive, "to a");
          assert.strictEqual(yield* b.receive, "to b");
        }),
      );
    }),
  );
});
