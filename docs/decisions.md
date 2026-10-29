# Decisions

Settled answers. Agents: don't reopen these without new evidence.

## teyd, 2026-10-29

1. **just-mining is replaced, not refactored.** Take nothing from it as architecture,
   `AGENTS.md`, rules, process or CI/CD. It's a Twitch behaviour reference only. Copying a small
   piece later needs an argument for why it's right. (01)
2. **Effect 4.1.0.** (03 §1b)
3. **Scope = TDM's scope + channel points.** Drops incl. badge/emote campaigns, plus channel
   points on the drops channel _and_ favourite streamers, without hurting drops. If both can't
   coexist, a queue/slot system decides. (05; narrowed by 17)
4. **Login uses the same token as just-mining** (teyd, 2026-10-29, replaces the `miner login`
   flow): an implicit-grant token for the Android client ID `kd1unb4b3q4t58fwlpcbzcbnm76a8fp` with
   redirect `https://www.twitch.tv/`, copied from the browser by the user (just-mining
   `docs/authentication.md`). The miner reads it from config/env and validates it hourly. No browser
   automation. (02 §1)
5. **A simulated Twitch (twin) is in.** No prior reason to avoid it, "the best we can do".
   Drift is handled by conformance tests against recordings. (04 §2)
6. **Accounts:** 5–10 Twitch accounts exist for testing. Not many in parallel: 2–3 per IP at
   most. They have no game links. (02 §4b, 04 §5)
7. **No miner is running on the homelab today** (`docker ps`, 2026-10-29). Lane B must be
   bootstrapped. (04 §3)
8. **Production = one account per instance.** The extra accounts are for test rotation only. No
   multi-account mining feature. (04 §5)
9. **No VPN/proxy per account.** gluetun belongs to the homelab, not this project. Test runs on one
   host share the per-IP budget. (02 §4b)
10. **Built for other people too.** Nothing may assume teyd's homelab (no Home Assistant/MQTT by
    default). Notifications must be generic. (narrowed by 15)
11. **Auth failure = park.** Stay up, report `needs_login`, poll nothing. Never auto-retry login or
    claims. Reads retry with backoff.
12. **A proper simulator, wire level, built in-house.** No existing Twitch simulator fits
    (04 §6b). Build it on Effect `TestClock`/`Random`/layers + fast-check, and borrow chronos's
    entropy guard and failure capsules.
13. **Our own small skills, not pstack.** Write only what this repo needs (`verify-miner` and
    friends). pstack and noodle are references (06).
14. **Models for agents:** Claude Opus 5.5, Claude Sonnet 5.5, DeepSeek 4.1 Flash (1017). Two
    families, so cross-family review means one Claude and DeepSeek. (06 §4)
15. **CLI only, bare minimum.** `status --json` is the whole external surface. No webhooks,
    MQTT, web UI or notifications until the miner works properly. Add things afterwards.
16. **One test account will have connected game accounts**, so the full link → claim → in-game
    path is testable. The others stay unlinked.
17. **Points: v1 = drops first, points only on the channel being watched.** Favourites, streaks and
    the second-slot queue are deferred and need evidence first (05 §Rethink). When they come, they're
    configurable with default "drops > channel points, watch streaks".
18. **Distribution:** eventually Docker, a single binary and npx. For now development only.
19. **Name `miner`, public from day one** (`github.com/teyd/miner`, already exists, empty).
20. **No licence for now.** Don't add a LICENSE file or licence headers.
21. **GitHub `teyd/miner` is set up like deadbolt, but not pushed yet.** Squash merge only, PR title
    and body as the commit, branches deleted after merge, wiki and projects off (applied
    2026-10-29). The local branch is `dev`. After the first push, make `dev` the default branch on
    GitHub (it can't be set before a `dev` branch exists there).
22. **Minimal CI/CD.** One workflow that runs `pnpm check` on PRs and pushes to `dev`. No release
    automation, image publishing, badges or nightly jobs until there is something to ship.
23. **Stop planning, start building** (2026-10-29). Proposal v0 + critique 08 are the design input.
    Open design questions get answered with code and the simulator, not more documents.
24. **Environment through Varlock** (teyd, 2026-10-29). `.env.schema` is committed and declares every
    variable (`TOKEN`: required, sensitive, format-checked). Values live in gitignored
    `.env.local`, optionally encrypted with `varlock encrypt`. Varlock is a dev dependency only:
    `pnpm dev` runs the CLI through `varlock run`, and the bundle reads plain environment variables
    through Effect `Config`, so Docker users can pass the variable directly. Varlock's bundled agent
    skill is declined (decision 13).
