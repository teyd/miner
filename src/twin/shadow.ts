import { Effect, Fiber, Layer, Logger, Random, References } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import fc from "fast-check";
import type { Config } from "../config/schema.ts";
import { MINUTE } from "../core/model.ts";
import { Gzip } from "../platform/Gzip.ts";
import { Instance } from "../platform/instance.ts";
import { formatJson } from "../platform/logging.ts";
import { run } from "../runtime/run.ts";
import { shadowLayer } from "../runtime/shadow.ts";
import { memoryFileSystem } from "../store/memoryFileSystem.ts";
import { Connector } from "../twitch/PubSub.ts";
import { channelFrames, buildWorld } from "./world.ts";
import { runEdge, scheduleFaults, sendFrames, webSocketConstructor } from "./edge.ts";
import { twinCredentials, twinHttp } from "./http.ts";
import { scenarioArbitrary, SIM_EPOCH, type Scenario } from "./scenario.ts";
import { bindClock, makeTwin } from "./twin.ts";

/**
 * `miner run --shadow` over the twin (verify-miner's launch step, decision 13): the real run loop,
 * `shadowLayer` and its recorder, status writer and state file, with the twin as Twitch, under
 * `TestClock` and an in-memory disk so the same scenario writes the same bytes every time. The
 * caller copies the files into a scratch `DATA_DIR`, where `miner status`, `miner journal cat` and
 * a person read them as they would a real shadow run's.
 */

/** Where the run's files live on the in-memory disk; `files` keys are relative to it. */
const DIR = "/data";

/** The version and pid `status.json` names: fixed, so the output is a function of the scenario. */
export const SHADOW_INSTANCE = { version: "0.0.0-twin", pid: 1 } as const;

/**
 * The scenario `miner sim --seed N` runs first for seed N: fast-check's first sample for that seed.
 * A test checks they agree, so a shadow run and a sweep talk about the same world.
 */
export const scenarioOfSeed = (seed: number): Scenario =>
  fc.sample(scenarioArbitrary, { seed, numRuns: 1 })[0]!;

export interface ShadowOverTwin {
  /** Path relative to the data directory, and its bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The run stopped by itself before the end (a `RunFailed` reason), or `undefined`. */
  readonly stopped: string | undefined;
  /** Requests the miner sent the twin, and claims it would have made. */
  readonly requests: number;
}

/**
 * Runs `config` for `minutes` of virtual time from the scenario's start. Faults and channel frames
 * follow the scenario; crashes are the simulator's business and do not happen here.
 */
export const shadowOverTwin = (
  scenario: Scenario,
  config: Config,
  minutes: number,
): Effect.Effect<ShadowOverTwin> => {
  const disk = memoryFileSystem();
  const logs: Array<string> = [];
  // Fiber ids count every fiber the process ever made, so they would differ between two runs.
  const capture = Logger.map(formatJson, (line) => {
    const { fiber: _, ...rest } = JSON.parse(line) as Record<string, unknown>;
    logs.push(JSON.stringify(rest));
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(SIM_EPOCH);
    const world = buildWorld(scenario);
    const twin = makeTwin(world, { direct: true });
    yield* bindClock(twin);
    scheduleFaults(twin);
    sendFrames(twin, channelFrames(world, SIM_EPOCH, SIM_EPOCH + minutes * MINUTE));
    yield* Effect.forkScoped(runEdge(twin));
    const services = shadowLayer(DIR).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, twinHttp(twin)),
          twinCredentials(twin),
          Connector.webSocket.pipe(Layer.provide(webSocketConstructor(twin))),
          Gzip.layer,
          Layer.succeed(Instance, Instance.of(SHADOW_INSTANCE)),
          disk.layer,
        ),
      ),
    );
    const fiber = yield* Effect.forkChild(run(config).pipe(Effect.provide(services)));
    // One-second steps, as the runtime's own tests take: every timer fires at its instant.
    for (let t = 0; t < minutes * MINUTE && fiber.pollUnsafe() === undefined; t += 1000) {
      yield* TestClock.adjust(1000);
    }
    const early = fiber.pollUnsafe();
    twin.edge.stopping = true;
    yield* Fiber.interrupt(fiber);
    const files = new Map<string, Uint8Array>();
    for (const [path, bytes] of disk.files) {
      if (path.startsWith(`${DIR}/`)) files.set(path.slice(DIR.length + 1), bytes);
    }
    if (logs.length > 0) {
      files.set("logs/miner.log", new TextEncoder().encode(`${logs.join("\n")}\n`));
    }
    const stopped =
      early === undefined
        ? undefined
        : early._tag === "Success"
          ? "the run ended by itself"
          : String(early.cause);
    return { files, stopped, requests: twin.activity.requests.length };
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(TestClock.layer(), Logger.layer([capture]))),
    Effect.provideService(References.MinimumLogLevel, "Info"),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Random.withSeed(scenario.latencySeed),
  );
};
