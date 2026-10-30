# miner — design proposal v0

Status: draft for critique, 2026-10-29. Sources: `docs/research/01`–`06`, `docs/decisions.md`.

## Goals (from teyd)

- Mine Twitch drops headlessly, as TDM does: game drops on linked campaigns, plus badge and emote
  campaigns. Claim them as soon as they complete.
- Claim channel points on the channel being watched (bonus chest).
- Run unattended on a homelab for other people, ≤ 90 MB RSS while watching.
- Find bugs without serialised live runs: a deterministic simulator, recordings and replay.

## Non-goals for v1

- Favourite channels, watch streaks, predictions, raids (decisions 17).
- More than one account per process (decisions 8).
- Notifications, webhooks, MQTT, web UI (decisions 15).
- Reward campaigns / quests (research 02 §6).
- Automated login. A human gets the token in a browser (decisions 4).

## Constraints

- Twitch's private API: GQL persisted queries, usher/HLS, PubSub edge, `oauth2/validate`.
  Breaks about monthly (research 02 §7).
- Drops credit one channel at a time per account. The limits (~10 websockets, ~5 GQL req/s) are per IP.
- The campaign catalog can come back as `null` with no error (research 02 §2).

## Architecture

```
cli        login · run · status --json · doctor · sim · replay
runtime    one Effect fiber per concern; executes Commands, feeds Events
core       pure: (State, Event, now) → (State, Command[])
twitch     Twitch service: typed ops over the wire
             Live | Twin (simulator) | Recording(Live) | Replay(journal)
store      state.json (atomic) · token file (0600) · journal (gzip JSONL, rolling)
```

### 1. Core

- One reducer. `State` is a discriminated union: `Starting | Planning | Watching | Idle | Parked`.
  `Watching` holds the channel, campaign, drop and last-credit time.
- `Event`: `Tick`, `CatalogRead`, `InventoryRead`, `StreamInfo`, `WatchResult`, `ClaimResult`,
  `PubSubMessage`, `AuthFailed`, `Error`.
- `Command`: `ReadCatalog`, `ReadInventory`, `ReadStream`, `WatchTick`, `ClaimDrop`,
  `ClaimPoints`, `ValidateToken`, `Park`.
- Planner: eligible campaigns (linked, or badge/emote; active; not finished) ordered by user game
  priority, then end time. Channels: allowed or directory with `DROPS_ENABLED`, live, right game,
  not excluded, most viewers first.

### 2. Runtime

- Timers: watch tick every 20 s, inventory every 60 s and on any drop event, rescan hourly,
  token validation hourly. All through `Clock`.
- The PubSub socket is one fiber. It turns frames into `Event`s and reconnects with backoff.
- Reads retry with backoff. Claims never retry; a lost claim answer triggers an inventory read.
  `401` → `Parked` with `needs_login`, polling nothing.

### 3. Twitch seam

- Ops: `catalog`, `campaignDetails`, `inventory`, `streamInfo`, `gameDirectory`,
  `playbackToken`, `watch` (usher → lowest playlist → `HEAD` each segment), `claimDrop`,
  `claimPoints`, `validate`, `pubsub`.
- Every response is Schema-decoded at the seam. Constants (hashes, client ID, user agent) live in
  one module with a verified date.
- A per-IP request budget (token bucket) sits inside the seam, so the twin enforces it too.

### 4. Simulator (twin)

- Answers the same HTTP and WebSocket requests from an in-memory world: campaigns, channels with
  live schedules, account inventory, and credit rules from research 05. Wire JSON is built with
  the same Schemas.
- Faults: 5xx, 429, timeouts, socket drops, `RECONNECT`, `null` catalog, revoked token, crash and restart.
- Invariants after each step: at most one credited watch, never claim twice or early, no idle
  time while an eligible live channel exists, mutations never retried, state survives a crash.
- `MINER_SIM_SEED`, `MINER_SIM_SEEDS`, `MINER_SIM_TRACE`. fast-check shrinks failures. Each seed
  runs twice and the trace digests must match.

### 5. Recorder and replay

- Records every request, response and frame at the seam, redacted, into a rolling journal.
- `miner replay <journal>`: strict mode (same order) or keyed mode (by op and variables, latest at
  time t). Recordings calibrate the twin.

### 6. Store and config

- One config file (games priority, excluded channels, badges/emotes on/off) plus a token file
  written by `miner login`, both in a data directory outside the checkout.

## Milestones

0. Scaffold, `pnpm check`, the entropy lint, vendored `repos/`.
1. Core reducer + twin + `miner sim` (no live Twitch at all).
2. Live read-only ops + recorder + `doctor` (a shadow run on a test account).
3. Watching + claims on a test account. Prototype experiments E1, E6, E7.
4. Points on the watched channel. Bundle + RAM measurement.

## What we reuse vs build

- Reuse: Effect (`effect/http`, `effect/socket`, `TestClock`, `Random`, Schema), fast-check,
  pino (replaced by Effect `Logger`, decision 29), `node:sqlite` only if needed. TDM (MIT) as the behaviour reference.
- Build: the Twitch seam, the twin, the reducer, the recorder and replay, the CLI.

## Open questions

1. Is one reducer plus a few fibers simpler than a few independent tasks with shared state?
2. Is a wire-level twin worth its cost over a typed-level twin?
3. How does the miner know Twitch is actually crediting, when inventory lags and no event names
   the drop?
4. Should PubSub be required or optional, given the 60 s inventory poll?
5. JSON state file vs SQLite for state and journal.
6. What happens on campaign end, game change and stream offline when they arrive mid-tick?
