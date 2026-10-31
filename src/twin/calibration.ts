import { MINUTE, type Millis } from "../core/model.ts";

/**
 * Timings the twin used to guess, measured on two live recordings of teyd's account (research 04
 * §2b). `fixtures/calibration-2026-10-30.json` holds what each value is measured from, relabelled,
 * and `calibration.test.ts` derives every value here from it again.
 *
 * - `2026-10-30/run37min`: `miner run`, 15:19–15:56 UTC, 2 channels watched, 3 claims.
 * - `2026-10-30/run4h`: `miner run` under systemd, 17:42–21:43 UTC, 4 watches, 3 claims, ~100
 *   channels followed over PubSub.
 */
export const RECORDINGS = ["2026-10-30/run37min", "2026-10-30/run4h"] as const;

/**
 * Credited minutes of one drop between two consecutive `drop-progress` frames (46 pairs, both
 * recordings): a frame every 3.8 credited minutes on average (176 minutes), with no pattern to
 * the gaps. The minute that completes a drop was framed every time
 * (5 of 5), and a frame names one drop per campaign: the one closest to done (APEX Pack while
 * Holospray moved silently, then Holospray; CFB 15 then CFB 30).
 */
export const FRAME_GAPS: ReadonlyArray<number> = [
  ...Array<number>(7).fill(1),
  ...Array<number>(13).fill(2),
  ...Array<number>(7).fill(3),
  ...Array<number>(5).fill(4),
  ...Array<number>(5).fill(5),
  6,
  ...Array<number>(3).fill(7),
  8,
  9,
  9,
  12,
  12,
];

/**
 * A credited minute per minute watched (60 s of ticks): 60 in 61.2 wall minutes (run4h, from
 * the first tick to the completing frame), 15 in 15.05 (run37min). The drift is the frame's own
 * delay and each token refresh, which costs about half a minute; the twin keeps 60 s.
 */
export const CREDIT_SECONDS = 60;

/**
 * The Inventory read's `currentMinutesWatched` against the frames around it: never behind by more
 * than the minute in progress (26 reads of drops being watched). The scenario's lag is drawn
 * mostly 0, sometimes 1, and rarely 2–3 to keep a worse Twitch covered.
 */
export const INVENTORY_LAG_MINUTES = 0;

/**
 * After a claim, the next Inventory read (5 minutes later) showed it claimed (2 of 2 drops with
 * a later drop still in the campaign), so the flag lags at most this long. No read fell earlier.
 */
export const CLAIMED_FLAG_LAG_MAX: Millis = 5 * MINUTE;

/**
 * The miner claimed 0.604–0.884 s after the frame that completed the drop (5 of 5), with an
 * Inventory read between them carrying the instance id. No `drop-claim` frame came in either
 * recording (4.6 h, 6 claims): the twin sends one only when the scenario asks.
 */
export const CLAIM_AFTER_FRAME: { readonly min: Millis; readonly max: Millis } = {
  min: 604,
  max: 884,
};

/** The simulator's bound on `CLAIM_AFTER_FRAME`: it looks at work in flight once a second. */
export const CLAIM_AFTER_FRAME_MAX: Millis = 1_000;

/**
 * A playback token lasts 20 minutes (`expires`, research 02 §4); the miner fetched a new one every
 * 19.0 minutes (10 of 11 intervals, the other 19.3), which is `TOKEN_MARGIN` before it.
 */
export const TOKEN_LIFETIME: Millis = 20 * MINUTE;

/** Segments in the lowest media playlist at a tick: 15 or 16 on 5 of 6 channels, 30 or 31 on one. */
export const PLAYLIST_SEGMENTS: ReadonlyArray<number> = [15, 16, 30, 31];

/**
 * PubSub `RECONNECT`: 5 in run4h, one per connection within 4 minutes (a server roll-out), none in
 * run37min. The new connection listened 1.670–2.335 s after it.
 */
export const RECONNECT_GAP: { readonly min: Millis; readonly max: Millis } = {
  min: 1_670,
  max: 2_335,
};

/**
 * Frames per hour for 100 followed channels (run4h; the miner follows channels it found live, so
 * `stream-down` outnumbers `stream-up`). `settings` counts every `broadcast-settings-update`;
 * `gameChange` the ones that changed the game, the only ones that reach the core.
 */
export const CHANNEL_FRAMES_PER_HOUR = {
  streamUp: 3.5,
  streamDown: 11,
  settings: 27.5,
  gameChange: 2.25,
} as const;

/** Share of `stream-down` frames within 60 s of the previous one, on another channel (10 of 43). */
export const DOWN_BURST_SHARE = 10 / 43;

/** A drop no answer lists, credited beside Apex (run4h): 900 minutes required. */
export const HIDDEN_DROP_MINUTES = 900;
