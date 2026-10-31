# Verification

How a change to the miner is proven without live Twitch (decision 13; research 06 §3 phase 1).
The guide for agents is the [`verify-miner` skill](../.agents/skills/verify-miner/SKILL.md); this
page is the short version for people.

## The flow

```sh
pnpm verify
```

runs six steps and prints PASS or FAIL for each, with the evidence:

| Step         | What it runs                                    | Fails when                                                                |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `check`      | `pnpm check` (format, lint, types, tests)       | anything in the gate fails                                                |
| `build`      | `pnpm build`, then `dist/bin.mjs --version`     | the build fails, or the bundle doesn't start                              |
| `sim`        | `miner sim --seeds 20 --json`                   | an invariant fires on a seed: its shrunk capsule is saved, with its rerun |
| `shadow`     | `miner sim --seed 3 --shadow DIR`               | the run stops by itself, or `DIR` is not a fresh directory                |
| `status`     | `miner status --json` on `DIR`                  | `status.json` is missing, unreadable, or shows no clean stop (stale)      |
| `recordings` | `miner journal cat` on every recording in `DIR` | a reference points at nothing, or a file holds the twin's token           |

`--skip-check` leaves out the gate while iterating. Every step is its own script in
[`scripts/verify/`](../scripts/verify/) (Node built-ins only), so one can be rerun alone. Their
tests (`scripts/verify/verify.test.ts`) break each one on purpose: a failing build, a failed seed,
a stale status file, a dangling recording reference, a leaked secret.

## The shadow run over the twin

`miner sim --shadow DIR` is `miner run --shadow` with the twin (`src/twin/`) as Twitch: the same
run loop, recorder, status writer and state file, under virtual time and an in-memory disk whose
files are then written into `DIR` (`src/twin/shadow.ts`). The same seed writes the same bytes
every time. Its `status.json` reads like a real run's, but its clock is the simulator's, so
`miner status` reports it stopped long ago; `scripts/verify/status.mjs --expect stopped` checks
what matters for a finished run instead.

A shadow run against real Twitch (`pnpm dev run --shadow`) uses the account's token and counts as
the one live miner, so only the supervisor runs it (AGENTS.md).

## Evidence

- **The sweep digest** (`miner sim` prints it; `sim.json` holds it and every seed's digest) hashes
  the traces of all seeds. A change meant to keep behaviour keeps it
  (`scripts/verify/sim.mjs --expect-digest HEX`).
- **A capsule** is a failed seed, shrunk: `miner sim --trace capsule.json` replays it, and
  `miner sim --trace capsule.json --shadow DIR` turns its world into files to read.
- **`status.json`, recordings, logs and state** of the shadow run, in `DIR`.

The skill's feature map says which of these prove which area. `scripts/verify/cleanup.mjs`
removes the scratch directories afterwards.
