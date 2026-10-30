import { Config, Console, Effect, FileSystem, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { Capsule, type Violation } from "../twin/scenario.ts";
import { runSeeds, runTwice, type SeedOptions } from "../twin/sim.ts";

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

export interface SimInput {
  readonly seed: number;
  readonly seeds: number;
  /** A capsule file. When set, the seeds are ignored. */
  readonly trace: Option.Option<string>;
  readonly json: boolean;
}

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
    if (json) {
      yield* Console.log(
        JSON.stringify(
          { ok: failures.length === 0, seeds: { first, count }, passed, failures },
          null,
          2,
        ),
      );
    } else {
      for (const capsule of failures) {
        yield* Console.log(`seed ${capsule.seed}: ${describe(capsule.violation)}`);
      }
      yield* Console.log(`${count} seeds, ${passed} passed, ${failures.length} failed`);
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

/** `miner sim`, with the core under test injectable so tests can plant a bug. */
export const simulate = (input: SimInput, options?: SeedOptions) =>
  Option.match(input.trace, {
    onNone: () => sweep(input.seed, input.seeds, input.json, options),
    onSome: (path) => replay(path, input.json, options),
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
  ]),
);
