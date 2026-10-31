import { Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { load } from "../config/load.ts";
import { compareText } from "../core/plan.ts";
import * as Memory from "../platform/memory.ts";
import { sha256 } from "../platform/Sha256.ts";
import { STATUS_FILE } from "../runtime/status.ts";
import { HEAP_LIMITS, overLimits, runHeapWeek } from "../twin/heap.ts";
import { Capsule, type Violation } from "../twin/scenario.ts";
import { scenarioOfSeed, shadowOverTwin } from "../twin/shadow.ts";
import { runSeeds, runTwice, type SeedOptions, type SeedResult } from "../twin/sim.ts";
import { ConfigInvalid } from "./config.ts";

/** An invariant failed, or a capsule still fails. Exit code 1. */
export class SimFailed extends Schema.TaggedError<SimFailed, { readonly brand: unique symbol }>()(
  "SimFailed",
  { failures: Schema.Int },
) {}

/** The `--trace` file is not a capsule. Exit code 2, like a usage error. */
export class SimTraceInvalid extends Schema.TaggedError<
  SimTraceInvalid,
  { readonly brand: unique symbol }
>()("SimTraceInvalid", { path: Schema.String, problem: Schema.String }) {}

/** `--shadow` was given a directory that holds more than a `config.json`. Exit code 2. */
export class SimShadowRefused extends Schema.TaggedError<
  SimShadowRefused,
  { readonly brand: unique symbol }
>()("SimShadowRefused", { path: Schema.String, problem: Schema.String }) {}

export interface SimInput {
  readonly seed: number;
  readonly seeds: number;
  /** A capsule file. When set, the seeds are ignored. */
  readonly trace: Option.Option<string>;
  readonly json: boolean;
  /** A scratch data directory: run `run --shadow` over the twin there instead of checking seeds. */
  readonly shadow?: Option.Option<string>;
  /** Virtual minutes of the shadow run. */
  readonly minutes?: number;
  /** Run the simulated week of `heap.ts` instead, sampling memory. */
  readonly heap?: boolean;
}

/** The default length of a shadow run over the twin, in virtual minutes. */
export const SHADOW_MINUTES = 60;

/**
 * One hash over every seed's trace digest. Two sweeps of the same seeds agree on it exactly when
 * every seed's trace does, so a refactor that should change no behaviour keeps it.
 */
export const sweepDigest = (results: ReadonlyArray<SeedResult>): string =>
  sha256(
    results
      .map((r) =>
        r._tag === "Passed" ? `${r.seed} ${r.digest}` : `${r.capsule.seed} ${r.capsule.digest}`,
      )
      .join("\n"),
  ).slice(0, 16);

const describe = (v: Violation) => `${v.kind} at +${v.at}m: ${v.detail}`;

const decodeCapsule = Schema.decodeUnknownEffect(Schema.fromJsonString(Capsule));

const readCapsule = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const invalid = (problem: string) =>
      Effect.flatMap(
        Console.log(`${path}: not a capsule (${problem})`),
        () => new SimTraceInvalid({ path, problem }),
      );
    const text = yield* fs.readFileString(path).pipe(Effect.catch((e) => invalid(e.message)));
    return yield* decodeCapsule(text).pipe(Effect.catch((e) => invalid(e.message)));
  });

const replay = (path: string, json: boolean, options: SeedOptions | undefined) =>
  Effect.gen(function* () {
    const capsule = yield* readCapsule(path);
    const result = yield* runTwice(capsule.scenario, options);
    const digestMatches = result.digest === capsule.digest;
    const ok = result.violation === undefined;
    if (json) {
      const violation = result.violation ?? null;
      yield* Console.log(
        JSON.stringify({ ok, digest: result.digest, digestMatches, violation }, null, 2),
      );
    } else {
      yield* Console.log(digestMatches ? "digest matches the capsule" : "digest changed");
      yield* Console.log(
        result.violation === undefined ? "no violation" : describe(result.violation),
      );
    }
    if (!ok) return yield* new SimFailed({ failures: 1 });
  });

