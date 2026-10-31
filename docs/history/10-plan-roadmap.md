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

### Wave A — make it operable (merged #19–#25)

| Step | What                                                                                                           | Done when                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A0   | 4 h live run (systemd `miner-live`, 18:42–22:42 CET), memory sampled per minute                                | analysed: 3 claims, 1 credit/min, RSS flat 126–131 MB, 8.1 MiB/day recorded |
| A1   | Recordings store a repeated answer once; decide gzip with numbers; a reader that expands them                  | #19                                                                         |
| A2   | `miner status [--json]`: health, watch with names, "discovery broken" apart from "nothing to mine", exit codes | #21                                                                         |
| A3   | Core: no plan flip at startup; every drops-goal option of decision 28                                          | #25                                                                         |
| A4   | README tutorial, Dockerfile, compose, systemd unit                                                             | #23                                                                         |
| A5   | Secret guard: gitleaks (pinned), lefthook pre-commit, token check, CI step                                     | #20                                                                         |
| A6   | Skip rewards already received (`gameEventDrops`); stop on credit the plan can't use (the 2 h Witchspire waste) | branch `fix/already-received-rewards`, open: seed 150534                    |

### Wave B — a twin we can trust (built, in review)

| Step | What                                                                                           | State                                                  |
| ---- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| B1   | Wire-level HLS and PubSub in the twin (`twin-wire-hls-pubsub`)                                 | review done: 2 P1s (token, claim truth), fixes owed    |
| B2   | Classed request budgets with an event the core sees (`feat/classed-request-budgets`)           | review done: P1 (refusals unreachable), fixes owed     |
| B3   | Calibration from the 2026-10-30 recordings (`calibrate-twin-timings`)                          | review done, fixes committed (2169cc9), merge after A6 |
| B4   | Conformance: replay a recording's answers and frames through the twin and report disagreements | after B1+B3                                            |

### Wave C — the agent harness

