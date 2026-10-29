import {
  CLAIM_GRACE,
  SPECIAL_GAMES,
  type Campaign,
  type Channel,
  type ChannelId,
  type Drop,
  type DropId,
  type Millis,
  type Progress,
  type Settings,
} from "./model.ts";

export type ProgressMap = ReadonlyMap<DropId, Progress>;

const isClaimed = (progress: ProgressMap, dropId: DropId): boolean =>
  progress.get(dropId)?.claimed ?? false;

export const minutesOf = (progress: ProgressMap, dropId: DropId): number =>
  progress.get(dropId)?.minutes ?? 0;

export const hasBadgeOrEmote = (campaign: Campaign): boolean =>
  campaign.drops.some((drop) =>
    drop.benefits.some((b) => b.distribution === "BADGE" || b.distribution === "EMOTE"),
  );

/**
 * Whether this account can earn the campaign at all. Decided per campaign: a campaign mixing a
 * badge with an in-game item is minable unlinked and yields only the badge (TDM `inventory.py:394-404`).
 */
export const isEligible = (campaign: Campaign, settings: Settings): boolean =>
  (campaign.linked || (settings.badgesAndEmotes && hasBadgeOrEmote(campaign))) &&
  (settings.games.length === 0 || settings.games.includes(campaign.game.id));

export const isActive = (campaign: Campaign, now: Millis): boolean =>
  campaign.startsAt <= now && now < campaign.endsAt;

/** A drop earns minutes only when its window is open and every precondition drop is claimed. */
export const canEarn = (drop: Drop, progress: ProgressMap, now: Millis): boolean =>
  drop.requiredMinutes > 0 &&
  drop.startsAt <= now &&
  now < drop.endsAt &&
  !isClaimed(progress, drop.id) &&
  minutesOf(progress, drop.id) < drop.requiredMinutes &&
  drop.preconditions.every((id) => isClaimed(progress, id));

/** Minutes still needed for this drop, including the longest chain of unclaimed preconditions. */
export const remainingMinutes = (
  campaign: Campaign,
  drop: Drop,
  progress: ProgressMap,
  seen: ReadonlySet<DropId> = new Set(),
): number => {
  if (isClaimed(progress, drop.id) || seen.has(drop.id)) return 0;
  const own = Math.max(0, drop.requiredMinutes - minutesOf(progress, drop.id));
  const next = new Set([...seen, drop.id]);
  const chain = drop.preconditions.map((id) => {
    const pre = campaign.drops.find((d) => d.id === id);
    return pre === undefined ? 0 : remainingMinutes(campaign, pre, progress, next);
  });
  return own + Math.max(0, ...chain);
};

/** A completed, unclaimed drop whose claim window is still open, wherever the campaign stands. */
export const isClaimable = (p: Progress, now: Millis): boolean =>
  p.instanceId !== undefined && !p.claimed && now < p.campaignEndsAt + CLAIM_GRACE;

/** Whether watching `channel` can credit `campaign` right now. */
export const channelCanEarn = (
  campaign: Campaign,
  channel: Channel,
  settings: Settings,
  refused: ReadonlySet<ChannelId>,
): boolean => {
  const live = channel.live;
  if (live === undefined) return false;
  if (settings.excludeChannels.includes(channel.id) || refused.has(channel.id)) return false;
  const allowed =
    campaign.allowedChannels.length === 0
      ? live.dropsEnabled
      : campaign.allowedChannels.includes(channel.id);
  return allowed && (channel.gameId === campaign.game.id || SPECIAL_GAMES.has(campaign.game.id));
};
