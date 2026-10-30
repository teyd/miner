# Plan — the twin and `miner sim` (milestone 1)

Status: plan, 2026-10-30, amended the same day after an independent review (verdict: block, six P1s).
Input: proposal v0 §4 (`07-proposal-v0.md`), critique 08, decisions 5, 11, 12, 23, research 02 §3,
04 §2 and 05. One PR on `feat/twin`. No live Twitch access anywhere in it.

Review amendments, in short: the timeout fault and the in-flight bound now agree (§3.3, §4 s3); the
idle oracle uses the twin's own rules, not `plan()`, and unfair avoidance is its own check (§4 #3,
`AvoidedUnfairly`); credit is per elapsed second, not per tick (§3.2); every fault has a defined effect
on watch ticks and claims (§3.4); fast-check per decision 12 (§8 Q1, settled by the supervisor); the
core fix is specified (§7); the `Actuator` interface lives in `src/twitch/` (§3.4); claim attempts and
applied claims are counted separately (§4 #2, #4); plus the smaller points (TestClock epoch, horizon
cap, trace typing, `--trace` output, extra checks, bundle cost, deferrals named in §6).

## 1. Scope

The twin is a deterministic, in-memory Twitch for one account. It runs the existing pure core
(`step`, `nextDeadline` in `src/core/`) through simulated time. After every step it checks
invariants, and when one fails, fast-check shrinks the scenario. `miner sim` runs seeds from the
command line and exits non-zero when an invariant fails.

What the PR builds:

1. **A scenario** is plain data: a world (campaigns, channels with live schedules, account link
   state, settings) plus a fault schedule. A Schema defines it (the capsule codec), and a fast-check
   arbitrary built from the same bounds generates and shrinks it.
2. **The world** is the twin's model of Twitch: what is live, what credits, what can be claimed.
   Each rule names its source.
3. **Wire-level reads.** A twin `HttpClient` answers `oauth2/validate` and the six GQL operations
   with JSON encoded through the decoding Schemas in `src/twitch/wire.ts`. The real `Twitch.layer`
   runs on top of it, so the retry, decode and `null` handling in `src/twitch/Twitch.ts` are what the sim
   exercises. This is decision 12's "wire level" for every surface that has a wire client today.
4. **Typed mutations.** No live client exists yet for watch, claim or PubSub, so there is no wire
   format of ours to encode through. A typed `Actuator` service (interface in `src/twitch/`, twin
   implementation in `src/twin/`) covers watch sessions, watch ticks, claims and channel
   subscriptions, and the twin delivers PubSub-like frames straight into the sim's inbox. Each
   surface moves to wire level when its live client lands (milestone 3); this is recorded as the
   one deliberate exception to decision 12 for this PR.
5. **A minimal command executor** in `src/twin/execute.ts` turns a core `Command` into calls on
   `Twitch` and `Actuator` and returns core `Event`s. It depends only on those two services, so
   the runtime can reuse or replace it later.
6. **One scheduler loop** (`src/twin/sim.ts`), as critique 08 §6.1 asks: step, persist, check,
   execute, then advance `TestClock` to the next wake-up.
7. **Invariants and the determinism check.** Each seed runs twice and the two trace digests must
   match.
8. **The `miner sim` command**, with `--seed`, `--seeds` and `--trace`, plus the matching
   `MINER_SIM_*` variables in `.env.schema`.

## 2. Files

