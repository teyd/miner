import { Effect, Random } from "effect";
import type { ChannelId, DropId, DropInstanceId, Millis } from "../core/model.ts";
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

export interface TwinRequest {
  readonly at: Millis;
  readonly endedAt: Millis;
  readonly operation: Operation;
  readonly status: number | "timeout";
}

export type ActuatorCall =
  | { readonly kind: "watch"; readonly at: Millis; readonly channelId: ChannelId }
  | { readonly kind: "stop"; readonly at: Millis }
  | {
      readonly kind: "subscribe";
      readonly at: Millis;
      readonly channelIds: ReadonlyArray<ChannelId>;
    }
  | {
      readonly kind: "tick";
      readonly at: Millis;
      readonly endedAt: Millis;
      readonly channelId: ChannelId;
      readonly result: string;
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
  };
};

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
