import { Clock, Context, DateTime, Effect, FileSystem, Layer, Semaphore } from "effect";
import { Gzip } from "../platform/Gzip.ts";
import { sha256 } from "../platform/Sha256.ts";
import { isSealed, redact } from "./redact.ts";

/** One Twitch answer as the miner saw it. */
export interface Answer {
  readonly operation: string;
  readonly variables: unknown;
  readonly status: number;
  readonly body: unknown;
}

/**
 * One PubSub frame on connection slot `connection`, as text. An outgoing LISTEN or UNLISTEN is
 * handed over with its `auth_token` already replaced.
 */
export interface Frame {
  readonly connection: number;
  readonly direction: "in" | "out";
  readonly text: string;
}

/**
 * One line of a recording: a Twitch answer, a PubSub frame, or a mutation the miner decided on
 * (in shadow mode, one it would have sent). Recordings feed replay and calibrate the simulator
 * (research 04 §3).
 */
export type Entry =
  | ({ readonly kind: "answer"; readonly at: number } & Answer)
  | ({ readonly kind: "frame"; readonly at: number } & Frame)
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
    readonly frame: (frame: Frame) => Effect.Effect<void>;
  }
>()("miner/twitch/Journal") {
  static readonly none = Layer.succeed(
    Journal,
    Journal.of({ record: () => Effect.void, intent: () => Effect.void, frame: () => Effect.void }),
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
   *
   * Answers are compacted (`compact`): a part of a body already written to today's file is
   * written as a reference to it, and `expandRecording` puts it back. A reference only ever
   * points at a line this process wrote to this file and saw succeed: the set of written parts
   * is filled after a write returns, emptied when the day changes, and starts empty, so neither
   * a failed or torn write, a day roll, nor a restart after a crash can leave one dangling.
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
        // The parts written to today's file, least recently used first.
        const written = new Map<string, true>();
        const remember = (ids: ReadonlyArray<string>) => {
          for (const id of ids) {
            written.delete(id);
            written.set(id, true);
          }
          // Forgetting is always safe: the part is written out again the next time it comes.
          for (const id of written.keys()) {
            if (written.size <= limits.rememberedParts) break;
            written.delete(id);
          }
        };

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
            written.clear();
          });

        const write = (entry: Entry) =>
          Effect.gen(function* () {
            const today = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(entry.at));
            if (today !== day) yield* startDay(today);
            if (full) return;
            let sealed = sealCompact(entry, secrets, limits.maxBodyChars, (id) => written.has(id));
            if (dayBytes >= limits.maxDayBytes) {
              full = true;
              const line = JSON.stringify({
                kind: "full",
                at: entry.at,
                maxDayBytes: limits.maxDayBytes,
              });
              sealed = { line, parts: [] };
              yield* Effect.logWarning(`journal: ${today} reached its budget, recording stops`);
            }
            const bytes = gzip(new TextEncoder().encode(`${sealed.line}\n`));
            yield* fs.writeFile(`${dir}/${today}${SUFFIX}`, bytes, { flag: "a" });
            dayBytes += bytes.length;
            remember(sealed.parts);
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
  /**
   * Parts of bodies the recorder remembers as written today, so it can refer to them, least
   * recently used forgotten first. About 64 bytes each. A forgotten part is written out again.
   */
  readonly rememberedParts: number;
}

const MIB = 1024 * 1024;

/**
 * Measured on the 2026-10-30 recordings (research 04 §3): a steady hour is about 280 KiB
 * compacted (800 KiB before), so about 7 MiB a day plus about 1 MiB for the first catalog read
 * of each file or restart. A week fits the budget many times over. A file gains about 3,000 parts
 * per catalog read, which repeat hourly, and about 7,000 an hour from directory pages, which
 * rarely do: 16,384 parts (about 1 MiB) keep the catalog's.
 */
export const DEFAULT_LIMITS: Limits = {
  keepDays: 7,
  maxBytes: 256 * MIB,
  maxDayBytes: 64 * MIB,
  maxBodyChars: MIB,
  rememberedParts: 16_384,
};

const SUFFIX = ".jsonl.gz";
const RECORDING = /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/;

const fromWriter = (write: (entry: Entry) => Effect.Effect<void>): Journal["Service"] => ({
  record: (answer) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => write({ kind: "answer", at, ...answer })),
  intent: (command, detail) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => write({ kind: "intent", at, command, detail })),
  frame: (frame) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => write({ kind: "frame", at, ...frame })),
});

/** The first 64 bits of a text's SHA-256, as hex: names a part or an omitted body. */
export const digest = (text: string): string => sha256(text).slice(0, 16);

/**
 * Objects and arrays whose JSON is at least this long are parts: written once per file, then
 * referred to. Measured on the 2026-10-30 recordings (research 04 §3): 128 writes 1 % less than
 * 256, 1024 a fifth more.
 */
