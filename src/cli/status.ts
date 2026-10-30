import { Clock, Console, Effect, FileSystem, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { dataDir } from "../config/load.ts";
import type { Millis } from "../core/model.ts";
import { STATUS_FILE } from "../runtime/status.ts";
import {
  encodeStatusReport,
  STATUS_SCHEMA_URL,
  statusJsonSchema,
  type StatusFile,
  type StatusReport,
} from "../status/schema.ts";
import { health, parseStatus, type Read } from "../status/snapshot.ts";

/** The miner is not healthy; `exitCode` says how (1 not running, 2 needs login, 3 discovery). */
export class StatusUnhealthy extends Schema.TaggedError<
  StatusUnhealthy,
  { readonly brand: unique symbol }
>()("StatusUnhealthy", { exitCode: Schema.Literals([1, 2, 3]) }) {}

const readStatus = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => true));
    if (!exists) return { _tag: "Missing" } satisfies Read;
    return yield* fs.readFileString(path).pipe(
      Effect.map(parseStatus),
      Effect.catch((e) => Effect.succeed<Read>({ _tag: "Unreadable", detail: e.message })),
    );
  });

/** The report for the status file at `path`, judged at the current time. */
export const statusReport = (path: string) =>
  Effect.gen(function* () {
    const read = yield* readStatus(path);
    const now = yield* Clock.currentTimeMillis;
    return {
      $schema: STATUS_SCHEMA_URL,
      version: 1,
      checkedAt: now,
      health: health(read, now),
      status: read._tag === "Read" ? read.status : null,
    } satisfies StatusReport;
  });

const ago = (now: Millis, at: Millis | null): string => {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 120) return `${s} s ago`;
  if (s < 7200) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};

const watchLine = (s: StatusFile): string => {
  const w = s.watch;
  if (w.state === "idle") return `idle (${w.reason})`;
  const drop = w.drop.name === null ? w.drop.id : `${w.game ?? "?"}: ${w.drop.name}`;
  const minutes =
    w.requiredMinutes === null ? `${w.minutes} min` : `${w.minutes}/${w.requiredMinutes} min`;
  return `watching ${w.channel.login ?? w.channel.id} for ${drop} (${minutes})`;
};

/** What `miner status` prints for a person. */
export const human = (path: string, r: StatusReport): ReadonlyArray<string> => {
  const head = `${r.health.state}: ${r.health.detail}`;
  const s = r.status;
  if (s === null) return [head, `  status file: ${path}`];
  const now = r.checkedAt;
  const named = (c: { readonly drop: string | null; readonly dropId: string }) =>
    c.drop ?? c.dropId;
  const reads = Object.entries(s.reads)
    .map(([kind, at]) => `${kind} ${ago(now, at)}`)
    .join(", ");
  return [
    head,
    `  miner ${s.miner.version} (${s.miner.mode}, pid ${s.miner.pid}), started ${ago(now, s.miner.startedAt)}, heartbeat ${ago(now, s.heartbeatAt)}`,
    `  token: ${s.auth}`,
    `  catalog: ${s.catalog.status}, ${s.catalog.campaigns} campaigns`,
    `  ${watchLine(s)}`,
    `  claims in flight: ${s.claims.inFlight.length === 0 ? "none" : s.claims.inFlight.map((c) => `${named(c)} (${c.status})`).join(", ")}`,
    `  claimed this run: ${s.claims.claimedThisRun.length === 0 ? "none" : s.claims.claimedThisRun.map(named).join(", ")}`,
    `  pubsub: ${s.pubsub.listening}/${s.pubsub.connections} connections listening, ${s.pubsub.topics} topics${s.pubsub.dropped > 0 ? `, ${s.pubsub.dropped} dropped` : ""}`,
    `  last success: ${reads}`,
  ];
};

export const status = Command.make(
  "status",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print one JSON document (schema: --schema)"),
      Flag.withDefault(false),
    ),
    schema: Flag.Boolean("schema").pipe(
      Flag.withDescription("Print the JSON Schema of the --json document and exit"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ json, schema }) {
    if (schema) return yield* Console.log(JSON.stringify(statusJsonSchema(), null, 2));
    const path = (yield* Path.Path).resolve(yield* dataDir, STATUS_FILE);
    const report = yield* statusReport(path);
    if (json) yield* Console.log(JSON.stringify(encodeStatusReport(report), null, 2));
    else for (const line of human(path, report)) yield* Console.log(line);
    const code = report.health.exitCode;
    if (code !== 0) return yield* new StatusUnhealthy({ exitCode: code });
  }),
).pipe(
  Command.withDescription(
    "Report on the miner running on $DATA_DIR, from the $DATA_DIR/status.json it writes on every " +
      "change and every 30 s. Exit codes: 0 healthy or starting, 1 not running (no file, stopped, " +
      "or no heartbeat for 90 s), 2 needs login (the token was rejected), 3 discovery broken (the " +
      "drops catalog is unavailable, or Twitch unreachable for 10 minutes after start). Reads " +
      "nothing from Twitch.",
  ),
  Command.withExamples([
    { command: "miner status", description: "A summary for a person" },
    { command: "miner status --json", description: "The document for scripts and agents" },
    {
      command: "miner status > /dev/null",
      description: "A health check for Docker HEALTHCHECK or a systemd timer: only the exit code",
    },
  ]),
);