| Step | What                                                                                                                                                        | Builds on  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C1   | `verify-miner` skill (decision 13, research 06): launch (sim, shadow), status, evidence (trace digest, recordings, status JSON), cleanup, and a feature map | A2, B4     |
| C2   | A simulated week with a heap bound (research 03 §2); bring RSS toward the ≤ 90 MB target (the live run sat at 126–131 MB)                                   | B1         |
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
- 2026-10-30 19:30 — Merged A1 (#19), A5 (#20), A2 (#21), A4 (#23), each after a DeepSeek review; the P1s
  found: escaped `auth_token` and `signature=` slipped past gitleaks, a fractional `requiredMinutes` froze
  `status.json`, and the pid lock let a second Docker container (also pid 1) take over. #22 gave a slow
  72-hour runtime test 30 s on CI. Open follow-ups from the reviews: status write-failure and heartbeat
  tests, a crash loop reads as "starting", validate retries hourly while `auth` is unknown, gitleaks rules for
  signed URL paths and `user_ip`, `journal cat` streaming, digest-pinned base images, and logging failed
  reads in `run` (now only visible in `status`).
- 2026-10-30 22:50 — A0 analysed. The 4 h run: 3 claims (APEX Pack, Respawning Holospray, Destiny 2
  Emblem), 1 credited minute per watched minute, no warnings, 5 PubSub reconnects handled, 313 GQL
  requests, RSS flat at 126–131 MB. It wasted ~2 h on a campaign whose drops were already received
  (`gameEventDrops`, which the core did not read) while Twitch credited one past its requirement: A6.
  Recording size: 132.8 MiB/day plain, 23.6 gzip, 8.1 deduplicated + gzip (now on `dev`).
- 2026-10-30 23:40 — A3 merged (#25) after three review rounds: least-slack ranked future drops; a doomed
  goal starved the others (6 h, nothing claimed); an inventory read without the drop re-sent a lost claim;
  two WatchFlip false alarms; a stale channel held by a reset stall clock. The twin gained an independent
  decision-28 oracle (`WrongPick`) that catches 10 planted ranking bugs.
- 2026-10-31 00:40 — Wave B delegated: A6 (Witchspire), B1 (wire-level HLS/PubSub), B2 (classed budgets),
  B3 (calibration from the recordings). All four built; reviews done.
- 2026-10-31 03:40 — Reviews in: A6 one P1 (a skip outlived its cause; a stale frame cost a fresh hour),
  B1 two P1s (twin never checks the token; a service-error claim is applied), B2 one P1 (refusals
  unreachable, so a dropped refused claim passed), B3 one P1 (blind re-claims unbounded). Supervisor
  fixes on A6's branch (`769394d`) plus an open seed: **150534** (`Unproductive`, core confirms on a
  credit the twin's oracle does not count; one-read disagreement, capsule saved), to be settled by A6's
  delegate together with the B1/B2 fix rounds after the 05:10 model reset.
- 2026-10-31 — B1 (`twin-wire-hls-pubsub`): the twin serves usher, playlists, segment `HEAD`s and PubSub
  frames at wire level under the real `hlsWatch`, `PubSub` and `liveServices`. Review fixes: the twin now
  checks the token on every API request and LISTEN (`WrongToken`); a claim answered with a service error
  is not applied, and every `ClaimResult` must match what the twin answered (`ClaimMisread`); a revoked
  token answers 401 before a 5xx; a `RECONNECT` must be obeyed (`ReconnectIgnored`); a request no command
  sent is an `Orphan`; only a whole credited beat counts as one; NotListening is excused only by PubSub,
  auth and restart faults; a client close needs a shrink that left enough sockets (`SocketChurn`); usher's
  `token` and a segment's `dna` are checked; the token in a CDN query or cookie is a `TokenLeak`; CDN
  requests need the player's identity headers (`CdnIdentity`); `drop-claim` frames are opt-in
  (`claimFrames`), as live sent none. The simulator yields 8 scheduler turns before moving virtual time,
  so a PubSub answer still between fibers isn't overtaken by a 10 s timeout (seed 6), and `TestClock`
  waits up to a minute, not 1 s of real time, for the fibers a sleep woke: under CPU load the default
  tripped and seeds 140001–141000 summed to other results.
- 2026-10-31 — B1 rebased on A6, B3 and B2 (`a069e76`). The miner's own code charges every request to
  its budgets over the wire (`gql.ts` for GQL and `PlaybackAccessToken`, `hls.ts` for usher, playlists
  and segments; one set per run, kept across crashes); the twin charges nothing, and `OverBudget` counts
  each request once as the twin served it (API and CDN concurrency, the CDN window, 429s for the rate).
  Sockets are the edge's to count (`SocketBudget`). B3's `reconnect` is a wire `RECONNECT`; its gap is
  the client's own. `ReconnectIgnored` now excuses a socket a `Subscribe` emptied, as `SocketChurn` does.
  A `TestClock` that runs out of patience fails the seed as a defect. Found by the merge: a budget can
  refuse the validation PubSub needs for the account id, and the drops topic then waits for the next
  change of channels (`PubSub.ts`); `NotListening` excuses that topic when PubSub says so. Sweeps:
  1–300 and 140001–141000 pass; 270001–271000 fail 270187 (`AvoidedUnfairly`, fails on `dev` too) and,
  new, 270057 (`Idle`: an idle core doesn't wake when a known drop's own window opens, `startsAt` is no
  deadline, so it waits for the next 5-minute tick past the 3.4-minute bound). Still open: 80578,
  and 161/160174 with `framesAll` off; 240609 passes.
- 2026-10-31 — Core fixes for what the calibrated, wire-level twin pinned (research 04, findings
  5–7). An inventory rise is a credit like a frame's (`creditShown`), so the sweep frames one drop
  per campaign, as measured (`FRAMES_ALL_SWEPT` false): 161 and 160174 pass. A credit to a drop the
  goal filters out confirms the watch only within a stall of completing it, in any wanted campaign
  (the twin's `wantedCredit` rule): 80578, 280710 (`Unproductive`) and 270187 (`AvoidedUnfairly`, a
  core bug, the twin was right) pass. An idle core wakes when a known wanted drop opens
  (`deadlines.tick` while idle) and reads the channels of what opened if none it knows can credit
  it: 270057, 280721 and 280753 (`Idle`) pass. No state field added, `STATE_VERSION` stays 5. Each
  seed is a stored regression (`sim.test.ts`). Sweeps: 1–300, 140001–141000, 280001–281000 and
  290001–291000 pass.