export const PART_MIN_CHARS = 256;
/** The key of a reference. GraphQL names can't start with `$`. */
const REF = "$same";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRef = (value: unknown): value is { readonly [REF]: string } =>
  isRecord(value) && Object.keys(value).length === 1 && typeof value[REF] === "string";

const hasRefShape = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(hasRefShape)
    : isRecord(value) && (isRef(value) || Object.values(value).some(hasRefShape));

/** Rebuilds an object or array with `f` applied to each child, in order. */
const mapChildren = (value: object, f: (child: unknown) => unknown): unknown =>
  Array.isArray(value)
    ? value.map(f)
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, f(child)]));

export interface Compacted {
  readonly body: unknown;
  /** References written in place of parts. */
  readonly refs: number;
  /** Parts this body writes out or refers to: what the file holds once the line is written. */
  readonly parts: ReadonlyArray<string>;
}

/**
 * Replaces every part of `body` that `written` already holds, or that appeared earlier in this
 * body, by `{"$same": digest}`. Depth first, a part counted as written once its children are,
 * the same order `expandRecording` reads it back in. A body that already holds an object shaped
 * like a reference is left whole, so a reader never mistakes data for a reference.
 */
export const compact = (body: unknown, written: (id: string) => boolean): Compacted => {
  const literal = hasRefShape(body);
  const parts = new Set<string>();
  let refs = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const json = JSON.stringify(value);
    const id = json.length >= PART_MIN_CHARS ? digest(json) : undefined;
    if (id !== undefined && !literal && (parts.has(id) || written(id))) {
      refs++;
      parts.add(id);
      return { [REF]: id };
    }
    const out = mapChildren(value, walk);
    if (id !== undefined) parts.add(id);
    return out;
  };
  return { body: walk(body), refs, parts: [...parts] };
};

/** The line to write: redacted, the body capped, and checked by `isSealed`. */
export const seal = (entry: Entry, secrets: ReadonlyArray<string>, maxBodyChars: number): string =>
  sealCompact(entry, secrets, maxBodyChars).line;

/**
 * `seal`, then, given what the file holds (`written`), the body compacted. Both the whole line
 * and the compacted one must pass `isSealed`. A line that fails names no parts, so nothing can
 * refer to what it would have written.
 */
export const sealCompact = (
  entry: Entry,
  secrets: ReadonlyArray<string>,
  maxBodyChars: number,
  written?: (id: string) => boolean,
): { readonly line: string; readonly parts: ReadonlyArray<string> } => {
  const redacted = redact(entry) as Entry;
  let line = JSON.stringify(redacted);
  let parts: ReadonlyArray<string> = [];
  if (redacted.kind === "answer") {
    const body = JSON.stringify(redacted.body) ?? "null";
    if (body.length > maxBodyChars) {
      const omitted = {
        omitted: "body over the size cap",
        chars: body.length,
        digest: digest(body),
      };
      line = JSON.stringify({ ...redacted, body: omitted });
    } else if (written !== undefined && isSealed(line, secrets)) {
      const compacted = compact(redacted.body, written);
      parts = compacted.parts;
      if (compacted.refs > 0) {
        line = JSON.stringify({ ...redacted, body: compacted.body, refs: compacted.refs });
      }
    }
  }
  if (isSealed(line, secrets)) return { line, parts };
  return {
    line: JSON.stringify({
      kind: entry.kind,
      at: entry.at,
      ...(entry.kind === "answer"
        ? { operation: entry.operation, status: entry.status }
        : entry.kind === "frame"
          ? { connection: entry.connection, direction: entry.direction }
          : { command: entry.command }),
      omitted: "failed the redaction check",
    }),
    parts: [],
  };
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

export interface Expanded {
  /** The entries with every reference replaced by its part, and without `refs`. */
  readonly entries: ReadonlyArray<unknown>;
  /** References no earlier line defines. Left in place; the recorder never writes one. */
  readonly missing: ReadonlyArray<string>;
}

/**
 * Undoes `compact` over one file's entries, in order: every answer body's parts are noted as
 * they are read, and a line that has `refs` gets its references replaced.
 */
export const expandRecording = (entries: ReadonlyArray<unknown>): Expanded => {
  const parts = new Map<string, unknown>();
  const missing: Array<string> = [];
  const expanded = entries.map((entry) => {
    if (!isRecord(entry) || entry["kind"] !== "answer" || !("body" in entry)) return entry;
    const resolve = typeof entry["refs"] === "number";
    const walk = (value: unknown): unknown => {
      if (typeof value !== "object" || value === null) return value;
      if (resolve && isRef(value)) {
        const part = parts.get(value[REF]);
        if (part === undefined) missing.push(value[REF]);
        return part ?? value;
      }
      const out = mapChildren(value, walk);
      const json = JSON.stringify(out);
      if (json.length >= PART_MIN_CHARS) parts.set(digest(json), out);
      return out;
    };
    const { refs: _, ...rest } = entry;
    return { ...rest, body: walk(entry["body"]) };
  });
  return { entries: expanded, missing };
};
