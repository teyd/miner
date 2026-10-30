import type { Config, Goal } from "../config/schema.ts";
import type {
  Campaign,
  Channel,
  ChannelId,
  DropsGoal,
  Game,
  GameGoal,
  Reward,
  Settings,
} from "../core/model.ts";

/**
 * Maps `config.json` to the core's `Settings`: every drops goal in priority order. Names and
 * logins become ids against what the miner has read so far (research 07: names, not ids), so the
 * runtime maps again before every step. A listed game or channel that isn't known yet matches
 * nothing; it never widens a list to "all". `unmapped` lists what the file asks for that
 * `Settings` can't express yet.
 */

type DropsConfig = Extract<Goal, { readonly type: "drops" }>;

const key = (name: string) => name.toLowerCase();

const gameNamed = (games: ReadonlyArray<Game>, name: string): Game | undefined =>
  games.find((g) => key(g.name) === key(name) || key(g.slug) === key(name));

const unique = <A>(xs: Iterable<A>): ReadonlyArray<A> => [...new Set(xs)];

const toGoal = (
  config: Config,
  goal: DropsConfig,
  games: ReadonlyArray<Game>,
  channels: ReadonlyArray<Channel>,
): DropsGoal => {
  const excludedNames = [...config.exclude.games, ...goal.exclude.games];
  const excludeGames = unique(
    excludedNames.flatMap((name) => gameNamed(games, name)?.id ?? []),
  ).toSorted();
  const excluded = new Set(excludedNames.map(key));
  const listed: Array<GameGoal> = [];
  if (goal.games !== "all") {
    for (const entry of goal.games) {
      const id = gameNamed(games, entry.name)?.id;
      if (id === undefined || excluded.has(key(entry.name)) || excludeGames.includes(id)) continue;
      if (listed.some((g) => g.id === id)) continue;
      listed.push({ id, rewards: unique<Reward>(entry.rewards ?? goal.rewards) });
    }
  }
  const excludedLogins = new Set([...config.exclude.channels, ...goal.exclude.channels].map(key));
  const excludeChannels = unique<ChannelId>(
    channels.flatMap((ch) => (excludedLogins.has(key(ch.login)) ? [ch.id] : [])),
  ).toSorted();
  return {
    games: goal.games === "all" ? "all" : listed,
    rewards: unique<Reward>(goal.rewards),
    excludeGames,
    excludeChannels,
    linkedOnly: goal.linkedOnly,
    order: goal.order,
  };
};

export const toSettings = (
  config: Config,
  campaigns: ReadonlyArray<Campaign>,
  channels: Iterable<Channel>,
): Settings => {
  const games = campaigns.map((c) => c.game);
  const known = [...channels];
  return {
    goals: config.priorities.flatMap((goal) =>
      goal.type === "drops" ? [toGoal(config, goal, games, known)] : [],
    ),
  };
};

/** What the file asks for that the core can't do yet, one sentence each. */
export const unmapped = (config: Config): ReadonlyArray<string> => {
  const notes: Array<string> = [];
  const drops = config.priorities.filter((g) => g.type === "drops");
  const points = config.priorities.filter((g) => g.type === "points");
  if (points.length > 0) notes.push("points goals are not supported yet and are skipped");
  if (drops.length === 0) notes.push("there is no drops goal, so nothing is mined");
  if (config.streams.max === 2)
    notes.push("streams.max 2 is not supported yet: one stream is watched");
  return notes;
};
