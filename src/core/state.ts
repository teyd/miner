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

/** Twitch's minute-watched cadence; TDM and just-mining both tick every 20 s. */
export const WATCH_INTERVAL: Millis = 20_000;
/** PubSub `drop-progress` frames are the fast truth; inventory is the slow one. */
export const INVENTORY_INTERVAL: Millis = 5 * MINUTE;
export const CATALOG_INTERVAL: Millis = HOUR;
export const CATALOG_RETRY: Millis = 5 * MINUTE;
/** Twitch requires apps that hold a token to validate it hourly. */
export const VALIDATE_INTERVAL: Millis = HOUR;
/** `stream-up` arrives before stream data does (TDM `ONLINE_DELAY`, `constants.py:129`). */
export const ONLINE_DELAY: Millis = 2 * MINUTE;
/** Beyond this many unconfirmed minutes the estimate is distrusted (TDM `MAX_EXTRA_MINUTES`). */
export const MAX_UNCONFIRMED_MINUTES = 15;
export const CURRENT_DROP_RECHECK: Millis = 5 * MINUTE;
/** Inventory lags a claim by seconds, so a lost claim answer is checked this much later. */
export const CLAIM_RECHECK: Millis = MINUTE;
/** No credit at all for this long means the channel doesn't credit us: move on. */
export const STALL_AFTER: Millis = 30 * MINUTE;
/** Upper bound on followed channels (TDM fits 199 in 8 sockets of 50 topics). */
export const WATCHLIST_LIMIT = 100;
/**
 * A change to the followed channels waits this long, so the burst of directory and channel reads
 * after a catalog read ends in one `Subscribe`, not one per answer (the first shadow run sent six
 * in 1.5 s, each moving 3 to 28 of 100 channels). Reads start 300 ms apart (`pace.ts`), so 10 s
 * covers about 30 of them.
 */
export const SUBSCRIBE_SETTLE: Millis = 10_000;

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
}

export type Idle =
  | NoTarget
  | "starting"
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

export interface State {
  readonly settings: Settings;
  readonly auth: "unknown" | "valid" | "needs-login";
  readonly catalog: ReadonlyArray<Campaign> | undefined;
  readonly catalogStatus: "unknown" | "ok" | "unavailable";
  readonly progress: ReadonlyMap<DropId, Progress>;
  readonly channels: ReadonlyMap<ChannelId, Channel>;
  /** Channels that refused playback or never credited us, skipped until restart. */
  readonly avoid: ReadonlySet<ChannelId>;
  readonly watch: Watch;
  readonly claims: ReadonlyMap<string, ClaimIntent>;
  readonly subscriptions: ReadonlyArray<ChannelId>;
  readonly deadlines: Deadlines;
}

export const initial = (settings: Settings): State => ({
  settings,
  auth: "unknown",
  catalog: undefined,
  catalogStatus: "unknown",
  progress: new Map(),
  channels: new Map(),
  avoid: new Set(),
  watch: { _tag: "Idle", reason: "starting" },
  claims: new Map(),
  subscriptions: [],
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
        ...d.online.values(),
      );
  }
};
