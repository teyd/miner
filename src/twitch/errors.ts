import { Schema } from "effect";

/** Twitch rejected the token: 401, or a token issued to another client. Needs a new login. */
export class AuthRejected extends Schema.TaggedError<
  AuthRejected,
  { readonly brand: unique symbol }
>()("AuthRejected", {
  reason: Schema.String,
}) {}

/**
 * A read that may pass on retry: no answer, an HTTP 5xx or 429, or a GraphQL backend error
 * (`service error`). Retries already ran when this reaches a caller.
 */
export class TwitchUnavailable extends Schema.TaggedError<
  TwitchUnavailable,
  { readonly brand: unique symbol }
>()("TwitchUnavailable", { operation: Schema.String, detail: Schema.String }) {}

/**
 * Twitch answered, but not with the shape we decode, or with `null` where data belongs: a hash
 * rotated, a field moved, or the catalog was withheld. Retrying won't help; a human must look.
 */
export class TwitchDrift extends Schema.TaggedError<
  TwitchDrift,
  { readonly brand: unique symbol }
>()("TwitchDrift", {
  operation: Schema.String,
  detail: Schema.String,
}) {}

export type TwitchError = AuthRejected | TwitchUnavailable | TwitchDrift;
