import { Console, Effect, FileSystem, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { Gzip } from "../platform/Gzip.ts";
import { expandRecording, parseRecording } from "../twitch/journal.ts";

/** The recording can't be read, or holds a reference no earlier line defines. Exit code 1. */
export class JournalUnreadable extends Schema.TaggedError<
  JournalUnreadable,
  { readonly brand: unique symbol }
>()("JournalUnreadable", { path: Schema.String, problem: Schema.String }) {}

const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b;

/** `miner journal cat`: one recording as plain JSON lines, every answer body whole again. */
export const catRecording = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { gunzip } = yield* Gzip;
    const bytes = yield* fs
      .readFile(path)
      .pipe(Effect.mapError((e) => new JournalUnreadable({ path, problem: e.message })));
    const text = new TextDecoder().decode(isGzip(bytes) ? gunzip(bytes) : bytes);
    // `gunzip` skips members it can't inflate, so a fully corrupt file would read as empty.
    if (isGzip(bytes) && text.length === 0) {
      return yield* new JournalUnreadable({ path, problem: "no gzip member could be inflated" });
    }
    const { entries, missing } = expandRecording(parseRecording(text));
    for (const entry of entries) yield* Console.log(JSON.stringify(entry));
    if (missing.length > 0) {
      const problem = `${missing.length} references to parts no earlier line holds, left as {"$same": …}`;
      yield* Effect.logError(`${path}: ${problem}`);
      return yield* new JournalUnreadable({ path, problem });
    }
  });

const cat = Command.make(
  "cat",
  {
    file: Argument.File("file", { mustExist: true }).pipe(
      Argument.withDescription("A recording, such as $DATA_DIR/recordings/2026-10-30.jsonl.gz"),
    ),
  },
  ({ file }) => catRecording(file).pipe(Effect.provide(Gzip.layer)),
).pipe(
  Command.withDescription(
    "Print a recording as JSON lines with every answer whole, for jq or less",
  ),
);

export const journal = Command.make("journal").pipe(
  Command.withDescription("Read the flight recorder's recordings"),
  Command.withSubcommands([cat]),
);
