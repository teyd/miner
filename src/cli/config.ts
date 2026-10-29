import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { configPath, jsonSchema, load, starter } from "../config/load.ts";

/** `validate` found problems. Exit code 2, like a usage error: the input is wrong, not the miner. */
export class ConfigInvalid extends Schema.TaggedError<
  ConfigInvalid,
  { readonly brand: unique symbol }
>()("ConfigInvalid", { path: Schema.String }) {}

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print one JSON document"),
  Flag.withDefault(false),
);

const schema = Command.make("schema", {}, () =>
  Console.log(JSON.stringify(jsonSchema(), null, 2)),
).pipe(
  Command.withDescription("Print the JSON Schema of config.json, with every field documented."),
  Command.withExamples([
    { command: "miner config schema > config.schema.json", description: "Save it for an editor" },
  ]),
);

const validate = Command.make(
  "validate",
  { json },
  Effect.fn(function* ({ json }) {
    const loaded = yield* load(yield* configPath);
    if (json) {
      const { _tag, path } = loaded;
      const problems = _tag === "Invalid" ? loaded.problems : [];
      const warnings = _tag === "Valid" ? loaded.warnings : [];
      yield* Console.log(
        JSON.stringify(
          { ok: _tag !== "Invalid", file: path, missing: _tag === "Missing", problems, warnings },
          null,
          2,
        ),
      );
    } else {
      switch (loaded._tag) {
        case "Missing":
          yield* Console.log(
            `no config at ${loaded.path}: using the defaults (drops for every game)`,
          );
          break;
        case "Valid":
          const n = loaded.config.priorities.length;
          yield* Console.log(`${loaded.path}: valid, ${n} ${n === 1 ? "goal" : "goals"}`);
          for (const w of loaded.warnings) yield* Console.log(`warning ${w.pointer}: ${w.message}`);
          break;
        case "Invalid":
          for (const p of loaded.problems)
            yield* Console.log(`${loaded.path}#${p.pointer}: ${p.message}`);
          yield* Console.log("Run `miner config schema` for every field and its allowed values.");
      }
    }
    if (loaded._tag === "Invalid") return yield* new ConfigInvalid({ path: loaded.path });
  }),
).pipe(
  Command.withDescription(
    "Check $DATA_DIR/config.json against the schema, offline. Exit 2 lists every problem.",
  ),
  Command.withExamples([
    { command: "miner config validate", description: "Check the file" },
    {
      command: "miner config validate --json",
      description: "Problems as JSON pointers, for agents",
    },
  ]),
);

const init = Command.make(
  "init",
  {},
  Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* configPath;
    if (yield* fs.exists(file)) {
      yield* Console.log(`${file} already exists; not touching it.`);
      return;
    }
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, `${JSON.stringify(starter, null, 2)}\n`);
    yield* Console.log(file);
  }),
).pipe(
  Command.withDescription("Write a starter config.json to $DATA_DIR. Never overwrites."),
  Command.withExamples([{ command: "miner config init", description: "Create data/config.json" }]),
);

export const config = Command.make("config").pipe(
  Command.withDescription("Read, check and create the config file."),
  Command.withSubcommands([schema, validate, init]),
);
