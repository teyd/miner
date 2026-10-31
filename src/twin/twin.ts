import { Clock, Context, Effect, Random } from "effect";
import type { ChannelId, DropId, DropInstanceId, Millis } from "../core/model.ts";
import type { Command } from "../core/protocol.ts";
import { REQUEST_TIMEOUT } from "../twitch/Twitch.ts";
import type { Operation } from "./scenario.ts";
import { SIM_EPOCH } from "./scenario.ts";
import type { TwinWebSocket } from "./edge.ts";
import type { Credit, World } from "./world.ts";

/**
 * One run's twin: Twitch's world, and what the twin saw since the simulator last looked. Its
 * HTTP surface (`http.ts`: GQL, usher, playlists, segments) and its PubSub edge (`edge.ts`) share
 * it. Mutated only from Effect code on the one JS thread, so every change happens at a virtual
 * instant the scheduler decides.
 */

/** A hung request: the client's own timeout must give up (Twitch's API: `REQUEST_TIMEOUT`). */
export const TWIN_TIMEOUT: Millis = REQUEST_TIMEOUT;

/**
 * Twitch's per-IP limits as the twin enforces them: about 5 GQL requests a second and about 10
 * websockets (DevilXD, TDM #1153, 2026-08-29; research 02 §4b), 50 topics each (TDM
 * `WS_TOPICS_LIMIT`). A GQL request above the rate is answered 429; the edge refuses a socket
 * above the count (`edge.ts`), and the topics it would carry are never heard.
 */
export const TWITCH_GQL_PER_SECOND = 5;
export const TWITCH_SOCKETS = 10;
export const TWITCH_TOPICS_PER_SOCKET = 50;

/** The token the simulated process holds, unless a test gives the twin another. */
export const TWIN_TOKEN = "twin-token";

/**
 * The core command a request was sent for, set by the simulator around each command's fiber. The
 * twin reads it to tell a request the miner sent from one it leaked (`orphans`), and to know what
 * each `WatchTick` saw.
 */
export interface Issue {
  readonly id: number;
  readonly command: Command;
  readonly at: Millis;
}

export const Issued = Context.Reference<Issue | undefined>("miner/twin/Issued", {
  defaultValue: () => undefined,
});

export interface TwinRequest {
  readonly at: Millis;
  readonly endedAt: Millis;
  readonly operation: Operation;
  readonly status: number | "timeout" | "lost";
  /** Answered 429 because the miner went over `TWITCH_GQL_PER_SECOND`, not by a fault window. */
  readonly limited: boolean;
}

export type ActuatorCall =
  | {
      /** A beat: a media playlist and a `HEAD` of each of its segments, as the CDN saw them. */
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
      /** The twin sent an answer: 200 with a payload. A fault, a lost answer or a crash sent none. */
      readonly answered: boolean;
      readonly outcome: string;
    }
  | {
      /** A socket opened, or a frame the client sent on one. */
      readonly kind: "pubsub";
      readonly at: Millis;
      readonly socket: number;
      readonly frame: string;
    };

export interface Activity {
  readonly requests: Array<TwinRequest>;
  readonly calls: Array<ActuatorCall>;
  readonly credits: Array<Credit>;
  /** Channel frames the edge delivered to at least one socket listening to them. */
  readonly delivered: Array<{ readonly at: Millis; readonly channelId: ChannelId }>;
  /** Requests no command in flight sent, and requests that broke a rule of Twitch's: violations. */
  readonly orphans: Array<string>;
  readonly leaks: Array<string>;
  /** Requests and LISTENs that carried no token or one the twin never issued. */
  readonly wrongTokens: Array<string>;
  /** CDN requests without the identity headers the browser player sends. */
  readonly identity: Array<string>;
  /** Sockets that a `RECONNECT` asked to go and that stayed, or that never came back. */
  readonly reconnects: Array<{
    readonly socket: number;
    /** When the edge sent the `RECONNECT`, and when it looked for the client's answer. */
    readonly at: Millis;
    readonly checkedAt: Millis;
    readonly closed: boolean;
    readonly reconnected: boolean;
    /** Sockets open when the edge looked. */
    readonly remaining: number;
  }>;
  /** Socket and topic limits the client went past. */
  readonly budget: Array<string>;
  /** Sockets the client closed; `excused` when the edge or a stopping process gave it cause. */
  readonly closes: Array<{
    readonly at: Millis;
    readonly socket: number;
    readonly excused: boolean;
    /** Sockets still open after it closed. */
    readonly remaining: number;
  }>;
  /** `WatchTick`s whose event disagrees with what the twin answered them. */
  readonly misreads: Array<string>;
}

/**
 * What the twin answered under one `WatchTick`: how Twitch would classify its last answer, and
 * whether it saw a whole beat. The command's event must agree (`WatchMisread`).
 */
export type Label = "ok" | "offline" | "refused" | "network" | "auth";

export interface TickView {
  label: Label | undefined;
  beat: boolean;
}

