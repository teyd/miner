import {
  CLAIM_GRACE,
  MINUTE,
  SPECIAL_GAMES,
  type Benefit,
  type Campaign,
  type Channel,
  type ChannelId,
  type Drop,
  type DropId,
  type DropsGoal,
  type Millis,
  type Progress,
  type Reward,
} from "./model.ts";

export type ProgressMap = ReadonlyMap<DropId, Progress>;

const isClaimed = (progress: ProgressMap, dropId: DropId): boolean =>
  progress.get(dropId)?.claimed ?? false;

export const minutesOf = (progress: ProgressMap, dropId: DropId): number =>
  progress.get(dropId)?.minutes ?? 0;

/**
 * Badges and emotes are Twitch-side; everything else is an in-game item for the linked account.
 * TDM treats an unknown type as an item too (`inventory.py:33-40, 394-404`).
 */
export const rewardOf = (benefit: Benefit): Reward =>
  benefit.distribution === "BADGE" ? "badge" : benefit.distribution === "EMOTE" ? "emote" : "item";

/** The rewards this goal wants from the campaign's game, or `undefined` if it skips the game. */
export const rewardsFor = (
  goal: DropsGoal,
  campaign: Campaign,
): ReadonlyArray<Reward> | undefined => {
  const id = campaign.game.id;
  if (goal.games === "all") return goal.excludeGames.includes(id) ? undefined : goal.rewards;
  return goal.games.find((g) => g.id === id)?.rewards;
};

/**
 * Whether the goal wants this reward. An item needs a linked game account unless the goal sets
 * `linkedOnly: false`: some campaigns credit unlinked accounts and deliver once linked (research
 * 02 §3, Funcom FAQ); TDM mines items only when linked (`inventory.py:394-404`). Badges and
 * emotes never need a link.
 */
const wantsBenefit = (
  goal: DropsGoal,
  campaign: Campaign,
  rewards: ReadonlyArray<Reward>,
  benefit: Benefit,
): boolean => {
  const reward = rewardOf(benefit);
  return rewards.includes(reward) && (reward !== "item" || campaign.linked || !goal.linkedOnly);
};

/**
 * Drops of the campaign worth earning for this goal: those with a wanted reward, and every
 * unclaimed drop a wanted drop waits on. A drop without wanted rewards still earns minutes
 * alongside the others, it just never makes a campaign worth watching on its own (TDM earns a
 * drop without benefits only inside a precondition chain, `inventory.py:110-117`).
 */
export const wantedDrops = (
  goal: DropsGoal,
  campaign: Campaign,
  progress: ProgressMap,
): ReadonlySet<DropId> => {
  const rewards = rewardsFor(goal, campaign);
  if (rewards === undefined) return new Set();
  const wanted = new Set<DropId>();
  const add = (drop: Drop) => {
    if (wanted.has(drop.id) || isClaimed(progress, drop.id)) return;
    wanted.add(drop.id);
    for (const id of drop.preconditions) {
      const pre = campaign.drops.find((d) => d.id === id);
      if (pre !== undefined) add(pre);
    }
  };
  for (const drop of campaign.drops) {
    if (drop.benefits.some((b) => wantsBenefit(goal, campaign, rewards, b))) add(drop);
  }
  return wanted;
};

/** Whether the goal wants anything from this campaign, whatever has been earned so far. */
export const isEligible = (campaign: Campaign, goal: DropsGoal): boolean =>
  wantedDrops(goal, campaign, new Map()).size > 0;

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

/**
 * Time a drop has to spare: until it ends, minus the minutes it (and its unclaimed precondition
 * chain) still needs. Research 07's "least slack"; TDM's `availability` is the ratio of the two
 * (`inventory.py:282-286`), which ranks a long drop with hours to spare like a short one with
 * minutes to spare, so the config documents the difference instead. For a drop whose window
 * opens later it is only a window fit: the planner ranks by drops that earn now (`plan.ts`).
 */
export const slackOf = (
  campaign: Campaign,
  drop: Drop,
  progress: ProgressMap,
  now: Millis,
): Millis =>
  drop.endsAt - Math.max(now, drop.startsAt) - remainingMinutes(campaign, drop, progress) * MINUTE;

/** Whether watching `channel` can credit `campaign` right now, for a goal excluding `excluded`. */
export const channelCanEarn = (
  campaign: Campaign,
  channel: Channel,
  excluded: ReadonlyArray<ChannelId>,
  refused: ReadonlySet<ChannelId>,
): boolean => {
  const live = channel.live;
  if (live === undefined) return false;
  if (excluded.includes(channel.id) || refused.has(channel.id)) return false;
  const allowed =
    campaign.allowedChannels.length === 0
      ? live.dropsEnabled
      : campaign.allowedChannels.includes(channel.id);
  return allowed && (channel.gameId === campaign.game.id || SPECIAL_GAMES.has(campaign.game.id));
};
