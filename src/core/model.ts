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
  /** The directory URL name, e.g. `dead-by-daylight`; the directory query needs it. */
  readonly slug: string;
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

/**
 * A reward Twitch delivered to the account (`Inventory.gameEventDrops`): a benefit id and when it
 * was last awarded. Twitch lists one entry per benefit, whatever campaign awarded it.
 */
export interface Award {
  readonly benefitId: string;
  readonly at: Millis;
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

/** `item`: an in-game reward (`DIRECT_ENTITLEMENT`, or a type Twitch added since). */
export type Reward = "item" | "badge" | "emote";

export type Order = "ending-soonest" | "least-slack";

export interface GameGoal {
  readonly id: GameId;
  readonly rewards: ReadonlyArray<Reward>;
}

/** One `drops` goal of `config.json` (decision 28), with names resolved to ids. */
export interface DropsGoal {
  /** Games in priority order, or every game but `excludeGames`. */
  readonly games: "all" | ReadonlyArray<GameGoal>;
  /** Rewards for `"all"`; a listed game carries its own. */
  readonly rewards: ReadonlyArray<Reward>;
  readonly excludeGames: ReadonlyArray<GameId>;
  /** The goal's and the file's excluded channels. */
  readonly excludeChannels: ReadonlyArray<ChannelId>;
  /** Items only from campaigns whose game account is linked. Badges and emotes ignore it. */
  readonly linkedOnly: boolean;
  readonly order: Order;
}

export interface Settings {
  /** Highest priority first. The first goal with a drop to earn on a live channel wins. */
  readonly goals: ReadonlyArray<DropsGoal>;
}

/** The goal of an empty `config.json`: every game, every reward, items only when linked. */
export const DEFAULT_GOAL: DropsGoal = {
  games: "all",
  rewards: ["item", "badge", "emote"],
  excludeGames: [],
  excludeChannels: [],
  linkedOnly: true,
  order: "ending-soonest",
};

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
