import { Effect, Random } from "effect";
import type { ChannelId, DropId, DropInstanceId, Millis } from "../core/model.ts";
import { TOKEN_MARGIN } from "../twitch/hls.ts";
import { REQUEST_TIMEOUT } from "../twitch/Twitch.ts";
import type { Operation } from "./scenario.ts";
import { SIM_EPOCH } from "./scenario.ts";
import { framesDownAt, type Credit, type Frame, type World } from "./world.ts";

/**
 * One run's twin: the world plus what the twin saw since the simulator last looked. The HTTP
 * client and the actuator share it. Mutated only inside `Effect.sync`, on one fiber at a time.
 */

/**
 * A `timeout` fault: the reads hang until `Twitch`'s own timeout gives up; an actuator call fails
 * after this long, as the live actuator's request timeout would make it.
 */
export const TWIN_TIMEOUT: Millis = REQUEST_TIMEOUT;

/**
 * Twitch's per-IP limits as the twin enforces them: about 5 GQL requests a second and about 10
 * websockets (DevilXD, TDM #1153, 2026-08-29; research 02 §4b), 50 topics each (TDM
 * `WS_TOPICS_LIMIT`). A GQL request above the rate is answered 429, a socket above the count is
 * refused, and the topics it would carry are never heard.
 */
export const TWITCH_GQL_PER_SECOND = 5;
export const TWITCH_SOCKETS = 10;
export const TWITCH_TOPICS_PER_SOCKET = 50;

/**
 * The requests one typed watch tick stands for: a media playlist and a `HEAD` of each of its
 * 15–16 segments (live run 2026-10-30, research 02 §4).
 */
export const TICK_REQUESTS = 17;

/**
 * A playback token lives 20 minutes (live 2026-10-30, `hls.ts`) and the HLS method fetches a new
 * one `TOKEN_MARGIN` early: a tick that resolves the stream (the first of a session, one after a
 * failure, one every 19 minutes) also sends the token request (GQL) and usher (one more CDN
 * request).
 */
export const TOKEN_REFRESH: Millis = 20 * 60_000 - TOKEN_MARGIN;

export interface TwinRequest {
  readonly at: Millis;
  readonly endedAt: Millis;
  /** The playback token is a GQL request no fault window targets. */
  readonly operation: Operation | "PlaybackAccessToken";
  readonly status: number | "timeout";
  /** Answered 429 because the miner went over `TWITCH_GQL_PER_SECOND`, not by a fault window. */
  readonly limited: boolean;
}

export type ActuatorCall =
  | { readonly kind: "watch"; readonly at: Millis; readonly channelId: ChannelId }
  | { readonly kind: "stop"; readonly at: Millis }
  | {
      readonly kind: "subscribe";
      readonly at: Millis;
      readonly channelIds: ReadonlyArray<ChannelId>;
      /** Sockets PubSub needs for these channels; above `TWITCH_SOCKETS` the rest is refused. */
      readonly sockets: number;
    }
  | {
      readonly kind: "tick";
      readonly at: Millis;
      readonly endedAt: Millis;
      readonly channelId: ChannelId;
      readonly result: string;
      /** CDN requests the tick stands for: usher too when it resolved the stream. */
      readonly requests: number;
    }
  | {
      readonly kind: "claim";
      readonly at: Millis;
      readonly endedAt: Millis;
      readonly instanceId: DropInstanceId;
      readonly dropId: DropId | undefined;
      /** The twin had already applied a claim of this drop when this attempt arrived. */
      readonly alreadyApplied: boolean;
      readonly applied: boolean;
      readonly outcome: string;
      /** Answered 429 because the miner went over `TWITCH_GQL_PER_SECOND`. */
      readonly limited: boolean;
    };

export interface Activity {
  readonly requests: Array<TwinRequest>;
  readonly calls: Array<ActuatorCall>;
  readonly credits: Array<Credit>;
}

export interface Twin {
  world: World;
  activity: Activity;
  /** Frames waiting for the simulator's inbox. */
  frames: Array<Frame>;
  /** Times of `lose-claim-answer` faults not yet used by a claim. */
  lostAnswers: Array<Millis>;
  /** Times of `in-claim` crashes not yet triggered. */
  inClaimCrashes: Array<Millis>;
  /** Set by a claim that hit an `in-claim` crash; the simulator crashes the process. */
  crashRequested: boolean;
  /** When the simulator must back the API budget off for a begun `gql-cooldown`, ascending. */
  backOffs: Array<Millis>;
  /** Starts of GQL requests in the last second, the twin's own count for its 429s. */
  gqlStarts: Array<Millis>;
  /** The stream the miner's watch resolved: for which session, and until when. */
  stream:
    | { readonly openedAt: Millis; readonly channelId: ChannelId; readonly until: Millis }
    | undefined;
}

const emptyActivity = (): Activity => ({ requests: [], calls: [], credits: [] });

export const makeTwin = (world: World): Twin => {
  const times = (kind: string, point?: string) =>
    world.faults
      .flatMap((f) =>
        f.kind === kind && (point === undefined || ("point" in f && f.point === point))
          ? [SIM_EPOCH + f.atMinute * 60_000]
          : [],
      )
      .toSorted((a, b) => a - b);
  return {
    world,
    activity: emptyActivity(),
    frames: [],
    lostAnswers: times("lose-claim-answer"),
    inClaimCrashes: times("crash", "in-claim"),
    crashRequested: false,
    backOffs: [],
    gqlStarts: [],
    stream: undefined,
  };
};

/**
 * Counts a GQL request starting at `at` (a refused one counts too, as Twitch counts it) and says
 * whether it is over `TWITCH_GQL_PER_SECOND` in the second ending at `at`. Call in `Effect.sync`.
 */
export const overGqlRate = (twin: Twin, at: Millis): boolean => {
  twin.gqlStarts = twin.gqlStarts.filter((t) => t > at - 1_000);
  twin.gqlStarts.push(at);
  return twin.gqlStarts.length > TWITCH_GQL_PER_SECOND;
};

/** Sockets PubSub needs to follow `channels`: two topics each, plus the account's drop topic. */
export const socketsFor = (channels: number): number =>
  channels === 0 ? 0 : Math.ceil((2 * channels + 1) / TWITCH_TOPICS_PER_SOCKET);

/** Frames sent while PubSub is down never arrive. */
export const emit = (twin: Twin, frames: ReadonlyArray<Frame>): void => {
  for (const frame of frames) if (!framesDownAt(twin.world, frame.at)) twin.frames.push(frame);
};

export const drainActivity = (twin: Twin): Activity => {
  const activity = twin.activity;
  twin.activity = emptyActivity();
  return activity;
};

export const drainFrames = (twin: Twin): ReadonlyArray<Frame> => {
  const frames = twin.frames;
  twin.frames = [];
  return frames;
};

/** Takes the first pending time at or before `now`, if any. */
export const takeDue = (times: Array<Millis>, now: Millis): boolean => {
  const i = times.findIndex((t) => t <= now);
  if (i === -1) return false;
  times.splice(i, 1);
  return true;
};

/** Network latency of one request or call, drawn from the run's seeded `Random`. */
export const latency = Effect.flatMap(Random.nextIntBetween(100, 400), (ms) => Effect.sleep(ms));
