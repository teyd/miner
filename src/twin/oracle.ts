import {
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

/**
 * Decision 28 written a second time, from its text and the review that refined it, for the
 * simulator to judge the core's picks by. It imports no code and no constant from `core/`: a bug
 * copied into both would hide itself.
 *
 * - The miner works on the first goal with something to do now: one of its campaigns has a drop
 *   it wants that earns now, on a live channel the goal may watch and that credits the campaign.
 * - Something that can still finish comes before anything that can't, whatever the goal
 *   (a doomed goal must not starve the ones below it; research 07, 2026-10-30).
 * - Within a goal: listed games in list order (`"all"` treats every game alike), then `order`.
 *   `ending-soonest` by the campaign's end. `least-slack` by the least time to spare of a drop
 *   that earns now and can finish; the watched campaign keeps its place until another has
 *   `HYSTERESIS` less. A campaign that can't finish anything waits behind those that can, and
 *   among themselves such campaigns go by end, soonest first, whatever the order.
 * - A goal wants a drop whose reward type it lists for the game (an item only from a linked
 *   campaign unless `linkedOnly` is off), and every unclaimed drop such a drop waits on.
 *   `excludeGames` leaves games out of `"all"`; `excludeChannels` keeps the goal off channels.
 * - A drop counts as claimed when the inventory says so, or, for a drop it doesn't list, when
 *   every award of its rewards fell inside the drop's window (TDM `inventory.py:71-90`): an
 *   award from before came from another campaign with the same reward.
 * - A campaign the core gave up on (Twitch credited only drops it couldn't use) is not ranked.
 */

/**
 * The watched campaign keeps its place until another has this much less to spare. Source: the
 * `order` description in `src/config/schema.ts` ("until another has 30 minutes less to spare").
 */
export const HYSTERESIS: Millis = 30 * 60_000;

/**
 * Games whose campaigns earn on any channel, whatever it streams. Source: TDM `utils.py:422`
 * (`Game.SPECIAL_GAME_IDS`), with "IRL" added 2026-05-31.
 */
const ANY_CHANNEL_GAMES: ReadonlySet<string> = new Set(["509663", "509672"]);

/**
 * What the core knew when it picked: its catalog, progress, received rewards, channels, and
 * avoided channels and campaigns.
 */
export interface View {
  readonly catalog: ReadonlyArray<Campaign>;
  readonly progress: ReadonlyMap<DropId, Progress>;
  /** `gameEventDrops`: benefit id to its last award. */
  readonly awarded: ReadonlyMap<string, Millis>;
  /** The drops the last inventory listed. */
  readonly inventoried: ReadonlySet<DropId>;
  readonly channels: ReadonlyMap<ChannelId, Channel>;
  readonly avoid: ReadonlySet<ChannelId>;
  readonly avoidCampaigns: ReadonlySet<CampaignId>;
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
  /** Smaller goes first: slack or end for what can finish, the end for what can't. */
  readonly key: number;
  /** The key is slack, so the watched campaign's margin applies. */
  readonly slack: boolean;
}

const minutesDone = (view: View, id: DropId) => view.progress.get(id)?.minutes ?? 0;

/** Drops the account has the rewards of, though the inventory doesn't list them. */
const receivedCache = new WeakMap<View, ReadonlySet<DropId>>();
const receivedOf = (view: View): ReadonlySet<DropId> => {
  const cached = receivedCache.get(view);
  if (cached !== undefined) return cached;
  const out = new Set<DropId>();
  for (const campaign of view.catalog) {
    for (const drop of campaign.drops) {
      if (view.inventoried.has(drop.id)) continue;
      const awards = drop.benefits.flatMap((b) => {
        const at = view.awarded.get(b.id);
        return at === undefined ? [] : [at];
      });
      if (awards.length > 0 && awards.every((at) => at >= drop.startsAt && at < drop.endsAt)) {
        out.add(drop.id);
      }
    }
  }
  receivedCache.set(view, out);
  return out;
};

const isClaimed = (view: View, id: DropId) =>
  view.progress.get(id)?.claimed === true || receivedOf(view).has(id);

/**
 * Earns now: a drop that takes minutes, window open, unclaimed, unfinished, and every drop it
 * waits on claimed. A 0-minute drop earns nothing by watching (the wire decodes any number).
 */
const earnsNow = (view: View, drop: Drop): boolean =>
  drop.requiredMinutes > 0 &&
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
  const plays = channel.gameId === campaign.game.id || ANY_CHANNEL_GAMES.has(campaign.game.id);
  const listed =
    campaign.allowedChannels.length > 0
      ? campaign.allowedChannels.includes(channel.id)
      : channel.live.dropsEnabled;
  return plays && listed;
};

