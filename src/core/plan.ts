import {
  MINUTE,
  type Campaign,
  type CampaignId,
  type Channel,
  type ChannelId,
  type Drop,
  type DropsGoal,
  type Millis,
  type Settings,
} from "./model.ts";
import {
  canEarn,
  channelCanEarn,
  isActive,
  minutesOf,
  remainingMinutes,
  slackOf,
  wantedDrops,
  type ProgressMap,
} from "./rules.ts";

export interface Target {
  /** Index of the goal in `settings.goals`. */
  readonly goal: number;
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
  /** The campaign being watched, if any: `least-slack` gives it `SLACK_HYSTERESIS`. */
  readonly watching: CampaignId | undefined;
}

/**
 * Slack moves while we watch: the watched campaign's stays put (each minute brings it a minute
 * of progress) while every other campaign's shrinks. Without a margin, two campaigns with close
 * slack would trade places every minute. TDM sorts by availability only when it reloads the
 * inventory (`twitch.py:741-750`), so its order holds for an hour; this margin bounds the
 * switches to one per 30 minutes instead.
 */
export const SLACK_HYSTERESIS: Millis = 30 * MINUTE;

/** A campaign one goal can work on now, with the drops it wants that can earn now. */
export interface Pick {
  readonly goal: number;
  readonly campaign: Campaign;
  readonly drops: ReadonlyArray<Drop>;
  /** The goal's ranking key under its `order`: smaller goes first. */
  readonly key: number;
}

const gameRank = (goal: DropsGoal, campaign: Campaign): number =>
  goal.games === "all" ? 0 : goal.games.findIndex((g) => g.id === campaign.game.id);

/**
 * `least-slack`: the wanted drop with the least time to spare. A drop that can no longer finish
 * in time earns nothing, so a campaign with only such drops goes after every feasible one.
 */
const orderKey = (input: PlanInput, goal: DropsGoal, campaign: Campaign): number => {
  if (goal.order === "ending-soonest") return campaign.endsAt;
  const wanted = wantedDrops(goal, campaign, input.progress);
  const slacks = campaign.drops
    .filter(
      (d) =>
        wanted.has(d.id) &&
        input.now < d.endsAt &&
        minutesOf(input.progress, d.id) < d.requiredMinutes,
    )
    .map((d) => slackOf(campaign, d, input.progress, input.now))
    .filter((slack) => slack >= 0);
  const bonus = campaign.id === input.watching ? SLACK_HYSTERESIS : 0;
  return Math.min(...slacks) - bonus;
};

const picksOf = (input: PlanInput, goal: DropsGoal, index: number): ReadonlyArray<Pick> =>
  input.campaigns
    .flatMap((campaign): ReadonlyArray<Pick> => {
      if (!isActive(campaign, input.now)) return [];
      const wanted = wantedDrops(goal, campaign, input.progress);
      const drops = campaign.drops.filter(
        (d) => wanted.has(d.id) && canEarn(d, input.progress, input.now),
      );
      if (drops.length === 0) return [];
      return [{ goal: index, campaign, drops, key: orderKey(input, goal, campaign) }];
    })
    .toSorted(
      (a, b) =>
        gameRank(goal, a.campaign) - gameRank(goal, b.campaign) ||
        a.key - b.key ||
        a.campaign.endsAt - b.campaign.endsAt ||
        a.campaign.id.localeCompare(b.campaign.id),
    );

/**
 * Every campaign some goal can work on, best first: goals in priority order, then the goal's
 * game order, then its `order`. A campaign two goals want appears once per goal.
 */
export const minable = (input: PlanInput): ReadonlyArray<Pick> =>
  input.settings.goals.flatMap((goal, index) => picksOf(input, goal, index));

/** The wanted drop of a campaign closest to completion (TDM `Campaign.first_drop`). */
export const nextDrop = (input: PlanInput, pick: Pick): Drop | undefined =>
  pick.drops.toSorted(
    (a, b) =>
      remainingMinutes(pick.campaign, a, input.progress) -
        remainingMinutes(pick.campaign, b, input.progress) || a.endsAt - b.endsAt,
  )[0];

const goalOf = (input: PlanInput, pick: Pick): DropsGoal => input.settings.goals[pick.goal]!;

/** Whether a goal that may watch `channelId` wants what this campaign can earn now. */
export const wantedOn = (input: PlanInput, campaign: Campaign, channelId: ChannelId): boolean =>
  minable(input).some(
    (p) => p.campaign.id === campaign.id && !goalOf(input, p).excludeChannels.includes(channelId),
  );

/** Live channels that can credit the campaign for its goal, most viewers first. */
export const candidates = (input: PlanInput, pick: Pick): ReadonlyArray<Channel> =>
  [...input.channels.values()]
    .filter((ch) =>
      channelCanEarn(pick.campaign, ch, goalOf(input, pick).excludeChannels, input.refused),
    )
    .toSorted(
      (a, b) => (b.live?.viewers ?? 0) - (a.live?.viewers ?? 0) || a.login.localeCompare(b.login),
    );

/**
 * The best drop that has a channel to watch: the first goal with something to earn on a live
 * channel wins (decision 28). A better-ranked campaign without a live channel never displaces a
 * working watch, so the search moves on to the next campaign, then the next goal.
 */
export const plan = (input: PlanInput): Target | NoTarget => {
  const picks = minable(input);
  if (picks.length === 0) return "nothing-to-mine";
  for (const pick of picks) {
    const drop = nextDrop(input, pick);
    const channel = candidates(input, pick)[0];
    if (drop !== undefined && channel !== undefined) {
      return { goal: pick.goal, campaign: pick.campaign, drop, channel };
    }
  }
  return "no-live-channel";
};

/** Channels worth a live/offline subscription: every candidate for every minable campaign. */
export const watchlist = (input: PlanInput, limit: number): ReadonlyArray<ChannelId> => {
  const ids = new Set<ChannelId>();
  for (const pick of minable(input)) {
    const campaign = pick.campaign;
    const excluded = goalOf(input, pick).excludeChannels;
    const known =
      campaign.allowedChannels.length > 0
        ? campaign.allowedChannels
        : [...input.channels.values()]
            .filter((ch) => ch.gameId === campaign.game.id)
            .map((ch) => ch.id);
    for (const id of known) {
      if (ids.size >= limit) return [...ids];
      if (!excluded.includes(id)) ids.add(id);
    }
  }
  return [...ids];
};
