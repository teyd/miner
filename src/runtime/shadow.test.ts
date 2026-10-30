import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { ChannelId, DropInstanceId } from "../core/model.ts";
import { Journal } from "../twitch/journal.ts";
import { shadowActuator } from "./shadow.ts";

const recorder = () => {
  const intents: Array<{ command: string; detail: unknown }> = [];
  const journal = Journal.of({
    record: () => Effect.void,
    intent: (command, detail) => Effect.sync(() => intents.push({ command, detail })),
    frame: () => Effect.void,
  });
  return { intents, actuator: shadowActuator(journal) };
};

describe("shadowActuator", () => {
  it.effect("records what it would do and sends nothing", () =>
    Effect.gen(function* () {
      const { intents, actuator } = recorder();
      const ch = "ch0" as ChannelId;
      yield* actuator.watch(ch, "chan0");
      yield* actuator.subscribe([ch]);
      yield* actuator.stopWatching;
      const tick = yield* Effect.flip(actuator.watchTick(ch));
      assert.strictEqual(tick.reason, "network");
      assert.deepStrictEqual(
        intents.map((i) => i.command),
        ["Watch", "Subscribe", "StopWatching"],
      );
    }),
  );

  it.effect("records a claim once and never answers it", () =>
    Effect.gen(function* () {
      const { intents, actuator } = recorder();
      const fiber = yield* Effect.forkChild(actuator.claim("i1" as DropInstanceId));
      yield* TestClock.adjust("1 day");
      assert.isUndefined(fiber.pollUnsafe());
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(intents, [{ command: "Claim", detail: { instanceId: "i1" } }]);
    }),
  );
});
