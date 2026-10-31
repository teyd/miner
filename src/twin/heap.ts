import { Effect } from "effect";
import type { MemorySample } from "../platform/memory.ts";
import { DEFAULT_GOAL_SPEC, type Fault, type Scenario } from "./scenario.ts";
import type { Plant } from "./process.ts";
import { runScenario, type RunResult } from "./sim.ts";

/**
 * A simulated week with the heap sampled after a forced collection every few hours (research 03
 * §2): a leak shows up as an unbounded fiber, map or cache, which a week finds without waiting one.
 */

export const DAY_MINUTES = 1440;
export const WEEK_MINUTES = 7 * DAY_MINUTES;
const CAMPAIGN_EVERY = 42 * 60;

const live = { dropsEnabled: true, refuses: false, liveAtStart: true } as const;

/**
 * What a process meets in a week of uptime, within a capsule's bounds (14 faults): a PubSub
 * `RECONNECT` every day, API errors, lost frames, an edge outage, stalled playlists, a crash.
 */
const weekFaults: ReadonlyArray<Fault> = [
  ...Array.from({ length: 7 }, (_, day): Fault => ({
    kind: "pubsub-reconnect",
    atMinute: day * DAY_MINUTES + 200,
  })),
  ...[1, 3, 5].map((day): Fault => ({
    kind: "http-5xx",
    operation: "any",
    atMinute: day * DAY_MINUTES + 400,
    durationSeconds: 120,
  })),
  { kind: "frames-down", atMinute: 2 * DAY_MINUTES + 700, durationSeconds: 600 },
  { kind: "crash", atMinute: 3 * DAY_MINUTES + 30, point: "after-persist" },
  { kind: "pubsub-outage", atMinute: 4 * DAY_MINUTES + 1000, durationSeconds: 90 },
  { kind: "timeout", operation: "playlist", atMinute: 6 * DAY_MINUTES + 1200, durationSeconds: 60 },
];

/**
 * Four two-day campaigns, each opening 42 h after the one before, with 32 h of drops: the miner
 * watches most of the week and claims a drop or two a day. Two games, a crowd of 80 channels on
 * several sockets and 14 games of other campaigns (directory reads per catalog read, as live on
 * 2026-10-30), one channel that goes down for a while on each of the first three days. Cut to
 * `horizonMinutes`.
 */
export const weekScenario = (horizonMinutes: number = WEEK_MINUTES): Scenario => ({
  latencySeed: 7,
  horizonMinutes,
  inventoryLagMinutes: 1,
  settings: { goals: [DEFAULT_GOAL_SPEC] },
  campaigns: [0, 1, 2, 3]
    .map((i) => ({
      game: i % 2,
      startMinute: i * CAMPAIGN_EVERY - 10,
      durationMinutes: 2 * DAY_MINUTES,
      linked: true,
      allowList: [],
      drops: [
        { requiredMinutes: 120, after: null, benefit: "DIRECT_ENTITLEMENT" as const },
        { requiredMinutes: 900, after: 0, benefit: "BADGE" as const },
        { requiredMinutes: 900, after: 1, benefit: "EMOTE" as const },
      ],
    }))
    .filter((c, i) => i === 0 || c.startMinute < horizonMinutes),
  channels: [
    {
      ...live,
      game: 0,
      viewers: 10_000,
      changes: [0, 1, 2].flatMap((day) => [
        { atMinute: day * DAY_MINUTES + 300, to: "down" as const },
        { atMinute: day * DAY_MINUTES + 400, to: "up" as const },
      ]),
    },
    { ...live, game: 1, viewers: 50, changes: [] },
  ],
  crowd: { count: 80 },
  otherGames: 14,
  faults: weekFaults.filter((f) => f.atMinute < horizonMinutes),
});

export interface HeapSample {
  readonly minute: number;
  readonly memory: MemorySample;
}

/**
 * What the heap may do in a week. `growthBytes` bounds the heap used at the end over the heap used
 * after the first day, when every code path has run once: a leak of 1 KB a simulated minute is
 * 9 MB. `heapUsedBytes` bounds every sample, the twin's heap and a test runner's included: the
 * bundle's `miner sim --heap` measured 16 MB, flat to 0.3 MB, on 2026-10-31 (research 03 §2).
 */
export const HEAP_LIMITS = { growthBytes: 6_000_000, heapUsedBytes: 128_000_000 } as const;

/** Whether a run stayed within `HEAP_LIMITS`: why not, or `undefined`. */
export const overLimits = (run: HeapRun): string | undefined => {
  const peak = Math.max(...run.samples.map((s) => s.memory.heapUsed));
  if (run.growthBytes >= HEAP_LIMITS.growthBytes) {
    return `the heap grew ${run.growthBytes} bytes after the first day (limit ${HEAP_LIMITS.growthBytes})`;
  }
  if (peak >= HEAP_LIMITS.heapUsedBytes) {
    return `the heap held ${peak} bytes (limit ${HEAP_LIMITS.heapUsedBytes})`;
  }
  return undefined;
};

export interface HeapRun {
  readonly result: RunResult;
  readonly samples: ReadonlyArray<HeapSample>;
  /** Heap used at the last sample over the first one at or after a day. */
  readonly growthBytes: number;
}

export const runHeapWeek = (
  sample: Effect.Effect<MemorySample>,
  options?: {
    readonly horizonMinutes?: number;
    readonly everyMinutes?: number;
    /** A bug to plant, as `sim.test.ts` does: the test plants a leak. */
    readonly plant?: Plant;
  },
): Effect.Effect<HeapRun> =>
  Effect.gen(function* () {
    const samples: Array<HeapSample> = [];
    const result = yield* runScenario(weekScenario(options?.horizonMinutes), {
      ...(options?.plant === undefined ? {} : { plant: options.plant }),
      probe: {
        everyMinutes: options?.everyMinutes ?? 360,
        run: (minute) => Effect.map(sample, (memory) => void samples.push({ minute, memory })),
      },
    });
    const settled = samples.find((s) => s.minute >= DAY_MINUTES) ?? samples[0];
    const last = samples.at(-1);
    const growthBytes =
      settled === undefined || last === undefined
        ? 0
        : last.memory.heapUsed - settled.memory.heapUsed;
    return { result, samples, growthBytes };
  });
