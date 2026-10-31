import {
  HOUR,
  MINUTE,
  type Campaign,
  type CampaignId,
  type Channel,
  type ChannelId,
  type DropId,
  type Millis,
  type Progress,
  type Settings,
} from "./model.ts";
import type { NoTarget } from "./plan.ts";
import type { ChannelRead } from "./protocol.ts";

/** Twitch's minute-watched cadence; TDM and just-mining both tick every 20 s. */
export const WATCH_INTERVAL: Millis = 20_000;
/** PubSub `drop-progress` frames are the fast truth; inventory is the slow one. */
export const INVENTORY_INTERVAL: Millis = 5 * MINUTE;
export const CATALOG_INTERVAL: Millis = HOUR;
export const CATALOG_RETRY: Millis = 5 * MINUTE;
/**
 * A drop opening its window brings the catalog read, and the directory reads it starts, forward
 * (`nextOpening`), at most this often: at most four catalog reads an hour, as a person reloading
 * the drops page would, however many drops open in a row.
 */
export const CATALOG_OPENING_GAP: Millis = 15 * MINUTE;
/** Twitch requires apps that hold a token to validate it hourly. */
export const VALIDATE_INTERVAL: Millis = HOUR;
/** `stream-up` arrives before stream data does (TDM `ONLINE_DELAY`, `constants.py:129`). */
export const ONLINE_DELAY: Millis = 2 * MINUTE;
/** Beyond this many unconfirmed minutes the estimate is distrusted (TDM `MAX_EXTRA_MINUTES`). */
export const MAX_UNCONFIRMED_MINUTES = 15;
export const CURRENT_DROP_RECHECK: Millis = 5 * MINUTE;
/** Inventory lags a claim by seconds, so a lost claim answer is checked this much later. */
export const CLAIM_RECHECK: Millis = MINUTE;
/**
 * No credit the plan can use for this long means the watch earns nothing: move on. A credit to a
 * drop already complete, received, or not wanted doesn't count; the live run of 2026-10-30 spent
 * two hours on a channel where Twitch kept crediting a received drop past its requirement.
 */
export const STALL_AFTER: Millis = 30 * MINUTE;
/**
 * How long a campaign stays given up after a stall on credit it can't use, at most: Twitch may
 * stop crediting that drop (its window closes first, then the skip ends with it) or move on to
 * another, so the campaign is tried again rather than lost until restart.
 */
export const CAMPAIGN_SKIP: Millis = HOUR;
/** Upper bound on followed channels (TDM fits 199 in 8 sockets of 50 topics). */
export const WATCHLIST_LIMIT = 100;
/**
 * A change to the followed channels waits this long, so the burst of directory and channel reads
 * after a catalog read ends in one `Subscribe`, not one per answer (the first shadow run sent six
 * in 1.5 s, each moving 3 to 28 of 100 channels). Reads start 300 ms apart (`pace.ts`), so 10 s
 * covers about 30 of them.
 */
export const SUBSCRIBE_SETTLE: Millis = 10_000;
/**
 * One request's worst case: four attempts of 30 s (`REQUEST_TIMEOUT`) and 2 + 4 + 8 s between
 * them (`retryReads`). `Twitch.test.ts` checks the constants here against the client's.
 */
export const READ_WORST_CASE: Millis = 4 * 30_000 + 14_000;
/** Request starts are paced this far apart (`REQUEST_GAP`, `pace.ts`), retries included. */
export const READ_GAP: Millis = 300;
/** Channels per stream-info request (`GQL_BATCH_LIMIT`); a longer read sends several in turn. */
export const READ_BATCH = 35;
/** Slack for the answer to reach the core after the read gives up. */
const SETTLE_MARGIN: Millis = 5_000;

/** Requests one channel read sends, one after the other. */
export const requestsOf = (read: ChannelRead): number =>
  read._tag === "ReadDirectory" ? 1 : Math.max(1, Math.ceil(read.channelIds.length / READ_BATCH));

/**
 * A catalog read starts one directory read per game and one read of allow-listed channels, and
 * their answers arrive one by one. Planning on the first answer watched a channel of a
 * lower-ranked game and switched 5 s later when a better game's answer came in (live run,
 * 2026-10-30). So no watch starts or switches until every read has answered or failed
 * (`ChannelsRead`, `ChannelsReadFailed`), or this long after the catalog read: each read's
 * requests one after the other at their worst, while every attempt of every request waits its
 * turn at the pacer. It is a backstop for an answer lost to a bug, never the normal way out, and
 * the runtime logs it when it runs out (`narrate.ts`).
 */
export const discoverySettle = (reads: ReadonlyArray<ChannelRead>): Millis => {
  const requests = reads.map(requestsOf);
  const attempts = 4 * requests.reduce((a, b) => a + b, 0);
  return attempts * READ_GAP + Math.max(0, ...requests) * READ_WORST_CASE + SETTLE_MARGIN;
};

