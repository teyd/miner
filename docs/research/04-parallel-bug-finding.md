# Research 04 — Finding new bugs when Twitch allows one run at a time

_Researched 2026-10-29. Builds on [01](01-agent-friendly-repos.md) (deadbolt's simulator) and
[02](02-twitch-2026.md) (Twitch credit limits). Mostly design reasoning, marked (inference)
where it isn't backed by a source._

## TL;DR

just-mining's bug discovery ran at **1 account × wall-clock time**. Every new question needed
a live `jm run` behind `/tmp/just-mining-live.lock`. Drops take hours, and the evidence was a log
nobody could re-run. The fix is to **stop using the scarce resource for questions it
doesn't need to answer**. There are four lanes, and only one of them needs the account's credit:

| Lane                                             | Finds                                                    | Parallel?                              | Needs Twitch?                           |
| ------------------------------------------------ | -------------------------------------------------------- | -------------------------------------- | --------------------------------------- |
| **A. Deterministic simulation** (deadbolt-style) | logic, timing, races, retries, crash/restart, leaks      | unlimited, ~seconds per simulated week | no                                      |
| **B. Flight recorder + replay**                  | real-world sequences we didn't imagine; user bug reports | unlimited replays of each recording    | only to record (the always-on instance) |
| **C. Shadow (read-only) live runs**              | contract drift, decode errors, planning on real data     | several at once per account            | yes, reads only, no credit              |
| **D. Credited live runs**                        | what Twitch actually credits and when                    | 1 per account (2 for points)           | yes, exclusive                          |

Lane D becomes rare and targeted. Its questions are _about Twitch_, and each answer gets
written back into the simulator's model (A), so you don't have to ask it again.

## 1. Where bugs come from (inference)

| Kind                | Example                                                                                              | Today's only detector | Better detector                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| Contract drift      | hash rotated, field renamed, silent `null` catalog                                                   | live run              | C (probe), B (diff)                                                |
| Twitch semantics    | which campaign progresses, inventory lag, claim window                                               | live run              | D, then encoded into A                                             |
| Our logic over time | switch on game change during PubSub reconnect; campaign ends at 00:00 mid-watch; rescan + claim race | live run (hours)      | **A**                                                              |
| Resilience          | 5xx storms, 429s, socket drops, token revoked, disk full, crash between claim and state write        | rarely seen live      | **A** (fault injection)                                            |
| Resource            | heap creeping over days                                                                              | a week-long live run  | A (simulated week + heap bound), confirmed by the homelab instance |

Most of the rows don't need Twitch at all. They need _realistic inputs_ and _time
compression_.

## 2. Lane A — deterministic simulation

Deadbolt's model, translated (see 01 §1):

- **Seams.** The miner core only sees Effect services: `Twitch` (typed ops: catalog,
  inventory, stream info, watch tick, claim, socket events), `Clock`, `Random`, `StateStore`.
  Production layers do HTTP/WS. The sim layer is a **Twitch twin**: an in-memory world.
- **The twin is a model, not a mock.** State: campaigns (start/end, drops, required minutes,
  ACLs, benefit types), channels (live schedule, game, viewers, sub-only/geo refusal), the
  account (inventory, progress, claimed, link state, token validity). Rules: credit only the
  one watched channel per minute; inventory lags by L; only one campaign per stream progresses;
  claim valid until 24 h after campaign end (the shorter of two sourced windows, 02 §3); points: two streams. Every rule cites the source that established
  it (02 or a lane-D measurement).
- **Seeded scenarios.** A seed generates a world and an action/fault schedule: streams
  go live, go offline or change game; campaigns start or end; HTTP 5xx/429/timeouts;
  socket drops/`RECONNECT`; token revoked; the process crashes and restarts from state; a
  schema-drift response. Run under `TestClock` + `Random.withSeed`. A simulated week takes
  seconds (inference, to measure).
- **Invariants after every step.** For example: never claim twice or before completion; at most one
  credit-bearing watch; never watch an excluded/offline/wrong-game channel for more than one
  interval; if a minable campaign has an eligible live channel, idle time < X; mutations never
  auto-retry; every failure is classified (no defects); state survives a crash at any step;
  fibers, maps and caches stay bounded.
- **Failures are executable.** Print the seed, the full trace and a **shrunk** trace, plus the exact
  command: `MINER_SIM_SEED=… MINER_SIM_SEEDS=1 vp test sim` or `MINER_SIM_TRACE='[…]'`.
  fast-check `fc.commands` / `fc.scheduledModelRun` give model-based runs with shrinking out of the box.
  `fc.scheduler` explores promise interleavings.
- **Determinism is tested.** Run a seed twice and compare a digest of all twin I/O (deadbolt
  does exactly this). Any `Date.now()`, raw `setTimeout`, `Math.random` or un-Effected Promise in
  the core breaks it, so lint for them.
- **Parallel by construction.** No sockets, no shared files, no account. Every agent in every
  worktree can sweep 1,000 seeds at once.

**The drift objection** ("a simulated Twitch drifts from the real one without catching anything
more", the reason just-mining skipped it; teyd 2026-10-29: "I just want the best we can do"). Drift
is real, so _measure_ it instead of avoiding the twin:

1. Shapes: the twin builds wire values through the **same Schemas** we decode with, and real
   recorded fixtures still have to decode. Shape drift shows in fixtures and lane C, not the twin.
2. Semantics: replay recordings from lane B through the twin's credit model and diff predicted
   against recorded inventory progress. A mismatch is a twin bug with a concrete
   counterexample (a **conformance test**).
3. The twin catches what fixtures can't: _sequences_ and _time_. A fixture is one response, and
   bugs live between responses.

## 3. Lane B — flight recorder and replay

An always-on miner is the best source of real sequences. **Today none runs** (`docker ps` on
the homelab, 2026-10-29: no miner container). (inference) Bootstrap order: ship the recorder
with the very first build, deploy a **shadow-mode** instance (lane C, reads only) on the homelab
as soon as discovery and decode work, and let it record while the actuator is still being built.
The recordings are then ready by the time the twin needs calibrating.

- **Record at the service boundary**: every Twitch request/response (redacted), every socket
  frame, every clock read that drove a decision, and the seed. It's a rolling, bounded journal
  (e.g. one gzip JSONL per day, keep N days). (inference) A few MB/day: one GQL read per minute plus
  20 s heartbeats.
- **Replay** = run the current code with the journal as the Twitch layer, under `TestClock`.
  - _Strict_ replay: the same requests in the same order. Proves a fix against the exact incident.
  - _Keyed_ replay: answer by `(operation, variables)` with "latest answer at or before
    simulated time t". This survives code changes that reorder or add reads. A request with no
    recorded answer falls back to the twin or fails with a named gap.
- **Bug reports become attachments.** `miner journal export --since 2h` (redacted) → the
  issue → an agent replays it in-process. No account, no lock, no waiting.
- Recordings promote into **regression scenarios**, and they calibrate the twin (A, point 2).
- Redaction is the risk: tokens, signed playlist URLs (`sig`, `token`, `hdnts`), user IDs.
  just-mining's triage fixture shows real leak shapes (signed URLs in messages, headers in
  fields, token fragments in redirects). Use them as test _inputs_, not as a design.

### 3a. Recording size, measured (2026-10-30)

Open question P3. Inputs: read-only copies of the two recordings of 2026-10-30 (shadow runs
14:07–17:42 UTC, 389 entries; the first live run 15:19–15:56 UTC, 342 entries), replayed through
the recorder's encoder. Scripts were throwaway; the numbers below are their output.

Where the bytes are (live run, 37 min, plain JSON 2,555 KiB, per-line gzip 464 KiB):
`DropCampaignDetails` 900 KiB, `Inventory` 868 KiB (9 reads), `DirectoryPage_Game` 502 KiB,
`ViewerDropsDashboard` 99 KiB; PubSub frames and HLS ticks are under 3 % together.

**No large answer repeats byte for byte.** Whole-body deduplication finds 0 of 9 inventory reads,
0 of 16 catalog batches and 0 of 55 directory pages equal to an earlier one (only `hls` and
`validate` repeat, 10 KiB). Twitch reorders the inventory's campaign list between reads, the
directory carries live viewer counts, and catalog batches group campaigns differently. A JSON
diff against the previous answer of the same operation and variables saves nothing either: the
reordering makes positional diffs as big as the body.

**What does repeat is the parts:** the same campaign object, drop, game or channel inside
different answers. Storing every object or array whose JSON is at least 256 characters once per
file, and writing `{"$same": "<first 16 hex of its SHA-256>"}` for it afterwards:

| Per-line gzip unless noted                | before    | parts once | plain JSON, parts once |
| ----------------------------------------- | --------- | ---------- | ---------------------- |
| shadow file, 14:07–17:42 (two runs)       | 1,054 KiB | 584 KiB    | 2,857 KiB              |
| live run, 37 min, one start               | 464 KiB   | 377 KiB    | 1,796 KiB              |
| steady state, 17:08–17:42 (file warm)     | 805 KiB/h | 282 KiB/h  | 1,015 KiB/h            |
| same, `DropCampaignDetails` / `Inventory` | 302 / 195 | 10 / 40    |                        |

Threshold: 128 characters writes 1 % less than 256, 1,024 a fifth more. The first catalog read
of a file costs what it did (about 1 MiB), then the hourly re-reads cost almost nothing; the
directory (viewer counts) is most of what is left. A day is about 7 MiB instead of about 19 MiB.
Encoding costs about 3 ms per answer, and remembering 16,384 parts about 1 MiB of heap.

**gzip stays.** On the compacted lines it still saves 3.6x (1,015 vs 282 KiB/h): plain
compacted JSON would be larger than today's gzip. Whole-file gzip would save 17 % more (482 vs
584 KiB) but loses the "a crash costs one line" property; per-line zstd (Node 26 `zlib`) is the
same as per-line gzip (582 vs 584 KiB), and whole-file zstd's lead over gzip shrinks from 37 % to
20 % once parts are stored once. Readability is the same either way: `zless`, `zgrep` and
`zcat … | jq` read a recording directly, and `miner journal cat <file>` prints it with every
answer whole.

