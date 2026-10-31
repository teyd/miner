# Research 03 — Stack versions and RAM budget

_Researched 2026-10-29. Versions are from the npm registry and `nodejs/Release/schedule.json`
on that date. RAM figures were measured on this machine (Linux 6.8, x64, Node 26.13.0)._

## TL;DR

- Every requested version exists and fits together: **Node 26.13.0 (LTS "Lithium" since
  2026-10-28)**, **Effect 4.1.0 (published 2026-10-29, today)**, **TypeScript 7.0.2**,
  **Vite+ 1.4.0**, **pnpm 12.16.1**, **drizzle-orm 1.0.0-rc.5**. pino 10.4.0 was checked too, but
  logging uses Effect's `Logger` instead (decision 29, §2b).
- **No native addons are needed.** `@effect/sql-sqlite-node@4.1.0` and drizzle's
  `effect-sqlite-node` / `node-sqlite` drivers sit on Node's built-in `node:sqlite`.
- **RAM: bundling is the big lever.** Effect + HTTP + pino + `node:sqlite`, idle:
  **104 MB RSS unbundled → 66 MB as a tree-shaken bundle** (heap 19 → 7 MB). Bare Node is 47 MB.
  So the image should ship one bundled file, not `node_modules`.
- **The running miner: 130 MB RSS → 83 MB** (systemd) or 88 MB (Docker), measured on the twin
  over TLS (§2c, 2026-10-31). The heap held no leak and little data: V8's compilers, the
  bundle's source as UTF-16 and glibc keeping parse memory were the difference. A simulated week
  keeps the heap flat (`miner sim --heap`).
- **Decided: Effect 4.1.0** (teyd, 2026-10-29). Release post dated 2026-10-20, npm `latest`
  published 2026-10-29. What changed and what it means for us is in §1b. `@effect/sql-drizzle` is
  stale (0.51, v3 era). If we want drizzle, use drizzle's own `drizzle-orm/effect-sqlite-node`.

## 1. Versions (verified 2026-10-29)

| Package                 | Version                     | Notes                                                                                                                                                                              |
| ----------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node                    | **26.13.0** (2026-10-28)    | v26: LTS 2026-10-28 → maintenance 2027-10-20 → EOL 2029-04-30. v24 went to maintenance 2026-10-20                                                                                  |
| pnpm                    | **12.16.1**                 | `devEngines.packageManager` / `devEngines.runtime` can pin pnpm and Node per repo                                                                                                  |
| effect                  | **4.1.0** (2026-10-29)      | 4.0.7 was 2026-10-28. One package now: `effect/http`, `effect/sql`, `effect/socket`, `effect/cli`, `effect/testing`, `effect/persistence`, `effect/workflow`, `effect/eventlog`, … |
| @effect/platform-node   | 4.1.0                       | Node runtime, `NodeRuntime.runMain`                                                                                                                                                |
| @effect/vitest          | 4.1.0                       | `it.effect`, `TestClock`                                                                                                                                                           |
| @effect/sql-sqlite-node | 4.1.0                       | peer `effect ^4.1.0`. Uses `node:sqlite`                                                                                                                                           |
| @effect/tsgo            | 0.63.0                      | Effect language-service rules for tsgo/oxlint. (unverified) how it plugs into Vite+ 1.4's oxlint, which needs checking before we rely on it                                        |
| typescript              | **7.0.2**                   | 7.1.0-beta available                                                                                                                                                               |
| vite-plus               | **1.4.0**                   | ships vitest 5.0.5, oxlint 1.89.0, oxfmt 0.74.0, oxlint-tsgolint 7.0.2004, Rolldown-based vite core                                                                                |
| drizzle-orm             | **1.0.0-rc.5** (2026-10-21) | has `effect-sqlite-node`, `node-sqlite`, `effect-schema`. Peers `effect >=4.0.0`, `@effect/sql-sqlite-node >=4.0.0`                                                                |
| @effect/sql-drizzle     | 0.51.0                      | **stale, don't use**                                                                                                                                                               |
| pino                    | 10.4.0                      | **not used**: Effect `Logger` instead (decision 29)                                                                                                                                |
| fast-check              | 4.10.2                      | `fc.commands`, `fc.modelRun`/`asyncModelRun`/`scheduledModelRun`, `fc.scheduler`, all with shrinking                                                                               |
| @types/node             | 26.6.6                      |                                                                                                                                                                                    |

