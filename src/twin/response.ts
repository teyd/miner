import { Effect, Inspectable, Option, type Schema, Stream } from "effect";
import { pipeArguments } from "effect/Pipeable";
import {
  Cookies,
  Headers,
  HttpClientError,
  HttpClientResponse,
  HttpIncomingMessage,
  UrlParams,
  type HttpClientRequest,
} from "effect/http";

/**
 * An answer whose body is already here. A web `Response` reads its body through a promise, outside
 * the Effect scheduler, so a `TestClock.adjust` could pass a request still reading its answer; this
 * one resolves at once, so every request the twin serves finishes inside the virtual instant it
 * is answered at.
 */
class TwinResponse extends Inspectable.Class implements HttpClientResponse.HttpClientResponse {
  readonly [HttpIncomingMessage.TypeId] = HttpIncomingMessage.TypeId;
  readonly [HttpClientResponse.TypeId] = HttpClientResponse.TypeId;

  readonly request: HttpClientRequest.HttpClientRequest;
  readonly status: number;
  private readonly body: string;

  constructor(request: HttpClientRequest.HttpClientRequest, status: number, body: string) {
    super();
    this.request = request;
    this.status = status;
    this.body = body;
  }

  get url(): string {
    return this.request.url;
  }
  get headers(): Headers.Headers {
    return Headers.empty;
  }
  get cookies(): Cookies.Cookies {
    return Cookies.empty;
  }
  get remoteAddress(): Option.Option<string> {
    return Option.none();
  }
  get text(): Effect.Effect<string, HttpClientError.HttpClientError> {
    return Effect.succeed(this.body);
  }
  get json(): Effect.Effect<Schema.Json, HttpClientError.HttpClientError> {
    return Effect.try({
      try: () => JSON.parse(this.body) as Schema.Json,
      catch: (cause): HttpClientError.HttpClientError =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({
            request: this.request,
            response: this,
            cause,
          }),
        }),
    });
  }
  get arrayBuffer(): Effect.Effect<ArrayBuffer, HttpClientError.HttpClientError> {
    return Effect.sync(() => new TextEncoder().encode(this.body).buffer);
  }
  get urlParamsBody(): Effect.Effect<UrlParams.UrlParams, HttpClientError.HttpClientError> {
    return Effect.sync(() => UrlParams.fromInput(new URLSearchParams(this.body)));
  }
  get stream(): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> {
    return Stream.make(new TextEncoder().encode(this.body));
  }
  get formData(): Effect.Effect<FormData, HttpClientError.HttpClientError> {
    return Effect.die(new Error("the twin answers no form data"));
  }
  get upgrade(): HttpClientResponse.HttpClientResponse["upgrade"] {
    return Effect.die(new Error("the twin upgrades no connection"));
  }
  toJSON(): unknown {
    return { _id: "HttpClientResponse", url: this.request.url, status: this.status };
  }
  pipe() {
    // oxlint-disable-next-line prefer-rest-params
    return pipeArguments(this, arguments);
  }
}

export const respond = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: string,
): HttpClientResponse.HttpClientResponse => new TwinResponse(request, status, body);

export const respondJson = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
): HttpClientResponse.HttpClientResponse => respond(request, status, JSON.stringify(body));

/** The connection broke after the request left: the client can't know what happened. */
export const transportError = (request: HttpClientRequest.HttpClientRequest, description: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description }),
  });
