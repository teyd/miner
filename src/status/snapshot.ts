import { Exit } from "effect";
import {
  claimKey,
  type Campaign,
  type CampaignId,
  type DropId,
  type Millis,
} from "../core/model.ts";
import type { Event } from "../core/protocol.ts";
import type { State } from "../core/state.ts";
import {
  decodeStatusFile,
  STALE_SECONDS,
  STARTUP_GRACE_SECONDS,
  type HealthState,
  type StatusFile,
} from "./schema.ts";

/** What the status reports about this process that `State` doesn't keep. */
export interface RunFacts {
  readonly startedAt: Millis;
  readonly reads: Readonly<Record<keyof StatusFile["reads"], Millis | undefined>>;
  readonly claimed: ReadonlyArray<{
    readonly campaignId: CampaignId;
    readonly dropId: DropId;
    readonly at: Millis;
  }>;
}

export const startFacts = (now: Millis): RunFacts => ({
  startedAt: now,
  reads: {
    validate: undefined,
    catalog: undefined,
    inventory: undefined,
    channels: undefined,
    currentDrop: undefined,
    watchTick: undefined,
  },
  claimed: [],
});

const READ_OF: Partial<Record<Event["_tag"], keyof RunFacts["reads"]>> = {
  TokenValid: "validate",
  CatalogRead: "catalog",
  InventoryRead: "inventory",
  ChannelsRead: "channels",
  CurrentDropRead: "currentDrop",
  WatchTicked: "watchTick",
};

/**
 * Folds one step into the facts. A read counts when its answer reached the core. A drop counts as
 * claimed this run when its claim intent ends with the drop claimed, whether the claim answer or a
 * later inventory read settled it; a drop claimed in a browser has no intent and doesn't count.
 */
export const observe = (
  facts: RunFacts,
  before: State,
  after: State,
  event: Event,
  now: Millis,
): RunFacts => {
  const read = READ_OF[event._tag];
  const reads = read === undefined ? facts.reads : { ...facts.reads, [read]: now };
  if (before.claims === after.claims) return read === undefined ? facts : { ...facts, reads };
  const settled = [...before.claims.values()].filter((intent) => {
    if (after.claims.has(claimKey(intent.campaignId, intent.dropId))) return false;
    if (after.progress.get(intent.dropId)?.claimed === true) return true;
    return (
      event._tag === "ClaimResult" && event.dropId === intent.dropId && event.outcome !== "unknown"
    );
  });
  const claimed = [
    ...facts.claimed,
    ...settled.map(({ campaignId, dropId }) => ({ campaignId, dropId, at: now })),
  ];
  return { ...facts, reads, claimed };
};

export interface Meta {
  readonly version: string;
  readonly pid: number;
  readonly mode: StatusFile["miner"]["mode"];
}

/** Sockets of Twitch PubSub, as `PubSub.status` reports them. */
export interface Sockets {
  readonly connections: number;
  readonly listening: number;
  readonly topics: number;
  readonly dropped: number;
}

const find = (catalog: ReadonlyArray<Campaign> | undefined, dropId: DropId) => {
  for (const campaign of catalog ?? []) {
    const drop = campaign.drops.find((d) => d.id === dropId);
    if (drop !== undefined) return { campaign, drop };
  }
  return undefined;
};

const dropName = (state: State, dropId: DropId): string | null => {
  const found = find(state.catalog, dropId);
  return found === undefined ? null : `${found.campaign.game.name}: ${found.drop.name}`;
};

const watchOf = (state: State): StatusFile["watch"] => {
  const w = state.watch;
  if (w._tag === "Idle") return { state: "idle", reason: w.reason };
  const found = find(state.catalog, w.dropId);
  const campaign = found?.campaign ?? state.catalog?.find((c) => c.id === w.campaignId);
  return {
    state: "watching",
    channel: { id: w.channelId, login: state.channels.get(w.channelId)?.login ?? null },
    game: campaign?.game.name ?? null,
    campaign: { id: w.campaignId, name: campaign?.name ?? null },
    drop: { id: w.dropId, name: found?.drop.name ?? null },
    minutes: Math.max(0, Math.floor(state.progress.get(w.dropId)?.minutes ?? 0)),
    requiredMinutes: found?.drop.requiredMinutes ?? null,
  };
};

