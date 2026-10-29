# Research 05 — Drops and channel points on one account: watch slots

_Researched 2026-10-29. Sources: help.twitch.tv (drops), TCPM README and `Twitch.py`, TCPM #618
and #732, TDM README. Most of this is (inference) awaiting lane-D measurements; the open facts
are listed as experiments._

Goal (teyd, 2026-10-29): mine what TDM mines (drops, incl. badge/emote campaigns) **plus**
channel points, on the drops channel _and_ on favourite streamers, without hurting drops. "If
that's impossible, OK. Otherwise think of a queueing system."

## Rethink (2026-10-29): should we mine favourites at all?

**Terms.** A _bonus chest_ is the "claim bonus" icon Twitch shows in chat's points button every
~15 min of watching (unverified cadence). Clicking it gives extra points. Miners claim it when
PubSub sends `claim-available`. **Correction (2026-10-29, critique 08):** TDM master does _not_
claim chests. `ClaimCommunityPoints` and the points topic exist in `constants.py` but are unused.
The only working implementation is TCPM (GPL-3.0, read only), so claiming points is a new,
unverified mutation for us, not a by-product to port. A _watch streak_ is a
bonus for watching several consecutive broadcasts of one channel (TCPM README: "+450 points when
the stream starts").

**Against favourites in v1.** They need the second watch slot. That second slot may hurt drop progress
(TCPM #618), it adds requests against the shared per-IP budget, it brings a queue/scheduler with
its own state and bugs, and its rules (E2–E5) are all unmeasured. Channel points are
per-channel cosmetics. Drops are the product.

**For.** Points on the drops channel are cheap: we already watch it and could receive its
PubSub events, so claiming its chest is one mutation.

**Decision (teyd, 2026-10-29):** v1 mines drops and claims points only on the channel it watches
for drops. Favourites with streaks come later, and only if E2/E3 show a second stream doesn't hurt
drops. Then they're configurable with default "drops > channel points, watch streaks". The rest of
this doc is the design for that later step.

## Known facts

| Fact                                                                                                                | Source                            |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Drops progress on one channel at a time                                                                             | help.twitch.tv "How Drops Work"   |
| Points accrue on at most 2 streams at once. TCPM hard-codes `max_watch_amount = 2`                                  | TCPM README "Limits", `Twitch.py` |
| More watched streams than that: Twitch "effectively chooses which ones" (a user's guess: randomly)                  | TCPM discussion #732 (2025-10)    |
| A points miner watching 2 streams next to a drops miner "sometimes" breaks drop progress                            | TCPM #618 (2024-10, open)         |
| Watching in a browser on the same account as the miner makes TDM report false progress or get stuck                 | TDM README                        |
| ~~TDM claims the bonus chest~~: a 2022 comment (TDM #105). TDM master defines but never uses `ClaimCommunityPoints` | TDM `constants.py:317,503,509`    |
| Points events TCPM handles: watch, bonus chest, stream start (watch streak), raids, predictions, moments            | TCPM README / `Twitch.py`         |

## Model (hypothesis to test)

The simplest model consistent with #618 and #732 (inference):

> An account has **2 credited watch slots**. Each credited minute counts for points on that
> channel, and the drops credit goes to the drops-eligible channel among them. Watching a third
> stream makes Twitch pick 2, possibly dropping the drops channel.

If true, the scheduler is simple and safe:

- **Slot 1 = drops**, reserved while any campaign is minable, else free.
- **Slot 2 = points queue**, rotating through favourites. When slot 1 is free, both slots serve the queue.
- **Never more than 2 watches per account, ever.** That's an invariant in the simulator (04 §2).

## The points queue

Ordered by what a minute is worth (inference, every rule needs confirming):

1. **Watch streak at risk:** a favourite just went live and the streak needs N minutes this
   broadcast (N unknown, see experiment E4).
2. **Raid follow:** join the raid target briefly if it's a favourite (TCPM `JoinRaid`).
3. **Bonus chest cadence:** stay on a channel long enough to collect a chest (the cadence is
   (unverified) ~15 min), then rotate.
4. **User priority order** of favourites, round-robin among equals.

Each switch costs nothing on Twitch's side, but a slice shorter than the accrual
interval wastes minutes. So slices are at least one accrual interval (unknown, E5).

## Experiments that decide the design (lane D, unlinked test accounts are fine)

| #   | Question                                                           | Setup                             | Signal                                 |
| --- | ------------------------------------------------------------------ | --------------------------------- | -------------------------------------- |
| E1  | Baseline drop progress rate                                        | drops only, 60 min                | inventory minutes vs wall minutes      |
| E2  | Does 1 extra points stream hurt drops?                             | drops + 1 points stream, 60 min   | E2 rate vs E1                          |
| E3  | Does a 3rd stream evict drops?                                     | drops + 2 points streams, 60 min  | drop progress gaps                     |
| E4  | Watch streak: minutes needed, works with HEAD-only watching?       | favourite goes live, watch N min  | streak count in channel points context |
| E5  | Points accrual interval and chest cadence under HEAD-only watching | 1 stream, 60 min                  | balance deltas over time               |
| E6  | Does any GQL read (no playlist) count as watching?                 | shadow mode only, 60 min          | balance and progress unchanged         |
| E7  | Do game campaigns progress on an unlinked account?                 | unlinked account, a game campaign | inventory progress                     |

Each result becomes a twin rule with date, account and recording id (04 §2). If E2 shows harm,
the fallback is "points only on the drops channel while drops are minable".
