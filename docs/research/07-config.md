# Research 07 — A config file that AI agents can write

_Researched 2026-10-29. Sources: just-mining `src/config/schema.ts` and `docs/config.md`, TDM
`settings.py` and `constants.py`, TCPM `Settings.py` and `Streamer.py`, OpenCode's published schema
(`opencode.ai/config.json`), Biome and Renovate docs, VS Code's JSON docs, Effect 4.1
`Schema.toJsonSchemaDocument`, poteto's `cli-for-agents` skill. "(inference)" = my design reasoning._

Goal (teyd, 2026-10-29): one JSON file with a proper schema, configured mainly by AI agents, much
deeper than what the reference miners offer.

## TL;DR

- **The schema is the documentation.** OpenCode, Biome and Renovate ship a JSON Schema and put
  `$schema` at the top of every config file. Editors and agents read field descriptions, defaults
  and allowed values from it. OpenCode documents 44 of its 49 top-level keys inline.
- **Unknown keys are errors.** OpenCode sets `additionalProperties: false`; Biome reports "Found an
  unknown key". A typo that silently does nothing is the worst outcome for an agent.
- **Ship the schema with the binary and check it at validation time.** Biome's lesson: users who
  point `$schema` at an old version get stale completions, so Biome added `biome migrate` and a
  warning when `$schema` doesn't match the running version.
- **Validation is a command with machine output.** Renovate has `renovate-config-validator` with a
  `--strict` mode that fails when a migration is due. just-mining had `config validate` naming the
  JSON path. poteto: every error carries a correct example invocation.
- **Effect 4.1 generates the schema** from the same `Schema` that decodes the file
  (`Schema.toJsonSchemaDocument`, dialects draft-07 and 2020-12). `onExcessProperty: "error"` emits
  `additionalProperties: false` and the decoder enforces the same. VS Code fully supports draft-07
  only (2020-12 is partial), so we emit draft-07.
- **Strict JSON, no comments.** Agents rewrite JSON reliably; comments get lost or mangled in
  round trips (inference). Every explanation lives in the schema instead. Effect has no JSONC parser.
- **Names, not IDs.** Users and agents know game names. The miner resolves them against the live
  catalog and reports unknown names with the closest matches, rather than failing (just-mining did
  this, because Twitch renames games).

## 1. What the reference miners let you set

| Setting                     | TDM                                                                       | just-mining                                                 | TCPM                                                                               |
| --------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Which games                 | `priority` list of names, plus `exclude` set                              | `mining.games`: ordered names, each with optional `rewards` | n/a (channels, not games)                                                          |
| What happens after the list | `priority_mode`: priority only, ending soonest, lowest availability first | `whenNothingElse`: none / any-linked / any                  | n/a                                                                                |
| Reward types                | `enable_badges_emotes` (one switch)                                       | `rewards`: game / badge / emote, global and per game        | n/a                                                                                |
| Channels                    | none                                                                      | `excludeChannels`                                           | per-streamer list with priority (`ORDER`, `STREAK`, `DROPS`, `POINTS_*`)           |
| Points                      | bonus chest only, implicitly                                              | bonus always claimed, no switch                             | per streamer: predictions + bet strategy, raids, streaks, moments, community goals |
| Behaviour knobs             | `connection_quality`, `available_drops_check`, proxy                      | watch interval, quality (one value)                         | analytics, SSL verification                                                        |
| Format                      | JSON written by the GUI                                                   | JSONC, `$schema`, `config init/validate/schema`             | Python code (`run.py`)                                                             |

What is worth taking (inference):

- **Ordered game list with per-game overrides** (just-mining) is the right primary control.
- **An explicit fallback policy** (TDM's priority mode, just-mining's `whenNothingElse`) answers the
  question every user eventually asks: "what does it do when my games have nothing?"
