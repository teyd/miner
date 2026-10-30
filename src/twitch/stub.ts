import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Credentials } from "./Twitch.ts";
import type { Answer as Recorded } from "./journal.ts";
import { Journal } from "./journal.ts";
import { Redacted } from "effect";

/** A recorded answer: what the fixture files hold. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * A fake Twitch for tests: answers by GQL operation name (or `validate`) from a script of
 * answers, and counts requests. Each answer is used once, the last one repeats.
 */
export const stubTwitch = (script: Record<string, ReadonlyArray<Answer>>) => {
  const calls: Record<string, number> = {};
  const recorded: Array<Recorded> = [];
  const http = HttpClient.make((request) => {
    let operation = "validate";
    let size = 1;
    if (request.body._tag === "Uint8Array") {
      const sent = JSON.parse(new TextDecoder().decode(request.body.body)) as ReadonlyArray<{
        readonly operationName: string;
      }>;
      operation = sent[0]?.operationName ?? "?";
      size = sent.length;
    }
    const n = calls[operation] ?? 0;
    calls[operation] = n + 1;
    const answers = script[operation] ?? [{ status: 404, body: null }];
    const answer = answers[Math.min(n, answers.length - 1)]!;
    // A GQL fixture holds one answer element; a batch gets it once per request.
    const raw: unknown = answer.body;
    const body =
      Array.isArray(raw) && raw.length === 1 && size > 1
        ? Array.from({ length: size }, () => raw[0] as unknown)
        : raw;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { status: answer.status }),
      ),
    );
  });
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(
      Credentials,
      Credentials.of({ token: Redacted.make("test-token"), deviceId: "d".repeat(32) }),
    ),
    Layer.succeed(
      Journal,
      Journal.of({
        record: (answer) => Effect.sync(() => recorded.push(answer)),
        intent: () => Effect.void,
      }),
    ),
  );
  return { layer, calls, recorded };
};
