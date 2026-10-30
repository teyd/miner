import { Config, Effect, FileSystem, Layer, Logger, Path, References } from "effect";
import { dataDir } from "../config/load.ts";
import { redact } from "../twitch/journal.ts";

/**
 * Logs go to stderr so command output on stdout (`doctor --json`, `config schema`) stays clean.
 * `pretty` for a person at a terminal, `json` (one object per line) for Docker, journald and jq.
 * The file copy is always JSON and rotates by size, because a single binary or npx install has
 * no log driver to do it (research 03 §2).
 */
export type Format = "pretty" | "json";

export interface Line {
  readonly time: string;
  readonly level: string;
  readonly msg: unknown;
  readonly [key: string]: unknown;
}

/** Flattens Effect's structured record pino-style: annotations become top-level keys. */
const toLine = Logger.map(Logger.formatStructured, (s): Line => {
  const [first, ...rest] = Array.isArray(s.message) ? s.message : [s.message];
  const spans = Object.keys(s.spans).length > 0 ? s.spans : undefined;
  const data = rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : rest;
  return redact({
    ...s.annotations,
    time: s.timestamp,
    level: s.level,
    fiber: s.fiberId,
    msg: first,
    ...(data === undefined ? {} : { data }),
    ...(spans === undefined ? {} : { spans }),
    ...(s.cause === undefined ? {} : { cause: s.cause }),
  }) as Line;
});

export const formatJson = Logger.map(toLine, (line) => JSON.stringify(line));

const LEVEL_COLOR: Record<string, string> = {
  TRACE: "90",
  DEBUG: "34",
  INFO: "32",
  WARN: "33",
  ERROR: "31",
  FATAL: "35",
};
const RESERVED = new Set(["time", "level", "fiber", "msg", "data", "spans", "cause"]);

const show = (value: unknown): string =>
  typeof value === "string" && /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);

export const formatPretty = (colors: boolean) =>
  Logger.map(toLine, (line) => {
    const paint = (code: string, text: string) =>
      colors ? `\u001B[${code}m${text}\u001B[0m` : text;
    const fields = Object.entries(line)
      .filter(([key]) => !RESERVED.has(key))
      .map(([key, value]) => `${paint("2", `${key}=`)}${show(value)}`);
    if (line["data"] !== undefined) fields.push(`${paint("2", "data=")}${show(line["data"])}`);
    const spans = line["spans"] as Record<string, number> | undefined;
    for (const [label, ms] of Object.entries(spans ?? {}))
      fields.push(paint("2", `${label}=${ms}ms`));
    const head = [
      paint("2", line.time.slice(11, 23)),
      paint(LEVEL_COLOR[line.level] ?? "0", line.level.padEnd(5)),
      typeof line.msg === "string" ? line.msg : JSON.stringify(line.msg),
      ...fields,
    ].join(" ");
    const cause = line["cause"];
    return typeof cause === "string" ? `${head}\n${paint("31", cause)}` : head;
  });

const toStderr = <M>(self: Logger.Logger<M, string>) =>
  Logger.make<M, void>((options) => {
    process.stderr.write(`${self.log(options)}\n`);
  });

export interface Rotation {
  /** Rotate when the next write would push the file past this many bytes. */
  readonly maxBytes: number;
  /** Rotated files kept besides the live one: `miner.log.1` (newest) … `miner.log.<keep>`. */
  readonly keep: number;
  /** How long lines wait in memory before one append. Lost on a hard crash; stderr has them. */
  readonly window: number;
}

/** Fixed on purpose, not a setting: at most 60 MB on disk. Tests pass their own `Rotation`. */
export const ROTATION: Rotation = { maxBytes: 10 * 1024 * 1024, keep: 5, window: 1000 };

/**
 * A logger that appends to `file` and rotates by size. The directory and the file are created on
 * the first write, so commands that log nothing leave nothing behind. Writes are batched and run
 * one at a time (`Logger.batched` flushes from a single fiber), so rotation never races a write.
 * A failed write is dropped: logging must never take the miner down.
 */
export const rotatingFile = Effect.fnUntraced(function* <M>(
  self: Logger.Logger<M, string>,
  file: string,
  rotation: Rotation = ROTATION,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const encoder = new TextEncoder();
  let size: number | undefined;

  const currentSize = Effect.gen(function* () {
    if (size !== undefined) return size;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    size = (yield* fs.exists(file)) ? Number((yield* fs.stat(file)).size) : 0;
    return size;
  });

  const rotate = Effect.gen(function* () {
    yield* fs.remove(`${file}.${rotation.keep}`, { force: true });
    for (let n = rotation.keep - 1; n >= 1; n--) {
      if (yield* fs.exists(`${file}.${n}`)) yield* fs.rename(`${file}.${n}`, `${file}.${n + 1}`);
    }
    if (rotation.keep > 0) yield* fs.rename(file, `${file}.1`);
    else yield* fs.remove(file, { force: true });
    size = 0;
  });

  const append = (lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      for (const line of lines) {
        const bytes = encoder.encode(`${line}\n`);
        const now = yield* currentSize;
        if (now > 0 && now + bytes.length > rotation.maxBytes) yield* rotate;
        yield* fs.writeFile(file, bytes, { flag: "a" });
        size = (size ?? 0) + bytes.length;
      }
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          size = undefined;
        }),
      ),
    );

  return yield* Logger.batched(self, { window: rotation.window, flush: append });
});

export const LogFormat = Config.Literals(["pretty", "json"], "LOG_FORMAT").pipe(Config.option);
export const LogLevel = Config.LogLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const));
export const LogFile = Config.Boolean("LOG_FILE").pipe(Config.withDefault(true));

/**
 * The miner's loggers, replacing Effect's default. `LOG_FORMAT` unset picks `pretty` when
 * stderr is a terminal and `json` otherwise, which is the whole dev/prod switch.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const level = yield* LogLevel;
    const chosen = yield* LogFormat;
    const tty = process.stderr.isTTY === true;
    const format: Format = chosen._tag === "Some" ? chosen.value : tty ? "pretty" : "json";
    const stderr = toStderr(format === "pretty" ? formatPretty(tty) : formatJson);
    const loggers = (yield* LogFile)
      ? [stderr, rotatingFile(formatJson, `${yield* dataDir}/logs/miner.log`)]
      : [stderr];
    return Layer.merge(Logger.layer(loggers), Layer.succeed(References.MinimumLogLevel, level));
  }),
);
