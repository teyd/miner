# Research 03 — Stack versions and RAM budget

_Researched 2026-10-29. Versions are from the npm registry and `nodejs/Release/schedule.json`
on that date. RAM figures were measured on this machine (Linux 6.8, x64, Node 26.13.0)._

## TL;DR

- Every requested version exists and fits together: **Node 26.13.0 (LTS "Lithium" since
  2026-10-28)**, **Effect 4.1.0 (published 2026-10-29, today)**, **TypeScript 7.0.2**,
  **Vite+ 1.4.0**, **pnpm 12.16.1**, **drizzle-orm 1.0.0-rc.5**, **pino 10.4.0**.
- **No native addons are needed.** `@effect/sql-sqlite-node@4.1.0` and drizzle's
  `effect-sqlite-node` / `node-sqlite` drivers sit on Node's built-in `node:sqlite`.
- **RAM: bundling is the big lever.** Effect + HTTP + pino + `node:sqlite`, idle:
  **104 MB RSS unbundled → 66 MB as a tree-shaken bundle** (heap 19 → 7 MB). Bare Node is 47 MB.
  So the image should ship one bundled file, not `node_modules`.
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
| pino                    | 10.4.0                      |                                                                                                                                                                                    |
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
- **No pino transports** (they run in a `thread-stream` worker thread, which is a second V8 isolate).
  Write JSON to stdout synchronously and let Docker or journald handle rotation. Pretty printing
  is a dev-only pipe (`| pino-pretty`).
- Never download video: `HEAD` segments only (see 02 §4). Don't hold the whole catalog
  JSON, only the decoded fields we use.
- `--jitless` saves ~5 MB more but costs CPU and is (unverified) untested with Effect at
  scale. Measure before adopting. `--max-old-space-size` mostly caps growth and doesn't cut the
  baseline.
- A "RAM budget" test: run a simulated week (see 04) and assert heap after GC stays under
  a bound. Leaks show up as unbounded fibers, maps or caches, which the sim catches without waiting a week.

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

## 4. Container (later)

Not in scope yet. Notes for then: `node:26-alpine` vs distroless; multi-arch amd64/arm64
(Pi 4/5 homelabs); run as non-root uid 1000; the bundle + `node` binary is the whole payload.

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
