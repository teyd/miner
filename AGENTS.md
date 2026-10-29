# miner

A headless Twitch drops miner for homelabs, built for other people too. TypeScript 7 on Node 26, Effect 4.1,
pnpm 12, Vite+ (`vp`). Status: the pure core and the read-only Twitch client are built; nothing watches or claims yet.

- `src/bin.ts`: the entry point. It wires Node services into the CLI.
- `src/cli/`: Effect CLI commands. `miner.ts` is the root command, `doctor.ts` the read-only probe.
- `src/platform/` (not yet created): the IO shell, the only place besides `src/bin.ts` that may touch time,
  randomness, timers, network, env, console or Node built-ins.
- `src/core/`: the pure decision logic. `step(state, event, now)` in `step.ts` returns the next state and the
  commands to run (`protocol.ts`). `rules.ts` holds Twitch's earn and claim rules with their sources, `plan.ts`
  picks a drop and a channel. Contract for the runtime: persist the returned state before executing its
  commands, and wake the core at `nextDeadline(state)`. `fixtures.ts` builds test data.
- `src/twitch/`: the one Twitch seam. `Twitch.ts` is the service (validate, catalog, inventory, directory,
  streams, current drop), `wire.ts` decodes answers into core types, `identity.ts` holds every Twitch constant
  with its source and date, `journal.ts` records answers (redacted) for replay. `fixtures/` are real answers
  recorded on 2026-10-28 with identities replaced; `stub.ts` serves them to tests.
- Planned (proposal v0): the runtime that executes core commands, `store`, `twin` (simulator).
- `docs/decisions.md`: settled answers. Read it before proposing anything. Don't reopen a decision without new evidence.
- `docs/research/`: dated research with sources. `docs/history/`: proposals and their critiques.

## Commands

- `pnpm install`. pnpm switches itself to the pinned 12.16.1 and installs Node 26.13.0 into
  `node_modules/.bin` (`devEngines` in `package.json`). Scripts run on that Node, whatever `node` is on PATH.
- `pnpm check` is the gate: `vp check` (format, lint, typecheck) and then `vp test`. CI runs exactly this
  plus `pnpm build`. Done means exit 0.
- `pnpm exec vp check --fix` formats and applies lint fixes. `pnpm exec vp test <file>` runs one test file.
- `pnpm build` bundles everything into `dist/bin.mjs` (`vp pack`). One file, no `node_modules` at runtime,
  because that halves idle RSS (research 03). `pnpm start --help` runs it.
- Environment comes from Varlock: `.env.schema` (committed) declares every variable, values go in `.env.local`
  (gitignored). `pnpm dev <command>` builds and runs the CLI with that environment (`varlock run`), e.g.
  `pnpm dev doctor [--json] [--record file.jsonl]`, which checks the token and reads the catalog and inventory,
  writing nothing to Twitch. `pnpm exec varlock load` validates the environment and masks secrets.
- Use `pnpm exec`, not `npx`: `devEngines` refuses npm.

## Read before you change

- Anything that talks to Twitch: `docs/research/02-twitch-2026.md`.
- Simulator, recorder, replay: `docs/research/04-parallel-bug-finding.md`.
- Watching and points: `docs/research/05-watch-slots.md`.
- Toolchain, bundling, RAM: `docs/research/03-stack-and-ram.md`.
- The config file and its schema: `docs/research/07-config.md`.
- Effect APIs: Effect's `LLMS.md` and `ai-docs/` on GitHub (Effect-TS/effect). They match 4.x. Older blog
  posts and v3 examples don't.

## Code rules

- Lint enforces determinism. The `effecttsgo` rules for `Date`, `Math.random`, timers, `fetch`,
  `process.env`, `console` and Node built-in imports are errors outside `src/bin.ts` and `src/platform/`.
  Use `Clock`, `Random`, `Effect.sleep`, `HttpClient`, `Config` and `Effect.log`. Simulator seeds must
  replay exactly. Don't widen the override list to make a file pass.
- Core logic is pure: `(state, event, now)` in, `(state, commands)` out.
- Comment only what the code can't say: a Twitch quirk, a source, a non-obvious invariant. No doc comment
  that restates the name or type.
- Decode Twitch JSON at the boundary with Schema. A `null` where data belongs is an error, never a default.
- Import platform modules by path (`@effect/platform-node/NodeRuntime`), not from the package index.
- Tests sit next to the code as `*.test.ts` and use `@effect/vitest` (`it.effect`, `TestClock`, `TestConsole`).
- `effect-tsgo patch` runs on every install (`prepare`). If lint says `Unknown plugin: 'effecttsgo'`, run
  `pnpm install` again. `@effect/tsgo` supports exact oxlint and tsgolint versions, so it is bumped together
  with `vite-plus`.

## Twitch gotchas

- The API is private and undocumented. Hashes, client IDs and headers break about monthly. Re-verify before relying on one, and update the date in research 02.
- Twitch sometimes answers `null` with no error. Treat it as a failure.
- Limits are per IP (about 10 websockets, 5 GQL requests per second). Live runs use the account in `.env.local`,
  which is teyd's normal account (approved 2026-10-29): one live miner at a time, and keep request rates at what a
  person in a browser would cause.
- Never log out or revoke a token. Getting a new one needs a human in a browser.
- Never auto-retry a claim. A lost answer may still have succeeded, so read state first.
- Tokens, signed playlist URLs (`sig`, `token`, `hdnts`) and `Authorization` headers never reach logs, fixtures or commits.
- Never read, print or copy `.env.local` or any `.env.*` file. To check the token is set, run
  `pnpm exec varlock load`, which masks it. A new variable goes into `.env.schema` first, marked `@sensitive`
  if it's a secret.

## Shipping

- The default branch is `dev`. One worktree per task: `scripts/worktree.sh <type>/<task>` creates `.worktrees/<task>`
  from `dev`, symlinks the main checkout's `.env.local` into it and installs. Remove it after merge.
- PRs target `dev`. Squash merge. The PR title becomes the commit: `feat(scope): …`, `fix(scope): …`, `docs: …`.
- The PR body gives the user-visible change first, then design notes with file paths, then the commands you ran and their output.
