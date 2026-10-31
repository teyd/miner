import type { Config, Goal } from "../config/schema.ts";
import { compareText } from "../core/plan.ts";
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
  if (drops.some((g) => g.claimBonus)) {
    notes.push("claimBonus is not supported yet: channel point bonuses are not claimed");
  }
  if (config.streams.max === 2)
    notes.push("streams.max 2 is not supported yet: one stream is watched");
  return notes;
};

/** Edit distance, for naming the game a misspelt name probably meant. */
const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next.push(
        Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)),
      );
    }
    row = next;
  }
  return row[b.length]!;
};

/** The catalog game whose name or slug is closest to `name`, if it is close enough to be a typo. */
const closest = (games: ReadonlyArray<Game>, name: string): Game | undefined => {
  const scored = games.map((game) => ({
    game,
    d: Math.min(distance(key(name), key(game.name)), distance(key(name), key(game.slug))),
  }));
  const best = scored.toSorted((a, b) => a.d - b.d || compareText(a.game.name, b.game.name))[0];
  return best !== undefined && best.d <= Math.max(2, Math.floor(name.length / 4))
    ? best.game
    : undefined;
};

/**
 * Game names in the file that match no game of the catalog, one sentence each (research 07:
 * report unknown names with the closest match). A listed game is a typo or has no active
 * campaign now; it matches nothing either way. An excluded one is named only when it looks like
 * a typo of a game that is in the catalog: that game is mined against the file's wish.
 */
export const unresolvedGames = (
  config: Config,
  campaigns: ReadonlyArray<Campaign>,
): ReadonlyArray<string> => {
  const games = [...new Map(campaigns.map((c) => [c.game.id, c.game])).values()];
  const drops = config.priorities.flatMap((g) => (g.type === "drops" ? [g] : []));
  const listed = drops.flatMap((g) => (g.games === "all" ? [] : g.games.map((e) => e.name)));
  const excluded = [...config.exclude.games, ...drops.flatMap((g) => g.exclude.games)];
  const notes: Array<string> = [];
  for (const name of unique(listed)) {
    if (gameNamed(games, name) !== undefined) continue;
    const near = closest(games, name);
    notes.push(
      `game "${name}" matches no game with an active campaign` +
        (near === undefined ? "" : `; did you mean "${near.name}"?`),
    );
  }
  for (const name of unique(excluded)) {
    if (gameNamed(games, name) !== undefined) continue;
    const near = closest(games, name);
    if (near !== undefined) {
      notes.push(`excluded game "${name}" matches no game; did you mean "${near.name}"?`);
    }
  }
  return notes;
};
