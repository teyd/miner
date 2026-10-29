import type { Brand } from "effect";

export type CampaignId = Brand.Branded<string, "CampaignId">;
export type DropId = Brand.Branded<string, "DropId">;
export type DropInstanceId = Brand.Branded<string, "DropInstanceId">;
export type ChannelId = Brand.Branded<string, "ChannelId">;
export type GameId = Brand.Branded<string, "GameId">;

/** Milliseconds since the epoch, always read from `Clock`. */
export type Millis = number;

export const MINUTE: Millis = 60_000;
export const HOUR: Millis = 60 * MINUTE;

/** Twitch's `distributionType`. Badges and emotes are Twitch-side and need no game account link. */
export type Distribution = "BADGE" | "EMOTE" | "DIRECT_ENTITLEMENT" | "UNKNOWN";

export interface Benefit {
  readonly id: string;
  readonly name: string;
  readonly distribution: Distribution;
}

export interface Game {
  readonly id: GameId;
  readonly name: string;
}

export interface Drop {
  readonly id: DropId;
  readonly name: string;
  readonly requiredMinutes: number;
  readonly startsAt: Millis;
  readonly endsAt: Millis;
  /** Drops that must be claimed before this one earns anything. */
  readonly preconditions: ReadonlyArray<DropId>;
  readonly benefits: ReadonlyArray<Benefit>;
}

export interface Campaign {
  readonly id: CampaignId;
  readonly name: string;
  readonly game: Game;
  readonly startsAt: Millis;
  readonly endsAt: Millis;
  /** Whether the account is connected to the game publisher's account. */
  readonly linked: boolean;
  /** Empty means any drops-enabled channel streaming the game. */
  readonly allowedChannels: ReadonlyArray<ChannelId>;
  readonly drops: ReadonlyArray<Drop>;
}

/** What Twitch says about one drop for this account (inventory, PubSub frames, current-drop reads). */
export interface Progress {
  readonly dropId: DropId;
  readonly campaignId: CampaignId;
  /** Kept with the progress so a claim can be planned after the campaign leaves the catalog. */
  readonly campaignEndsAt: Millis;
  readonly minutes: number;
  /** Present once the drop is complete and claimable. */
  readonly instanceId: DropInstanceId | undefined;
  readonly claimed: boolean;
}

export interface Live {
  readonly viewers: number;
  readonly dropsEnabled: boolean;
}

export interface Channel {
  readonly id: ChannelId;
  readonly login: string;
  /** The channel's category. Twitch reports it offline too, so a followed channel stays followed. */
  readonly gameId: GameId | undefined;
  /** `undefined` while offline. */
  readonly live: Live | undefined;
}

export interface Settings {
  /** Game priority, highest first. Empty mines every eligible game. */
  readonly games: ReadonlyArray<GameId>;
  readonly excludeChannels: ReadonlyArray<ChannelId>;
  /** Mine campaigns whose rewards include a badge or an emote, linked or not. */
  readonly badgesAndEmotes: boolean;
}

/**
 * Games whose campaigns earn on any channel, whatever it streams.
 * Source: TDM `utils.py:422` (`Game.SPECIAL_GAME_IDS`), "IRL" added 2026-05-31.
 */
export const SPECIAL_GAMES: ReadonlySet<string> = new Set(["509663", "509672"]);

/**
 * Twitch keeps a completed drop claimable until 24 h after its campaign ends.
 * Source: TDM `inventory.py:143-151`, quoting help.twitch.tv. A help-page snippet says 7 days;
 * the shorter window wins until a live check settles it (research 02 §3).
 */
export const CLAIM_GRACE: Millis = 24 * HOUR;

export const claimKey = (campaignId: CampaignId, dropId: DropId): string =>
  `${campaignId}/${dropId}`;
