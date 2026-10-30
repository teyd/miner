import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Fiber } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { REQUEST_GAP, pace } from "./pace.ts";

describe("pace", () => {
  it.effect("starts requests at least the gap apart, even when sent at once", () =>
    Effect.gen(function* () {
      const starts: Array<number> = [];
      const inner = HttpClient.make((request) =>
        Effect.map(Clock.currentTimeMillis, (at) => {
          starts.push(at);
          return HttpClientResponse.fromWeb(request, new Response("{}"));
        }),
      );
      const client = yield* pace(inner);
      const fiber = yield* Effect.forkChild(
        Effect.forEach(
          Array.from({ length: 10 }, () => HttpClientRequest.get("https://gql.twitch.tv/gql")),
          (r) => client.execute(r),
          { concurrency: "unbounded" },
        ),
      );
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(fiber);
      assert.strictEqual(starts.length, 10);
      for (let i = 1; i < starts.length; i++) {
        assert.isAtLeast(starts[i]! - starts[i - 1]!, REQUEST_GAP);
      }
    }),
  );
});