/** The CDN's memory: playback tokens it issued, and the beat each channel's player is in. */
export interface Cdn {
  readonly tokens: Map<
    string,
    {
      readonly login: string;
      readonly channelId: ChannelId;
      readonly expiresAt: Millis;
      /** The token's `value`, which usher wants beside its signature. */
      readonly value: string;
    }
  >;
  nextToken: number;
  readonly beats: Map<
    ChannelId,
    {
      readonly startedAt: Millis;
      readonly remaining: Set<string>;
      readonly issued: Issue | undefined;
    }
  >;
}

/** Something the edge does at a set time: deliver a frame, or a fault. */
export interface Scheduled {
  readonly at: Millis;
  readonly seq: number;
  readonly run: (twin: Twin, now: Millis) => void;
}

export interface Edge {
  /** Open sockets by id. */
  readonly sockets: Map<number, TwinWebSocket>;
  nextSocket: number;
  /** Sorted by time, then by when it was scheduled. */
  pending: Array<Scheduled>;
  seq: number;
  /** Wakes the edge's pump when something was scheduled earlier than it sleeps. */
  wake: () => void;
  /** The process is stopping: its sockets close for that. */
  stopping: boolean;
  /** Processes stopped so far: a `RECONNECT` owed by a stopped one is void. */
  stops: number;
}

export interface Twin {
  world: World;
  /** The OAuth token the account holds: the API and the edge accept only it. */
  readonly token: string;
  /**
   * A test that sends requests itself, with no command around them. The simulator's twin is
   * never direct: there a request no command sent is an `Orphan`.
   */
  readonly direct: boolean;
  activity: Activity;
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
  readonly cdn: Cdn;
  readonly edge: Edge;
  /** Ids of the commands in flight, kept by the simulator. */
  readonly live: Set<number>;
  readonly ticks: Map<number, TickView>;
  /** The virtual time now, for the edge's synchronous socket calls. */
  now: () => Millis;
}

export const emptyActivity = (): Activity => ({
  requests: [],
  calls: [],
  credits: [],
  delivered: [],
  orphans: [],
  leaks: [],
  wrongTokens: [],
  identity: [],
  reconnects: [],
  budget: [],
  closes: [],
  misreads: [],
});

export interface TwinOptions {
  readonly token?: string;
  readonly direct?: boolean;
}

export const makeTwin = (world: World, options?: TwinOptions): Twin => {
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
    token: options?.token ?? TWIN_TOKEN,
    direct: options?.direct ?? false,
    activity: emptyActivity(),
    lostAnswers: times("lose-claim-answer"),
    inClaimCrashes: times("crash", "in-claim"),
    crashRequested: false,
    backOffs: [],
    gqlStarts: [],
    cdn: { tokens: new Map(), nextToken: 0, beats: new Map() },
    edge: {
      sockets: new Map(),
      nextSocket: 0,
      pending: [],
      seq: 0,
      wake: () => {},
      stopping: false,
      stops: 0,
    },
    live: new Set(),
    ticks: new Map(),
    now: () => SIM_EPOCH,
  };
};

/** Lets the edge's synchronous socket calls read the virtual time of the running `Clock`. */
export const bindClock = (twin: Twin) =>
  Clock.clockWith((clock) =>
    Effect.sync(() => {
      twin.now = () => clock.currentTimeMillisUnsafe();
    }),
  );

/**
 * Counts a GQL request starting at `at` (a refused one counts too, as Twitch counts it) and says
 * whether it is over `TWITCH_GQL_PER_SECOND` in the second ending at `at`.
 */
export const overGqlRate = (twin: Twin, at: Millis): boolean => {
  twin.gqlStarts = twin.gqlStarts.filter((t) => t > at - 1_000);
  twin.gqlStarts.push(at);
  return twin.gqlStarts.length > TWITCH_GQL_PER_SECOND;
};

export const drainActivity = (twin: Twin): Activity => {
  const activity = twin.activity;
  twin.activity = emptyActivity();
  return activity;
};

/** Takes the first pending time at or before `now`, if any. */
export const takeDue = (times: Array<Millis>, now: Millis): boolean => {
  const i = times.findIndex((t) => t <= now);
  if (i === -1) return false;
  times.splice(i, 1);
  return true;
};

/** Network latency of one request, drawn from the run's seeded `Random`. */
export const latencyBetween = (min: number, max: number) =>
  Effect.flatMap(Random.nextIntBetween(min, max), (ms) => Effect.sleep(ms));

/** An API request's latency. */
export const latency = latencyBetween(100, 400);

/** Schedules `run` on the edge at `at`. */
export const schedule = (twin: Twin, at: Millis, run: Scheduled["run"]): void => {
  const item: Scheduled = { at, seq: twin.edge.seq++, run };
  const pending = twin.edge.pending;
  let i = pending.length;
  while (i > 0 && pending[i - 1]!.at > at) i--;
  pending.splice(i, 0, item);
  if (i === 0) twin.edge.wake();
};
