import { Effect, Schema } from "effect";

/**
 * The miner's config file, `$DATA_DIR/config.json`. This schema decodes the file and generates
 * the JSON Schema that editors and AI agents read (`miner config schema`), so every description
 * here is user documentation. Design: docs/research/07-config.md.
 */

export const SCHEMA_URL = "https://raw.githubusercontent.com/teyd/miner/dev/schema/config.v1.json";

export const Reward = Schema.Literals(["item", "badge", "emote"]).annotate({
  identifier: "Reward",
  description:
    '"item": an in-game reward, delivered to the game account linked on twitch.tv/drops/campaigns. ' +
    '"badge" and "emote": Twitch-side rewards that need no linked account.',
});

const Rewards = Schema.NonEmptyArray(Reward).annotate({
  description: "Which reward types to mine.",
  examples: [
    ["item", "badge", "emote"],
    ["badge", "emote"],
  ],
});

const GameName = Schema.NonEmptyString.annotate({
  description:
    "The game as Twitch shows it, or its URL slug (twitch.tv/directory/category/<slug>). " +
    "Case-insensitive.",
  examples: ["Rust", "The Cycle: Frontier", "overwatch-2"],
});

const ChannelLogin = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_]{1,25}$/u, {
    expected: "a Twitch login: letters, digits and _, as in twitch.tv/<login>",
  }),
).annotate({
  description: "A channel's login, as in twitch.tv/<login>. Case-insensitive.",
  examples: ["oilrats", "riqqeloff"],
});

export const Game = Schema.Struct({
  name: GameName,
  rewards: Schema.optionalKey(Rewards).annotate({
    description: "Reward types for this game. Omitted: the goal's `rewards`.",
  }),
}).annotate({ identifier: "Game", description: "A game to mine. Earlier entries go first." });

const Exclude = Schema.Struct({
  games: Schema.Array(GameName).pipe(
    Schema.annotate({ description: "Games never mined.", default: [] }),
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  channels: Schema.Array(ChannelLogin).pipe(
    Schema.annotate({ description: "Channels never watched.", default: [] }),
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});

const excludeField = Exclude.pipe(
  Schema.annotate({
    description: "What to leave out of this goal.",
    default: { games: [], channels: [] },
  }),
  Schema.withDecodingDefaultKey(Effect.succeed({})),
);

const CLAIM_BONUS = "Claim the bonus chest that appears about every 15 minutes of watching.";
const WATCH_STREAKS = "Keep watch streaks: join a points channel early in each broadcast.";
const FOLLOW = "Follow a raid to the raided channel to collect the raid bonus.";
const STAY =
  "Minutes to stay on the raided channel before returning to the priorities. " +
  "Whether the bonus needs any stay is not yet verified.";
const StayMinutes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60 }));

const claimBonus = Schema.Boolean.pipe(
  Schema.annotate({ description: CLAIM_BONUS, default: true }),
  Schema.withDecodingDefaultKey(Effect.succeed(true)),
);

const note = Schema.optionalKey(Schema.String).annotate({
  description: "Free text about this goal, for the people and agents reading the file.",
  examples: ["My games first"],
});

