import { DateTime, Schema, SchemaGetter } from "effect";
import type {
  Benefit,
  Campaign,
  CampaignId,
  Channel,
  ChannelId,
  Distribution,
  DropId,
  DropInstanceId,
  GameId,
  Progress,
} from "../core/model.ts";

/**
 * Twitch's answers, decoded at the boundary. Each schema names only the fields the miner reads,
 * so an unrelated field change doesn't break decoding, and a change to one we read does.
 */

const Millis = Schema.DateTimeUtcFromString.pipe(
  Schema.decodeTo(Schema.Finite, {
    decode: SchemaGetter.transform((dt: DateTime.Utc) => DateTime.toEpochMillis(dt)),
    encode: SchemaGetter.transform((ms: number) => DateTime.makeUnsafe(ms)),
  }),
);

export const Validation = Schema.Struct({
  client_id: Schema.String,
  login: Schema.String,
  user_id: Schema.String,
});
export type Validation = typeof Validation.Type;

export const GqlError = Schema.Struct({
  message: Schema.String,
});

/** One element of a GQL response array. `data` stays unknown until its operation decodes it. */
export const Envelope = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  errors: Schema.optionalKey(Schema.Array(GqlError)),
});

const Game = Schema.Struct({ id: Schema.String, displayName: Schema.String });

export const Dashboard = Schema.Struct({
  currentUser: Schema.NullOr(
    Schema.Struct({
      dropCampaigns: Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            status: Schema.String,
            game: Game,
          }),
        ),
      ),
    }),
  ),
});

const Drop = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  requiredMinutesWatched: Schema.Finite,
  startAt: Millis,
  endAt: Millis,
  preconditionDrops: Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String }))),
  benefitEdges: Schema.Array(
    Schema.Struct({
      benefit: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        distributionType: Schema.String,
      }),
    }),
  ),
});

const DetailedCampaign = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  startAt: Millis,
  endAt: Millis,
  game: Schema.Struct({ id: Schema.String, displayName: Schema.String, slug: Schema.String }),
  self: Schema.Struct({ isAccountConnected: Schema.Boolean }),
  allow: Schema.NullOr(
    Schema.Struct({
      channels: Schema.NullOr(
        Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
      ),
      isEnabled: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  timeBasedDrops: Schema.NullOr(Schema.Array(Drop)),
});

export const CampaignDetails = Schema.Struct({
  user: Schema.NullOr(Schema.Struct({ dropCampaign: Schema.NullOr(DetailedCampaign) })),
});

/**
 * A `null` anywhere down to the campaign list fails decoding: an empty inventory is `[]`, and a
 * backend failure arrives as a `service error`, which the client retries before decoding.
 */
export const Inventory = Schema.Struct({
  currentUser: Schema.Struct({
    inventory: Schema.Struct({
      dropCampaignsInProgress: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          endAt: Millis,
          timeBasedDrops: Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                id: Schema.String,
                self: Schema.NullOr(
                  Schema.Struct({
                    currentMinutesWatched: Schema.Finite,
                    isClaimed: Schema.Boolean,
                    dropInstanceID: Schema.NullOr(Schema.String),
                  }),
                ),
              }),
            ),
          ),
        }),
      ),
    }),
  }),
});

