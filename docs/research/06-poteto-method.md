# Research 06 — How poteto runs agents in parallel, and how she'd build this

_Researched 2026-10-29. Sources: `poteto/noodle` (2026-03), `poteto/plugins` (pstack + Cursor's
`orchestrate`, 2026-06), `cursor/plugins/pstack` (current, 58 skills), `poteto/verification-skill-example`,
"The Complete Guide to pstack Pt. 2" (poteto on X, 2026-09-09, via hraness.com), an interview
explainer (bsbarkur.github.io/explainers/poteto-pstack), and Barnaby Robson "On pstack" (2026-10-05).
Lauren Tan (poteto): React Compiler core team, ex-Meta/Netflix/Cursor, now xAI. "(inference)" = my
mapping to our project, not her words._

## TL;DR

- **"If you want to go fast, go deep first."** Parallelism comes _last_. In order: (1) the agent can
  **verify its own work** on the real artifact, (2) the repo **narrows the mistakes** agents can make
  (types, feature directories, a registry, lint rules: "make the easy thing the right thing"), (3) only then
  coordinators and workers in parallel. "Parallelism should wait until the environment can absorb it."
- **Verification is the foundation.** Each app has a project-local `verify-<app>` skill: a thin guide
  around a **deterministic CLI** (launch, doctor, drive, evidence, cleanup) plus a per-feature
  map. Mechanics live in scripts; agents spend judgment on what to inspect.
- **Plan with code, not documents.** She does not review abstract plans adversarially: "agents start
  hallucinating theoretical risks". She uses readme-driven design (write the user's tutorial first),
  **prototypes** to settle empirical forks instead of asking the human, and `/architect` (3 models
  sketch types and signatures in parallel, a cross-judge on a different model picks a base and grafts the best of the rest,
  then implement against the sketch, and scrap it if friction repeats).
- **Parallel shapes she uses:** `arena` (N attempts at one thing, judge, graft), `swarm` (N workers on
  slices or a race, aggregate PASS/ISSUES/BLOCKED), `interrogate` (the same diff to 3–4 model families,
  consensus = signal), team execution (lead in its own worktree, one worktree per worker, review each
  before merging into the lead, then merge the lead to main), and Cursor `orchestrate` (planners never code,
  workers are isolated, git + JSON handoffs are the only channel).
- **Applied to us (inference):** our "verify the app" skill is the **simulator + a control CLI**.
  Build it first. Answer E1–E7 and the RAM questions with throwaway prototypes, not with questions
  to you. Fan out only after the shared types and the Twitch seam land.

## 1. Her method, in the order she applies it

