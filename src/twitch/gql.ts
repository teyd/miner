import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Millis } from "../core/model.ts";
import type { Budget } from "./budget.ts";
import { AuthRejected, TwitchDrift, TwitchUnavailable, type TwitchError } from "./errors.ts";
import {
  CLIENT_ID,
  GQL_URL,
  TRANSIENT_GQL_ERRORS,
  USER_AGENT,
  type PersistedQuery,
} from "./identity.ts";
import type { Journal } from "./journal.ts";
import { redact } from "./redact.ts";
import { Envelope } from "./wire.ts";

/**
 * A request with no answer this long fails as `TwitchUnavailable`, so a hung connection can't hang
 * the runtime. The wait for a turn at the budget comes before it and has its own bound
 * (`GQL_LIMITS.maxWait`), so with its three retries one request (a batch of up to 35) gives up
 * within 4 × (15 s + 30 s) + 14 s = 194 s (`READ_WORST_CASE`). A read of several batches sends
 * them one after the other, each with this bound; the simulator's bound on a command
 * (`COMMAND_DEADLINE`, plan 09 §4 s3) counts three. A claim has its own, shorter bound
 * (`CLAIM_TIMEOUT`).
 */
export const REQUEST_TIMEOUT: Millis = 30_000;

export type Decodable = Schema.Top & { readonly DecodingServices: never };

/**
 * One HTTP exchange with Twitch's API, recorded, with its status classified. Reads and mutations
 * share it, so both carry the same client identity, count against the same request budget and
 * land in the same recording. It sends at most once: retrying is the caller's choice, and never a
 * claim's. A budget that refuses the request fails it with `BudgetExhausted`, unsent.
 */
export interface Gql {
  readonly oauth: () => string;
  readonly send: (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    variables: unknown,
  ) => Effect.Effect<unknown, TwitchError>;
  /** One request of up to `GQL_BATCH_LIMIT` variable sets; the results keep their order. */
  readonly request: <S extends Decodable>(
    query: PersistedQuery,
    batch: ReadonlyArray<unknown>,
    schema: S,
  ) => Effect.Effect<ReadonlyArray<S["Type"]>, TwitchError>;
}

export const decode =
  <S extends Decodable>(operation: string, schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      // Schema messages quote the input they rejected, so they pass through `redact` too.
      Effect.mapError((e) => new TwitchDrift({ operation, detail: String(redact(e.message)) })),
    );

export const makeGql = (
  http: HttpClient.HttpClient,
  credentials: { readonly token: Redacted.Redacted<string>; readonly deviceId: string },
  journal: Journal["Service"],
  budget: Budget,
): Gql => {
  const oauth = () => `OAuth ${Redacted.value(credentials.token)}`;

  const send = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    variables: unknown,
  ) =>
    Effect.gen(function* () {
      const exchange = http.execute(request).pipe(
        // Keep the raw text when it isn't JSON (an HTML error page): that is the answer to record.
        Effect.flatMap((r) =>
          Effect.map(r.text.pipe(Effect.orElseSucceed(() => "")), (t) => [r, t] as const),
        ),
        Effect.mapError((e) => new TwitchUnavailable({ operation, detail: e.message })),
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new TwitchUnavailable({ operation, detail: `no answer in ${REQUEST_TIMEOUT} ms` }),
            ),
        }),
      );
      const [response, text] = yield* budget.run(operation, exchange);
      const body: unknown = yield* Effect.try(() => JSON.parse(text) as unknown).pipe(
        Effect.orElseSucceed(() => text),
      );
      yield* journal.record({ operation, variables, status: response.status, body });
      if (response.status === 401)
        return yield* new AuthRejected({ reason: `${operation} answered 401` });
      // Twitch says this IP sends too much: the whole budget backs off, not just this request.
      if (response.status === 429) yield* budget.backOff;
      if (response.status === 429 || response.status >= 500) {
        return yield* new TwitchUnavailable({ operation, detail: `HTTP ${response.status}` });
      }
      if (response.status !== 200) {
        return yield* new TwitchDrift({ operation, detail: `unexpected HTTP ${response.status}` });
      }
      return body;
    });

  const request = <S extends Decodable>(
    query: PersistedQuery,
    batch: ReadonlyArray<unknown>,
    schema: S,
  ): Effect.Effect<ReadonlyArray<S["Type"]>, TwitchError> => {
    const operation = query.operationName;
    return Effect.gen(function* () {
      const post = HttpClientRequest.post(GQL_URL).pipe(
        HttpClientRequest.setHeaders({
          "Client-Id": CLIENT_ID,
          "User-Agent": USER_AGENT,
          "X-Device-Id": credentials.deviceId,
          Authorization: oauth(),
        }),
        HttpClientRequest.bodyJsonUnsafe(
          batch.map((v) => ({
            operationName: operation,
            variables: v,
            extensions: { persistedQuery: { version: 1, sha256Hash: query.sha256Hash } },
          })),
        ),
      );
      const body = yield* send(operation, post, batch);
      const envelopes = yield* decode(operation, Schema.Array(Envelope))(body);
      if (envelopes.length !== batch.length) {
        const detail = `${batch.length} requests got ${envelopes.length} answers`;
        return yield* new TwitchDrift({ operation, detail });
      }
      return yield* Effect.forEach(envelopes, (envelope) =>
        Effect.gen(function* () {
          const errors = envelope.errors ?? [];
          const transient = errors.find((e) => TRANSIENT_GQL_ERRORS.includes(e.message));
          if (transient !== undefined) {
            return yield* new TwitchUnavailable({ operation, detail: transient.message });
          }
          if (envelope.data === undefined || envelope.data === null) {
            const detail = errors.map((e) => e.message).join("; ") || "no data";
            return yield* new TwitchDrift({ operation, detail });
          }
          // Twitch may null one field and say why in `errors`: keep that reason with the drift.
          return yield* decode(
            operation,
            schema,
          )(envelope.data).pipe(
            Effect.mapError((e) =>
              errors.length === 0
                ? e
                : new TwitchDrift({
                    operation,
                    detail: `${e.detail} (Twitch: ${errors.map((x) => x.message).join("; ")})`,
                  }),
            ),
          );
        }),
      );
    });
  };

  return { oauth, send, request };
};

/** The one answer of a single-variable request. */
export const single = <A>(
  operation: string,
  results: ReadonlyArray<A>,
): Effect.Effect<A, TwitchDrift> =>
  results[0] === undefined
    ? Effect.fail(new TwitchDrift({ operation, detail: "empty response" }))
    : Effect.succeed(results[0]);