export const DropsGoal = Schema.Struct({
  type: Schema.Literal("drops"),
  note,
  games: Schema.Union([
    Schema.Literal("all").annotate({ description: "Every game with an active drop campaign." }),
    Schema.NonEmptyArray(Game).annotate({ description: "These games, highest priority first." }),
  ]).annotate({
    description: 'The games to mine: "all", or a list in priority order.',
    examples: ["all", [{ name: "Rust" }, { name: "The Cycle: Frontier", rewards: ["item"] }]],
  }),
  exclude: excludeField,
  rewards: Rewards.pipe(
    Schema.annotate({
      description: "Reward types for games without their own `rewards`.",
      default: ["item", "badge", "emote"],
    }),
    Schema.withDecodingDefaultKey(Effect.succeed(["item", "badge", "emote"] as const)),
  ),
  linkedOnly: Schema.Boolean.pipe(
    Schema.annotate({
      description:
        "Mine in-game items only for games whose account is linked on twitch.tv/drops/campaigns. " +
        "Set false to collect items now and link the game later. Badges and emotes ignore this.",
      default: true,
    }),
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  order: Schema.Literals(["ending-soonest", "least-slack"]).pipe(
    Schema.annotate({
      description:
        'How to rank campaigns of the same game, or all of them with games "all": ' +
        '"ending-soonest" by end time, "least-slack" by the least time to spare of a drop ' +
        "that earns now (time left minus minutes still needed), so fewer drops expire " +
        "unfinished. A campaign that can no longer finish a drop in time waits until no goal " +
        'has one that can. With "least-slack", the campaign being watched keeps its place ' +
        "until another has 30 minutes less to spare.",
      default: "ending-soonest",
    }),
    Schema.withDecodingDefaultKey(Effect.succeed("ending-soonest" as const)),
  ),
  claimBonus,
}).annotate({
  identifier: "DropsGoal",
  description:
    "Mine drop campaigns. Active while one of its games has a drop to earn on a live channel.",
});

export const PointsGoal = Schema.Struct({
  type: Schema.Literal("points"),
  note,
  channels: Schema.NonEmptyArray(ChannelLogin).annotate({
    description: "Channels to watch for points, highest priority first. The first live one wins.",
  }),
  exclude: excludeField,
  claimBonus,
  watchStreaks: Schema.Boolean.pipe(
    Schema.annotate({ description: WATCH_STREAKS, default: true }),
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  raids: Schema.Struct({
    follow: Schema.Boolean.pipe(
      Schema.annotate({ description: FOLLOW, default: true }),
      Schema.withDecodingDefaultKey(Effect.succeed(true)),
    ),
    stayMinutes: StayMinutes.pipe(
      Schema.annotate({ description: STAY, default: 1 }),
      Schema.withDecodingDefaultKey(Effect.succeed(1)),
    ),
  }).pipe(
    Schema.annotate({
      description: "What to do when a channel of this goal raids another channel.",
      default: { follow: true, stayMinutes: 1 },
    }),
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
}).annotate({
  identifier: "PointsGoal",
  description: "Collect channel points. Active while one of its channels is live.",
});

/** The goal an empty config gets, decoded with its defaults. */
const DEFAULT_GOAL = {
  type: "drops",
  games: "all",
  exclude: { games: [], channels: [] },
  rewards: ["item", "badge", "emote"],
  linkedOnly: true,
  order: "ending-soonest",
  claimBonus: true,
} as const;

export const Goal = Schema.Union([DropsGoal, PointsGoal]).annotate({ identifier: "Goal" });

export const Config = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String).annotate({
    description: "The JSON Schema for this file, for editor and agent autocomplete.",
    examples: [SCHEMA_URL],
  }),
  version: Schema.Literal(1).pipe(
    Schema.annotate({
      description:
        "The config format version. A future format bumps it, and the miner migrates old files.",
      default: 1,
    }),
    Schema.withDecodingDefaultKey(Effect.succeed(1 as const)),
  ),
  priorities: Schema.Array(Goal).pipe(
    Schema.annotate({
      description:
        "What to do, highest priority first. The miner works on the first goal that has something " +
        "to do right now and re-checks whenever a stream goes live or offline, a drop completes, " +
        "or this file changes. Default: drops for every linked game, plus badges and emotes.",
      default: [DEFAULT_GOAL],
    }),
    Schema.withDecodingDefaultKey(Effect.succeed([{ type: "drops", games: "all" } as const])),
  ),
  exclude: Exclude.pipe(
    Schema.annotate({
      description: "Never mined or watched, in every goal.",
      default: { games: [], channels: [] },
    }),
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  streams: Schema.Struct({
    max: Schema.Literals([1, 2]).pipe(
      Schema.annotate({
        description:
          "Streams watched at once. With 2, the next active goal runs beside the first. Twitch " +
          "credits drops on one stream and points on two; a second stream may slow drop " +
          "progress (not yet measured), so 1 is the safe default.",
        default: 1,
      }),
      Schema.withDecodingDefaultKey(Effect.succeed(1 as const)),
    ),
  }).pipe(
    Schema.annotate({ description: "Concurrent watching.", default: { max: 1 } }),
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
}).annotate({
  identifier: "MinerConfig",
  title: "miner config",
  description:
    "Configuration for miner, a headless Twitch drops and channel-points miner. Every field is " +
    "optional. Check a change with `miner config validate`.",
});

export type Config = typeof Config.Type;
export type Goal = typeof Goal.Type;