A reference only points at a line the same process wrote to the same file and saw succeed, so
a failed or torn write, a day roll or a restart after a crash can't leave one dangling (property
test in `src/twitch/journal.test.ts`). Measuring also found that a torn gzip member followed by
more members (a crash, then a restart appending to the same day) made `gunzip` stop at the tear
without an error; the reader now inflates member by member.

## 4. Lane C — shadow (read-only) live runs

Only the _actuator_ contends: playlist/segment `HEAD`s and spade/watch events, plus claims.
Discovery, inventory, stream info, the directory and PubSub listening do not (inference: GQL reads
are not credited watching. Verify once in lane D).

- `miner run --shadow`: real token, real reads, real planner. The actuator is replaced by a
  recorder that logs what it _would_ do. Claims are logged, not sent.
- Several shadow runs per account can run in parallel (cap ~3, inference). Rate limits and TDM's "AvailableDrops stops
  working for X days" (02 §2) argue for a shared, low request rate and a token-bucket per account.
- Uses: catch contract drift fast, test planner changes against today's real catalog, record
  journals for lane B without touching credit.
- A scheduled read-only probe (`doctor`) in CI catches hash rotation and the null-catalog trap.

## 5. Lane D — credited live runs, made rare and cheap

Still exclusive. Make each run count:

