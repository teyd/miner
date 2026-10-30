/**
 * Every Twitch constant the miner sends, in one place. Twitch's private API changes about
 * monthly: each value carries where it came from and when it was last confirmed. `miner doctor`
 * re-checks them live.
 */

/** Twitch's Android app. The only client whose implicit-grant tokens can read the drop catalog. */
export const CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

/** TDM `constants.py` ANDROID_APP, updated 2026-10-27. */
export const USER_AGENT =
  "Dalvik/2.1.0 (Linux; U; Android 16; SM-S911B Build/TP1A.220624.014) tv.twitch.android.app/31.8.0/3108006";

export const GQL_URL = "https://gql.twitch.tv/gql";
export const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";

/** Twitch rejects larger batches with `BATCH_LIMIT_EXCEEDED` (just-mining, verified live). */
export const GQL_BATCH_LIMIT = 35;

/**
 * GraphQL errors that mean a backend behind a field failed and the field came back `null`.
 * Common on Inventory; the next read usually succeeds (just-mining, seen live 2026-10-28).
 */
export const TRANSIENT_GQL_ERRORS: ReadonlyArray<string> = [
  "service error",
  "service timeout",
  // TDM retries these too (`twitch.py:1425-1434`).
  "request cancelled",
  "service unavailable",
  "context deadline exceeded",
];

export interface PersistedQuery {
  readonly operationName: string;
  readonly sha256Hash: string;
}

/**
 * Persisted-query hashes, as just-mining sent them when it recorded our fixtures on 2026-10-28.
 * TDM (2026-10-28) uses different hashes for Inventory, ViewerDropsDashboard and
 * DirectoryPage_Game; Twitch tends to accept several at once. Unverified which is current.
 */
export const Queries = {
  Inventory: {
    operationName: "Inventory",
    sha256Hash: "09acb7d3d7e605a92bdfdcc465f6aa481b71c234d8686a9ba38ea5ed51507592",
  },
  ViewerDropsDashboard: {
    operationName: "ViewerDropsDashboard",
    sha256Hash: "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619",
  },
  DropCampaignDetails: {
    operationName: "DropCampaignDetails",
    sha256Hash: "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1",
  },
  DirectoryPage_Game: {
    operationName: "DirectoryPage_Game",
    sha256Hash: "c7c9d5aad09155c4161d2382092dc44610367f3536aac39019ec2582ae5065f9",
  },
  VideoPlayerStreamInfoOverlayChannel: {
    operationName: "VideoPlayerStreamInfoOverlayChannel",
    sha256Hash: "198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d",
  },
  DropCurrentSessionContext: {
    operationName: "DropCurrentSessionContext",
    sha256Hash: "4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b",
  },
} as const satisfies Record<string, PersistedQuery>;

export type QueryName = keyof typeof Queries;

/** Directory variables that list only drops-enabled live streams, most viewers first. */
export const dropsDirectory = (slug: string, limit: number) => ({
  limit,
  slug,
  imageWidth: 50,
  includeIsDJ: false,
  options: {
    broadcasterLanguages: [],
    freeformTags: null,
    includeRestricted: ["SUB_ONLY_LIVE"],
    recommendationsContext: { platform: "web" },
    sort: "VIEWER_COUNT",
    systemFilters: ["DROPS_ENABLED"],
    tags: [],
    requestID: "JIRA-VXP-2397",
  },
  sortTypeIsRecency: false,
});

/**
 * Twitch's PubSub edge. Twitch shut public PubSub down for third-party apps in April 2025 and its
 * web client moved to Hermes (`wss://hermes.twitch.tv/v1`, TCPM #722, 2025), but the edge still
 * answers and delivers these topics to the Android token: PING → PONG in 161 ms, LISTEN →
 * `RESPONSE` with an empty error, live frames on every topic below (probe, 2026-10-30).
 * TDM and just-mining use it too (2026-10-28).
 */
export const PUBSUB_URL = "wss://pubsub-edge.twitch.tv/v1";

/** Topic prefixes; the name is `<prefix>.<user or channel id>` (TDM `constants.py`, 2026-10-28). */
export const Topics = {
  /** `drop-progress`, `drop-claim`. */
  drops: "user-drop-events",
  /** `stream-up`, `stream-down`, `viewcount`, `commercial`. */
  playback: "video-playback-by-id",
  /** `broadcast_settings_update`: title and category changes. */
  settings: "broadcast-settings-update",
} as const;

/** Topics one connection may hold (TDM `WS_TOPICS_LIMIT`; Twitch's former PubSub docs). */
export const PUBSUB_TOPICS_PER_CONNECTION = 50;

/**
 * Connections at most. Twitch allows about 10 websockets per IP (DevilXD, TDM #1153,
 * 2026-08-29); TDM stops at 8 (`MAX_WEBSOCKETS`). 8 × 50 topics hold the core's 100 channels.
 */
export const PUBSUB_MAX_CONNECTIONS = 8;

/** Topics per LISTEN or UNLISTEN frame (TDM `websocket.py`, chunks of 20). */
export const PUBSUB_TOPICS_PER_FRAME = 20;

/**
 * PING every 4 minutes, and a connection that doesn't answer a PING or a LISTEN within 10 s is
 * dead (just-mining; TDM pings every 3 minutes; Twitch's former docs asked for at least every 5).
 */
export const PUBSUB_PING_INTERVAL_MS = 4 * 60_000;
export const PUBSUB_ANSWER_TIMEOUT_MS = 10_000;
/** A connection must open within this. */
export const PUBSUB_OPEN_TIMEOUT_MS = 10_000;
/** Reconnect delay: 1 s, doubling per failure, at most 2 minutes (just-mining). */
export const PUBSUB_BACKOFF_MS = { first: 1_000, max: 120_000 } as const;