const sweep = (first: number, count: number, json: boolean, options: SeedOptions | undefined) =>
  Effect.gen(function* () {
    const results = yield* runSeeds(first, count, options);
    const failures = results.flatMap((r) => (r._tag === "Failed" ? [r.capsule] : []));
    const passed = results.length - failures.length;
    // A sweep that never earns checks little: show how many seeds watched and claimed.
    const watched = results.filter((r) => r._tag === "Passed" && r.creditedMinutes > 0).length;
    const claimed = results.filter((r) => r._tag === "Passed" && r.claimsApplied > 0).length;
    // And how many had a request budget refuse each kind of command, so refusals stay reached.
    const refused: Record<string, number> = {};
    for (const r of results) {
      if (r._tag === "Passed") for (const tag of r.refused) refused[tag] = (refused[tag] ?? 0) + 1;
    }
    const digests = Object.fromEntries(
      results.map((r) =>
        r._tag === "Passed"
          ? [String(r.seed), r.digest]
          : [String(r.capsule.seed), r.capsule.digest],
      ),
    );
    const combined = sweepDigest(results);
    const refusedLine = Object.entries(refused)
      .toSorted(([a], [b]) => compareText(a, b))
      .map(([tag, n]) => `${tag} ${n}`)
      .join(", ");
    if (json) {
      yield* Console.log(
        JSON.stringify(
          {
            ok: failures.length === 0,
            seeds: { first, count },
            passed,
            watched,
            claimed,
            refused,
            sweepDigest: combined,
            digests,
            failures,
          },
          null,
          2,
        ),
      );
    } else {
      for (const capsule of failures) {
        yield* Console.log(`seed ${capsule.seed}: ${describe(capsule.violation)}`);
      }
      yield* Console.log(
        `${count} seeds, ${passed} passed, ${failures.length} failed; ` +
          `${watched} earned watch minutes, ${claimed} claimed a drop`,
      );
      yield* Console.log(
        `seeds where a budget refused: ${refusedLine === "" ? "none" : refusedLine}`,
      );
      yield* Console.log(`sweep digest: ${combined}`);
      for (const capsule of failures) {
        yield* Console.log(`\nseed ${capsule.seed} capsule:`);
        yield* Console.log(JSON.stringify(capsule, null, 2));
        yield* Console.log(
          `rerun: MINER_SIM_SEED=${capsule.seed} MINER_SIM_SEEDS=1 pnpm start sim`,
        );
        yield* Console.log(
          "replay: save the capsule above to a file, then pnpm start sim --trace <file>",
        );
      }
    }
    if (failures.length > 0) return yield* new SimFailed({ failures: failures.length });
  });

/** Refuses a directory with anything but a `config.json` in it: never write over a real one. */
const scratch = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(dir))) return;
    const refuse = (problem: string) =>
      Effect.flatMap(
        Console.log(`${dir}: ${problem}`),
        () => new SimShadowRefused({ path: dir, problem }),
      );
    const names = yield* fs.readDirectory(dir).pipe(Effect.catch((e) => refuse(e.message)));
    const other = names.filter((n) => n !== "config.json");
    if (other.length > 0) {
      return yield* refuse(
        `not a fresh scratch directory (holds ${other.toSorted().join(", ")}); give an empty or new one`,
      );
    }
  });

const shadowRun = (dir: string, input: SimInput, minutes: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(dir);
    yield* scratch(root);
    const loaded = yield* load(path.join(root, "config.json")).pipe(Effect.orDie);
    if (loaded._tag === "Invalid") {
      for (const p of loaded.problems)
        yield* Console.log(`${loaded.path}#${p.pointer}: ${p.message}`);
      return yield* new ConfigInvalid({ path: loaded.path });
    }
    const scenario = yield* Option.match(input.trace, {
      onNone: () => Effect.succeed(scenarioOfSeed(input.seed)),
      onSome: (file) => Effect.map(readCapsule(file), (c) => c.scenario),
    });
    const world = Option.match(input.trace, {
      onNone: () => `seed ${input.seed}`,
      onSome: (file) => `the capsule ${file}`,
    });
    const result = yield* shadowOverTwin(scenario, loaded.config, minutes);
    const written: Array<string> = [];
    for (const [name, bytes] of [...result.files].toSorted(([a], [b]) => compareText(a, b))) {
      const file = path.join(root, name);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.orDie);
      yield* fs.writeFile(file, bytes).pipe(Effect.orDie);
      written.push(name);
    }
    const ok = result.stopped === undefined;
    const recordings = written.filter((n) => n.startsWith("recordings/"));
    if (input.json) {
      yield* Console.log(
        JSON.stringify(
          {
            ok,
            dataDir: root,
            world,
            minutes,
            requests: result.requests,
            stopped: result.stopped ?? null,
            files: written,
            status: path.join(root, STATUS_FILE),
            recordings: recordings.map((n) => path.join(root, n)),
          },
          null,
          2,
        ),
      );
    } else {
      yield* Console.log(
        `shadow run over the twin of ${world}, ${minutes} virtual minutes: ${result.requests} requests`,
      );
      if (!ok) yield* Console.log(`the run stopped by itself: ${result.stopped}`);
      yield* Console.log(`wrote ${root}: ${written.join(", ")}`);
      yield* Console.log(`status: DATA_DIR=${root} miner status --json`);
      for (const r of recordings)
        yield* Console.log(`recording: miner journal cat ${path.join(root, r)}`);
    }
    if (!ok) return yield* new SimFailed({ failures: 1 });
  });