- **Reward types as a list** (just-mining) beats a single badges switch.
- **Ranking strategy** (TDM's ending-soonest / lowest-availability) is a real choice users make.
  "Lowest availability" means: the campaign with the least slack between time left and minutes
  left goes first, so fewer drops expire unfinished.

What not to take: watch interval and stream quality (internal, changing them only breaks crediting),
proxy (out of scope), TCPM's betting (decision 17 defers points beyond the watched channel).

## 2. Design (decided 2026-10-29, decision 28)

The file is `$DATA_DIR/config.json`, strict JSON. The source of truth is `src/config/schema.ts`.
`schema/config.v1.json` is generated from it (`pnpm schema`), and a test fails when the two
differ. `schema/config.example.json` is the example below, and a test keeps it valid.

### The priority list

People run the miner 24/7 for drops, for channel points, or for both in an order they choose. The
core of the file is `priorities`: an ordered list of goals. The miner works on the **first goal that
has something to do right now** and re-checks whenever a stream goes live or offline, a drop
completes, or the file changes.

- A `drops` goal has something to do while one of its games has an earnable drop on a live channel.
- A `points` goal has something to do while one of its channels is live. Points never run out, so
  a drops goal below it waits until those channels are offline.
- To farm points first and drops after, swap the entries.

```json
{
  "$schema": "https://raw.githubusercontent.com/teyd/miner/dev/schema/config.v1.json",
  "version": 1,
  "priorities": [
    {
      "type": "drops",
      "note": "My games first",
      "games": [{ "name": "Rust" }, { "name": "The Cycle: Frontier", "rewards": ["item", "badge"] }]
    },
    { "type": "points", "note": "Favourite streamers", "channels": ["oilrats", "riqqeloff"] },
    {
      "type": "drops",
      "note": "Everything else that pays out",
      "games": "all",
      "exclude": { "games": ["League of Legends"] },
      "rewards": ["item", "badge", "emote"],
      "linkedOnly": true,
      "order": "least-slack"
    }
  ],
  "exclude": { "channels": ["channelidontwanttosupport"] },
  "points": {
    "claimBonus": true,
    "watchStreaks": true,
    "raids": { "follow": true, "stayMinutes": 1 }
  },
  "streams": { "max": 1 }
}
```

### Fields

| Field                                      | Default                   | Meaning                                                                                             |
| ------------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------- |
| `version`                                  | `1`                       | Format version; a future format bumps it and the miner migrates old files                           |
| `priorities`                               | one drops goal on `"all"` | Goals, highest priority first                                                                       |
| drops `games`                              | required                  | `"all"`, or `[{ "name", "rewards"? }]` in priority order. Names match Twitch's display name or slug |
| drops `exclude.games` / `exclude.channels` | `[]`                      | Left out of this goal                                                                               |
| drops `rewards`                            | all three                 | `item` (in-game, needs a linked account), `badge`, `emote`                                          |
| drops `linkedOnly`                         | `true`                    | Items only for linked games. `false` collects items to claim after linking                          |
| drops `order`                              | `ending-soonest`          | `least-slack`: least time to spare first (TDM's "lowest availability")                              |
| points `channels`                          | required                  | Logins in priority order; the first live one wins                                                   |
| goal `points`                              | top-level `points`        | Per-goal override of the points behaviour                                                           |
| `exclude`                                  | `[]`                      | Never mined or watched, in any goal                                                                 |
| `points.claimBonus`                        | `true`                    | Claim the chest every ~15 minutes, on whatever channel is watched                                   |
| `points.watchStreaks`                      | `true`                    | Join points channels early in each broadcast                                                        |
| `points.raids`                             | follow, stay 1 min        | Follow raids for the raid bonus, then return. Whether a stay is needed is unverified                |
| `streams.max`                              | `1`                       | `2` lets the next active goal run beside the first; the cost to drops is unmeasured                 |

### Choices and why

- **A `type` field on every goal**: a discriminated union, so the schema shows exactly which keys
  each kind takes and an agent can't mix them.
- **Objects only in lists** (teyd): agents write the file, so a uniform shape beats shorthand.
  `"games": "all"` is the one either/or, because it means something different from a list.
- **Unknown keys are errors**, reported with the key's name. **No comments**: a `note` field
  replaces them and shows up in status output.
- **Names, never IDs.** `miner config explain` (next) resolves them against Twitch.
- **No timing, quality or rate settings**: those are Twitch facts, not preferences (research 02).
- **No follow-list option** (teyd): not worth an extra read.
- **Draft-07**: VS Code fully supports it; 2020-12 only partly. Fields that reuse a shared object
  are inlined so each keeps its own description (draft-07 ignores siblings of `$ref`).

### Commands

| Command                          | Does                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `miner config schema`            | Prints the JSON Schema                                                                         |
| `miner config validate [--json]` | Offline check. Exit 2 lists every problem as a JSON pointer and a message                      |
| `miner config init`              | Writes a starter file to `$DATA_DIR`, never overwrites                                         |
| `miner config explain` (next)    | Effective config, game and channel names resolved against Twitch, which goal is active and why |

## 3. Answered (teyd, 2026-10-29)

1. `$schema` points at the raw GitHub file on `dev`; a stable host later.
2. `least-slack` ships in v1.
3. The file reloads while the miner runs.
