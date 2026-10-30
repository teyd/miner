import { Clock, Context, DateTime, Effect, FileSystem, Layer, Semaphore } from "effect";
import { Gzip } from "../platform/Gzip.ts";
import { isSealed, redact } from "./redact.ts";

/** One Twitch answer as the miner saw it. */
export interface Answer {
  readonly operation: string;
  readonly variables: unknown;
  readonly status: number;
  readonly body: unknown;
}

/**
 * One line of a recording: a Twitch answer, or a mutation the miner decided on (in shadow mode,
 * one it would have sent). Recordings feed replay and calibrate the simulator (research 04 §3).
 */
export type Entry =
  | ({ readonly kind: "answer"; readonly at: number } & Answer)
  | {
      readonly kind: "intent";
      readonly at: number;
      readonly command: string;
      readonly detail: unknown;
    };

/**
 * Records at the Twitch seam. Recordings go into issues, so a line that may hold a secret is
 * never written (`isSealed`). Recording never fails the miner: a failed write is logged.
 */
export class Journal extends Context.Service<
  Journal,
  {
    readonly record: (answer: Answer) => Effect.Effect<void>;
    readonly intent: (command: string, detail: unknown) => Effect.Effect<void>;
  }
>()("miner/twitch/Journal") {
  static readonly none = Layer.succeed(
    Journal,
    Journal.of({ record: () => Effect.void, intent: () => Effect.void }),
  );

  /** Appends plain JSON lines to one file, as `doctor --record` does. */
  static readonly file = (path: string, secrets: ReadonlyArray<string> = []) =>
    Layer.effect(
      Journal,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const write = (entry: Entry) =>
          fs
            .writeFileString(path, `${seal(entry, secrets, DEFAULT_LIMITS.maxBodyChars)}\n`, {
              flag: "a",
            })
            .pipe(Effect.catch((error) => Effect.logWarning("journal: write failed", error)));
        return Journal.of(fromWriter(write));
      }),
    );

  /**
   * The flight recorder: one gzip file per UTC day in `dir`, one gzip member per line, so a
   * crash loses at most the line being written and the file needs no closing. Bounded in four
   * ways, see `Limits`. The token itself is one of the `secrets` no line may contain.
   */
  static readonly rolling = (
    dir: string,
    secrets: ReadonlyArray<string>,
    limits: Limits = DEFAULT_LIMITS,
  ) =>
    Layer.effect(
      Journal,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { gzip } = yield* Gzip;
        const lock = yield* Semaphore.make(1);
        let day: string | undefined;
        let dayBytes = 0;
        let full = false;

        const startDay = (today: string) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(dir, { recursive: true });
            const names = (yield* fs.readDirectory(dir))
              .filter((n) => RECORDING.test(n))
              .toSorted();
            const sizes = new Map<string, number>();
            for (const name of names) {
              sizes.set(name, Number((yield* fs.stat(`${dir}/${name}`)).size));
            }
            const current = `${today}${SUFFIX}`;
            const older = names.filter((n) => n !== current);
            // Today's file may still grow by `maxDayBytes`: older days get what remains.
            let total = older.reduce((sum, n) => sum + (sizes.get(n) ?? 0), 0);
            let kept = older.length;
            for (const name of older) {
              if (kept < limits.keepDays && total + limits.maxDayBytes <= limits.maxBytes) break;
              yield* fs.remove(`${dir}/${name}`);
              total -= sizes.get(name) ?? 0;
              kept--;
            }
            day = today;
            dayBytes = sizes.get(current) ?? 0;
            full = false;
          });

        const write = (entry: Entry) =>
          Effect.gen(function* () {
            const today = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(entry.at));
            if (today !== day) yield* startDay(today);
            if (full) return;
            let line = seal(entry, secrets, limits.maxBodyChars);
            if (dayBytes >= limits.maxDayBytes) {
              full = true;
              line = JSON.stringify({
                kind: "full",
                at: entry.at,
                maxDayBytes: limits.maxDayBytes,
              });
              yield* Effect.logWarning(`journal: ${today} reached its budget, recording stops`);
            }
            const bytes = gzip(new TextEncoder().encode(`${line}\n`));
            yield* fs.writeFile(`${dir}/${today}${SUFFIX}`, bytes, { flag: "a" });
            dayBytes += bytes.length;
          }).pipe(
            (effect) => lock.withPermit(effect),
            Effect.catchCause((cause) => Effect.logWarning("journal: write failed", cause)),
          );
        return Journal.of(fromWriter(write));
      }),
    );
}

export interface Limits {
  /** Days of recordings kept, today included. */
  readonly keepDays: number;
  /** All recordings together, compressed. */
  readonly maxBytes: number;
  /** One day's file, compressed. Past it, the day records nothing more. */
  readonly maxDayBytes: number;
  /** One answer's body as JSON, before compression. A larger body is replaced by its digest. */
  readonly maxBodyChars: number;
}

const MIB = 1024 * 1024;

/**
 * A shadow day is about 17 MiB compressed (about 80 MiB as plain JSON, estimated in
 * `journal.test.ts` from the recorded answers), so a week fits the budget with room to spare.
 */
export const DEFAULT_LIMITS: Limits = {
  keepDays: 7,
  maxBytes: 256 * MIB,
  maxDayBytes: 64 * MIB,
  maxBodyChars: MIB,
};

const SUFFIX = ".jsonl.gz";
const RECORDING = /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/;

const fromWriter = (write: (entry: Entry) => Effect.Effect<void>): Journal["Service"] => ({
  record: (answer) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => write({ kind: "answer", at, ...answer })),
  intent: (command, detail) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => write({ kind: "intent", at, command, detail })),
});

/** 64-bit FNV-1a in two 32-bit lanes: tells two omitted bodies apart, nothing more. */
export const digest = (text: string): string => {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x01000193);
  }
  const lane = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return lane(a) + lane(b);
};

/** The line to write: redacted, the body capped, and checked by `isSealed`. */
export const seal = (
  entry: Entry,
  secrets: ReadonlyArray<string>,
  maxBodyChars: number,
): string => {
  const redacted = redact(entry) as Entry;
  let line = JSON.stringify(redacted);
  if (redacted.kind === "answer") {
    const body = JSON.stringify(redacted.body) ?? "null";
    if (body.length > maxBodyChars) {
      const omitted = {
        omitted: "body over the size cap",
        chars: body.length,
        digest: digest(body),
      };
      line = JSON.stringify({ ...redacted, body: omitted });
    }
  }
  if (isSealed(line, secrets)) return line;
  return JSON.stringify({
    kind: entry.kind,
    at: entry.at,
    ...(entry.kind === "answer"
      ? { operation: entry.operation, status: entry.status }
      : { command: entry.command }),
    omitted: "failed the redaction check",
  });
};

/** The entries of a recording's text, skipping a line torn by a crash. */
export const parseRecording = (text: string): ReadonlyArray<unknown> =>
  text.split("\n").flatMap((line) => {
    if (line.length === 0) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
