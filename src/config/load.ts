import {
  Cause,
  Config as EffectConfig,
  Effect,
  Exit,
  FileSystem,
  JsonSchema,
  Path,
  Schema,
  SchemaIssue,
} from "effect";
import { Config, SCHEMA_URL } from "./schema.ts";

export interface Problem {
  /** RFC 6901 JSON pointer into the file, `""` for the whole document. */
  readonly pointer: string;
  readonly message: string;
}

export type Loaded =
  | { readonly _tag: "Missing"; readonly path: string; readonly config: Config }
  | {
      readonly _tag: "Valid";
      readonly path: string;
      readonly config: Config;
      readonly warnings: ReadonlyArray<Problem>;
    }
  | { readonly _tag: "Invalid"; readonly path: string; readonly problems: ReadonlyArray<Problem> };

/** `$DATA_DIR`, default `./data`: config, state and recordings live here. */
export const dataDir = EffectConfig.String("DATA_DIR").pipe(EffectConfig.withDefault("./data"));

export const configPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(yield* dataDir, "config.json");
});

const pointer = (path: ReadonlyArray<PropertyKey>): string =>
  path.map((p) => `/${String(p).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

/** Decodes an already-parsed document. Unknown keys are problems, so a typo never goes unnoticed. */
export const decode = (input: unknown): Exit.Exit<Config, ReadonlyArray<Problem>> => {
  // The schema has no services, so decoding is synchronous and total.
  const exit = Schema.decodeUnknownExit(Config)(input, {
    onExcessProperty: "error",
    errors: "all",
  });
  if (Exit.isSuccess(exit)) return Exit.succeed(exit.value);
  const error = Cause.squash(exit.cause);
  if (!Schema.isSchemaError(error)) return Exit.fail([{ pointer: "", message: String(error) }]);
  return Exit.fail(
    formatter(error.issue).issues.map((issue) => {
      const path = (issue.path ?? []).map((p) => (typeof p === "object" ? p.key : p));
      const isGoal = path.length === 2 && path[0] === "priorities";
      // A goal with an unknown `type` fails both union members; say what `type` must be.
      const message =
        isGoal && (issue.message === "Expected Goal" || issue.message.startsWith("Expected {"))
          ? 'each goal needs "type": "drops" or "type": "points"'
          : issue.message === "Expected no excess property"
            ? `unknown key "${String(path.at(-1))}"`
            : issue.message;
      return { pointer: pointer(path), message };
    }),
  );
};

/** Reads and validates the file. A missing file is valid: every field has a default. */
export const load = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(file))) {
      const config = yield* Schema.decodeEffect(Config)({});
      return { _tag: "Missing", path: file, config } satisfies Loaded;
    }
    // A directory or an unreadable file is a problem to report, not a crash.
    const read = yield* fs.readFileString(file).pipe(Effect.result);
    if (read._tag === "Failure") {
      const problem = { pointer: "", message: `cannot read the file: ${read.failure.message}` };
      return { _tag: "Invalid", path: file, problems: [problem] } satisfies Loaded;
    }
    const text = read.success;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (e) => ({
        pointer: "",
        message: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      }),
    }).pipe(Effect.result);
    if (parsed._tag === "Failure")
      return { _tag: "Invalid", path: file, problems: [parsed.failure] } satisfies Loaded;
    const decoded = decode(parsed.success);
    if (Exit.isFailure(decoded)) {
      const problems = Cause.squash(decoded.cause) as ReadonlyArray<Problem>;
      return { _tag: "Invalid", path: file, problems } satisfies Loaded;
    }
    const config = decoded.value;
    const warnings: Array<Problem> =
      config.$schema !== undefined && config.$schema !== SCHEMA_URL
        ? [
            {
              pointer: "/$schema",
              message: `points at another schema, which may be stale; this miner's is ${SCHEMA_URL}`,
            },
          ]
        : [];
    return { _tag: "Valid", path: file, config, warnings } satisfies Loaded;
  });

/** The JSON Schema document editors and agents read: draft-07, which VS Code fully supports. */
export const jsonSchema = (): Record<string, unknown> => {
  const document = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(Config, { onExcessProperty: "error" }),
  );
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    $id: SCHEMA_URL,
    ...document.schema,
    definitions: document.definitions,
  };
};

/** What `miner config init` writes: the defaults, spelled out so an agent sees the shape. */
export const starter = {
  $schema: SCHEMA_URL,
  version: 1,
  priorities: [{ type: "drops", note: "Every game with an active campaign", games: "all" }],
} as const;