const MB = 1_000_000;
const mb = (bytes: number) => Math.round(bytes / (MB / 10)) / 10;

/** `--heap`: a simulated week, memory after a forced collection every 6 simulated hours. */
const heapWeek = (json: boolean) =>
  Effect.gen(function* () {
    const run = yield* runHeapWeek(Memory.sample);
    const over = overLimits(run);
    const ok = run.result.violation === undefined && over === undefined;
    const samples = run.samples.map((s) => ({
      minute: s.minute,
      heapUsedMB: mb(s.memory.heapUsed),
      heapTotalMB: mb(s.memory.heapTotal),
      rssMB: mb(s.memory.rss),
    }));
    const { claimsApplied, creditedMinutes, restarts } = run.result;
    if (json) {
      yield* Console.log(
        JSON.stringify(
          {
            ok,
            growthMB: mb(run.growthBytes),
            limitMB: mb(HEAP_LIMITS.growthBytes),
            over: over ?? null,
            claimsApplied,
            creditedMinutes,
            restarts,
            violation: run.result.violation ?? null,
            samples,
          },
          null,
          2,
        ),
      );
    } else {
      for (const s of samples) {
        yield* Console.log(
          `+${s.minute}m heap ${s.heapUsedMB}/${s.heapTotalMB} MB, rss ${s.rssMB} MB`,
        );
      }
      yield* Console.log(
        `a week: ${creditedMinutes} minutes credited, ${claimsApplied} claims, ${restarts} ` +
          `restart(s); heap grew ${mb(run.growthBytes)} MB after the first day ` +
          `(limit ${mb(HEAP_LIMITS.growthBytes)} MB)`,
      );
      if (over !== undefined) yield* Console.log(over);
      if (run.result.violation !== undefined) yield* Console.log(describe(run.result.violation));
    }
    if (!ok) return yield* new SimFailed({ failures: 1 });
  });

/** `miner sim`, with the core under test injectable so tests can plant a bug. */
export const simulate = (input: SimInput, options?: SeedOptions) =>
  input.heap === true
    ? heapWeek(input.json)
    : Option.match(input.shadow ?? Option.none(), {
        onSome: (dir) => shadowRun(dir, input, input.minutes ?? SHADOW_MINUTES),
        onNone: () =>
          Option.match(input.trace, {
            onNone: () => sweep(input.seed, input.seeds, input.json, options),
            onSome: (path) => replay(path, input.json, options),
          }),
      });

export const sim = Command.make(
  "sim",
  {
    seed: Flag.Int("seed").pipe(
      Flag.withDescription("The first seed"),
      Flag.withFallbackConfig(Config.Int("MINER_SIM_SEED")),
      Flag.withDefault(1),
    ),
    seeds: Flag.Int("seeds").pipe(
      Flag.withDescription("How many seeds to run, one after another"),
      Flag.withFallbackConfig(Config.Int("MINER_SIM_SEEDS")),
      Flag.withDefault(100),
    ),
    trace: Flag.String("trace").pipe(
      Flag.withDescription("Rerun the scenario of this capsule file instead of seeds"),
      Flag.withFallbackConfig(Config.String("MINER_SIM_TRACE")),
      Flag.optional,
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print one JSON document"),
      Flag.withDefault(false),
    ),
    shadow: Flag.String("shadow").pipe(
      Flag.withDescription(
        "Instead of checking seeds, run `miner run --shadow` over the twin of --seed (or of the " +
          "--trace capsule) and write its state, status.json, recordings and logs to this new or " +
          "empty directory (a config.json in it is used)",
      ),
      Flag.optional,
    ),
    minutes: Flag.Int("minutes").pipe(
      Flag.withDescription("Virtual minutes of the --shadow run"),
      Flag.withDefault(SHADOW_MINUTES),
    ),
    heap: Flag.Boolean("heap").pipe(
      Flag.withDescription(
        "Instead of seeds, mine a simulated week and sample the heap every 6 simulated hours " +
          "after a forced collection; exit 1 if it grows",
      ),
      Flag.withDefault(false),
    ),
  },
  (input) => simulate(input),
).pipe(
  Command.withDescription(
    "Run the miner's core against a simulated Twitch, checking its invariants after every step. " +
      "Exit 1 on a violation, with a capsule to replay it. Talks to no one.",
  ),
  Command.withExamples([
    { command: "miner sim", description: "Seeds 1-100" },
    { command: "miner sim --seed 17 --seeds 1", description: "One seed" },
    { command: "miner sim --trace capsule.json", description: "Replay a failure" },
    {
      command: "miner sim --seed 3 --shadow /tmp/miner-shadow",
      description: "A shadow run over seed 3's twin, its files in /tmp/miner-shadow",
    },
    { command: "miner sim --heap", description: "A simulated week with a heap bound" },
  ]),
);
