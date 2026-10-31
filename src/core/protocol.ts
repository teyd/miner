import { Data } from "effect";
import type {
  Award,
  Campaign,
  CampaignId,
  Channel,
  ChannelId,
  DropId,
  DropInstanceId,
  GameId,
  Millis,
  Progress,
} from "./model.ts";

/** Everything the core learns about the world. The runtime turns Twitch answers into these. */
export type Event = Data.TaggedEnum<{
  /** The process started, possibly from saved state. */
  Started: {};
  /** Time passed. The core compares its deadlines with `now`. */
  Tick: {};
  TokenValid: {};
  /**
   * Twitch rejected the token (401, or a token for another client). A network failure during
   * validation is not this: the runtime reports nothing and the next hourly check tries again.
   */
  AuthFailed: {};
  CatalogRead: { readonly campaigns: ReadonlyArray<Campaign> };
  /** The catalog came back `null` or failed after retries: discovery is broken, not empty. */
  CatalogUnavailable: { readonly reason: string };
  InventoryRead: {
    /** Drops of the campaigns the inventory lists (`dropCampaignsInProgress`). */
    readonly progress: ReadonlyArray<Progress>;
    /** Every reward the account received (`gameEventDrops`), from any campaign, ever. */
    readonly awarded: ReadonlyArray<Award>;
  };
  /** PubSub `drop-progress`: Twitch credited minutes to this drop. */
  DropProgress: { readonly dropId: DropId; readonly minutes: number };
  /** PubSub `drop-claim`: the drop is complete and can be claimed with this instance id. */
  DropClaimable: { readonly dropId: DropId; readonly instanceId: DropInstanceId };
  /** `DropCurrentSessionContext`: which drop the watch is crediting, if any. */
  CurrentDropRead: {
    /** The channel the read was asked for; a read for a channel no longer watched is ignored. */
    readonly channelId: ChannelId;
    readonly dropId: DropId | undefined;
    readonly minutes: number;
  };
  ChannelsRead: {
    readonly channels: ReadonlyArray<Channel>;
    /** `readKey` of the `ReadDirectory` or `ReadChannels` this answers. */
    readonly read: string;
  };
  /**
   * A `ReadDirectory` or `ReadChannels` gave up after its retries, or had nothing to ask for (no
   * slug or login known). Its channels stay as they were; discovery stops waiting for it.
   */
  ChannelsReadFailed: { readonly read: string };
  /** PubSub `stream-up`. Stream data lags, so the core re-reads the channel later. */
  StreamUp: { readonly channelId: ChannelId };
  StreamDown: { readonly channelId: ChannelId };
  GameChanged: { readonly channelId: ChannelId; readonly gameId: GameId | undefined };
  WatchTicked: { readonly channelId: ChannelId };
  WatchFailed: {
    readonly channelId: ChannelId;
    /** `refused`: 403/410, the channel won't play for this account. `offline`: 404. */
    readonly reason: "offline" | "refused" | "network";
  };
  ClaimResult: {
    readonly campaignId: CampaignId;
    readonly dropId: DropId;
    /** `unknown` means the answer was lost or unclassifiable: the claim may have succeeded. */
    readonly outcome: "claimed" | "already-claimed" | "unknown";
  };
  /**
   * Request budgets refused these commands' next requests before sending them (critique 08 CF-5).
   * Refusals that arrive together are one event (`coalesceThrottled`): a budget in cooldown
   * refuses a whole discovery burst at one instant, and one step per refusal looked like a core
   * that can't stop waking (`BusyWake`).
   */
  Throttled: { readonly refusals: ReadonlyArray<Refusal> };
}>;

export const Event = Data.taggedEnum<Event>();

/**
 * Twitch said 429, or no turn came within the budget's wait. A refused `Claim` was not sent. The
 * command is due again at `retryAt` at the earliest.
 */
export interface Refusal {
  readonly command: Command;
  readonly budget: "gql" | "cdn";
  readonly retryAt: Millis;
}

/**
 * Merges a run of consecutive `Throttled` events into one, in order. The runtime and the
 * simulator call it on the events queued behind a `Throttled` they are about to step.
 */
export const coalesceThrottled = (events: ReadonlyArray<Event>): Event =>
  Event.Throttled({
    refusals: events.flatMap((e) => (e._tag === "Throttled" ? e.refusals : [])),
  });

/**
 * What the core asks the runtime to do. The runtime persists the new state (claim intents
 * included) before it executes any command, so a crash can never send a claim twice.
 */
export type Command = Data.TaggedEnum<{
  ValidateToken: {};
  ReadCatalog: {};
  ReadInventory: {};
  ReadCurrentDrop: { readonly channelId: ChannelId };
  ReadDirectory: { readonly gameId: GameId };
  ReadChannels: { readonly channelIds: ReadonlyArray<ChannelId> };
  /** The full set of channels to follow for live/offline/game events. Replaces the previous set. */
  Subscribe: { readonly channelIds: ReadonlyArray<ChannelId> };
  /** Start (or switch to) watching this channel. Only one watch exists at a time. */
  Watch: { readonly channelId: ChannelId };
  WatchTick: { readonly channelId: ChannelId };
  StopWatching: {};
  Claim: {
    readonly campaignId: CampaignId;
    readonly dropId: DropId;
    readonly instanceId: DropInstanceId;
  };
}>;

export const Command = Data.taggedEnum<Command>();

export type ChannelRead = Extract<Command, { readonly _tag: "ReadDirectory" | "ReadChannels" }>;

/** Names a channel read, so its answer can be matched to it. */
export const readKey = (command: ChannelRead): string =>
  command._tag === "ReadDirectory"
    ? `directory:${command.gameId}`
    : `channels:${command.channelIds.join(",")}`;

/** The read a `readKey` names. Ids hold no commas (Twitch's ids are digits). */
export const readOfKey = (key: string): ChannelRead => {
  const at = key.indexOf(":");
  const rest = key.slice(at + 1);
  return key.slice(0, at) === "directory"
    ? Command.ReadDirectory({ gameId: rest as GameId })
    : Command.ReadChannels({
        channelIds: (rest === "" ? [] : rest.split(",")) as Array<ChannelId>,
      });
};
