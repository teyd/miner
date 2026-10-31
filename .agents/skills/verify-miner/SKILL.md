---
name: verify-miner
description: "Prove a change to the miner works, without live Twitch: build it, sweep simulator seeds, run a shadow run over the twin, read its status.json and recordings, and keep the evidence (trace digests, capsules, files) for the PR. Use before calling any change on this repo done, when a sim seed fails, when asked which evidence proves an area (discovery, watching, switching, claims, budgets, PubSub, status, recordings, config), and to clean up scratch directories and stray miners afterwards."
---

# verify-miner

The guide to proving work on this repo (decision 13; research 06 §3 phase 1). The scripts in
`scripts/verify/` do the mechanics, one command per step. Each prints `PASS <step>: …` or
`FAIL <step>: …` with its evidence, and exits 0 on a pass, 1 on a failure, 2 on a usage error.
None of them talks to Twitch: the miner runs over the twin (`src/twin/`), under virtual time.

Live Twitch is the supervisor's, one miner per account (AGENTS.md, Twitch gotchas). Never start
`miner run` or `pnpm dev run` yourself unless your task says so.

## The one command

```sh
pnpm verify              # check + build + 20 seeds + a shadow run over the twin, ~4 min
pnpm verify --skip-check # the same without `pnpm check`, ~25 s, while iterating
```

It ends with a table, one row per step, and `PASS: every step passed` or `FAIL: n step(s)
failed`, and names the evidence directory (`$TMPDIR/miner-verify-run-*`: a log per step,
`sim.json`, capsules, `data/`). Options: `--seed N --seeds M` for the sweep, `--shadow-seed N
--minutes M` for the shadow run. Paste the table into the PR body.

Done on this repo is still `pnpm check`, `pnpm build` and `node dist/bin.mjs sim --seeds 300`
(or what the task names). `pnpm verify` is the cheap loop, not a replacement for a wide sweep.

## Steps, one at a time

### 1. Launch

```sh
node scripts/verify/build.mjs                     # pnpm build, then the bundle must start
node scripts/verify/sim.mjs --seed 1 --seeds 100  # miner sim --json; sim.json + capsules in --out
node scripts/verify/sim.mjs --trace capsule.json  # replay one capsule
node scripts/verify/shadow.mjs --seed 3           # run --shadow over seed 3's twin
```

- `sim.mjs` saves `sim.json` (per-seed trace digests, the sweep digest, how many seeds watched,
  claimed and were refused by a budget) in `--out DIR`, a new scratch directory by default. A
  failed seed exits 1 and leaves `capsule-seed-N.json` with three commands: replay
  (`sim --trace`), rerun (`sim --seed N --seeds 1`) and `files` (the capsule's world as a shadow
  run, so you can read its status and recordings).
- `shadow.mjs` runs `miner sim --shadow DIR`: the real run loop, `shadowLayer`, recorder and
  status writer, with the twin as Twitch, for `--minutes` of virtual time (60). It writes
  `state.shadow.json`, `status.json`, `recordings/` and `logs/miner.log` into `--dir` (new or
  empty; a scratch directory by default). `--config file.json` copies a config in first;
  `--trace capsule.json` uses a capsule's world. The same seed writes the same bytes every time.
- Any other command: `node dist/bin.mjs …` (after a build), never `pnpm dev`, which loads the
  real token. Set `LOG_FILE=false` or a scratch `DATA_DIR`, or logs land in `./data/logs`.

### 2. Status

```sh
node scripts/verify/status.mjs DATA_DIR --expect stopped --mode shadow  # a finished run
node scripts/verify/status.mjs DATA_DIR                                 # a miner that runs now
```

It reads `DATA_DIR/status.json` through `miner status --json` (schema: `miner status --schema`).
Exit codes of `miner status`: 0 healthy or starting, 1 not running (no file, stopped, or no
heartbeat for 90 s), 2 needs login, 3 discovery broken.

- `--expect running` (default) needs exit 0. A stale heartbeat, a stop, a parked token or broken
  discovery fail with the miner's own verdict.
- `--expect stopped` is for a shadow run over the twin, whose clock is virtual (so `miner status`
  itself says "stopped … ago", exit 1). It needs a clean stop (`stoppedAt`), a valid token and a
  catalog that was read; a file with no `stoppedAt` (a run that died) fails.

### 3. Evidence

| Evidence                       | Where                                                       | Read it with                                                 |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------ |
| Sweep digest, per-seed digests | `sim.json`; `sweep digest:` on `miner sim`                  | `sim.mjs --expect-digest HEX`                                |
| Shrunk capsule, rerun command  | `capsule-seed-N.json`; printed by `sim.mjs` and `miner sim` | `node dist/bin.mjs sim --trace FILE`                         |
| `status.json`                  | `DATA_DIR/status.json`                                      | `status.mjs`; `DATA_DIR=… node dist/bin.mjs status`          |
| Recordings                     | `DATA_DIR/recordings/*.jsonl.gz`                            | `recordings.mjs`; `node dist/bin.mjs journal cat FILE \| jq` |
| Logs                           | `DATA_DIR/logs/miner.log` (JSON lines, redacted)            | `jq`                                                         |
| State                          | `DATA_DIR/state.shadow.json`                                | `jq`                                                         |

```sh
node scripts/verify/recordings.mjs DATA_DIR --secret twin-token
```