| Path                          | Change | What                                                                                                                                            |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/twin/scenario.ts`        | add    | `Scenario`, `Fault`, `Violation` and `Capsule` Schemas, `scenarioArbitrary` (fast-check), `SIM_EPOCH`                                           |
| `src/twin/scenario.test.ts`   | add    | generated scenarios decode, index references resolve modulo, capsule round-trip                                                                 |
| `src/twin/world.ts`           | add    | `World` built from a `Scenario`, the pure twin rules (live state, credit, claim, inventory with lag, frames)                                    |
| `src/twin/world.test.ts`      | add    | one test per twin rule                                                                                                                          |
| `src/twin/answers.ts`         | add    | `World` → wire values (`Dashboard`, `CampaignDetails`, `Inventory`, `Directory`, `StreamInfo`, `CurrentDrop`, `Validation`) via `Schema.encode` |
| `src/twin/http.ts`            | add    | the twin `HttpClient` (routing, latency, HTTP faults, revoked token, request log), `twinTwitch` layer = `Twitch.layer` over it                  |
| `src/twin/http.test.ts`       | add    | the real `Twitch` service over the twin: decode, retries, faults                                                                                |
| `src/twitch/Actuator.ts`      | add    | the `Actuator` service interface, `WatchFailure`, `ClaimAnswer` (the mutation seam, beside `Twitch`)                                            |
| `src/twin/actuator.ts`        | add    | the twin `Actuator`: session switching, ticks, claims, subscriptions, the fault table of §3.4                                                   |
| `src/twin/actuator.test.ts`   | add    | session switching, ticks without a session, each fault row of §3.4                                                                              |
| `src/twin/execute.ts`         | add    | `execute(memory, command)`: `Command` → `Event`s, error classification                                                                          |
| `src/twin/execute.test.ts`    | add    | command → event mapping, errors, claims never retried                                                                                           |
| `src/twin/durable.ts`         | add    | canonical JSON (`canonical`) and the codec for core `State` (Maps, Sets, `undefined`)                                                           |
| `src/twin/durable.test.ts`    | add    | round-trip of a fully populated `State`, canonical order                                                                                        |
| `src/twin/invariants.ts`      | add    | `Violation`, `Observation`, `checkStep(checker, observation)`, the idle oracle                                                                  |
| `src/twin/invariants.test.ts` | add    | each invariant fires on a hand-built observation sequence and stays quiet on a good one                                                         |
| `src/twin/sim.ts`             | add    | the loop, crash/restart, trace and digest, `runScenario`, `runSeed`, `runSeeds`                                                                 |
| `src/twin/sim.test.ts`        | add    | seeds pass, digests replay, fixed fault scenarios, planted bugs are caught and shrunk, capsule replay                                           |
| `src/cli/sim.ts`              | add    | `miner sim`                                                                                                                                     |
| `src/cli/sim.test.ts`         | add    | flags, env fallback, exit behaviour, `--json` document, `--trace`                                                                               |
| `src/cli/miner.ts`            | change | add `sim` to the subcommands                                                                                                                    |
| `src/bin.ts`                  | change | `SimFailed` → exit code 1, `SimTraceInvalid` → exit code 2 (the same pattern as `DoctorFailed` and `ConfigInvalid`)                             |
| `.env.schema`                 | change | `MINER_SIM_SEED`, `MINER_SIM_SEEDS`, `MINER_SIM_TRACE`, all optional and not sensitive                                                          |
| `package.json`                | change | `fast-check` 4.10.2 as a dev dependency (decision 12)                                                                                           |
| `AGENTS.md`                   | change | status line, a `src/twin/` bullet, how to run the sim (`pnpm build && pnpm start sim …`, `pnpm exec vp test src/twin`)                          |
| `src/core/state.ts`           | change | `nextDeadline` no longer reads claim intents (§7)                                                                                               |
| `src/core/step.ts`            | change | a claim recheck moves the inventory deadline instead of being a deadline of its own (§7)                                                        |
| `src/core/step.test.ts`       | change | regression tests for §7 and any other core bug the sim finds and that blocks `pnpm check`                                                       |

Nothing goes in `src/platform/`. The `src/twin/**` files follow the determinism lint unchanged: they
use `Clock`, `TestClock`, `Random` and `Effect.sleep`, and touch no Node built-ins.

## 3. Types and interfaces

### 3.1 Scenario (`scenario.ts`)

Each field is a bounded `Schema.Int` or a literal. Every reference to another entity is an index
taken modulo the length of its list when the world is built, and a precondition points only at an
earlier drop of the same campaign. Any generated or shrunk value is then a valid world, so shrinking
never needs a filter.

```ts
export const SIM_EPOCH: Millis; // 2026-10-29T12:00:00Z, the same instant as core fixtures' T0

Scenario = Struct({
  latencySeed: Int,                // seeds `Random` for request latency (100–400 ms)
  horizonMinutes: Int 60..1440,
  inventoryLagMinutes: Int 0..3,
  settings: Struct({ games: Array(Int 0..2) max 3, exclude: Array(Int 0..7) max 2, badgesAndEmotes: Boolean }),
  campaigns: Array(1..4, Struct({
    game: Int 0..2,                // game 2 is the special game "509663"
    startMinute: Int -120..600, durationMinutes: Int 30..2880,
    linked: Boolean,
    allowList: Array(Int 0..7) max 3,      // empty: any drops-enabled channel
    drops: Array(1..3, Struct({ requiredMinutes: Int 1..240, after: NullOr(Int 0..2), benefit: Literals(["BADGE","EMOTE","DIRECT_ENTITLEMENT"]) })),
  })),
  channels: Array(1..8, Struct({
    game: Int 0..2, viewers: Int 1..10000, dropsEnabled: Boolean, refuses: Boolean,
    liveAtStart: Boolean,
    changes: Array(max 6, Struct({ atMinute: Int 0..1440, to: Literals(["up","down","game-0","game-1","game-2"]) })),
  })),
  faults: Array(max 8, Fault),
})

Fault =
  | { kind: "http-5xx" | "http-429" | "timeout" | "service-error" | "null-catalog", operation: Operation | "any", atMinute, durationSeconds: Int 1..1800 }
  | { kind: "revoke-token", atMinute }
  | { kind: "lose-claim-answer", atMinute }   // the next claim applies, its answer is lost
  | { kind: "frames-down", atMinute, durationSeconds }   // PubSub frames dropped for the window
  | { kind: "crash", atMinute, point: "before-persist" | "after-persist" | "in-claim" }

Operation = "validate" | "ViewerDropsDashboard" | "DropCampaignDetails" | "Inventory" | "DirectoryPage_Game" | "VideoPlayerStreamInfoOverlayChannel" | "DropCurrentSessionContext" | "ClaimDrop"

Violation = Struct({ kind: String, at: Int (minutes since SIM_EPOCH), detail: String })
Capsule = Struct({ seed: NullOr(Int), scenario: Scenario, violation: Violation, digest: String, tail: Array(String) })

export const scenarioArbitrary: fc.Arbitrary<Scenario>   // the same bounds as the Schema
```

Ids are fixed strings: games `g0`, `g1` and `509663`, campaigns `c0`…, drops `c0-d0`…, channels `ch0`… with
logins `chan0`…. A failure trace therefore reads the same on every machine.

### 3.2 World and twin rules (`world.ts`)

`World` is immutable, and every function takes it as `(world, now) → …` and returns the next world
plus the frames it caused. It holds:

- `campaigns: ReadonlyArray<Campaign>` (core type, built from the scenario), and `channels` with
  their schedules resolved to `liveAt(world, channelId, now)` and `gameAt(world, channelId, now)`
- `account`: `minutes: Map<DropId, ReadonlyArray<{ at, minutes }>>` (the history, for lag),
  `claimed: Map<DropId, Millis>`, `revokedAt`
- `session`: `{ channelId, openedAt, lastCreditAt, carrySeconds } | undefined`
- `subscriptions`: the channel set of the last `Subscribe`

Rules, each a named export with its source:

| Rule              | Behaviour                                                                                                                                                                           | Source                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `oneChannel`      | Only the open session's channel can credit; opening a session closes the previous one                                                                                               | help.twitch.tv "How Drops Work" (research 02 §3)                       |
| `tickCredit`      | A successful tick on a live, crediting channel adds `min(WATCH_INTERVAL, at − lastCreditAt)` seconds to the session (`lastCreditAt` starts at `openedAt`); every 60 s adds 1 minute | TDM `channel.py:432-487` (inference: exact accounting is lane-D E1)    |
| `channelCredits`  | Live, not refusing, right game (or special game), and either on the allow-list or drops-enabled when there is no allow-list                                                         | TDM `inventory.py:352-355, 469-476`, `utils.py:422`                    |
| `accountEarns`    | Linked, or the campaign has a badge/emote benefit                                                                                                                                   | TDM `inventory.py:394-404` (unlinked progress is lane-D E7, inference) |
| `oneCampaign`     | Among active campaigns the account earns, the channel credits and that still have an earnable drop, the newest `startsAt` wins (tiebreak by id)                                     | TDM #756 (research 02 §3)                                              |
| `dropsInCampaign` | Every earnable drop of the credited campaign progresses; a drop with an unclaimed precondition earns nothing                                                                        | TDM `inventory.py:97-105, 262-271` (concurrent progress: inference)    |
| `completion`      | At `requiredMinutes`, the drop gets an instance id `"<dropId>#i"` and a `drop-claim` frame; each credited minute sends a `drop-progress` frame                                      | TDM `twitch.py:1239-1297`                                              |
| `claimWindow`     | A claim succeeds while the drop is complete, has an instance, is unclaimed, and `now < campaign end + CLAIM_GRACE`; a second claim answers already-claimed                          | TDM `inventory.py:143-151, 200-215`; reuses core `CLAIM_GRACE` (Q6)    |
| `inventoryLag`    | Inventory shows minutes credited up to `now − inventoryLagMinutes`, the instance id once those minutes are complete, and the claimed flag 10 s after the claim                      | research 02 §3 (lag value: inference)                                  |
| `currentDrop`     | For the session channel: the lowest-id progressing drop of the credited campaign and its minutes; otherwise none                                                                    | TDM `twitch.py:996-1010` (shape unverified, as `wire.ts` says)         |

The twin also self-checks: credited seconds of a session never exceed the time it was open, and
nothing is credited or claimed after the token was revoked.

### 3.3 Twin HTTP (`http.ts`)

```ts
export interface TwinRequest { readonly at: Millis; readonly operation: Operation; readonly status: number | "timeout" }

export const twinHttp: (twin: Twin) => HttpClient.HttpClient
export const twinTwitch: (twin: Twin) => Layer<Twitch>   // Twitch.layer + twinHttp + fixed Credentials ("twin-token", "0"×32) + Journal.none
```

`Twin` is the run's mutable cell: the world, the fault schedule, the request and actuator log, and
the inbox the twin writes frames to.

- Routing works like `stub.ts`: `VALIDATE_URL` goes to validate, and a POST to `GQL_URL` is decoded
  as a batch, answered one element per entry, in order.
- Each request sleeps a latency drawn from the seeded `Random`, 100–400 ms (virtual time).
- When a fault window covers a request, the fault replaces the answer. `http-5xx` is a 503 and
  `http-429` a 429. `timeout` sleeps `TWIN_TIMEOUT` = 30 s and then fails as a transport error,
  because the client has no timeout of its own (§9). `service-error` is `[{ errors: [{ message:
  "service error" }], data: null }]`. `null-catalog` is `dropCampaigns: null`.
- After `revoke-token`, every request answers 401.

One read therefore takes at most 4 × (30 s + 0.4 s) + 2 + 4 + 8 s ≈ 136 s with its retries, and
`catalog` (two sequential GQL calls) ≈ 272 s. §4 s3 is stated against those numbers.

### 3.4 Actuator (`src/twitch/Actuator.ts`, twin in `src/twin/actuator.ts`)

```ts
export class WatchFailure extends Schema.TaggedError<…>()("WatchFailure", { reason: Literals(["offline","refused","network"]) }) {}
export type ClaimAnswer = "claimed" | "already-claimed";

export class Actuator extends Context.Service<Actuator, {
  readonly watch: (channelId: ChannelId) => Effect<void>;                 // open or switch the one session
  readonly watchTick: (channelId: ChannelId) => Effect<void, WatchFailure | AuthRejected>;
  readonly stopWatching: Effect<void>;
  readonly claim: (instanceId: DropInstanceId) => Effect<ClaimAnswer, TwitchError>;
  readonly subscribe: (channelIds: ReadonlyArray<ChannelId>) => Effect<void>; // replaces the set
}>()("miner/twitch/Actuator") {}
```

`watch`, `stopWatching` and `subscribe` take effect immediately. `watchTick` and `claim` sleep the
same seeded latency as a request. A `watchTick` for a channel that is not the open session's
(including no session) credits nothing and fails `WatchFailure{network}`; §4 #1 reports the command
that caused it. A tick on an offline channel fails `offline`, on a refusing one `refused`.

Frames reach the inbox 1 s after the world change: `StreamUp`, `StreamDown` and `GameChanged` for
subscribed channels, and `DropProgress` and `DropClaimable` for the account. Frames are dropped
during `frames-down`.

Faults on the mutation paths (a claim is the GQL mutation `ClaimDrop`; a watch tick is a CDN request,
not GQL):

| Fault                                      | `watchTick`                     | `claim`                                                 | `watch`, `stopWatching`, `subscribe` |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| `http-5xx`, `http-429` (`ClaimDrop`/`any`) | unaffected                      | fails `TwitchUnavailable` before it applies             | unaffected                           |
| `service-error` (`ClaimDrop`/`any`)        | unaffected                      | fails `TwitchUnavailable` before it applies             | unaffected                           |
| `timeout` (`any`)                          | waits 30 s, fails `network`     | waits 30 s, fails `TwitchUnavailable` before it applies | unaffected                           |
| `null-catalog`                             | unaffected                      | unaffected                                              | unaffected                           |
| `revoke-token`                             | fails `AuthRejected`, no credit | fails `AuthRejected`, not applied                       | unaffected                           |
| `lose-claim-answer`                        | unaffected                      | the next claim applies, then fails `TwitchUnavailable`  | unaffected                           |
| `frames-down`                              | credits, frames dropped         | applies, frames dropped                                 | unaffected                           |

A claim **attempt** is every call of `claim` that reaches the twin; an **applied** claim is one that
marks the drop claimed. Both are logged.

### 3.5 Executor (`execute.ts`)

```ts
export interface Memory { readonly account: Account | undefined; readonly logins: ReadonlyMap<ChannelId, string>; readonly slugs: ReadonlyMap<GameId, string> }
export const DIRECTORY_LIMIT = 30;
export const execute: (memory: Ref<Memory>, command: Command) => Effect<ReadonlyArray<Event>, never, Twitch | Actuator>
```

| Command                              | Call                                                | Events (success / failure)                                                                                         |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ValidateToken`                      | `validate`                                          | `TokenValid` / `AuthRejected` → `AuthFailed`, anything else → none (the hourly check retries, `protocol.ts`)       |
| `ReadCatalog`                        | `catalog(account)`, remembers logins/slugs          | `CatalogRead` / `AuthFailed`, or `CatalogUnavailable{reason}` for `TwitchUnavailable`/`TwitchDrift`                |
| `ReadInventory`                      | `inventory`                                         | `InventoryRead` / `AuthFailed` or none                                                                             |
| `ReadDirectory`                      | `directory(slug, 30)`, remembers logins             | `ChannelsRead` / `AuthFailed` or none                                                                              |
| `ReadChannels`                       | `streams(logins)` (ids without a login are skipped) | `ChannelsRead` / `AuthFailed` or none                                                                              |
| `ReadCurrentDrop`                    | `currentDrop`                                       | `CurrentDropRead` / `AuthFailed` or none                                                                           |
| `Watch`, `StopWatching`, `Subscribe` | `Actuator`                                          | none                                                                                                               |
| `WatchTick`                          | `watchTick`                                         | `WatchTicked` / `WatchFailed{reason}`, `AuthFailed` for `AuthRejected`                                             |
| `Claim`                              | `claim(instanceId)`, **once**                       | `ClaimResult{claimed / already-claimed}`; any error → `ClaimResult{unknown}`, plus `AuthFailed` for `AuthRejected` |

`ReadCatalog` without a known account (after a restart, before validation landed) validates first.
A defect in any command becomes a `Defect` violation. It is never turned into an event.

### 3.6 Durable state (`durable.ts`)

```ts
export const canonical: (value: unknown) => string    // keys sorted, Map/Set as sorted tagged entries, undefined as a sentinel
export const encodeState: (state: State) => string
export const decodeState: (text: string) => State
```

A stand-in until `store` lands: `store` moves this module to `src/store/` and adds a schema version
(Q5). The trace uses the same `canonical`.

### 3.7 Sim (`sim.ts`)

```ts
export interface Core { readonly step: typeof step; readonly nextDeadline: typeof nextDeadline }  // injectable, for planted-bug tests
export interface RunOptions { readonly core?: Core; readonly maxHorizonMinutes?: number }
export interface RunResult { readonly digest: string; readonly steps: number; readonly violation: Violation | undefined; readonly tail: ReadonlyArray<string> }

export const runScenario: (scenario: Scenario, options?: RunOptions) => Effect<RunResult>   // provides its own TestClock.layer() and Random.withSeed
export const runSeed: (seed: number, options?: RunOptions & { maxShrinks?: number }) => Effect<SeedResult>
export const runSeeds: (first: number, count: number, options?) => Effect<ReadonlyArray<SeedResult>>
export type SeedResult = { _tag: "Passed"; seed; digest } | { _tag: "Failed"; capsule: Capsule }
```

**Loop.** One fiber. `inbox` is ordered by `(at, seq)`.

0. `TestClock.setTime(SIM_EPOCH)`, so campaign times line up; deliver `Started` at `SIM_EPOCH`.
1. Compute the next wake-up as the minimum of: the inbox head; `max(now, nextDeadline(state))`;
   the next schedule change or campaign boundary in the world; the next fault edge; and the
   horizon (`min(scenario.horizonMinutes, options.maxHorizonMinutes)`). While an executor fiber is
   in flight, `now + 1 s` also counts, because retry sleeps are not visible from outside the fiber.
   `TestClock.adjust` moves to that time, and fibers that finish meanwhile push their events into
   the inbox with the time they finished.
2. Push frames for world changes due by `now`.
3. Take one event, either the inbox head if it is due or `Tick` when the deadline is due, and run
   `core.step`.
4. Persist the new state with `encodeState` into the durable slot.
5. Run `checkStep` and append the step to the trace.
6. Fork each command in order through `execute`.

**Crash.** Interrupt every in-flight fiber and drop the inbox, the executor `Memory`, the
subscriptions and the watch session. The world and the account stay, because Twitch does not crash.
Then load the durable slot, decode it, check the round-trip, and deliver `Started`.

- `before-persist` fires between steps 3 and 4 of the first step at or after its time, so that
  step's state and commands are lost.
- `after-persist` fires between steps 4 and 6.
- `in-claim` fires right after the next claim at or after its time is applied by the twin and before
  its answer comes back.

**Trace and digest.** Each trace entry is the `canonical` JSON string of `{ at, kind, data }`,
made at append time. The lines are folded into a 64-bit FNV-1a digest (two 32-bit lanes, pure TS).
Only the last 200 lines are kept for the capsule, so memory stays bounded.

**Seeds.** `runSeed(s)` is `fc.check(fc.asyncProperty(scenarioArbitrary, property), { seed: s,
numRuns: 1 })`. The property runs the scenario twice and fails if either run reports a violation or
the two digests differ (`Nondeterministic`). fast-check has no shrink cap, so the property counts its
calls and answers "pass" after `maxShrinks` (default 100, tests 30), which ends shrinking with the
smallest failure so far. The capsule holds the shrunk scenario, the violation, the digest of a fresh
run of the shrunk scenario, and its trace tail. `runSeeds(first, n)` runs seeds `first … first+n-1`
one after another.

### 3.8 CLI (`cli/sim.ts`)

```
miner sim [--seed <int>] [--seeds <int>] [--trace <capsule.json>] [--json]
```

| Flag      | Env fallback                                 | Default                                                                          |
| --------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `--seed`  | `MINER_SIM_SEED` (`Flag.withFallbackConfig`) | `1`                                                                              |
| `--seeds` | `MINER_SIM_SEEDS`                            | `100`                                                                            |
| `--trace` | `MINER_SIM_TRACE`                            | none. When set, decode the capsule and run its scenario twice; seeds are ignored |
| `--json`  | none                                         | off                                                                              |

Output:

- One line per failed seed, `seed 17: ClaimedTwice at +312m: c1/c1-d0`.
- Then a summary, `100 seeds, 99 passed, 1 failed`.
- For each failure, the capsule as JSON and the exact rerun command:
  `MINER_SIM_SEED=17 MINER_SIM_SEEDS=1 pnpm start sim` and `pnpm start sim --trace <file>`.
- `--trace` prints `digest matches the capsule` or `digest changed`, then the violation or `no
  violation`. It exits 0 only when the violation is gone.
- `--json` prints one document instead: `{ ok, seeds: { first, count }, passed, failures: Capsule[] }`,
  or with `--trace`: `{ ok, digest, digestMatches, violation }`.

Exit codes: 1 (`SimFailed`) on any violation, 2 (`SimTraceInvalid`) when the capsule file does not
decode, 0 otherwise. The command writes no files. A user saves a capsule by redirecting the output.

## 4. Invariants

`checkStep(checker, observation) → [checker, violations]` is pure. An `Observation` is one loop
wake-up: `{ now, event, before: State, after: State, commands, persisted, world, twin activity since
the last observation (requests, actuator calls, claim attempts and applies, credits), executor
outcomes, in-flight commands, restarted }`. Wake-ups without a step (`event` undefined) still run the
time-based checks.

| #   | Invariant                                                   | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | At most one credited watch (`TwoWatches`)                   | The twin has at most one open session and credits one channel at a time: two credits on different channels never land less than `WATCH_INTERVAL` apart. A `WatchTick(c)` command while the core's last `Watch` since the last restart or `StopWatching` was not `c` is a violation (a tick without a session).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2a  | Never claim twice (`ClaimedTwice`)                          | A claim attempt reaches the twin for a drop it has already applied as claimed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2b  | Never claim early or late (`ClaimedEarly`)                  | When the core emits `Claim`: by twin truth the drop is complete, has that instance id, and `now < campaign end + CLAIM_GRACE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | No idle time while an eligible live channel exists (`Idle`) | The oracle is the twin's own rules (§3.2), not `plan()`: an _opportunity_ exists when a discoverable channel (allow-listed for the campaign, or streaming the campaign's game) is live, not excluded by the settings, not refusing, not legitimately avoided (see `AvoidedUnfairly`), and `oneCampaign` there picks a campaign the settings allow (`games`, `badgesAndEmotes` or linked). The miner is _productive_ when the twin's session channel credits such a campaign. While an opportunity exists and the miner is not productive, an idle clock runs. Bound: `ONLINE_DELAY + 1 min` when the core already knows the channel live or was subscribed to it at its last up edge, and the campaign is in `after.catalog`; `CATALOG_INTERVAL + 2 min` otherwise (discovery is hourly, critique P0.6); `STALL_AFTER + 2 min` when the core is watching a channel it believes credits (stream info can't tell `dropsEnabled`, `wire.ts`). The clock pauses while a fault window is active, after `revoke-token`, and for 2 min after a restart; the long bound applies for `CATALOG_INTERVAL` after any fault window closes, because a failed directory or channel read is only repeated at the next catalog read. |
| 3b  | Avoid only for cause (`AvoidedUnfairly`)                    | A channel newly in `after.avoid` must refuse in the twin, or the twin must have credited nothing on it for the last `STALL_AFTER − INVENTORY_INTERVAL − inventoryLag − 2 min`, or a fault window or frames-down was active in the last `STALL_AFTER`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3c  | Idle means not watching (`IdleButWatching`)                 | When an observation starts with the core `Idle` (after its commands ran), the twin has no open session and credits nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | Mutations never retried (`MutationRetried`)                 | The executor makes at most one claim attempt per `Claim` command. Per claim key, a second `Claim` command is legal only when, since the previous one, the core has received an `InventoryRead` at or after that intent's `recheckAt` with the drop unclaimed, _and_ the twin did not apply the first claim. One applied claim per drop is 2a.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | State survives a crash (`StateLost`)                        | On every persist, `encodeState(decodeState(saved)) === saved`. At restart, the state the core resumes from is the decoded last save. No command from a `before-persist` step reaches the twin. Semantic survival (no lost or repeated claim across the crash) is covered by 2a, 2b and 4 together with `in-claim` crashes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| s1  | Parked polls nothing (`ParkedButPolling`)                   | After the core parks (`auth: needs-login`), it emits no command until the next restart, and no request or actuator call starts until then (decision 11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| s2  | No busy wake (`BusyWake`)                                   | More than 20 consecutive steps at one virtual instant is a violation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| s3  | Every failure classified (`Defect`)                         | An executor fiber ending in a defect, a single request or actuator call waiting longer than `TWIN_TIMEOUT` + 1 s, or a command in flight longer than `COMMAND_DEADLINE` = 5 min (the worst case of §3.3 is 272 s) is a violation (critique CF-5: no op waits past its deadline).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| s4  | Determinism (`Nondeterministic`)                            | The two runs of a seed produce different digests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| s5  | Bounded work (`TooManyInFlight`)                            | At most `IN_FLIGHT_LIMIT` = 4 commands of one kind in flight at once. The core keeps no in-flight record, so a read that outlives its interval may overlap the next one; a storm cannot hide under the bound.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| t   | Twin self-checks (`TwinBroken`)                             | Credited seconds of a session never exceed its open time; nothing is credited or applied after `revoke-token`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 5. Test plan

All tests use `@effect/vitest` and sit next to the code. Seed counts and horizons keep `pnpm check`
under about 15 s of added time (the PR body states the measured number). The long sweep is
`miner sim`.

- `scenario.test.ts`: generated scenarios decode with the Schema; a capsule round-trips.
- `world.test.ts`: one case per rule in §3.2.
  - Credit only on the session channel; switching closes the old session.
  - Credit follows elapsed time: two ticks 1 s apart credit 21 s, not 40 s.
  - Newest campaign wins on a shared stream.
  - A precondition blocks credit until it is claimed.
  - The special game credits on any game.
  - An unlinked item-only campaign earns nothing.
  - Completion gives the instance id and a `drop-claim` frame; `currentDrop` names the drop.
  - The claim window closes at end + 24 h; a second claim answers already-claimed.
  - Inventory lags by `inventoryLagMinutes`; the claimed flag shows 10 s after the claim.
- `http.test.ts`: the real `Twitch` over `twinTwitch`.
  - The world's campaigns come back from `catalog`, equal after `toCampaign`, which shows the
    encoding is conformant.
  - Inventory, directory, streams and currentDrop decode.
  - A 5xx window shorter than 14 s is absorbed by retries.
  - A longer window gives `TwitchUnavailable`.
  - `null-catalog` gives `TwitchDrift`.
  - A revoked token gives `AuthRejected` with no retry.
  - `service-error` on Inventory is retried.
  - A timeout window costs one read its retries and stays within §3.3's bound.
- `actuator.test.ts`: session switching, a tick with no session, each row of the §3.4 fault table.
- `execute.test.ts`: every row of the §3.5 table.
  - A claim during a 5xx window is one attempt, none applied, and `ClaimResult{unknown}`.
  - `lose-claim-answer` gives `unknown` while the twin holds the drop as claimed.
- `durable.test.ts`: a `State` with progress, channels, avoid, a `Watching` watch, claims in both
  statuses, online deadlines, `auth: "needs-login"`, `catalogStatus` and `deadlines.tick: undefined`
  round-trips, and encoding is canonical (insertion order doesn't change it).
- `invariants.test.ts`: for each violation, a short hand-built observation list that triggers it,
  and one that is legal near the boundary. Examples: a switch 20 s apart is legal; a resend after a
  settling inventory read is legal; idle just under the bound is legal.
- `sim.test.ts`:
  - Seeds 1–20 pass, with `maxHorizonMinutes: 360`.
  - Each passing seed's digest is stable across two `runSeed` calls.
  - Fixed scenarios cover each fault kind (timeout included, against s3's bound), each crash point,
    a delayed tick, and pass.
  - §7's regression: a scenario with an `in-claim` crash passes (it failed `BusyWake` before the fix).
  - Planted bugs are caught and shrunk, through `Core` injection: (a) a `step` wrapper that
    re-emits every `Claim` on the next event gives `MutationRetried` or `ClaimedTwice`; (b) one that
    drops `Watch` commands gives `TwoWatches` (ticks without a session); (c) a `Started` that forgets
    intents gives `ClaimedTwice` across an `in-claim` crash. For each, `shrunkInput` has no more
    campaigns, channels and faults than the initial input.
  - Running a capsule gives the same digest as the failure that produced it.
- `cli/sim.test.ts`: on a `TestConsole`:
  - `sim --seed 1 --seeds 2` prints the summary and succeeds.
  - `MINER_SIM_SEEDS=1` through a `ConfigProvider` is honoured.
  - A failing capsule fails with `SimFailed`; a passing one prints `digest matches the capsule`.
  - A malformed capsule file fails with `SimTraceInvalid`.
  - `--json` prints one document.

Gate: `pnpm check` and `pnpm build`, then `pnpm start sim --seeds 200` exits 0. The PR body reports
that run's output and timing, and the bundle size before and after (`ls -l dist/bin.mjs`: 1,306,126
bytes on `dev` before this PR).

## 6. Out of scope

- Wire-level HLS (usher, m3u8, segment `HEAD`s) and the PubSub socket protocol (frames, PING,
  `RECONNECT`, topic budget). Watch, claim and subscriptions stay typed through `Actuator` until the
  live actuator exists (milestone 3). See §1.4 and Q2.
- Recorder → twin conformance (replaying journals through the credit model, decision 5). It needs
  lane-B recordings of watching, which need the live actuator: it lands with milestone 3. Wire
  conformance is already covered: `src/twitch/Twitch.test.ts` decodes the recorded answers in
  `src/twitch/fixtures/`, and `http.test.ts` decodes the twin's answers through the same Schemas.
  Keyed or strict replay and `miner replay` come with it.
- Classed request budgets and rate invariants (critique CF-5 fix), and the per-IP limits (research
  04 §6.2b: "the twin enforces the same limits"). The core has no budget yet, so a rate invariant
  would only measure the absence of one; it lands with the runtime's budgets (milestone 2), and the
  twin then answers 429 above ~5 GQL requests per second.
- Shape-drift faults made by mutating encoded bytes (critique S7).
- Channel points, `priorities` goals, `streams.max = 2`, raids and streaks (decision 28). The core
  `Settings` doesn't model them yet. Mapping `config.json` to `Settings`.
- The runtime, `miner run`, `src/platform/`, `store`, `status --json`.
- A heap bound or week-long soak, chronos-style runtime entropy traps (the lint covers it),
  `docs/simulation.md` (AGENTS.md carries the how-to).

## 7. Known first finding

A probe against `step`/`nextDeadline` on 2026-10-30 found that a claim intent with `recheckAt <= now`
makes `nextDeadline` return a past time (`src/core/state.ts`, the `claims` term). Every `Tick` then
re-issues `ReadInventory` (`src/core/step.ts`, `tick`'s `recheck` branch) without moving that deadline.
A runtime would spin until the read lands, and forever if the read fails or the drop is missing from
inventory, because the intent is never settled. `Started` sets `recheckAt: now` for every intent, so
any restart with a claim in flight reproduces it, and invariant s2 catches it on an `in-claim` crash.

**Fix (no new `State` field).** A recheck is an inventory read, so it uses the inventory deadline:

- `ClaimResult{unknown}` sets `deadlines.inventory = min(deadlines.inventory, now + CLAIM_RECHECK)`.
- `Started` needs nothing more: `TokenValid` already issues `ReadInventory`, and that read lands
  after `recheckAt = now`.
- `nextDeadline` drops the `claims` term, and `tick` drops the `recheck` branch: the inventory branch
  issues the read and moves the deadline 5 min on, so a failed read is retried at the next inventory
  read, which also settles the intent (`InventoryRead`'s rule is unchanged).

Regression tests in `step.test.ts`: after `Started` + `TokenValid` with an intent, `nextDeadline` is
not in the past; a lost answer is rechecked at `+CLAIM_RECHECK` by the inventory read. In
`sim.test.ts`: a fixed `in-claim` crash scenario passes.

## 8. Settled questions

1. **fast-check or `effect/Arbitrary`?** fast-check, as decision 12 says (supervisor, 2026-10-30).
   It is a dev dependency, but `pack` bundles everything, so it ships inside `dist/bin.mjs` for
   `miner sim`; the PR body states the size before and after. `effect/Arbitrary` is unstable and
   would have needed an amendment of decision 12.
2. **Is a typed `Actuator` an acceptable reading of decision 12 ("wire level")?** Reads are wire
   level. Watch, claim and PubSub have no live client to share Schemas with yet, so they are typed
   now (§1.4) and become wire level when their live client lands. The interface lives in
   `src/twitch/Actuator.ts` from the start, so the runtime imports its mutation seam from the Twitch
   seam, not from the simulator.
3. **`MINER_SIM_TRACE`: inline JSON or a file?** A path to a capsule file, because capsules hold a
   whole scenario and that is too long for a shell variable.
4. **Core fixes inside this PR?** Yes, for bugs the sim finds that block `pnpm check`, starting with
   §7. Each fix is the smallest change, comes with a `step.test.ts` regression, and is listed in the
   PR body. A fix that needs a new `State` field is raised with the supervisor first.
5. **Where does the `State` codec live?** `src/twin/durable.ts` for now; `store` moves it to
   `src/store/` and adds a schema version when it lands.
6. **Should the twin reuse core `CLAIM_GRACE` and `SPECIAL_GAMES`?** Yes, because both carry the same
   single source, and `world.ts` notes that the twin and core are only as right as that source. Lane
   D settles the claim window.
7. **Claimed-flag lag in inventory.** 10 s, per the core's "seconds" comment. A lag longer than
   `CLAIM_RECHECK` (1 min) would make the core resend a claim that succeeded; generating longer lags
   is a follow-up once lane B measures it.
8. **Default seed count for `miner sim`.** Seeds 1–100. `pnpm check` runs 20, with 6 h horizons.

## 9. Risks

- No request timeout: `Twitch.ts` sets none, so a real hang would hang the runtime. The twin only
  models a timeout as a transport failure after 30 s, and s3 reports any request that waits longer.
- Polling while fibers are in flight costs CPU: the loop advances 1 s at a time. Retries are short,
  but if 100 seeds take minutes, move to a deadline hint from the twin.
- fast-check's generation can change across its releases; that's why the capsule stores the
  scenario itself, and a seed is only reproducible on the same fast-check version.
- The idle bound has a second tier of one hour. It catches a miner that never watches, not one that
  is slow to discover new channels. Tightening it needs periodic directory reads in the core, which
  is a core design change and not this PR.
