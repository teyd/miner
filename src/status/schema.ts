import { DateTime, JsonSchema, Schema, SchemaGetter } from "effect";

/**
 * `$DATA_DIR/status.json`, written by the running miner, and the report `miner status --json`
 * prints. Decision 15: this is the miner's whole external surface, read by people, Docker
 * HEALTHCHECK, systemd and AI agents, so every description here is user documentation.
 * `schema/status.v1.json` is generated from it (`pnpm schema`).
 */

export const STATUS_SCHEMA_URL =
  "https://raw.githubusercontent.com/teyd/miner/dev/schema/status.v1.json";

/** Seconds between two writes of an unchanged status: the heartbeat. */
export const HEARTBEAT_SECONDS = 30;
/** A heartbeat older than this means the miner is gone or hung. Three missed beats. */
export const STALE_SECONDS = 90;
/**
 * Starting for longer than this means Twitch can't be reached: the token check and the first
 * catalog read take seconds. A failed token check only repeats at the hourly validation, so a
 * network outage at start reads as discovery broken until then.
 */
export const STARTUP_GRACE_SECONDS = 600;

/**
 * ISO 8601 UTC in JSON, epoch milliseconds in code. The JSON Schema describes the encoded side,
 * so the description goes there.
 */
const timestamp = (description: string) =>
  Schema.DateTimeUtcFromString.pipe(
    Schema.decodeTo(Schema.Finite, {
      decode: SchemaGetter.transform((dt: DateTime.Utc) => DateTime.toEpochMillis(dt)),
      encode: SchemaGetter.transform((ms: number) => DateTime.makeUnsafe(ms)),
    }),
    Schema.annotateEncoded({ description: `${description} ISO 8601, UTC.` }),
  );

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Never = (description: string) =>
  Schema.NullOr(timestamp(description)).annotate({
    description: `${description} \`null\`: not yet.`,
  });

export const Mode = Schema.Literals(["live", "shadow"]).annotate({
  description:
    '"live" mines for real. "shadow" (`miner run --shadow`) reads and plans for real but only ' +
    "records what it would watch and claim.",
});

export const Auth = Schema.Literals(["checking", "valid", "needs-login"]).annotate({
  description:
    '"checking": the token is not validated yet. "valid": Twitch accepts it. "needs-login": ' +
    "Twitch rejected it; the miner is parked, polls nothing and waits for a new TOKEN and a restart.",
});

export const CatalogStatus = Schema.Literals(["unknown", "ok", "unavailable"]).annotate({
  description:
    '"unknown": not read yet. "ok": the last read decoded. "unavailable": discovery is broken: ' +
    "Twitch answered `null` or the read failed after retries. Not the same as nothing to mine.",
});

export const IdleReason = Schema.Literals([
  "starting",
  "needs-login",
  "catalog-unavailable",
  "nothing-to-mine",
  "no-live-channel",
]).annotate({
  description:
    '"starting": no catalog yet. "needs-login": parked on a rejected token. "catalog-unavailable": ' +
    'discovery is broken. "nothing-to-mine": no campaign the config asks for has a drop left to ' +
    'earn. "no-live-channel": there is one, but no eligible channel streams it now.',
});

const Watching = Schema.Struct({
  state: Schema.Literal("watching"),
  channel: Schema.Struct({
    id: Schema.String,
    login: Schema.NullOr(Schema.String).annotate({
      description: "As in twitch.tv/<login>. `null` until a read names the channel.",
    }),
  }),
  game: Schema.NullOr(Schema.String).annotate({ description: "`null`: not in the catalog." }),
  campaign: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  drop: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  minutes: Count.annotate({ description: "Minutes Twitch has confirmed for the drop." }),
  requiredMinutes: Schema.NullOr(Count).annotate({
    description: "Minutes the drop needs. `null`: not in the catalog.",
  }),
}).annotate({ identifier: "Watching", description: "The miner watches a channel for a drop." });

const Idle = Schema.Struct({
  state: Schema.Literal("idle"),
  reason: IdleReason,
}).annotate({ identifier: "Idle", description: "No channel is watched." });

export const Watch = Schema.Union([Watching, Idle]).annotate({ identifier: "Watch" });

const DropRef = {
  campaignId: Schema.String,
  dropId: Schema.String,
  drop: Schema.NullOr(Schema.String).annotate({
    description: "`<game>: <drop>`, or `null` when the catalog doesn't hold the drop.",
  }),
};

const ClaimInFlight = Schema.Struct({
  ...DropRef,
  status: Schema.Literals(["sent", "unknown"]).annotate({
    description:
      '"sent": waiting for Twitch to answer. "unknown": the answer was lost; the next inventory ' +
      "read decides. Claims are never retried blindly.",
  }),
}).annotate({ identifier: "ClaimInFlight" });