## 1b. Effect 4.1: what changed that touches us

From the release post (effect.website/blog/releases/effect/41):

| Change                                                                                                                                                                                                                  | Impact on this project                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New `effect/crypto` (`SecureRandom`, `Digest`, …) replaces `effect/Crypto`. **Not in the default runtime services**, so provide `NodeCrypto.layer` explicitly. `effect/testing/TestCrypto` is removed; use `Layer.mock` | Trace digests for the simulator's determinism check use `Digest`. The simulator mocks `SecureRandom` with a seeded `Layer.mock`. Seeded game logic uses `Random` (`Random.withSeed`) |
| Node stream/socket pulls are bounded by `chunkSize` (default 4096). Use `readSize` for byte reads                                                                                                                       | Affects the PubSub websocket and HTTP body reads. Test large frames                                                                                                                  |
| `FetchHttpClient` fails with `EncodeError` on runtimes without streaming request bodies unless `StreamBodyFallback = "buffer"`                                                                                          | Node 26 supports streaming bodies (inference). We only send small JSON bodies anyway                                                                                                 |
| `HttpClient.withCookiesRef` takes a `Ref<ReadonlyArray<Cookie>>` and matches host, path and scheme                                                                                                                      | Only matters if we keep cookies (we don't plan to)                                                                                                                                   |
| `Migrator.fromFileSystem` moved to `effect/sql/MigratorFileSystem`. `sql.insert` needs non-empty rows                                                                                                                   | Only if we adopt `effect/sql`                                                                                                                                                        |
| `Duration.fromIso`/`formatIso`, `Schema.DurationFromIsoString`                                                                                                                                                          | Config durations ("PT20S") if we want ISO in config                                                                                                                                  |
| `Match.literals` / `literalsExhaustive`                                                                                                                                                                                 | Exhaustive handling of Twitch enums (benefit types, PubSub message types)                                                                                                            |
| `Effect.ignore({ log: "Unhandled" })`, `UnhandledLogLevel`                                                                                                                                                              | Makes "ignored on purpose" visible in logs                                                                                                                                           |
| CLI help formatters read `HelpDoc.inheritedFlags`                                                                                                                                                                       | Only for custom help formatting                                                                                                                                                      |
| `ChildProcess` accepts `Redacted` args/env                                                                                                                                                                              | Not needed (no child processes planned)                                                                                                                                              |

## 2. RAM measurements

Idle process after 1.5 s, forced GC, Node 26.13.0:

| Setup                                                             | RSS         | heapUsed   |
| ----------------------------------------------------------------- | ----------- | ---------- |
| bare `node`                                                       | 47.3 MB     | 3.8 MB     |
| `import 'effect'` + `effect/http`, unbundled                      | 99.7 MB     | 18.2 MB    |
| + pino + `node:sqlite` (`:memory:`), unbundled                    | 103.9 MB    | 19.2 MB    |
| same, `--jitless --max-semi-space-size=1 --max-old-space-size=64` | 67.6 MB     | 18.6 MB    |
| **same app, esbuild tree-shaken ESM bundle (393 KB)**             | **66.4 MB** | **7.3 MB** |
| bundle + `--max-semi-space-size=1 --max-old-space-size=48`        | 63.3 MB     | 7.3 MB     |
| bundle + `--jitless --max-semi-space-size=1`                      | 59.7 MB     | 7.0 MB     |

(inference) A realistic target for an idle-to-watching miner is **≤ 90 MB RSS** with a bundle,
and the steady state should be flat over days. Rules that follow:

- Ship a single bundled entry (`vp build` / Rolldown, `platform: node`). No `node_modules`
  in the runtime image beyond what can't be bundled.
- **No logging worker threads** (pino transports run in a `thread-stream` worker, a second V8
  isolate). Logging is Effect's `Logger`, written synchronously in-process (§2b).
- Never download video: `HEAD` segments only (see 02 §4). Don't hold the whole catalog
  JSON, only the decoded fields we use.
- `--jitless` saves ~5 MB more but costs CPU and is (unverified) untested with Effect at
  scale. Measure before adopting. `--max-old-space-size` mostly caps growth and doesn't cut the
  baseline.
- A "RAM budget" test: run a simulated week (see 04) and assert heap after GC stays under
  a bound. Leaks show up as unbounded fibers, maps or caches, which the sim catches without waiting a week.

## 2b. Logging (updated 2026-10-30, decision 29)

The RAM rows above include pino; the miner doesn't ship it. Logging is Effect 4.1's `Logger` in
`src/platform/logging.ts`, so log calls stay `Effect.log*` with `Effect.annotateLogs` and
`Effect.withLogSpan` (pino's child bindings and timers), timestamps come from `Clock` (so the
simulator's logs replay under `TestClock`), and there's no extra dependency.

- **stderr, not stdout.** stdout is command output (`doctor --json`, `config schema`).
- **Dev/prod is one switch, `LOG_FORMAT`.** Unset: `pretty` when stderr is a terminal, `json`
  (one flat object per line, annotations as top-level keys, like pino) otherwise. `LOG_LEVEL`
  sets the minimum level (default `Info`).
- **Redaction** (pino's `redact`) is the journal's `redact` applied to every entry: message,
  annotations, extra data and the pretty-printed cause.
- **Rotation in-process.** Docker and journald rotate stderr, but the single binary and npx
  installs (decision 18) have nobody to do it. So a JSON copy goes to `$DATA_DIR/logs/miner.log`,
  rotated at 10 MiB with 5 old files kept (≤ 60 MB on disk). It's batched (1 s window,
  `Logger.batched`), created on the first log line, and a failed write is dropped, never fatal.
  `LOG_FILE=false` turns it off where a log driver already keeps stderr. Effect's own
  `Logger.toFile` doesn't rotate, which is why this is ours. No gzip: 60 MB doesn't need it.

## 2c. The running miner: 130 MB to 83 MB (measured 2026-10-31, roadmap C2)

The 4 h live run of 2026-10-29 (roadmap A0) sat at 126–131 MB RSS, flat, against the ≤ 90 MB
target above. Flat means no leak: the memory was a baseline, so C2 measured where it goes.

**Method.** The bundle (`dist/bin.mjs`, unmodified) runs `miner run` against the twin served over
real localhost sockets, HTTPS and WSS with a self-signed certificate, so TLS costs what it costs
live. Simulated time runs 10× real, in both processes. The twin plays `weekScenario` of
`src/twin/heap.ts`: watching, a claim every few hours, 80 channels over several PubSub sockets,
14 directory reads per catalog read. Two preloads route `fetch` and `WebSocket` to the twin and
sample `process.memoryUsage()` and `/proc/self/smaps_rollup` every 20 s, without forcing a
collection. The figures are the mean of the last three samples of 5-minute runs (50 simulated
minutes), two runs each, on Linux 6.8 x64. Runs of the same setup agree within 2 MB. The scripts
are in [03-rss-harness.md](03-rss-harness.md). The harness reproduces the live figure:
129.6 MB before any change.

**Where 130 MB went** (glibc, before):

| Part                                                                 | MB  |
| -------------------------------------------------------------------- | --- |
| `node` binary pages (code and ICU/OpenSSL tables), file-backed       | 62  |
| V8 heap (`heapTotal`; 23 used)                                       | 30  |
| glibc's heap: 11 MB of it is memory V8 parsed the bundle with, freed | 18  |
| external: the bundle's source, kept as UTF-16                        | 7.6 |
| thread stacks, V8's own pages and the rest                           | 12  |

A heap snapshot of the running miner (26 MB) has no data structure worth mentioning. The 2.2 MB
bundle's source is 4.4 MB of it: one `—` in a doc comment made V8 store all of it two bytes a
character. Bytecode, baseline code and feedback are 9.8 MB. All JavaScript objects, arrays,
closures and maps (the state, the decoded catalog, fibers, layers, Node's own) are about 5 MB.

The data the miner holds is small even at the live catalog's size. The twin's week has 18
campaigns; live had 123 (research 02, 2026-10-29), so `subsystems.ts` of the harness measures
each holder at that size, as retained heap after a forced collection:

| Held by                                                                       | Retained    |
| ----------------------------------------------------------------------------- | ----------- |
| `State.catalog`: 123 campaigns as core types (only the fields the core reads) | 0.31 MB     |
| `run.ts`'s `saved`, the canonical durable state it compares before a save     | 0.12 MB     |
| the journal's remembered parts, at their cap (16,384 ids of 16 characters)    | 0.99 MB max |
| 80 PubSub topics, the device id (32 characters)                               | < 0.01 MB   |
| `status.json`, written each change and every 30 s, not kept                   | 0           |

A catalog read's answers (0.5 MB parsed, 0.34 MB decoded) are garbage once `toCampaign` has
taken the fields the core uses: `State` never held the wire's catalog. The state is encoded
only when what a restart keeps changed (`durableChanged` in `src/runtime/run.ts`), not every step. The journal
remembered 8 parts in the harness's 50 minutes. Nothing here was worth a change; the simulated
week (below) finds no growth either. Effect's runtime and layers are part of the 5 MB of objects.

**Fixes**, in the order they matter:

1. **V8 flags** (`LEAN_V8_FLAGS` in `src/platform/memory.ts`): `--optimize-for-size --no-opt
   --no-maglev --no-sparkplug`, only V8's interpreter, and the heap sized for memory over speed.
   The compilers' code is gone from the heap, and their pages of the `node` binary are never
   read. `run` sets them itself; the Dockerfile and the systemd unit also give them to `node`,
   which saves 3 MB more from its start. CPU: 0.55 % of a core instead of 0.43 % on the same
   run (measured at 10×, 300 s). `--jitless` would save more, but it removes WebAssembly, and
   `fetch` (undici) parses HTTP with it: the miner then hung without a request or a log line.
2. **`MALLOC_MMAP_THRESHOLD_=16384`** on glibc (the systemd unit). V8 parses the bundle in 11 MB
   of 32 kB blocks and frees them, but glibc keeps freed memory below its top. Above the
   threshold, blocks are `mmap`ped and go back on free. musl (the Alpine image) returns it
   already. `jemalloc` (`LD_PRELOAD`) was worse.
3. **A minified ASCII bundle** (`vite.config.ts`): 0.79 MB instead of 2.2 MB, stored one byte
   a character, and less to parse at start. Names are kept, for stack traces.
4. **No ICU collation**: `localeCompare` sorted ids in the core and the twin. Its first call loads
   ICU's collation data (2 MB of the binary's pages), and it orders by the host's locale. Ids
   and names now sort by code unit (`compareText` in `src/core/plan.ts`).

**Results** (MB RSS, steady, while watching; heap snapshot 26 → 18 MB):

| How it runs                                      | Before | After | Anon | File | Heap used |
| ------------------------------------------------ | ------ | ----- | ---- | ---- | --------- |
| systemd unit (glibc, flags and env)              | 130    | 83    | 28   | 55   | 14        |
| Docker image (Alpine, musl, flags)               | 115    | 88    | 28   | 60   | 14        |
| plain `node dist/bin.mjs run`, `pnpm dev`, glibc | 130    | 100   | 43   | 57   | 15        |
| the same with `MALLOC_MMAP_THRESHOLD_=16384`     | 112    | 87    | 29   | 57   | 15        |

Re-measured on dev `3285768` (with config reload and the verify tooling), four runs at once:
129.6 → 82.7 MB as the unit runs it, 98.1 MB plain, and 110.9 MB for the old bundle with only
`MALLOC_MMAP_THRESHOLD_` (heap used 22.7 → 13.6 MB).

The file-backed pages are the `node` binary's, shared with any other node process and dropped
first under memory pressure. They are a third of the binary: little more is left to cut without
a custom Node build.

**What didn't help:** `--max-semi-space-size=1` (− 1 MB once the rest was in),
`--v8-pool-size=1`, `MALLOC_ARENA_MAX=2`, `--single-threaded` (+ 20 MB: no concurrent marking,
the heap grows), `--managed-zone-memory` (most of the env's gain as a flag, but an obscure
one), and `node:https` with `ws` instead of `fetch` and undici: − 6 MB of binary pages, + 6 MB
of heap and buffers, and a transport change nobody has run against Twitch.

**The simulated week** (`src/twin/heap.ts`, `miner sim --heap`, `heap.test.ts`): `weekScenario`
for 10,080 simulated minutes, the miner's own services over the twin's wire, with a PubSub
`RECONNECT` every day, API errors, lost frames, an edge outage, stalled playlists and a crash on
day 3; the heap sampled after a forced collection every 6 simulated hours. It credits 7,680
minutes and claims all 12 drops. On the bundle the heap (twin included) stays at 15.4–16.1 MB
used (15.0–16.1 MB in a second run, RSS 171–203 MB with the twin's bursts), 0.3–0.4 MB above
the first day's at the end; under the test runner 37–38 MB used, 0.4 MB of growth
(`pnpm exec vp test src/twin/heap.test.ts --silent=false` prints the series). The bound is 6 MB
of growth after the first day (a leak of 1 KB a simulated minute is 9 MB) and 128 MB used; a
planted leak of 1 KB a request fails it. A week takes 60 s.

## 3. Persistence: do we need SQL at all?

| Need                                                        | Smallest thing that works                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| claimed / handled drops, refused channels, last token check | a small JSON state file, written atomically (tmp + rename) |
| history ("what did I earn this month")                      | SQLite via `node:sqlite`                                   |
| flight-recorder journal (see 04)                            | append-only JSONL (rotated, gzip) **or** a SQLite table    |

Options for the SQLite layer: `effect/sql` + `@effect/sql-sqlite-node` (Effect-native, no
ORM, has `Migrator`), or drizzle 1.0 rc on top of it (typed schema + drizzle-kit migrations,
one more dependency, still rc). (inference) Start with a JSON state file. Add SQLite only
when history or a journal needs queries.

## 4. Container (measured 2026-10-30)

`Dockerfile`: build on `$BUILDPLATFORM` (the bundle is plain JavaScript), run on
`node:26.13.0-alpine` as uid 1000 with `/data` as the volume. Sizes on amd64, disk / download:

| Runtime base                                       | Image          | Note                                    |
| -------------------------------------------------- | -------------- | --------------------------------------- |
| `node:26.13.0-alpine` + bundle (chosen)            | 254 MB / 63 MB | official tag, has a shell for debugging |
| `gcr.io/distroless/nodejs26-debian13` (base only)  | 243 MB / 60 MB | no shell, floating tag, uid 65532       |
| `alpine:3.24.3` + node binary copied + `libstdc++` | 216 MB / 56 MB | two pins that must move together        |

The node binary alone is 139 MB, so no base gets far below 200 MB. The 8 MB download saved by
copying the binary is not worth keeping the Alpine and Node versions in step by hand.
The runtime stage has no `RUN`, so `docker buildx build --platform linux/arm64` builds on an amd64
host without QEMU (checked; not run on arm64). Node as PID 1 is fine: `NodeRuntime.runMain`
interrupts on SIGINT and SIGTERM. `docker stop` ended `miner run` (no network, so before any
Twitch answer) in 0.08 s with exit 130 and removed `miner.lock`.

## 5. Scaffold (verified 2026-10-29)

Sources: viteplus.dev `llms-full.txt` (Vite+ 1.4.0), pnpm.io (12.0 release post, "What's different in
pnpm 12", settings reference), Effect `LLMS.md` and `ai-docs/`, the `@effect/tsgo` 0.63.0 README and
oxlint presets. Every point below was checked by running it in this repo.

| Topic                       | What the docs say                                                                                                                                                                                                                                           | What we did                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite+ without a global CLI  | `vite-plus` as a devDependency. Pin `vite` to `@voidzero-dev/vite-plus-core` and `vitest` to the bundled version through overrides, or plugins get a second copy                                                                                            | `overrides` in `pnpm-workspace.yaml`: `vite@*` → core 1.4.0, `vitest@*` → 5.0.5. `vp toolchain` is not needed                                                                                 |
| Config                      | Everything in `vite.config.ts` (`lint`, `fmt`, `test`, `pack`). No `.oxlintrc.json`, `vitest.config.ts` or `tsdown.config.ts`                                                                                                                               | One `vite.config.ts`                                                                                                                                                                          |
| Type checking               | `lint.options.typeAware` + `typeCheck` make `vp check` the only static check (tsgolint on TS 7)                                                                                                                                                             | Both on. No separate `tsc` step                                                                                                                                                               |
| Built-ins vs scripts        | `vp check`/`vp test` are built-ins and `vp run <name>` runs a script                                                                                                                                                                                        | `pnpm check` = `vp check && vp test`. CI runs `vp run check`                                                                                                                                  |
| Node CLI bundle             | `vp pack` (tsdown) builds standalone artifacts. `vp build` is for web apps                                                                                                                                                                                  | `pack` with `platform: node`, `deps.alwaysBundle: [/./]`: one 963 KB `dist/bin.mjs`, 65 MB peak RSS for `--version`                                                                           |
| Single executable           | `pack.exe: true` uses Node SEA, Node ≥ 25.7                                                                                                                                                                                                                 | Not used yet. It's the path to the "binary" distribution later                                                                                                                                |
| CI                          | `voidzero-dev/setup-vp` at an exact version (not `@v1`), reads Node from `devEngines.runtime` and installs                                                                                                                                                  | `setup-vp@v1.22.0`, `cache: true`                                                                                                                                                             |
| pnpm 12                     | Rust rewrite, same lockfile format. Unknown `pnpm-workspace.yaml` keys are an error when the pin matches. `minimumReleaseAge` defaults to 1440 min. `strictDepBuilds` defaults to true                                                                      | pnpm wrote `minimumReleaseAgeExclude` entries for effect 4.1.0 and friends (under a day old). `minimumReleaseAgeExcludePrune: true` removes them once they age                                |
| Runtime pinning             | `devEngines.runtime` with `onFail: download`. pnpm then runs scripts on that Node                                                                                                                                                                           | On a machine with Node 24 on PATH, `pnpm exec node -v` prints 26.13.0. npm refuses the project (`EBADDEVENGINES`), which is intended                                                          |
| Vite+ vs pnpm managing Node | Vite+ suggests `runtimeOnFail: ignore` + `pmOnFail: ignore` when Vite+'s global CLI manages Node and pnpm                                                                                                                                                   | Not set: locally pnpm manages both, and in CI setup-vp resolves the same exact pins, so they never disagree                                                                                   |
| Peers                       | `vite` is aliased, so vitest's `vite` peer range never matches                                                                                                                                                                                              | `peerDependencyRules.allowAny: [vite]`; `pnpm peers check` is clean                                                                                                                           |
| Effect lint                 | `@effect/tsgo` patches oxlint (`effect-tsgo patch --no-typescript --oxlint` in `prepare`). It supports exact oxlint 1.88–1.90 and tsgolint 7.0.2004/2005; Vite+ 1.4.0 ships 1.89.0 and 7.0.2004                                                             | Patched. The patch replaces the files (link count 1), so pnpm's hardlinked store stays untouched                                                                                              |
| Determinism lint            | `effect-native` preset has `global-date`, `global-random`, `global-timers`, `global-fetch`, `process-env`, `node-builtin-import`, `global-console` as warnings, absent from `recommended`                                                                   | `strict` preset plus those rules as errors, off only for `src/bin.ts` and `src/platform/**`. A file with `Date.now()`, `Math.random()`, `setTimeout` and `process.env` fails with four errors |
| Effect style                | `Effect.gen` inline, `Effect.fn("name")` for reusable functions, `Context.Service` for services, `Schema.TaggedError` for errors, `NodeRuntime.runMain` as the entry point, `effect/cli` for commands, `@effect/vitest` `it.effect` + `TestClock` for tests | The root command and its test follow this                                                                                                                                                     |
| platform-node imports       | The package index re-exports everything, including a Redis client                                                                                                                                                                                           | Deep imports (`@effect/platform-node/NodeRuntime`) and `redis: "-"` override                                                                                                                  |