export interface Watching {
  readonly _tag: "Watching";
  readonly channelId: ChannelId;
  readonly campaignId: CampaignId;
  readonly dropId: DropId;
  /** `dropId` came from Twitch (a progress frame or current-drop read), not from our plan. */
  readonly credited: boolean;
  /** Last time Twitch confirmed progress on the watched drop, and how much. */
  readonly confirmedAt: Millis;
  readonly confirmedMinutes: number;
  /** Our own count: confirmed minutes plus watch ticks since. */
  readonly estimatedMinutes: number;
  readonly lastCurrentDropRead: Millis | undefined;
  /**
   * The drop of the last credit since `confirmedAt` that earned nothing: received, complete, past
   * its requirement, or in a campaign the plan doesn't want. When it is a drop of the watched
   * campaign, a stall means Twitch credits the wrong drop of it, on any channel: the campaign is
   * avoided for a while (`CAMPAIGN_SKIP`), not the channel.
   */
  readonly wasted: DropId | undefined;
}

export type Idle =
  | NoTarget
  | "starting"
  /** A catalog read's channel reads are still out: see `discoverySettle`. */
  | "discovering"
  | "needs-login"
  /** The catalog is `null` or unreachable: discovery is broken, which is not "nothing to mine". */
  | "catalog-unavailable";

export type Watch = Watching | { readonly _tag: "Idle"; readonly reason: Idle };

/** A claim the runtime may have sent. Persisted before the claim goes out. */
export interface ClaimIntent {
  readonly campaignId: CampaignId;
  readonly dropId: DropId;
  /** `sent`: waiting for the answer. `unknown`: the answer was lost; inventory decides. */
  readonly status: "sent" | "unknown";
  /**
   * For `unknown`: only an inventory read at or after this time may settle the claim. The read
   * itself is due through `deadlines.inventory`, so a failed read never wakes the core in a loop.
   */
  readonly recheckAt: Millis | undefined;
}

export interface Deadlines {
  readonly validate: Millis;
  readonly catalog: Millis;
  readonly inventory: Millis;
  readonly tick: Millis | undefined;
  /** Channels that sent `stream-up`, re-read once their stream data exists. */
  readonly online: ReadonlyMap<ChannelId, Millis>;
  /** The followed channels differ from what the plan wants: send the plan's set then. */
  readonly subscribe: Millis | undefined;
}

/** The channel reads a catalog read started, by `readKey`, and when to stop waiting for them. */
export interface Discovery {
  readonly pending: ReadonlyArray<string>;
  readonly until: Millis;
}

export interface State {
  readonly settings: Settings;
  readonly auth: "unknown" | "valid" | "needs-login";
  readonly catalog: ReadonlyArray<Campaign> | undefined;
  readonly catalogStatus: "unknown" | "ok" | "unavailable";
  readonly progress: ReadonlyMap<DropId, Progress>;
  /** The last inventory's received rewards: benefit id to when it was last awarded. */
  readonly awarded: ReadonlyMap<string, Millis>;
  /** The drops the last inventory listed. Only drops it doesn't list are judged by `awarded`. */
  readonly inventoried: ReadonlySet<DropId>;
  readonly channels: ReadonlyMap<ChannelId, Channel>;
  /** Channels that refused playback or never credited us, skipped until restart. */
  readonly avoid: ReadonlySet<ChannelId>;
  /**
   * Campaigns whose watch Twitch kept crediting with a drop that earns nothing, each until when
   * (`CAMPAIGN_SKIP`). An entry is dropped at the first tick past its time.
   */
  readonly avoidCampaigns: ReadonlyMap<CampaignId, Millis>;
  /**
   * The drop each campaign was last given up for, kept past the skip while the catalog lists the
   * campaign: on a retry, a credit to that same drop shows the cause stands, and the campaign is
   * given up again at once instead of after another stall.
   */
  readonly skipCauses: ReadonlyMap<CampaignId, DropId>;
  readonly watch: Watch;
  readonly claims: ReadonlyMap<string, ClaimIntent>;
  readonly subscriptions: ReadonlyArray<ChannelId>;
  readonly discovery: Discovery | undefined;
  readonly deadlines: Deadlines;
}

export const initial = (settings: Settings): State => ({
  settings,
  auth: "unknown",
  catalog: undefined,
  catalogStatus: "unknown",
  progress: new Map(),
  awarded: new Map(),
  inventoried: new Set(),
  channels: new Map(),
  avoid: new Set(),
  avoidCampaigns: new Map(),
  skipCauses: new Map(),
  watch: { _tag: "Idle", reason: "starting" },
  claims: new Map(),
  subscriptions: [],
  discovery: undefined,
  deadlines: {
    validate: 0,
    catalog: 0,
    inventory: 0,
    tick: undefined,
    online: new Map(),
    subscribe: undefined,
  },
});

/** When the runtime must wake the core next, whatever events arrive. */
export const nextDeadline = (state: State): Millis | undefined => {
  const d = state.deadlines;
  switch (state.auth) {
    case "needs-login":
      return undefined;
    // Until the token is valid, only validation is due; older deadlines would wake us for nothing.
    case "unknown":
      return d.validate;
    case "valid":
      return Math.min(
        d.validate,
        d.catalog,
        d.inventory,
        d.tick ?? Infinity,
        d.subscribe ?? Infinity,
        state.discovery?.until ?? Infinity,
        ...d.online.values(),
        ...state.avoidCampaigns.values(),
      );
  }
};
