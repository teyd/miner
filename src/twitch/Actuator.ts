import { Context, Schema, type Effect } from "effect";
import type { ChannelId, DropInstanceId } from "../core/model.ts";
import type { AuthRejected, TwitchError } from "./errors.ts";

/** A watch tick that credited nothing. The reasons are the core's `WatchFailed` reasons. */
export class WatchFailure extends Schema.TaggedError<
  WatchFailure,
  { readonly brand: unique symbol }
>()("WatchFailure", {
  channelId: Schema.String,
  /** `refused`: 403/410, the channel won't play for this account. `offline`: 404. */
  reason: Schema.Literals(["offline", "refused", "network"]),
}) {}

/** Twitch accepts `ELIGIBLE_FOR_ALL` and `DROP_INSTANCE_ALREADY_CLAIMED` (TDM `inventory.py:200-215`). */
export type ClaimAnswer = "claimed" | "already-claimed";

/**
 * Every write the miner makes to Twitch: the one watch session, its ticks, claims, and the channels
 * followed for live/offline/game frames. `live.ts` sends them to Twitch, the twin simulates them,
 * and the shadow only records them.
 */
export class Actuator extends Context.Service<
  Actuator,
  {
    /** Opens the watch session on this channel, closing any other. Playback goes by login. */
    readonly watch: (channelId: ChannelId, login: string) => Effect.Effect<void>;
    readonly watchTick: (channelId: ChannelId) => Effect.Effect<void, WatchFailure | AuthRejected>;
    readonly stopWatching: Effect.Effect<void>;
    /** Sent once per call. A lost answer may still have succeeded: never retry it. */
    readonly claim: (instanceId: DropInstanceId) => Effect.Effect<ClaimAnswer, TwitchError>;
    /** Replaces the followed channel set. */
    readonly subscribe: (channelIds: ReadonlyArray<ChannelId>) => Effect.Effect<void>;
  }
>()("miner/twitch/Actuator") {}
