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
  /** Campaigns given up for now: their watch stalled on credit that earned nothing (`STALL_AFTER`). */
  readonly avoidedCampaigns: ReadonlySet<CampaignId>;
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
  /** Wanted drops that earn now (`canEarn`): drops whose window hasn't opened don't count. */
  readonly drops: ReadonlyArray<Drop>;
  /** Some of `drops` can still finish before it ends. */
  readonly feasible: boolean;
  /** The goal's ranking key under its `order`: smaller goes first. */
  readonly key: number;
}

/** Ranks every campaign some goal can work on, best first. `minable` is the miner's ranking. */
export type Rank = (input: PlanInput) => ReadonlyArray<Pick>;

/** A total order on numbers: `Infinity - Infinity` is `NaN`, which a comparator must never return. */
export const compareNumbers = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ids and names in code-unit order. `localeCompare` would make the order depend on the host's
 * locale, and its first call loads ICU's collation data: 2 MB of RSS (research 03 §2).
 */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The game's place in the goal's list; `"all"` ranks every game alike. */
const gameRank = (goal: DropsGoal, campaign: Campaign): number => {
  if (goal.games === "all") return 0;
  const index = goal.games.findIndex((g) => g.id === campaign.game.id);
  // `picksOf` never sees an unlisted game (it wants nothing from it); last, if it ever does.
  return index === -1 ? goal.games.length : index;
};

/** A drop that earns now and can still finish: its slack is not negative. */
const fits = (input: PlanInput, campaign: Campaign, drop: Drop): boolean =>
  slackOf(campaign, drop, input.progress, input.now) >= 0;

/**
 * `ending-soonest`: the campaign's end. `least-slack`: the least time to spare of a drop that
 * earns now and can still finish. A drop whose window opens later ranks nothing: only what earns
 * now can be watched, and a campaign whose watchable drop has hours to spare is no emergency
 * because a later drop will be (review of decision 28, P1-1).
 */
const orderKey = (
  input: PlanInput,
  goal: DropsGoal,
  campaign: Campaign,
  drops: ReadonlyArray<Drop>,
): number => {
  if (goal.order === "ending-soonest") return campaign.endsAt;
  const slacks = drops
    .map((d) => slackOf(campaign, d, input.progress, input.now))
    .filter((slack) => slack >= 0);
  const bonus = campaign.id === input.watching ? SLACK_HYSTERESIS : 0;
  return Math.min(...slacks) - bonus;
};

const picksOf = (input: PlanInput, goal: DropsGoal, index: number): ReadonlyArray<Pick> =>
  input.campaigns.flatMap((campaign): ReadonlyArray<Pick> => {
    if (!isActive(campaign, input.now) || input.avoidedCampaigns.has(campaign.id)) return [];
    const wanted = wantedDrops(goal, campaign, input.progress);
    const drops = campaign.drops.filter(
      (d) => wanted.has(d.id) && canEarn(d, input.progress, input.now),
    );
    if (drops.length === 0) return [];
    const feasible = drops.some((d) => fits(input, campaign, d));
    return [
      { goal: index, campaign, drops, feasible, key: orderKey(input, goal, campaign, drops) },
    ];
  });

/**
 * Every campaign some goal can work on, best first: first every campaign with a drop that can
 * still finish, then the rest. Within each, goals in priority order, then the goal's game order,
 * then its `order`. A campaign that can't finish earns nothing, so it must not hold up a lower
 * goal that can (review of decision 28, P1-2); it is still watched when nothing else is. A
 * campaign two goals want appears once per goal.
 */
export const minable: Rank = (input) =>
  input.settings.goals
    .flatMap((goal, index) => picksOf(input, goal, index))
    .toSorted(
      (a, b) =>
        Number(b.feasible) - Number(a.feasible) ||
        a.goal - b.goal ||
        compareNumbers(goalRank(input, a), goalRank(input, b)) ||
        compareNumbers(a.key, b.key) ||
        compareNumbers(a.campaign.endsAt, b.campaign.endsAt) ||
        compareText(a.campaign.id, b.campaign.id),
    );

const goalRank = (input: PlanInput, pick: Pick): number =>
  gameRank(input.settings.goals[pick.goal]!, pick.campaign);

/** The wanted drop of a campaign closest to completion (TDM `Campaign.first_drop`). */
export const nextDrop = (input: PlanInput, pick: Pick): Drop | undefined =>
  pick.drops.toSorted(
    (a, b) =>
      Number(fits(input, pick.campaign, b)) - Number(fits(input, pick.campaign, a)) ||
      compareNumbers(
        remainingMinutes(pick.campaign, a, input.progress),
        remainingMinutes(pick.campaign, b, input.progress),
      ) ||
      compareNumbers(a.endsAt, b.endsAt) ||
      compareText(a.id, b.id),
  )[0];

const goalOf = (input: PlanInput, pick: Pick): DropsGoal => input.settings.goals[pick.goal]!;

/**
 * Whether a goal that may watch `channelId` wants this drop and it can still earn: the drop is one
 * the ranking would work on. A credit to any other drop earns the plan nothing, even in a wanted
 * campaign: a drop complete beyond its requirement, received already, or an item the goal can't
 * use (unlinked under `linkedOnly`).
 */
export const usableOn = (
  input: PlanInput,
  campaign: Campaign,
  drop: Drop,
  channelId: ChannelId,
  rank: Rank = minable,
): boolean =>
  rank(input).some(
    (p) =>
      p.campaign.id === campaign.id &&
      p.drops.some((d) => d.id === drop.id) &&
      !goalOf(input, p).excludeChannels.includes(channelId),
  );

/**
 * Whether a goal that may watch `channelId` works on this campaign: the ranking has it, with a
 * wanted drop that can earn now.
 */
export const wantedOn = (
  input: PlanInput,
  campaign: Campaign,
  channelId: ChannelId,
  rank: Rank = minable,
): boolean =>
  rank(input).some(
    (p) => p.campaign.id === campaign.id && !goalOf(input, p).excludeChannels.includes(channelId),
  );

/** Live channels that can credit the campaign for its goal, most viewers first. */
export const candidates = (input: PlanInput, pick: Pick): ReadonlyArray<Channel> =>
  [...input.channels.values()]
    .filter((ch) =>
      channelCanEarn(pick.campaign, ch, goalOf(input, pick).excludeChannels, input.refused),
    )
    .toSorted(
      (a, b) =>
        compareNumbers(b.live?.viewers ?? 0, a.live?.viewers ?? 0) || compareText(a.login, b.login),
    );

/**
 * The best drop that has a channel to watch: the first goal with something to earn on a live
 * channel wins (decision 28), something that can still finish before anything that can't. A
 * better-ranked campaign without a live channel never displaces a working watch, so the search
 * moves on to the next campaign, then the next goal.
 */
export const plan = (input: PlanInput, rank: Rank = minable): Target | NoTarget => {
  const picks = rank(input);
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
export const watchlist = (
  input: PlanInput,
  limit: number,
  rank: Rank = minable,
): ReadonlyArray<ChannelId> => {
  const ids = new Set<ChannelId>();
  for (const pick of rank(input)) {
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
