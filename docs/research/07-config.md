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

## 2. Design (inference)

### The file

`$DATA_DIR/config.json`, strict JSON, every field optional. A missing file means all defaults.

```json
{
  "$schema": "https://raw.githubusercontent.com/teyd/miner/dev/schema/config.v1.json",
  "version": 1,
  "games": [{ "name": "Rust" }, { "name": "Overwatch 2", "rewards": ["badge", "emote"] }],
  "otherGames": "linked",
  "rewards": ["item", "badge", "emote"],
  "order": "ending-soonest",
  "excludeChannels": ["somechannel"],
  "channelPoints": { "claimBonus": true }
}
```

| Field                      | Default            | Meaning                                                                                                                  |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `version`                  | `1`                | Format version. A future change bumps it, and `miner config migrate` rewrites old files                                  |
| `games`                    | `[]`               | Games to mine first, highest priority first. A name matches Twitch's display name or URL slug, case-insensitively        |
| `games[].rewards`          | `rewards`          | Reward types to mine for this game                                                                                       |
| `otherGames`               | `"linked"`         | After the list: `"none"` (only the list), `"linked"` (games linked to your account, plus badge/emote campaigns), `"all"` |
| `rewards`                  | all three          | `item` (needs a linked game account), `badge`, `emote`                                                                   |
| `order`                    | `"ending-soonest"` | How to rank campaigns of equal priority: `ending-soonest`, `least-slack` (least time to spare first)                     |
| `excludeChannels`          | `[]`               | Channel logins never watched                                                                                             |
| `channelPoints.claimBonus` | `true`             | Claim the bonus chest on the channel being watched                                                                       |

Deliberately absent: anything about timing, quality or rate limits. Those are Twitch facts, not
preferences (research 02).

### The schema, written for agents

- Generated by `miner config schema` from the decoding `Schema`, so the two never drift. Committed
  to `schema/config.v1.json` and checked in CI against the generated output.
- Every field has a `description` that says what it does, what the default does, and when to change
  it. `examples` on every non-trivial field. `markdownDescription` for VS Code hovers.
- `additionalProperties: false` everywhere. Enums are closed lists.
- The `$schema` URL contains the format version (`config.v1.json`). A file and a binary disagreeing
  on the version is reported by `validate`.

### The commands an agent uses

| Command                          | Does                                                                                                                                                                           | Output                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `miner config schema`            | Prints the JSON Schema                                                                                                                                                         | the schema                                   |
| `miner config validate [--json]` | Decodes the file offline. Exit 2 lists every problem with its JSON pointer, the expected value, and a fix                                                                      | `{ ok, problems: [{ path, message, fix }] }` |
| `miner config explain [--json]`  | The effective config with defaults filled in, and, with a token, each game name resolved against the live catalog: matched, unknown (with closest matches), or not running now | a resolved view                              |
| `miner config init`              | Writes a default file with `$schema` and `version`. Refuses to overwrite                                                                                                       | the path                                     |

`explain` is the deep part (inference). Agents can't see Twitch. `explain` lets them check their
edit against reality ("Overwatch 2" → matched, 3 active campaigns; "Apex" → unknown, did you mean
"Apex Legends"?) before restarting anything.

### Where it plugs in

`config.json` decodes into a `Config` value. At startup the runtime resolves game names against the
catalog into the core's `Settings` (`games: GameId[]` and friends). The core grows the per-game
reward filter, the `otherGames` policy and the `order` strategy. Unknown names become `problems` in
`status --json`.

## 3. Open questions for teyd

1. **The `$schema` URL.** A raw GitHub URL on `dev` works now. A stable host later (GitHub Pages)?
2. **`order: least-slack` in v1, or only `ending-soonest`?** It's TDM's "lowest availability first".
3. **Hot reload?** just-mining and TDM read the file at startup only. Reloading on change is easy
   with the core's design (a `SettingsChanged` event), and agents like immediate feedback.