/** The status document for `state` at `now`. Pure: the runtime adds nothing but the IO. */
export const snapshot = (input: {
  readonly state: State;
  readonly facts: RunFacts;
  readonly meta: Meta;
  readonly sockets: Sockets;
  readonly now: Millis;
  readonly stoppedAt?: Millis | undefined;
}): StatusFile => {
  const { state, facts, meta, sockets, now } = input;
  const reads = Object.fromEntries(
    Object.entries(facts.reads).map(([k, v]) => [k, v ?? null]),
  ) as unknown as StatusFile["reads"];
  return {
    version: 1,
    miner: { version: meta.version, pid: meta.pid, mode: meta.mode, startedAt: facts.startedAt },
    heartbeatAt: now,
    stoppedAt: input.stoppedAt ?? null,
    auth: state.auth === "unknown" ? "checking" : state.auth,
    catalog: { status: state.catalogStatus, campaigns: state.catalog?.length ?? 0 },
    watch: watchOf(state),
    claims: {
      inFlight: [...state.claims.values()].map((c) => ({
        campaignId: c.campaignId,
        dropId: c.dropId,
        drop: dropName(state, c.dropId),
        status: c.status,
      })),
      claimedThisRun: facts.claimed.map((c) => ({
        campaignId: c.campaignId,
        dropId: c.dropId,
        drop: dropName(state, c.dropId),
        at: c.at,
      })),
    },
    reads,
    pubsub: { ...sockets },
  };
};

/**
 * What a change is: everything but the heartbeat and the read times, which move on every tick.
 * Those reach the file with the next heartbeat.
 */
export const changeKey = (status: StatusFile): string =>
  JSON.stringify({ ...status, heartbeatAt: 0, reads: null });

export interface Health {
  readonly state: HealthState;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly detail: string;
}

/** The status file as read: absent, unreadable (with why), or decoded. */
export type Read =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unreadable"; readonly detail: string }
  | { readonly _tag: "Read"; readonly status: StatusFile };

export const parseStatus = (text: string): Read => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      _tag: "Unreadable",
      detail: "not JSON (a partial write would not show: writes are atomic)",
    };
  }
  const version = (json as { version?: unknown } | null)?.version;
  if (version !== 1) {
    return { _tag: "Unreadable", detail: `format version ${String(version)}, this miner reads 1` };
  }
  const exit = decodeStatusFile(json);
  return Exit.isSuccess(exit)
    ? { _tag: "Read", status: exit.value }
    : { _tag: "Unreadable", detail: "does not match the version 1 format" };
};

const seconds = (ms: number) => Math.round(ms / 1000);

/**
 * The verdict and exit code. Order matters: a miner that is not running can't be parked or
 * broken, and a parked one reads no catalog, so "needs-login" hides "discovery-broken".
 */
export const health = (read: Read, now: Millis): Health => {
  if (read._tag === "Missing") {
    return {
      state: "not-running",
      exitCode: 1,
      detail: "no status file: the miner has not run here",
    };
  }
  if (read._tag === "Unreadable") {
    return { state: "not-running", exitCode: 1, detail: `status file unreadable: ${read.detail}` };
  }
  const s = read.status;
  if (s.stoppedAt !== null) {
    return {
      state: "not-running",
      exitCode: 1,
      detail: `stopped ${seconds(now - s.stoppedAt)} s ago`,
    };
  }
  const age = now - s.heartbeatAt;
  if (age > STALE_SECONDS * 1000) {
    return {
      state: "not-running",
      exitCode: 1,
      detail: `no heartbeat for ${seconds(age)} s (pid ${s.miner.pid}): stopped or hung`,
    };
  }
  if (s.auth === "needs-login") {
    return {
      state: "needs-login",
      exitCode: 2,
      detail: "Twitch rejected the token: set a new TOKEN and restart the miner",
    };
  }
  if (s.catalog.status === "unavailable") {
    return {
      state: "discovery-broken",
      exitCode: 3,
      detail: "the drops catalog is unavailable (Twitch answered null or failed); retrying",
    };
  }
  if (s.auth === "checking" || s.catalog.status === "unknown") {
    const running = now - s.miner.startedAt;
    if (running > STARTUP_GRACE_SECONDS * 1000) {
      return {
        state: "discovery-broken",
        exitCode: 3,
        detail: `no ${s.auth === "checking" ? "token check" : "catalog read"} succeeded in ${seconds(running)} s: Twitch is unreachable or failing`,
      };
    }
    return {
      state: "starting",
      exitCode: 0,
      detail: "starting: checking the token and the catalog",
    };
  }
  return { state: "healthy", exitCode: 0, detail: "running" };
};