/** The drops a goal wants from a campaign that earn now. */
const earning = (view: View, goal: DropsGoal, campaign: Campaign): ReadonlyArray<Drop> =>
  view.now < campaign.startsAt ||
  view.now >= campaign.endsAt ||
  view.avoidCampaigns.has(campaign.id)
    ? []
    : goalDrops(goal, campaign, (id) => isClaimed(view, id)).filter((d) => earnsNow(view, d));

const entries = (settings: Settings, view: View): ReadonlyArray<Entry> =>
  settings.goals.flatMap((goal, index) =>
    view.catalog.flatMap((campaign): ReadonlyArray<Entry> => {
      const drops = earning(view, goal, campaign);
      if (drops.length === 0) return [];
      if (![...view.channels.values()].some((ch) => watchable(view, goal, campaign, ch))) {
        return [];
      }
      const finishing = drops.filter((d) => spare(view, d) >= 0);
      const feasible = finishing.length > 0;
      const game =
        goal.games === "all" ? 0 : goal.games.findIndex((g) => g.id === campaign.game.id);
      const slack = feasible && goal.order === "least-slack";
      const key = slack ? Math.min(...finishing.map((d) => spare(view, d))) : campaign.endsAt;
      return [{ goal: index, campaign: campaign.id, feasible, game, key, slack }];
    }),
  );

/** `a` must go before `b`. Equal ranks beat neither: the core may break the tie either way. */
const beats = (a: Entry, b: Entry, watched: CampaignId | undefined): boolean => {
  if (a.feasible !== b.feasible) return a.feasible;
  if (a.goal !== b.goal) return a.goal < b.goal;
  if (a.game !== b.game) return a.game < b.game;
  if (a.slack !== b.slack) return false;
  const margin = (e: Entry) => (e.slack && e.campaign === watched ? HYSTERESIS : 0);
  return a.key - margin(a) < b.key - margin(b);
};

/**
 * The goals and campaigns decision 28 ranks first, given what the core knew. `holders` are the
 * campaigns that may hold the `least-slack` margin: the one watched when the core planned (and
 * one a credit adopted during the step). With none watched, nothing holds it.
 */
const firstRanked = (
  settings: Settings,
  view: View,
  holders: ReadonlyArray<CampaignId>,
): ReadonlyArray<Entry> => {
  const all = entries(settings, view);
  const out: Array<Entry> = [];
  for (const holder of holders.length === 0 ? [undefined] : holders) {
    for (const e of all) {
      if (!all.some((other) => beats(other, e, holder)) && !out.includes(e)) out.push(e);
    }
  }
  return out;
};

/** The campaigns decision 28 allows a watch to be for. */
export const allowedPicks = (
  settings: Settings,
  view: View,
  holders: ReadonlyArray<CampaignId>,
): ReadonlySet<CampaignId> => new Set(firstRanked(settings, view, holders).map((e) => e.campaign));

/**
 * Watching `channelId` for `campaignId` is allowed: the campaign ranks first for a goal that may
 * watch the channel, and the channel credits the campaign. Without `campaignId`, any campaign
 * ranked first will do (Twitch picks what a stream credits when several campaigns share it).
 */
export const allowedWatch = (
  settings: Settings,
  view: View,
  holders: ReadonlyArray<CampaignId>,
  campaignId: CampaignId | undefined,
  channelId: ChannelId,
): boolean => {
  const channel = view.channels.get(channelId);
  if (channel === undefined) return false;
  return firstRanked(settings, view, holders).some((e) => {
    const campaign = view.catalog.find((x) => x.id === e.campaign);
    return (
      campaign !== undefined &&
      (campaignId === undefined || e.campaign === campaignId) &&
      watchable(view, settings.goals[e.goal]!, campaign, channel)
    );
  });
};

/**
 * Some goal that may watch the channel wants a drop of the campaign that earns now and can still
 * finish. A watch whose campaign has none left has a cause to move.
 */
export const canFinishOn = (
  settings: Settings,
  view: View,
  campaignId: CampaignId,
  channelId: ChannelId,
): boolean => {
  const campaign = view.catalog.find((x) => x.id === campaignId);
  if (campaign === undefined) return false;
  return settings.goals.some(
    (goal) =>
      !goal.excludeChannels.includes(channelId) &&
      earning(view, goal, campaign).some((d) => spare(view, d) >= 0),
  );
};