const Claimed = Schema.Struct({ ...DropRef, at: timestamp("When the claim settled.") }).annotate({
  identifier: "Claimed",
});

export const StatusFile = Schema.Struct({
  version: Schema.Literal(1).annotate({
    description: "The format version. A reader refuses a version it doesn't know.",
  }),
  miner: Schema.Struct({
    version: Schema.String.annotate({ description: "The miner's package version." }),
    pid: Count.annotate({ description: "The process id, in the miner's own pid namespace." }),
    mode: Mode,
    startedAt: timestamp("When this process started."),
  }),
  heartbeatAt: timestamp(
    `When the miner last wrote this file. It writes on every change and at least every ` +
      `${HEARTBEAT_SECONDS} s, so a heartbeat older than ${STALE_SECONDS} s means it is gone or hung.`,
  ),
  stoppedAt: Never("When the miner stopped cleanly."),
  auth: Auth,
  catalog: Schema.Struct({
    status: CatalogStatus,
    campaigns: Count.annotate({ description: "Campaigns in the last catalog read." }),
  }),
  watch: Watch,
  claims: Schema.Struct({
    inFlight: Schema.Array(ClaimInFlight).annotate({
      description: "Claims sent and not yet settled.",
    }),
    claimedThisRun: Schema.Array(Claimed).annotate({
      description:
        "The newest 50 drops this process claimed (or settled as claimed) since it started.",
    }),
  }),
  reads: Schema.Struct({
    validate: Never("Last time Twitch accepted the token."),
    catalog: Never("Last successful catalog read."),
    inventory: Never("Last successful inventory read."),
    channels: Never("Last successful directory or stream read."),
    currentDrop: Never("Last successful read of the drop the watch credits."),
    watchTick: Never("Last watch tick Twitch served. Always `null` in shadow mode."),
  }).annotate({ description: "When each kind of Twitch request last succeeded in this run." }),
  pubsub: Schema.Struct({
    connections: Count.annotate({ description: "Sockets wanted: one per 50 topics." }),
    listening: Count.annotate({
      description: "Sockets open and listening. Fewer than `connections` while reconnecting.",
    }),
    topics: Count.annotate({ description: "Topics followed: the account's drops and channels." }),
    dropped: Count.annotate({ description: "Topics that didn't fit the connection limit." }),
  }).annotate({ description: "Twitch PubSub, the live/offline and drop-progress feed." }),
}).annotate({
  identifier: "StatusFile",
  description: "What the running miner writes to $DATA_DIR/status.json.",
});

export type StatusFile = typeof StatusFile.Type;

export const HealthState = Schema.Literals([
  "healthy",
  "starting",
  "not-running",
  "needs-login",
  "discovery-broken",
]).annotate({
  description:
    '"healthy" and "starting" (exit 0): running, the token is valid or being checked, the ' +
    'catalog reads. "not-running" (exit 1): no status file, a clean stop, a heartbeat older ' +
    `than ${STALE_SECONDS} s, or a file this version can't read. "needs-login" (exit 2): parked ` +
    'on a rejected token; set a new TOKEN and restart. "discovery-broken" (exit 3): the catalog ' +
    "is unavailable, so the miner can't tell whether there is anything to mine, or it has been " +
    `starting for over ${STARTUP_GRACE_SECONDS} s (Twitch unreachable).`,
});

export const ExitCode = Schema.Literals([0, 1, 2, 3]);

export const StatusReport = Schema.Struct({
  $schema: Schema.Literal(STATUS_SCHEMA_URL),
  version: Schema.Literal(1),
  checkedAt: timestamp("When `miner status` read the file."),
  health: Schema.Struct({
    state: HealthState,
    exitCode: ExitCode.annotate({
      description:
        "The exit code of `miner status`: 0 healthy, 1 not running, 2 needs login, 3 discovery broken.",
    }),
    detail: Schema.String.annotate({ description: "One line for a person." }),
  }),
  status: Schema.NullOr(StatusFile).annotate({
    description: "The status file as read, or `null` when there is none or it can't be read.",
  }),
}).annotate({
  identifier: "MinerStatus",
  title: "miner status",
  description:
    "What `miner status --json` prints: a verdict on the miner's health from $DATA_DIR/status.json, " +
    "and the file itself. The exit code repeats `health.exitCode`.",
});

export type StatusReport = typeof StatusReport.Type;
export type HealthState = typeof HealthState.Type;

export const encodeStatusFile = Schema.encodeSync(StatusFile);
export const decodeStatusFile = Schema.decodeUnknownExit(StatusFile);
export const encodeStatusReport = Schema.encodeSync(StatusReport);

/** `schema/status.v1.json`: draft-07, like the config's. */
export const statusJsonSchema = (): Record<string, unknown> => {
  const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(StatusReport));
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    $id: STATUS_SCHEMA_URL,
    ...document.schema,
    definitions: document.definitions,
  };
};
