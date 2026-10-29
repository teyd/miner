# Research 01 — What makes a repo agent-friendly

_Researched 2026-10-29. Sources: `anomalyco/deadbolt@28c0429`, the Effect blog ("The One Weird
Git Trick That Makes Coding Agents More Effect-ive", 2026-05-11), `teyd/just-mining@6e643bf`.
"(inference)" = my reasoning, not something a source states._

**Ground rule (teyd, 2026-10-29):** just-mining is being _replaced_, not refactored. Take
**nothing** from it as architecture, `AGENTS.md`, rules, process or CI/CD. It is a reference for
_what Twitch does_ only (see [02](02-twitch-2026.md)). If we copy any small piece later, first
argue why it is right, not why it exists.

## TL;DR

- **Deadbolt doesn't depend on rules files for agents. Its tooling makes agents effective.** Its `AGENTS.md` is 55 lines: a crate map,
  one gate command, the simulator's env vars, and a "read X before changing Y" pointer. Most of
  the leverage is in a **deterministic simulator whose failures print a replay command**.
- **Its design is written down as an argument, not just a spec:** numbered research files with primary
  sources → a proposal → **hostile critiques by another agent** → a short final `design.md`
  listing what was dropped and why. History is kept.
- **Effect's own advice:** vendor the library _source_ into the repo (`git subtree add
  --prefix=repos/effect … --squash`) and tell the agent in `AGENTS.md` to read `repos/effect`
  (and `repos/effect/LLMS.md`, ~19 KB) as reference. Agents read source well. They read
  compiled `node_modules` and human-oriented docs badly.
- just-mining's one lesson that matters here is a _negative_ one. With no simulator, the only way to find new
  bugs was a live run, and live runs are serialised per account. That is the problem
  [04](04-parallel-bug-finding.md) solves.

## 1. Deadbolt: the patterns

| Pattern                                                                  | Where                                                                                     | Why it helps an agent                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Short `AGENTS.md` = map + one gate + pointers                            | `AGENTS.md` (55 lines), `CLAUDE.md` is just `@AGENTS.md`                                  | Fits in context and points to the long docs instead of inlining them |
| "See `docs/simulation.md` before changing sync or pairing"               | `AGENTS.md`                                                                               | Routes an agent to the one doc that matters for a risky area         |
| One gate command, CI runs the same steps                                 | `bun run check` = typecheck, tests, fmt, clippy `-D warnings`, deny                       | Gives agents one unambiguous done criterion                          |
| **Deterministic simulator** over production handlers                     | `crates/cli/src/agent/sim/` (~1.2k lines), `docs/simulation.md`                           | Finds new bugs without the network, in parallel, reproducibly        |
| Seed / seed count / trace as env vars                                    | `DEADBOLT_SIM_SEED`, `_SEEDS`, `_TRACE`, `_TIMING`                                        | Lets an agent sweep 1000 seeds or replay one exact failure           |
| **Failures print seed + full trace + shrunk trace + the replay command** | `sim/mod.rs` `exploration()`                                                              | The bug report is executable. No log reading or re-running live      |
| Determinism is itself tested                                             | `replay_has_identical_wire_schedule` runs the same trace twice and compares a wire digest | Catches accidental non-determinism before it makes seeds lie         |
| Properties checked after every step                                      | removal confidentiality, encrypted disk, durability, watch coverage, convergence          | A failure is noticed at the step that caused it, not at the end      |
| Fault actions are first-class                                            | crash/reopen, partitions, cuts mid-exchange, failed writes                                | Exercises the code paths that live runs hit rarely                   |
| Production seams, not mocks                                              | `run_sync_session` takes generic byte streams; sim drives the real handlers               | The simulator tests the shipping code, not a replica                 |
| Debug-only fast knobs                                                    | `DEADBOLT_NET=local`, `DEADBOLT_KDF=fast`, ignored by release builds                      | Speeds up tests without being able to weaken production              |
| Research → proposal → critique → design                                  | `docs/research/0N-*.md`, `docs/history/04..06`, `docs/design.md`                          | Agents read _why_, so they don't relitigate settled choices          |
| Research files: dated, primary sources, TL;DR first, tagged inferences   | `docs/research/02-rust-sync-stacks.md`                                                    | Lets you tell a sourced fact from a guess quickly                    |
| Decisions recorded with who/when; open questions at the end              | `docs/agent-control.md` "Decisions (Kit, Oct 27)"                                         | Agents stop asking settled questions                                 |
| Scripted scenes for UI checks                                            | `crates/app/scripts/*.json` + `snap.sh`                                                   | Agents check visuals headlessly. Analogue for us: scripted scenarios |
| One task per worktree, remove it after merge                             | `AGENTS.md` Shipping                                                                      | Parallel agents don't trample each other                             |
| Heavy runs offloaded to a lab runner                                     | `hivemind run --kind cargo -- …`                                                          | Long runs don't block the dev box (Kit-specific tool)                |

The key point: in deadbolt the **simulator removes the scarce resource** (real devices and real
networks) from bug-finding. Twitch's scarce resources are _credited watch slots per account_
and _request budget per IP_, both in wall-clock time.

## 2. Vendored reference source (Effect blog, 2026-05-11)

- Put all vendored repos under one folder (`repos/`), squashed subtrees, excluded from editor
  search and auto-import. The `AGENTS.md` rules are: read-only reference, prefer its patterns over
  guesses or web search, never edit, never import from `repos/`.
- Optional: have an agent write small **pattern files** (e.g. `agent-patterns/effect-schema.md`)
  from the vendored source and tests, so it doesn't rediscover idioms every session.
- Cost: repo size and keeping subtrees current.

Candidates for `repos/` (licences checked 2026-10-29):

| Repo                                      | Licence                                         | Use                                                                            |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `Effect-TS/effect`                        | MIT                                             | idioms, `TestClock`, `effect/http`, `effect/socket`, `LLMS.md`                 |
| `DevilXD/TwitchDropsMiner`                | MIT                                             | Twitch behaviour reference (the most current drops client)                     |
| `rdavydov/Twitch-Channel-Points-Miner-v2` | **GPL-3.0**                                     | read-only _outside_ the repo. Do not vendor or copy code, only learn behaviour |
| `anomalyco/deadbolt`                      | **none declared** (no LICENSE file, 2026-10-29) | design reference only. Read it, don't vendor or copy code                      |

## 3. Things to decide fresh (not inherited from anywhere)

Each of these is a design question for `design.md`, to be argued from our goals (low RAM,
headless, parallel bug-finding), not copied:

- the `AGENTS.md` content and length;
- the gate command and what it runs;
- the error-handling policy (how strict, how many error kinds);
- the CLI surface and machine-readable output;
- persistence (state file vs SQLite) and config format;
- test layering: unit, simulation, replay, live;
- CI/CD, releases, container publishing (deferred until the Docker phase).

## 4. just-mining as a behaviour source only

Useful _facts_ it recorded about Twitch, to be re-verified before we rely on them (they are
cited in 02): the implicit-grant Android login, the HLS watch with specific client-identity and
`Origin` headers, `403`/`410` = the channel refuses playback, `404` = offline, the hourly token validation,
the PubSub topics and ping cadence, and the leak shapes for redaction (signed playlist URLs, `sig`,
`token`, `hdnts`, `Authorization`). Everything else about it is deliberately out of scope.