- **Ask Twitch questions, not code questions.** For example: "does a HEAD-only watch credit within 5 min?",
  "how long does inventory lag?", "which campaign progresses when two share a stream?". Encode
  each answer as a twin rule with the date and the evidence.
- **Lease, not a `/tmp` lock.** One lease per account with holder, purpose and expiry, and preemption by
  the homelab instance (inference: a small file or SQLite lease with a heartbeat). Experiments can
  **hand over** the always-on instance's account for N minutes and then give it back, instead of
  running a second miner.
- **More accounts = more lanes, but the budget is per IP.** teyd has 5–10 accounts
  (2026-10-29). Twitch's limits are per IP (~10 websockets, ~5 GQL req/s, TDM #1153), and
  DevilXD calls more than 2–3 accounts per IP abuse (TDM #414). So:
  - at most **2–3 live accounts at once per IP**, with every live run on the host drawing from **one shared
    budget** (one process managing several accounts, or a host-wide broker);
  - the pool is for _rotation_, not width: spread lane-D hours across accounts so no single
    account carries all the experimental traffic;
  - suspending a phone-verified account reportedly suspends its phone-linked accounts
    (TechCrunch 2021-09-29, unverified for 2026), so test accounts should not share your main's phone.
- **Unlinked test accounts** (no game links) can still test badge/emote campaigns, points, the
  watch actuator, inventory lag and switching ([02 §4b](02-twitch-2026.md)). Whether game campaigns
  progress while unlinked is itself the first lane-D question. If they do, unlinked accounts cover
  almost everything except the final in-game delivery.
- Automation of watching is a ToS grey zone in general.

## 6. What this means for architecture (inference)

1. **Functional core, effectful shell.** The planner, switching, claim and points decisions are pure
   functions of `(state, observation, now)`. Tasks are thin Effect loops that call them. A
   _single_ `Twitch` service seam is implemented by production, the twin and the recorder.
2. **One process, few tasks.** Fewer concurrent fibers means fewer interleavings to explore.
   Prefer one event loop per account (timer tick, socket frame, state change) over many
   independent periodic tasks.
   2b. **The per-IP budget is a service.** A rate limiter plus a socket pool shared by all accounts in
   the process. The twin enforces the same limits, so the simulator catches a planner that would
   get us throttled.
3. **Time is always `Clock`**, randomness always `Random`, I/O always a service. Lint enforces it.
4. **The sim is a first-class package** (`sim/` or `test/sim`), documented in `docs/simulation.md`
   with the env vars in `AGENTS.md`, as in deadbolt.

## 6b. Does a Twitch simulator already exist? (checked 2026-10-29)

No. GitHub searches for Twitch mock/fake/simulator/emulator servers found:

| Candidate                                      | What it is                                                                                                      | Useful?                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `twitchdev/twitch-cli` `mock-api` (686★)       | official mock of the **public Helix API** (users, streams, categories…), plus an EventSub websocket test server | No. Miners use the private GQL/PubSub/HLS/Spade surface, which it doesn't mock |
| `DanielBarletta81/twitch-drops-simulator` (1★) | a React/WebSocket demo of the _idea_ of drops                                                                   | No                                                                             |
| assorted "mock twitch" repos                   | React clones of the site                                                                                        | No                                                                             |

Generic TypeScript deterministic-simulation libraries exist: `sx4im/chronos` (MIT, 19★: virtual
time, seeded PRNG, chaos network, **entropy guards** that throw on `Date.now`/`Math.random`/native
`setTimeout`, replayable **failure capsules**) and `glideapps/determined` (MIT, 2★: seeded task
scheduling, failpoints). (inference) We don't need either. Effect already provides virtual time
(`TestClock`), seeded `Random`, a single-threaded fiber scheduler and `Layer` swapping, and
fast-check adds shrinking. Borrow chronos's two ideas: the entropy guard (as a lint rule plus a
runtime trap in sim mode) and the failure-capsule format.

**Decision (teyd, 2026-10-29): build a proper simulator ourselves, at the wire level.**

## 7. Prior art to read before building (not yet researched in depth)

- Deadbolt `crates/cli/src/agent/sim/` (read): seeded actions, manual scheduler, shrinker.
- FoundationDB / TigerBeetle deterministic simulation testing (background knowledge, not re-read
  for this pass).
- fast-check model-based testing docs (`commands`, `scheduledModelRun`, `scheduler`).
- Effect `TestClock` gotcha: ordered wake-ups across scheduler hops need fibers under
  `TestClock.layer()`, not a hand-provided clock (`effect/testing/TestClock.d.ts`, 4.1.0).
