# miner

A headless Twitch drops miner for homelabs, built for other people too. TypeScript 7 on Node 26, Effect 4.1,
pnpm 12, Vite+ (`vp`). Status: the pure core is built; nothing talks to Twitch yet.

- `src/bin.ts`: the entry point. It wires Node services into the CLI.
- `src/cli/`: Effect CLI commands. `miner.ts` is the root command.
- `src/platform/` (not yet created): the IO shell, the only place besides `src/bin.ts` that may touch time,
  randomness, timers, network, env, console or Node built-ins.
- `src/core/`: the pure decision logic. `step(state, event, now)` in `step.ts` returns the next state and the
  commands to run (`protocol.ts`). `rules.ts` holds Twitch's earn and claim rules with their sources, `plan.ts`
  picks a drop and a channel. Contract for the runtime: persist the returned state before executing its
  commands, and wake the core at `nextDeadline(state)`. `fixtures.ts` builds test data.
- Planned (proposal v0): `twitch` (the one Twitch seam), `store`, `twin` (simulator).
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
- Use `pnpm exec`, not `npx`: `devEngines` refuses npm.

## Read before you change

- Anything that talks to Twitch: `docs/research/02-twitch-2026.md`.
- Simulator, recorder, replay: `docs/research/04-parallel-bug-finding.md`.
- Watching and points: `docs/research/05-watch-slots.md`.
- Toolchain, bundling, RAM: `docs/research/03-stack-and-ram.md`.
- Effect APIs: Effect's `LLMS.md` and `ai-docs/` on GitHub (Effect-TS/effect). They match 4.x. Older blog
  posts and v3 examples don't.

## Code rules

- Lint enforces determinism. The `effecttsgo` rules for `Date`, `Math.random`, timers, `fetch`,
  `process.env`, `console` and Node built-in imports are errors outside `src/bin.ts` and `src/platform/`.
  Use `Clock`, `Random`, `Effect.sleep`, `HttpClient`, `Config` and `Effect.log`. Simulator seeds must
  replay exactly. Don't widen the override list to make a file pass.
- Core logic is pure: `(state, event, now)` in, `(state, commands)` out.
- Decode Twitch JSON at the boundary with Schema. A `null` where data belongs is an error, never a default.
- Import platform modules by path (`@effect/platform-node/NodeRuntime`), not from the package index.
- Tests sit next to the code as `*.test.ts` and use `@effect/vitest` (`it.effect`, `TestClock`, `TestConsole`).
- `effect-tsgo patch` runs on every install (`prepare`). If lint says `Unknown plugin: 'effecttsgo'`, run
  `pnpm install` again. `@effect/tsgo` supports exact oxlint and tsgolint versions, so it is bumped together
  with `vite-plus`.

## Twitch gotchas

- The API is private and undocumented. Hashes, client IDs and headers break about monthly. Re-verify before relying on one, and update the date in research 02.
- Twitch sometimes answers `null` with no error. Treat it as a failure.
- Limits are per IP (about 10 websockets, 5 GQL requests per second). Live runs use test accounts only, at most 2 at once.
- Never log out or revoke a token. Getting a new one needs a human in a browser.
- Never auto-retry a claim. A lost answer may still have succeeded, so read state first.
- Tokens, signed playlist URLs (`sig`, `token`, `hdnts`) and `Authorization` headers never reach logs, fixtures or commits.

## Shipping

- The default branch is `dev`. One worktree per task: `git worktree add .worktrees/<task> -b <type>/<task> dev`. Remove it after merge.
- PRs target `dev`. Squash merge. The PR title becomes the commit: `feat(scope): …`, `fix(scope): …`, `docs: …`.
- The PR body gives the user-visible change first, then design notes with file paths, then the commands you ran and their output.
