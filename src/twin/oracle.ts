import {
  SPECIAL_GAMES,
  type Campaign,
  type CampaignId,
  type Channel,
  type ChannelId,
  type Drop,
  type DropId,
  type DropsGoal,
  type Millis,
  type Progress,
  type Settings,
} from "../core/model.ts";
import { SLACK_HYSTERESIS } from "../core/plan.ts";

/**
 * Decision 28 written a second time, from its text and the review that refined it, for the
 * simulator to judge the core's picks by. It shares no code with `plan.ts` or `rules.ts`: a bug
 * copied into both would hide itself. Only `SLACK_HYSTERESIS`, a tuning value, is the core's.
 *
 * - The miner works on the first goal with something to do now: one of its campaigns has a drop
 *   it wants that earns now, on a live channel the goal may watch and that credits the campaign.
 * - Something that can still finish comes before anything that can't, whatever the goal
 *   (a doomed goal must not starve the ones below it).
 * - Within a goal: listed games in list order (`"all"` treats every game alike), then `order`.
 *   `ending-soonest` by the campaign's end. `least-slack` by the least time to spare of a drop
 *   that earns now and can finish; the watched campaign keeps its place until another has
 *   `SLACK_HYSTERESIS` less.
 * - A goal wants a drop whose reward type it lists for the game (an item only from a linked
 *   campaign unless `linkedOnly` is off), and every unclaimed drop such a drop waits on.
 *   `excludeGames` leaves games out of `"all"`; `excludeChannels` keeps the goal off channels.
 */

/** What the core knew when it picked: its catalog, progress, channels and avoided channels. */
export interface View {
  readonly catalog: ReadonlyArray<Campaign>;
  readonly progress: ReadonlyMap<DropId, Progress>;
  readonly channels: ReadonlyMap<ChannelId, Channel>;
  readonly avoid: ReadonlySet<ChannelId>;
  readonly now: Millis;
}

/** The reward type of a benefit: badges and emotes are Twitch's, anything else an item. */
const rewardType = (distribution: string) =>
  distribution === "BADGE" ? "badge" : distribution === "EMOTE" ? "emote" : "item";

/** The drops a goal asks for in a campaign, each with the unclaimed drops it waits on. */
export const goalDrops = (
  goal: DropsGoal,
  campaign: Campaign,
  claimed: (id: DropId) => boolean,
): ReadonlyArray<Drop> => {
  const game = campaign.game.id;
  const rewards =
    goal.games === "all"
      ? goal.excludeGames.includes(game)
        ? []
        : goal.rewards
      : (goal.games.find((g) => g.id === game)?.rewards ?? []);
  const asks = (drop: Drop) =>
    drop.benefits.some((b) => {
      const type = rewardType(b.distribution);
      return rewards.includes(type) && (type !== "item" || campaign.linked || !goal.linkedOnly);
    });
  const out = new Set<DropId>();
  const visit = (drop: Drop | undefined) => {
    if (drop === undefined || out.has(drop.id) || claimed(drop.id)) return;
    out.add(drop.id);
    for (const id of drop.preconditions) visit(campaign.drops.find((d) => d.id === id));
  };
  for (const drop of campaign.drops) if (asks(drop)) visit(drop);
  return campaign.drops.filter((d) => out.has(d.id));
};

interface Entry {
  readonly goal: number;
  readonly campaign: CampaignId;
  readonly feasible: boolean;
  readonly game: number;
  /** `undefined`: nothing to compare (a campaign that can't finish has no slack to rank by). */
  readonly key: number | undefined;
  readonly order: DropsGoal["order"];
}

const minutesDone = (view: View, id: DropId) => view.progress.get(id)?.minutes ?? 0;
const isClaimed = (view: View, id: DropId) => view.progress.get(id)?.claimed === true;

/** Earns now: window open, unclaimed, unfinished, and every drop it waits on claimed. */
const earnsNow = (view: View, drop: Drop): boolean =>
  drop.startsAt <= view.now &&
  view.now < drop.endsAt &&
  !isClaimed(view, drop.id) &&
  minutesDone(view, drop.id) < drop.requiredMinutes &&
  drop.preconditions.every((id) => isClaimed(view, id));

/** Time to spare before the drop ends, after the minutes it still needs. */
const spare = (view: View, drop: Drop): Millis =>
  drop.endsAt - view.now - (drop.requiredMinutes - minutesDone(view, drop.id)) * 60_000;

/** The goal may watch this channel for this campaign, and the channel credits it, as far as the core can tell. */
const watchable = (view: View, goal: DropsGoal, campaign: Campaign, channel: Channel): boolean => {
  if (channel.live === undefined) return false;
  if (goal.excludeChannels.includes(channel.id) || view.avoid.has(channel.id)) return false;
  const plays = channel.gameId === campaign.game.id || SPECIAL_GAMES.has(campaign.game.id);
  const listed =
    campaign.allowedChannels.length > 0
      ? campaign.allowedChannels.includes(channel.id)
      : channel.live.dropsEnabled;
  return plays && listed;
};

const entries = (settings: Settings, view: View): ReadonlyArray<Entry> =>
  settings.goals.flatMap((goal, index) =>
    view.catalog.flatMap((campaign): ReadonlyArray<Entry> => {
      if (view.now < campaign.startsAt || view.now >= campaign.endsAt) return [];
      const earning = goalDrops(goal, campaign, (id) => isClaimed(view, id)).filter((d) =>
        earnsNow(view, d),
      );
      if (earning.length === 0) return [];
      if (![...view.channels.values()].some((ch) => watchable(view, goal, campaign, ch))) {
        return [];
      }
      const finishing = earning.filter((d) => spare(view, d) >= 0);
      const game =
        goal.games === "all" ? 0 : goal.games.findIndex((g) => g.id === campaign.game.id);
      const key =
        goal.order === "ending-soonest"
          ? campaign.endsAt
          : finishing.length === 0
            ? undefined
            : Math.min(...finishing.map((d) => spare(view, d)));
      return [
        {
          goal: index,
          campaign: campaign.id,
          feasible: finishing.length > 0,
          game,
          key,
          order: goal.order,
        },
      ];
    }),
  );

/** `a` must go before `b`. Equal ranks beat neither: the core may break the tie either way. */
const beats = (a: Entry, b: Entry, watched: CampaignId | undefined): boolean => {
  if (a.feasible !== b.feasible) return a.feasible;
  if (a.goal !== b.goal) return a.goal < b.goal;
  if (a.game !== b.game) return a.game < b.game;
  if (a.key === undefined || b.key === undefined) return false;
  const margin = (e: Entry) =>
    e.order === "least-slack" && e.campaign === watched ? SLACK_HYSTERESIS : 0;
  return a.key - margin(a) < b.key - margin(b);
};

/**
 * The campaigns decision 28 allows a new watch to be for, given what the core knew. `watched`
 * lists the campaigns that may hold the `least-slack` margin (the one watched before the step,
 * and one a credit adopted during it); none holding it is allowed too.
 */
export const allowedPicks = (
  settings: Settings,
  view: View,
  watched: ReadonlyArray<CampaignId>,
): ReadonlySet<CampaignId> => {
  const all = entries(settings, view);
  const allowed = new Set<CampaignId>();
  for (const holder of [undefined, ...watched]) {
    for (const e of all) {
      if (!all.some((other) => beats(other, e, holder))) allowed.add(e.campaign);
    }
  }
  return allowed;
};
