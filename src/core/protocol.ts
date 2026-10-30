import { Data } from "effect";
import type {
  Campaign,
  CampaignId,
  Channel,
  ChannelId,
  DropId,
  DropInstanceId,
  GameId,
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
  InventoryRead: { readonly progress: ReadonlyArray<Progress> };
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
}>;

export const Event = Data.taggedEnum<Event>();

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