Every recording must expand through `miner journal cat`: a `{"$same": …}` that points at nothing
fails. With `--secret`, no file under `DATA_DIR` may hold the value, gzip inflated (the twin's
token is `twin-token`; `pnpm verify` checks it). It prints counts per kind (`answer`, `frame`,
`intent`).

- **The sweep digest** hashes every seed's trace digest. A refactor that should change no
  behaviour keeps it: note it before (`sim.mjs` prints it), then `sim.mjs --expect-digest HEX`
  after. A change that should change behaviour changes it; say which seeds in the PR
  (`digests` in `sim.json`).
- **A failed seed:** the capsule is the bug report. Replay it, fix, replay again (`no violation`;
  `digest changed` is expected after a fix), then add a test that fails without the fix.
- **A shadow run's recording** shows what the miner would do: `intent` lines (`Watch`,
  `StopWatching`, `Claim`) with every answer they were based on before them.

### 4. Cleanup

```sh
node scripts/verify/cleanup.mjs --dry-run   # what it would do
node scripts/verify/cleanup.mjs             # remove this checkout's $TMPDIR/miner-verify-* directories
node scripts/verify/cleanup.mjs --kill      # also SIGTERM miners running on those directories
node scripts/verify/cleanup.mjs --worktrees # also `git worktree prune` stale entries
```

It deletes only `$TMPDIR/miner-verify-*` directories that this checkout made (their `.owner`
file names it, so another worktree's evidence survives; `--all` takes every checkout's), and signals only miner processes (under `--kill`) whose
`DATA_DIR` (or `sim --shadow` directory) is one of them; every other miner, such as the
supervisor's live one, is listed and left alone. It lists worktrees but removes none: a task's
worktree goes after its merge, by whoever made it (AGENTS.md, Shipping). Never delete a data
directory you did not make, and never `/home/teyd/projects/miner/data`.

## Feature map: which evidence proves which area

Violations are the simulator's invariants (`src/twin/invariants.ts`); a sweep that passes means
none fired on any seed. Name the ones your change touches in the PR.

| Area                                      | Proves it                                                                                                                                                                | Look at                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Discovery (catalog, inventory, directory) | Sweep passes `Idle`, `Unproductive`, `RefusalDropped`; shadow `status.json` `catalog.status: "ok"` with campaigns                                                        | `status.mjs`; `answer` lines for `ViewerDropsDashboard`, `Inventory`, `DirectoryPage_Game` in the recording                       |
| Watching and credit (HLS)                 | `watched` count in `sim.json`; `TwoWatches`, `WatchMisread`, `CdnIdentity`, `IdleButWatching`                                                                            | `sim.json`; a shadow run's `Watch` intent and `watch` in `status.json` (a shadow run never earns minutes: its ticks are not sent) |
| Switching and plan (decision 28)          | `WrongPick`, `WatchFlip`, `AvoidedTooLong`, `AvoidedUnfairly`, `WatchedClaimed`                                                                                          | Run `shadow.mjs --config` with the priorities in question and read `watch` in `status.json` and the `Watch` intents               |
| Claims                                    | `claimed` count in `sim.json`; `ClaimedTwice`, `ClaimedEarly`, `ClaimLate`, `ClaimMisread`, `MutationRetried`                                                            | Capsules; `Claim` intents in a shadow recording (never sent)                                                                      |
| Request budgets                           | `refused` counts in `sim.json` (each kind still reached); `OverBudget`, `TooManyInFlight`, `RefusalDropped`, `BusyWake`                                                  | `sim.json`; `Throttled` events in a capsule's `tail`                                                                              |
| PubSub                                    | `SocketBudget`, `SocketChurn`, `SubscribeChurn`, `NotListening`, `ReconnectIgnored`                                                                                      | `frame` lines in the recording; `pubsub` in `status.json`                                                                         |
| Login and park (decision 11)              | `ParkedButPolling`, `WrongToken`; seeds with a revoked-token fault                                                                                                       | A capsule with that fault as `shadow.mjs --trace`: `auth: "needs-login"` in `status.json`                                         |
| Status (decision 15)                      | `src/status/*.test.ts`, `src/runtime/status.test.ts`; `status.mjs` on a shadow run                                                                                       | `status.json`, `miner status --json`                                                                                              |
| Recordings and redaction                  | `recordings.mjs --secret twin-token`; `TokenLeak`, `Orphan`                                                                                                              | `journal cat`; the recorder's tests in `src/twitch/journal.test.ts` and `redact.test.ts`                                          |
| Crash and state                           | `StateLost` (crash faults in the sweep), `Nondeterministic` (each seed runs twice)                                                                                       | Sweep digest; `state.shadow.json`                                                                                                 |
| Config                                    | `pnpm check` (schema test); `node dist/bin.mjs config validate` with a scratch `DATA_DIR`; `shadow.mjs --config` refuses an invalid file (exit 1, with the JSON pointer) | `schema/config.v1.json` committed after `pnpm schema`                                                                             |

Things the twin cannot prove: whether Twitch still answers as recorded (hashes, headers;
research 02), and whether real progress moves. Those need the supervisor's live runs (wave D).

## Reporting

In the PR body or final message: the `pnpm verify` table (or the step lines you ran), the sweep
digest with its seed range, any capsule with its replay command, and the evidence directory if
someone should look. Then run `cleanup.mjs`.
