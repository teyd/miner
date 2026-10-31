# miner

A headless Twitch drops miner for homelabs. It runs on a server with no browser and watches
streams for one Twitch account, so drop campaigns progress and their rewards get claimed as
soon as they're earned. One instance mines one account.

It watches the way Twitch's player does, one stream at a time at the lowest quality (a few hundred
kbit/s). It follows stream and drop events over Twitch's PubSub socket, re-reads the campaign
list every hour and claims each finished drop once.

## Status

Early, but it works. `miner run` from a checkout mined and claimed real drops on 2026-10-30. The
Docker image and the systemd unit are new: they build, start and stop cleanly, but haven't mined
for long yet. Today:

- **Works:** several drops goals in priority order, for the games you list or for every game
  but those you exclude, per-game reward types, `linkedOnly`, `order: "ending-soonest"` or
  `"least-slack"`, excluded channels, claiming, read-only shadow runs, and a simulator that
  checks the decision logic against a fake Twitch. A drop that can no longer finish in time
  never holds up a goal below it that can.
- **Not yet:** channel-points goals and `claimBonus` (accepted in the config, skipped with a
  warning), a second stream, picking up `config.json` edits without a restart, and a published
  image, binary or npm package. You build it from this repository.
- **Twitch's API is private** and changes about once a month. Then the miner needs an update
  ([section 5](#5-when-it-needs-you) tells how to notice).

On startup the miner logs one warning per config option it can't honour yet, so it never
silently ignores a setting.

## Contents

1. [Get a token](#1-get-a-token)
2. [Write config.json](#2-write-configjson)
3. Run it with [Docker Compose](#3a-run-it-with-docker-compose), [systemd](#3b-run-it-with-systemd)
   or [plain Node](#3c-run-it-with-plain-node)
4. [What you see when it works](#4-what-you-see-when-it-works)
5. [When it needs you](#5-when-it-needs-you)
6. [Where things live](#where-things-live), [shadow runs](#shadow-runs),
   [settings](#environment-variables) and [commands](#commands)

## 1. Get a token

The miner logs in with a Twitch access token that you copy out of your own browser once. The
token belongs to Twitch's Android app, the same login the official app uses. The miner never sees
your password, and the server needs no browser.

1. In a desktop browser where you're logged in to Twitch (or will log in), open this link:

   <https://id.twitch.tv/oauth2/authorize?client_id=kd1unb4b3q4t58fwlpcbzcbnm76a8fp&redirect_uri=https%3A%2F%2Fwww.twitch.tv%2F&response_type=token>

   Sign in if Twitch asks, with 2FA if you use it. Twitch then sends you to
   `https://www.twitch.tv/#access_token=…&scope=…`.

2. The token is the 30 or so letters and digits between `access_token=` and the next `&` in
   the address bar. To have the browser copy it for you, open DevTools (F12) → Console on that page, paste
   this line and press Enter. Chrome may ask you to type `allow pasting` first.

   ```js
   (() => {
     const t = new URLSearchParams(location.hash.slice(1)).get("access_token");
     if (!t) return console.log("No token here: open the link above first.");
     try {
       copy(t);
     } finally {
       history.replaceState(null, "", "/");
     }
     console.log("Copied the token to the clipboard.");
   })();
   ```

   It copies the token and removes it from the address bar and the browser history. After you
   paste it below, copy something else, so a clipboard manager or clipboard sync doesn't keep it.
   `docker compose config` and `docker inspect` print it in clear: never paste their output into
   an issue.

3. Keep it like a password. It opens your whole Twitch account, it doesn't expire, and it goes
   only into the one file named in section 3.

Running the link again is safe and gives you a fresh token. A token dies when you change your Twitch password, use "Log out of all devices", or Twitch revokes it.
The miner then stops mining and waits for you ([section 5](#5-when-it-needs-you)).

## 2. Write config.json

The miner reads `$DATA_DIR/config.json` (`/data/config.json` in Docker). Without the file it
mines drops for every game. `miner config init` writes this starter file:

```json
{
  "$schema": "https://raw.githubusercontent.com/teyd/miner/dev/schema/config.v1.json",
  "version": 1,
  "priorities": [{ "type": "drops", "note": "Every game with an active campaign", "games": "all" }]
}
```

- [`schema/config.example.json`](schema/config.example.json) shows every option.
  [`schema/config.v1.json`](schema/config.v1.json) is the JSON Schema with every field explained.
  Editors that understand `$schema` complete and check the file as you type, and an AI agent can
  write the file from the schema alone. `miner config schema` prints the same schema.
- Games go by the name Twitch shows (`{ "name": "Rust" }`), never by id.
- `miner config validate` checks the file offline and names each problem by its JSON path, e.g.
  `config.json#/priorities/0/games: …`. Unknown keys count as problems, so a typo can't slip through.
- Restart the miner after editing the file.

Section 3 shows how to run these commands in each setup. The design behind the file is in [research 07](docs/research/07-config.md).

## 3a. Run it with Docker Compose

You need Docker with the compose plugin, on amd64 or arm64 (a Raspberry Pi 4 or 5 is fine).
There is no published image yet, so compose builds one from this repository.

```sh
git clone https://github.com/teyd/miner && cd miner

# The container runs as uid 1000. Create the data directory yourself: one Docker creates for
# you belongs to root, and the miner can't write to it.
mkdir data && sudo chown 1000:1000 data   # skip the chown if `id -u` already prints 1000

# The token goes into .env next to compose.yaml (git ignores it). It isn't echoed or saved in
# your shell history.
(umask 077; read -rsp 'Token: ' t; echo; printf 'TOKEN=%s\n' "$t" > .env)
chmod 600 .env   # umask only applies when .env is new

docker compose build
docker compose run --rm miner config init   # writes data/config.json; edit it if you like
docker compose run --rm miner doctor        # checks the token, writes nothing to Twitch
docker compose up -d
docker compose logs -f
```

`doctor` should print `token: ok, <your login> (user …)`, followed by how many campaigns and
drops it can see.

The image is `node:26-alpine` plus one 2 MB JavaScript file, about 250 MB on disk and 63 MB to
download. Logs are JSON on stderr, so `docker logs` and log collectors can parse them. Uncomment
`LOG_FORMAT: pretty` in [`compose.yaml`](compose.yaml) for the readable lines shown in
section 4. `docker compose down` or `docker stop` stops the miner cleanly.

To update, run `git pull && docker compose build && docker compose up -d`.

## 3b. Run it with systemd

You need Node 26.13 or newer on the server, plus [pnpm](https://pnpm.io) on whichever machine
builds the miner (pnpm downloads the Node it needs for the build). The bundle is one file with no
dependencies, so you can build it anywhere and copy it over.

```sh
git clone https://github.com/teyd/miner && cd miner
pnpm install && pnpm build                  # writes dist/bin.mjs

sudo useradd --system --home-dir /var/lib/miner --no-create-home --shell /usr/sbin/nologin miner
sudo install -D -m 644 dist/bin.mjs /opt/miner/bin.mjs
sudo install -d -o miner -g miner -m 750 /var/lib/miner
sudo install -d -m 700 /etc/miner
(umask 077; read -rsp 'Token: ' t; echo; printf 'TOKEN=%s\n' "$t" | sudo tee /etc/miner/miner.env >/dev/null)
sudo chmod 600 /etc/miner/miner.env
sudo install -m 644 deploy/miner.service /etc/systemd/system/miner.service
```

[`deploy/miner.service`](deploy/miner.service) runs `/usr/bin/node`. If `command -v node` prints
another path, change `ExecStart` to it (home directories are read-only to the unit, so a node from
nvm, asdf or mise works). Then write the config, check the token and start the miner:

```sh
sudo -u miner env DATA_DIR=/var/lib/miner LOG_FILE=false "$(command -v node)" /opt/miner/bin.mjs config init
sudo systemd-run --pty --wait --quiet -p User=miner -p EnvironmentFile=/etc/miner/miner.env \
  -E DATA_DIR=/var/lib/miner -E LOG_FILE=false "$(command -v node)" /opt/miner/bin.mjs doctor
sudo systemctl daemon-reload
sudo systemctl enable --now miner
journalctl -u miner -f
```

The unit runs node directly as the `miner` user, with the token from `/etc/miner/miner.env`.
systemd reads that file as root, so the miner itself can't read it back. The unit is sandboxed:
read-only system, no home directories, network and `/var/lib/miner` only. `journalctl` gets
readable lines (`LOG_FORMAT=pretty`) and keeps them, so the JSON file copy is off. After a crash it
restarts after 10 s, with the delay growing to 15 min (systemd 254 or newer, e.g. Debian 13 or
Ubuntu 24.04; older systemd ignores the growth and retries every 10 s). An invalid `config.json` (exit code 2)
stops it for good until you fix the file and run `systemctl restart miner`. In Docker,
`restart: unless-stopped` keeps restarting it and repeating the problem lines: fix the file and run
`docker compose up -d`.

## 3c. Run it with plain Node

You need Node 26.13 or newer. Build `dist/bin.mjs` as in 3b and run it from anywhere:

```sh
read -rsp 'Token: ' TOKEN; echo; export TOKEN
export DATA_DIR=~/miner-data
node dist/bin.mjs config init
node dist/bin.mjs doctor
node dist/bin.mjs run          # Ctrl-C stops it
```

On a terminal the log lines are readable and coloured. A JSON copy also goes to
`$DATA_DIR/logs/miner.log`, rotated at 10 MiB with five old files kept.

## 4. What you see when it works

On a terminal, or with `LOG_FORMAT=pretty`, a healthy start looks like this (times are UTC):

```text
18:42:36.906 INFO  live run: state in /data/state.json, recordings in /data/recordings
18:42:36.917 INFO  runtime: starting fresh
18:42:37.968 INFO  inventory: 14 drops known, 3 not claimed yet
18:42:40.344 INFO  runtime: watching oilrats for Rust: Hoodie (6/15 min)
18:42:47.433 INFO  pubsub: following 100 channels and the account's drops
18:43:07.052 INFO  watch: watching oilrats over HLS at 230 kbit/s
18:44:29.095 INFO  runtime: watching oilrats for Rust: Hoodie (7/15 min)
…
18:52:31.210 INFO  claim: … claimed
18:52:31.502 INFO  claimed Rust: Hoodie
18:52:33.880 INFO  runtime: watching oilrats for Rust: Jacket (0/30 min)
```

- `runtime: watching <channel> for <game>: <drop> (minutes/needed)` is the line that matters. It
  repeats whenever the channel, the drop or the minutes change. A drop gains about one minute per
  minute watched.
- `claimed <game>: <drop>` means the reward is yours. If you haven't linked the game account,
  the claim still goes through with a warning, and Twitch delivers the item once you link it.
- `progress <game>: <drop> n/m min` reports each drop whose minutes changed: the one being
  watched, and others that the same stream also counts for.
- `runtime: skipping <channel> until restart: …` (a warning) means the miner gave up on a channel
  that refuses playback, or credits nothing the miner wants for 30 minutes.
  `runtime: skipping <campaign> for <n> min: …` means Twitch kept crediting a drop of that
  campaign that earns you nothing, such as one you already have: Twitch counted a received reward
  past its requirement for two hours in one live run. The miner tries the campaign again after at
  most an hour, and gives it up again at once if Twitch is still on that drop.
- `runtime: received already: <game>: <drop>, …` means the miner takes a drop as yours from the
  rewards on Twitch's inventory page (even from campaigns it no longer shows there), and won't
  watch for it. Twitch names a reward, not the campaign that gave it, so a reward another campaign
  gave during the drop's dates counts too; if you see a drop here you don't have, that's why.
- `runtime: idle (<reason>)` means nothing is being watched right now:

  | Reason                | Meaning                                                                                                     |
  | --------------------- | ----------------------------------------------------------------------------------------------------------- |
  | `starting`            | Checking the token and reading the campaigns (logged only after a resume).                                  |
  | `discovering`         | Reading which channels stream the campaigns; a watch starts once they answer.                               |
  | `nothing-to-mine`     | No active campaign matches your config, or everything is claimed.                                           |
  | `no-live-channel`     | There are drops to earn, but no channel streaming them is live now. The miner looks again every 15 minutes. |
  | `catalog-unavailable` | Twitch didn't return the campaign list. The miner tries again.                                              |
  | `needs-login`         | The token was refused. See [section 5](#5-when-it-needs-you).                                               |

`LOG_LEVEL=Debug` adds every watch tick and PubSub event.

## 5. When it needs you

The miner retries reads on its own, with a backoff. It never retries a login or a claim, so
these cases are yours:

| You see                                                              | What happened                                                                                                                   | What to do                                                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime: idle (needs-login)`                                        | Twitch refused the token. The miner stays up but sends nothing.                                                                 | Get a new token ([section 1](#1-get-a-token)), put it in `.env` or `miner.env`, restart.                                                                                              |
| `run stopped: TOKEN is not set`, exit 1                              | No token in the environment.                                                                                                    | Set `TOKEN`.                                                                                                                                                                          |
| `…config.json#/…: …`, exit 2                                         | `config.json` is invalid. Each line names one problem.                                                                          | Fix it, check with `miner config validate`, restart.                                                                                                                                  |
| `run stopped: another miner (pid …) runs on …`, exit 1               | A second miner on the same data directory.                                                                                      | Stop the other one. Only one miner per account, ever, even across machines.                                                                                                           |
| `run stopped: …state.json can't be read …`, exit 1                   | The state file is damaged or from another version.                                                                              | Stop the miner, move `state.json` away. It starts fresh from Twitch's inventory.                                                                                                      |
| `config: … is not supported yet …` (warning at start)                | A config option the miner doesn't honour yet.                                                                                   | Nothing. The miner runs without it ([status](#status)).                                                                                                                               |
| `config: game "…" matches no game with an active campaign`           | A listed game is misspelt, or has no campaign right now.                                                                        | If it names a "did you mean", fix the name in `config.json` and restart. Otherwise nothing: it is mined once a campaign starts.                                                       |
| `idle (catalog-unavailable)` for hours, or minutes that stop growing | Twitch changed its private API, or is down.                                                                                     | Run `miner doctor`: it names an answer that "changed shape or was null". Update the miner, or open an issue with that line.                                                           |
| `claim: … outcome unknown …`                                         | The answer to a claim got lost.                                                                                                 | Nothing. The next inventory read shows whether it went through, and only then is it claimed again.                                                                                    |
| `runtime: … not sent, the gql request budget has room again in … s`  | Twitch answered "too many requests" (429), or a burst was too big for the miner's own limits. Nothing of that command was sent. | Nothing, if it is rare: the miner waits, then sends it again (a claim only after inventory shows it still unclaimed). Often: check that no other miner or Twitch tool shares this IP. |

To restart after a new token: `docker compose up -d` (it recreates the container when `.env`
changed) or `sudo systemctl restart miner`. Don't use "Log out of all devices" on Twitch to get
rid of an old token: that kills the new one too.

## Where things live

Everything the miner keeps is in `DATA_DIR`: `./data` by default, `/data` in Docker,
`/var/lib/miner` under systemd.

| Path                             | What                                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                    | Your settings. The miner never writes it, except `miner config init` once.                                                                                                                                                                  |
| `state.json`                     | What the miner knows: campaigns, progress, claims in flight. Written atomically after every change, so it survives crashes and restarts. No token.                                                                                          |
| `state.shadow.json`              | The same for [shadow runs](#shadow-runs), kept apart so a shadow run never blocks a real claim.                                                                                                                                             |
| `miner.lock`                     | The pid and host (container) of the running miner, so a second miner on this directory refuses to start. A crash's lock is taken over on the next start in the same container; after a crash in another container, remove the file by hand. |
| `recordings/YYYY-MM-DD.jsonl.gz` | The flight recorder: Twitch's answers and the miner's actions, one file per UTC day, read with `zcat`. Kept 7 days and 256 MiB at most, 64 MiB per day.                                                                                     |
| `logs/miner.log`, `.1` … `.5`    | A JSON copy of the log, rotated at 10 MiB. Off in the Docker image and the systemd unit, which keep logs themselves.                                                                                                                        |

Recordings and logs are redacted: no token, no signed video URLs, no `Authorization` headers.
They still show your login and what you watched, so share them only with care.

## Shadow runs

`miner run --shadow` is a dress rehearsal. It uses the real token, does the real reads and the
real planning, and logs what it would do (`shadow: would watch channel …`, `shadow: would claim
drop instance …`). It never watches, never claims and changes nothing on your account. Use it to
try a new config or a new version. It counts as the account's one miner, so stop the real one
first:

```sh
docker compose stop
docker compose run --rm miner run --shadow   # Ctrl-C ends it
docker compose start
```

## Environment variables

| Variable     | Default  | Meaning                                                               |
| ------------ | -------- | --------------------------------------------------------------------- |
| `TOKEN`      | required | The Twitch token from [section 1](#1-get-a-token).                    |
| `DATA_DIR`   | `./data` | Config, state, recordings and logs. `/data` in the image.             |
| `LOG_LEVEL`  | `Info`   | `Trace`, `Debug`, `Info`, `Warn`, `Error`, `Fatal` or `None`.         |
| `LOG_FORMAT` | auto     | `pretty` or `json`. Unset: pretty on a terminal, JSON otherwise.      |
| `LOG_FILE`   | `true`   | The JSON copy in `$DATA_DIR/logs`. `false` in the image and the unit. |

[`.env.schema`](.env.schema) declares them all.

## Commands

| Command                 | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `miner run`             | Mine. `--shadow` for a read-only rehearsal.                                     |
| `miner doctor`          | Check the token, read the campaigns and the inventory, write nothing. `--json`. |
| `miner config init`     | Write a starter `config.json`. Never overwrites one.                            |
| `miner config validate` | Check `config.json` offline. `--json` for scripts and agents.                   |
| `miner config schema`   | Print the JSON Schema.                                                          |
| `miner sim`             | Run the decision logic against a simulated Twitch. Talks to no one.             |

Each takes `--help`. In Docker: `docker compose run --rm miner <command>`. `miner status` reads the running
miner's `status.json` (in Docker: `docker compose exec miner node /app/bin.mjs status`), and its exit code is the
image's health check: 0 healthy or starting, 1 not running, 2 needs login, 3 discovery broken.

## Developing

[`AGENTS.md`](AGENTS.md) covers the layout, the commands and the rules (`pnpm check` is the gate).
Settled design choices are in [`docs/decisions.md`](docs/decisions.md), and the research behind
them, with sources, in [`docs/research/`](docs/research/).