export const Directory = Schema.Struct({
  game: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      streams: Schema.NullOr(
        Schema.Struct({
          edges: Schema.Array(
            Schema.Struct({
              node: Schema.Struct({
                viewersCount: Schema.Finite,
                type: Schema.String,
                broadcaster: Schema.NullOr(
                  Schema.Struct({ id: Schema.String, login: Schema.String }),
                ),
              }),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const StreamInfo = Schema.Struct({
  user: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      login: Schema.String,
      broadcastSettings: Schema.NullOr(
        Schema.Struct({ game: Schema.NullOr(Schema.Struct({ id: Schema.String })) }),
      ),
      stream: Schema.NullOr(Schema.Struct({ viewersCount: Schema.Finite })),
    }),
  ),
});

/** Shape per TDM `twitch.py:996-1010`; no recorded fixture yet (unverified). */
export const CurrentDrop = Schema.Struct({
  currentUser: Schema.NullOr(
    Schema.Struct({
      dropCurrentSession: Schema.NullOr(
        Schema.Struct({ dropID: Schema.String, currentMinutesWatched: Schema.Finite }),
      ),
    }),
  ),
});

const distribution = (type: string): Distribution =>
  type === "BADGE" || type === "EMOTE" || type === "DIRECT_ENTITLEMENT" ? type : "UNKNOWN";

export const toCampaign = (c: typeof DetailedCampaign.Type): Campaign => ({
  id: c.id as CampaignId,
  name: c.name,
  game: { id: c.game.id as GameId, name: c.game.displayName, slug: c.game.slug },
  startsAt: c.startAt,
  endsAt: c.endAt,
  linked: c.self.isAccountConnected,
  // A disabled allow-list doesn't restrict (TDM `inventory.py:352-355`).
  allowedChannels:
    c.allow?.isEnabled === false ? [] : (c.allow?.channels ?? []).map((ch) => ch.id as ChannelId),
  drops: (c.timeBasedDrops ?? []).map((d) => ({
    id: d.id as DropId,
    name: d.name,
    requiredMinutes: d.requiredMinutesWatched,
    startsAt: d.startAt,
    endsAt: d.endAt,
    preconditions: (d.preconditionDrops ?? []).map((p) => p.id as DropId),
    benefits: d.benefitEdges.map((e): Benefit => ({
      id: e.benefit.id,
      name: e.benefit.name,
      distribution: distribution(e.benefit.distributionType),
    })),
  })),
});

/** Allow-listed channels with their logins: stream reads go by login, the core by id. */
export const allowedLogins = (
  c: typeof DetailedCampaign.Type,
): ReadonlyArray<readonly [ChannelId, string]> =>
  (c.allow?.channels ?? []).map((ch) => [ch.id as ChannelId, ch.name] as const);

export const toProgress = (inventory: typeof Inventory.Type): ReadonlyArray<Progress> =>
  inventory.currentUser.inventory.dropCampaignsInProgress.flatMap((c) =>
    (c.timeBasedDrops ?? []).map((d) => ({
      dropId: d.id as DropId,
      campaignId: c.id as CampaignId,
      campaignEndsAt: c.endAt,
      // No `self` means no progress yet; dropping the drop would hide it from later claims.
      minutes: d.self?.currentMinutesWatched ?? 0,
      instanceId: (d.self?.dropInstanceID ?? undefined) as DropInstanceId | undefined,
      claimed: d.self?.isClaimed ?? false,
    })),
  );

/** Directory streams are drops-enabled by construction: the query filters on `DROPS_ENABLED`. */
export const toDirectoryChannels = (
  game: NonNullable<typeof Directory.Type.game>,
): ReadonlyArray<Channel> =>
  (game.streams?.edges ?? []).flatMap(({ node }) =>
    node.broadcaster === null || node.type !== "live"
      ? []
      : [
          {
            id: node.broadcaster.id as ChannelId,
            login: node.broadcaster.login,
            gameId: game.id as GameId,
            live: { viewers: node.viewersCount, dropsEnabled: true },
          },
        ],
  );

/**
 * Stream info can't tell whether drops are enabled; like TDM (`channel.py:41`), assume they are.
 * Allow-listed channels don't need it, and a directory channel that stops crediting stalls out.
 */
export const toChannel = (info: typeof StreamInfo.Type): Channel | undefined => {
  const user = info.user;
  if (user === null) return undefined;
  return {
    id: user.id as ChannelId,
    login: user.login,
    gameId: (user.broadcastSettings?.game?.id ?? undefined) as GameId | undefined,
    live:
      user.stream === null ? undefined : { viewers: user.stream.viewersCount, dropsEnabled: true },
  };
};

/**
 * `null` when Twitch issues no token for the login (just-mining treats it as offline).
 * `authorization` says whether this account may play the stream at all.
 */
export const PlaybackToken = Schema.Struct({
  streamPlaybackAccessToken: Schema.NullOr(
    Schema.Struct({
      value: Schema.String,
      signature: Schema.String,
      authorization: Schema.Struct({
        isForbidden: Schema.Boolean,
        forbiddenReasonCode: Schema.String,
      }),
    }),
  ),
});

/** The token's `value` is a JSON document; `expires` is when usher stops honouring it. */
export const PlaybackTokenValue = Schema.fromJsonString(Schema.Struct({ expires: Schema.Finite }));

/**
 * `null` is no claim: Twitch answers so for an instance id it doesn't know (just-mining fixture
 * `claim-unknown-instance.json`, 2026-10-28). `isUserAccountConnected: false` comes with
 * `ELIGIBLE_FOR_ALL` when the game account isn't linked; Twitch grants the reward on linking.
 */
export const ClaimDropRewards = Schema.Struct({
  claimDropRewards: Schema.NullOr(
    Schema.Struct({ status: Schema.String, isUserAccountConnected: Schema.Boolean }),
  ),
});
