# Plan — from a working miner to building against the twin (2026-10-30)

Status: running plan, kept current by the supervisor. Input: decisions 13, 15, 18, 22, 28; critique
08 (CF-5, S2, S4, S5, §5, §6); research 01, 03, 04, 05, 06; plan 09 §6. Milestones 1–3 are done
(#10–#17): the core, the twin, `miner sim`, the recorder, `run --shadow`, PubSub, HLS watch,
`ClaimDrop`, `miner run`. `miner run` mined and claimed on teyd's account on 2026-10-30.

**The goal.** Features get built and proven in the simulator, by several agents at once, each in its
own worktree. Live Twitch is needed only for a short final check, one at a time. That needs a twin
whose rules come from recordings, a check that tells when Twitch and the twin disagree, and one fixed
way for an agent to prove its work (research 06: "parallelism should wait until the environment can
absorb it").

## How every step runs

1. An implementer (Opus 5.5 via pi-claude-cli) builds it in its own worktree from `dev`. No live
   Twitch: only the supervisor runs a live miner, and only one at a time (AGENTS.md).
2. The supervisor reruns `pnpm check`, `pnpm build && pnpm start sim --seeds 200`, and reads the diff.
3. A reviewer from another model family (DeepSeek v4.1 Flash, max) reviews the branch read-only:
   bugs, rule breaks (AGENTS.md), missing tests, secrets. Small findings are fixed by the supervisor,
   large ones go back to an implementer.
4. A live check by the supervisor where the step touches Twitch.
5. PR to `dev`, CI green, squash merge, worktree and branch removed.

## Waves

Each wave starts when what it builds on is merged. Inside a wave the steps run in parallel.

### Wave A — make it operable (started 2026-10-30 18:45)

| Step | What                                                                                                           | Done when                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A0   | 4 h live run (systemd `miner-live`, 18:42–22:42 CET), memory sampled per minute                                | analysed: drops, progress rate, switches, errors, requests, RSS, MB/day |
| A1   | Recordings store a repeated answer once; decide gzip with numbers; a reader that expands them                  | merged, measured on real recordings, P3 answered                        |
| A2   | `miner status [--json]`: health, watch with names, "discovery broken" apart from "nothing to mine", exit codes | merged, decoded by a Schema in tests                                    |
| A3   | Core: no plan flip at startup; every drops-goal option of decision 28                                          | merged, sim covers the new settings, `unmapped` lists only points goals |
| A4   | README tutorial, Dockerfile, compose, systemd unit                                                             | image builds and runs `sim`; unit passes `systemd-analyze verify`       |
| A5   | Secret guard: gitleaks (pinned), lefthook pre-commit, token check, CI step                                     | each layer shown to block a planted secret; full history clean          |

### Wave B — a twin we can trust

| Step | What                                                                                                                                                                                                                                             | Builds on |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| B1   | Wire-level HLS and PubSub in the twin: usher, playlists and segment `HEAD`s over the real `hlsWatch`, socket frames over the real `PubSub` (critique §6.2; the #15 socket bug was invisible to the typed twin)                                   | A1        |
| B2   | Classed budgets (GQL, CDN, sockets), rate and concurrency apart; exhaustion is an event for the core, never a wait in the seam (critique CF-5); the twin answers 429 above ~5 GQL/s (plan 09 §6)                                                 | —         |
| B3   | Calibration: the twin's guessed rules (inventory lag, progress cadence, skipped frames, concurrent drops, claim timing, stream-up bursts, settings-update rate) set from the A0 recordings, each with its recording id and date (research 04 §2) | A0, A1    |
| B4   | Conformance: replay a recording's answers and frames through the twin's rules and report every disagreement (research 04 lane B point 2). Runs in `pnpm check` on committed, redacted recordings                                                 | B1, B3    |

### Wave C — the agent harness

| Step | What                                                                                                                                                        | Builds on  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C1   | `verify-miner` skill (decision 13, research 06): launch (sim, shadow), status, evidence (trace digest, recordings, status JSON), cleanup, and a feature map | A2, B4     |
| C2   | A simulated week with a heap bound (research 03 §2); bring RSS toward the ≤ 90 MB target (the live run sat at 118–122 MB)                                   | B1         |
| C3   | `config.json` reloads while the miner runs (decision 28)                                                                                                    | A3         |
| C4   | Scheduled `doctor` on the homelab, catching hash and header changes (research 02 §7)                                                                        | A2, A4, D1 |

### Wave D — live, one at a time (supervisor only)

| Step | What                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| D1   | Homelab deploy (needs teyd to place the token), then a 24 h run: RSS (P2), MB/day (P3), request rate (P4)    |
| D2   | E6: does a shadow run (reads only) move progress? E7: does an unlinked game campaign progress? (research 05) |
| D3   | Record the channel points topics and the bonus chest while watching (E4/E5 inputs for milestone 4)           |

### Wave E — milestone 4 and users

| Step | What                                                                                                          | Builds on |
| ---- | ------------------------------------------------------------------------------------------------------------- | --------- |
| E1   | Points goals, bonus chest, streaks, raids (decision 28), built against the twin calibrated from D3            | C1, D3    |
| E2   | Export a redacted recording for a bug report, and replay it (research 04 §3; strict replay only, critique §5) | B4        |
| E3   | `design.md`: the short final design, with what was dropped and why (research 01)                              | E1        |

Favourites and a second stream wait for experiments E2/E3 of research 05 (decision 28).

## Log

- 2026-10-30 18:42 — A0 started. A1–A5 delegated.
