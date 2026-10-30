import type { Config } from "../config/schema.ts";
import type { Campaign, Channel, ChannelId, GameId, Settings } from "../core/model.ts";

/**
 * Maps `config.json` to the core's `Settings`, which today model one drops goal: a game priority
 * list, excluded channels and badges/emotes on or off. Names and logins become ids against what
 * the miner has read so far (research 07: names, not ids), so the runtime maps again before every
 * step. `unmapped` lists what the file asks for that `Settings` can't express yet.
 */

/** Matches no campaign: a listed game that isn't in the catalog must not widen to "all". */
const unresolved = (name: string) => `unresolved:${name.toLowerCase()}` as GameId;

const dropsGoal = (config: Config) => config.priorities.find((g) => g.type === "drops");

export const toSettings = (
  config: Config,
  campaigns: ReadonlyArray<Campaign>,
  channels: Iterable<Channel>,
): Settings => {
  const goal = dropsGoal(config);
  if (goal === undefined)
    return { games: [unresolved("")], excludeChannels: [], badgesAndEmotes: false };
  const excludedGames = new Set(
    [...config.exclude.games, ...goal.exclude.games].map((n) => n.toLowerCase()),
  );
  const games: Array<GameId> = [];
  if (goal.games !== "all") {
    for (const { name } of goal.games) {
      const key = name.toLowerCase();
      if (excludedGames.has(key)) continue;
      const game = campaigns
        .map((c) => c.game)
        .find((g) => g.name.toLowerCase() === key || g.slug.toLowerCase() === key);
      const id = game?.id ?? unresolved(name);
      if (!games.includes(id)) games.push(id);
    }
    if (games.length === 0) games.push(unresolved(""));
  }
  const excludedLogins = new Set(
    [...config.exclude.channels, ...goal.exclude.channels].map((l) => l.toLowerCase()),
  );
  const excludeChannels: Array<ChannelId> = [];
  for (const channel of channels) {
    if (excludedLogins.has(channel.login.toLowerCase()) && !excludeChannels.includes(channel.id)) {
      excludeChannels.push(channel.id);
    }
  }
  return {
    games,
    excludeChannels: excludeChannels.toSorted(),
    badgesAndEmotes: goal.rewards.includes("badge") || goal.rewards.includes("emote"),
  };
};

/** What the file asks for that the core can't do yet, one sentence each. */
export const unmapped = (config: Config): ReadonlyArray<string> => {
  const notes: Array<string> = [];
  const drops = config.priorities.filter((g) => g.type === "drops");
  const points = config.priorities.filter((g) => g.type === "points");
  const goal = drops[0];
  if (points.length > 0) notes.push("points goals are not supported yet and are skipped");
  if (goal === undefined) {
    notes.push("there is no drops goal, so nothing is mined");
    return notes;
  }
  if (drops.length > 1) notes.push("only the first drops goal is used");
  if (goal.order === "least-slack")
    notes.push('order "least-slack" is not supported yet: campaigns go ending-soonest');
  if (!goal.linkedOnly)
    notes.push("linkedOnly false is not supported yet: in-game items need a linked account");
  if (!goal.rewards.includes("item"))
    notes.push('leaving out "item" is not supported yet: linked games still earn their items');
  if (goal.rewards.includes("badge") !== goal.rewards.includes("emote")) {
    notes.push("badges and emotes are mined together or not at all");
  }
  if (goal.games !== "all" && goal.games.some((g) => g.rewards !== undefined)) {
    notes.push("per-game rewards are not supported yet: the goal's rewards apply");
  }
  const excludedGames = [...config.exclude.games, ...goal.exclude.games];
  if (goal.games === "all" && excludedGames.length > 0) {
    notes.push('excluded games are not supported with games "all" yet');
  }
  if (config.streams.max === 2)
    notes.push("streams.max 2 is not supported yet: one stream is watched");
  return notes;
};
