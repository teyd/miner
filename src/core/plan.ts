import type { Campaign, Channel, ChannelId, Drop, Millis, Settings } from "./model.ts";
import {
  canEarn,
  channelCanEarn,
  isActive,
  isEligible,
  remainingMinutes,
  type ProgressMap,
} from "./rules.ts";

export interface Target {
  readonly campaign: Campaign;
  readonly drop: Drop;
  readonly channel: Channel;
}

export type NoTarget = "nothing-to-mine" | "no-live-channel";

export interface PlanInput {
  readonly campaigns: ReadonlyArray<Campaign>;
  readonly progress: ProgressMap;
  readonly channels: ReadonlyMap<ChannelId, Channel>;
  readonly settings: Settings;
  readonly refused: ReadonlySet<ChannelId>;
  readonly now: Millis;
}

const gameRank = (settings: Settings, campaign: Campaign): number => {
  const index = settings.games.indexOf(campaign.game.id);
  return index === -1 ? settings.games.length : index;
};

/** Campaigns with an earnable drop, best first: game priority, then the one ending soonest. */
export const minable = (input: PlanInput): ReadonlyArray<Campaign> =>
  input.campaigns
    .filter(
      (c) =>
        isEligible(c, input.settings) &&
        isActive(c, input.now) &&
        c.drops.some((d) => canEarn(d, input.progress, input.now)),
    )
    .toSorted(
      (a, b) =>
        gameRank(input.settings, a) - gameRank(input.settings, b) ||
        a.endsAt - b.endsAt ||
        a.id.localeCompare(b.id),
    );

/** The earnable drop of a campaign closest to completion (TDM `Campaign.first_drop`). */
export const nextDrop = (input: PlanInput, campaign: Campaign): Drop | undefined =>
  campaign.drops
    .filter((d) => canEarn(d, input.progress, input.now))
    .toSorted(
      (a, b) =>
        remainingMinutes(campaign, a, input.progress) -
          remainingMinutes(campaign, b, input.progress) || a.endsAt - b.endsAt,
    )[0];

/** Live channels that can credit the campaign: allowed channels first, then most viewers. */
export const candidates = (input: PlanInput, campaign: Campaign): ReadonlyArray<Channel> =>
  [...input.channels.values()]
    .filter((ch) => channelCanEarn(campaign, ch, input.settings, input.refused))
    .toSorted(
      (a, b) => (b.live?.viewers ?? 0) - (a.live?.viewers ?? 0) || a.login.localeCompare(b.login),
    );

/**
 * The best drop that has a channel to watch. A better-ranked campaign without a live channel
 * never displaces a working watch, so the search moves on to the next campaign.
 */
export const plan = (input: PlanInput): Target | NoTarget => {
  const campaigns = minable(input);
  if (campaigns.length === 0) return "nothing-to-mine";
  for (const campaign of campaigns) {
    const drop = nextDrop(input, campaign);
    const channel = candidates(input, campaign)[0];
    if (drop !== undefined && channel !== undefined) return { campaign, drop, channel };
  }
  return "no-live-channel";
};

/** Channels worth a live/offline subscription: every candidate for every minable campaign. */
export const watchlist = (input: PlanInput, limit: number): ReadonlyArray<ChannelId> => {
  const ids = new Set<ChannelId>();
  for (const campaign of minable(input)) {
    const known =
      campaign.allowedChannels.length > 0
        ? campaign.allowedChannels
        : [...input.channels.values()]
            .filter((ch) => ch.gameId === campaign.game.id)
            .map((ch) => ch.id);
    for (const id of known) {
      if (ids.size >= limit) return [...ids];
      if (!input.settings.excludeChannels.includes(id)) ids.add(id);
    }
  }
  return [...ids];
};