| Step                            | What                                                                                                                                                                              | Her artefact                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Verification first              | The agent drives the real app and captures evidence; a test only counts if it checks the behaviour that matters                                                                   | `create-verification-skill` → `verify-<app>/SKILL.md` + `features/*.md`; a CLI over Playwright/CDP            |
| Narrow the choices              | Every recurring agent mistake becomes a type, directory convention, lint rule or API that makes it impossible                                                                     | "Dune" (internal): feature directories + registry + restrictive lint; `principle-encode-lessons-in-structure` |
| Build the lever                 | Do one unit by hand, then build the script/codemod that does or proves it; "a deterministic lever beats fan-out"                                                                  | `principle-build-the-lever`                                                                                   |
| Understand in the agent's words | Restate the problem; `/how` (runtime mechanics, parallel explorers), `/why` (history), `/teach`, `/recall`                                                                        | skills `how`, `why`, `teach`, `recall`, `in-your-own-words`                                                   |
| Readme-driven design            | Write the user tutorial first (Diátaxis: tutorial / how-to / reference / explanation), work backwards                                                                             | `/technical-writing`                                                                                          |
| Prototype the forks             | "If the answer is a fact you could observe by running something, it is not the human's to answer." Throwaway scripts, variants behind a switch                                    | `poteto-mode/playbooks/prototype.md`                                                                          |
| Architect                       | Ground → sketch (arena, 3 models: caller usage first, types, signatures, module map) → cross-judge → implement against the sketch → scrap on repeated friction                    | `/architect`, `/arena`                                                                                        |
| Model the domain                | State machines over booleans, discriminated unions, reducers/events; TLA+ + statechart for concurrency, retries and state machines                                                | `principle-model-the-domain`, `create-formal-verification-skill`, `/statechart`                               |
| Throughput checkpoint           | Before fan-out: blocking first steps, independent workstreams, shared mutable state (split it, don't lock it), smallest safe decomposition                                        | `playbooks/feature.md` step 3, `principle-separate-before-serializing-shared-state`                           |
| Execute in parallel             | Lead in its own worktree, one worker per worktree, review each diff, merge workers into the lead, verify, merge the lead to main. Never `cd` into a worktree (noodle)             | `execute/references/team-execution.md`, `noodle worktree`                                                     |
| Adversarial review              | The same prompt to 3–4 model families, read-only; consensus is high signal; no auto-apply                                                                                         | `/interrogate`                                                                                                |
| Deliver                         | Small stacked commits/PRs that read as an argument (failing test, then fix)                                                                                                       | `principle-sequence-verifiable-units`                                                                         |
| Learn                           | `/reflect` turns a painful run into a skill edit; a decision trail TSV for long autonomous runs                                                                                   | `/reflect`, `/show-me-your-work`                                                                              |
| Scale                           | Persistent coordinators (Cursor Projects) own task lists and spawn workers; an outer loop (Slack/Linear/email) feeds reports; the inner loop **reproduces on main** before fixing | interview, `orchestrate`                                                                                      |

## 2. What this says about what we are doing right now (candid)

We have six research docs and a question list. By her standard that's close to an "overcooked abstract plan".
Her rule splits our open questions into two kinds:

- **Empirical** (answer by running something, never ask the human): E1–E7 in 05, real RAM of
  a watching miner, recording size per day, whether reads count as watching, GQL rate in practice,
  the PubSub frame sizes after Effect 4.1's `chunkSize` change.
- **Preference/product** (only these go to teyd): scope, UX for other users, licence, name,
  what "done" means.

So the research phase should stop after this round. The next artefacts are code: a readme tutorial,
an architect sketch, throwaway prototypes and the simulator harness.

## 3. How she would build this miner (inference, in her playbook shape)

**Phase 0: sharpen the knife (no parallelism).**

1. Scaffold + one gate (`vp check && vp test`) + lint rules that make the wrong thing impossible:
   no `Date.now`/`Math.random`/`setTimeout`/`fetch` outside the IO shell (chronos-style entropy guard),
   feature directories, no cross-feature imports.
2. Vendor `repos/effect` and `repos/TwitchDropsMiner` (both MIT) as read-only references.
3. `/how` over TDM's Twitch client, restated in our words into a Twitch facts ledger.

**Phase 1: the verification harness before any feature.** 4. The **twin** (wire-level fake Twitch: GQL/HLS/PubSub on a fake `HttpClient` + socket) and the
**control CLI** (`miner sim --seed`, `miner replay`, `miner status --json`, `miner doctor`). 5. `create-verification-skill` → `verify-miner`: launch (sim, shadow), doctor, drive, evidence (status JSON,
journal, trace digest), cleanup, plus a feature map (discovery, watching, switching, claims,
points slots, login/park). This is what every later agent uses to prove its work.

**Phase 2: design with code.** 6. README tutorial for a homelabber first (`/technical-writing`): `docker compose up`, `miner login`,
what you see when it works and when it needs you. 7. Name the data shapes: `Campaign`, `Drop`, `Benefit`, `Channel`, `WatchSlot`, `AccountState`,
`Observation` (the Twitch → core events), `Command` (core → Twitch actions), and the miner as a
reducer/state machine. 8. `/architect` with an arena of 3 models over those shapes. Commit the sketch with `not implemented`
bodies. 9. `create-formal-verification-skill`: a TLA+ model of the watch-slot scheduler and claim idempotency
(never more than 2 watches; never claim twice; drops slot never starved). `/statechart` renders it
for review. 10. Prototypes for E1–E7 on test accounts, one throwaway script each, logged as twin rules.

**Phase 3: fan out (now it's safe).** Throughput checkpoint:

- _Blocking first:_ shared types, the `Twitch` service seam, the twin skeleton, the gate. Done in the lead worktree.
- _Independent workstreams (one worktree each):_ (a) wire clients + Schemas, (b) twin world rules,
  (c) pure planner + slot scheduler, (d) login/park/CLI/status, (e) recorder + replay.
- _Shared mutable state:_ only the types module. Changes go through the lead, never two workers.
- Each worker proves its slice with `verify-miner` and sim seeds. The lead reviews every diff and
  `/interrogate`s contested ones. Seed sweeps are a **lever** (one process runs 10k seeds), not
  an agent swarm. `/swarm` is for gauntlets ("break the switching logic", "find a claim race").

**Phase 4: the outer loop.** Other users file issues with a redacted journal → an agent runs
`miner replay` on main → a failing sim test first → the fix → `interrogate`.

## 4. What fits our tools here (inference)

- She works in Cursor with several model families (Claude, GPT, Composer, Grok). Her cross-model
  steps (`arena` judge, `interrogate`) only make sense if we have **at least two model families**.
  Which ones do you have?
- pstack is MIT and has a standalone mirror for Claude Code / Codex / Pi (`backnotprop/pstack`).
  Option: install pstack as-is instead of writing our own skills. Her advice is to fork it via
  `/automate-me` into a `<you>-mode`.
