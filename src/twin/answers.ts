import { Schema } from "effect";
import type { ChannelId, Millis } from "../core/model.ts";
import { CLIENT_ID } from "../twitch/identity.ts";
import {
  CampaignDetails,
  CurrentDrop,
  Dashboard,
  Directory,
  Inventory,
  StreamInfo,
  Validation,
} from "../twitch/wire.ts";
import {
  ACCOUNT,
  GAMES,
  awardsAt,
  channelOf,
  currentDropView,
  gameAt,
  inventoryView,
  liveAt,
  type World,
} from "./world.ts";

/**
 * The twin's answers, built as decoded values and encoded through the same Schemas the client
 * decodes with (research 04 §2.1), so an answer the twin can build is one the client can read.
 */

const status = (startsAt: Millis, endsAt: Millis, now: Millis) =>
  now < startsAt ? "UPCOMING" : now < endsAt ? "ACTIVE" : "EXPIRED";

export const validation = () =>
  Schema.encodeSync(Validation)({
    client_id: CLIENT_ID,
    login: ACCOUNT.login,
    user_id: ACCOUNT.userId,
  });

export const dashboard = (world: World, now: Millis, withheld: boolean) =>
  Schema.encodeSync(Dashboard)({
    currentUser: {
      dropCampaigns: withheld
        ? null
        : world.campaigns.map((c) => ({
            id: c.id,
            name: c.name,
            status: status(c.startsAt, c.endsAt, now),
            game: { id: c.game.id, displayName: c.game.name },
          })),
    },
  });

export const campaignDetails = (world: World, campaignId: string) => {
  const c = world.campaigns.find((x) => x.id === campaignId);
  return Schema.encodeSync(CampaignDetails)({
    user:
      c === undefined
        ? null
        : {
            dropCampaign: {
              id: c.id,
              name: c.name,
              startAt: c.startsAt,
              endAt: c.endsAt,
              game: { id: c.game.id, displayName: c.game.name, slug: c.game.slug },
              self: { isAccountConnected: c.linked },
              allow:
                c.allowedChannels.length === 0
                  ? null
                  : {
                      channels: c.allowedChannels.map((id) => ({
                        id,
                        name: channelOf(world, id)?.login ?? id,
                      })),
                      isEnabled: true,
                    },
              timeBasedDrops: c.drops.map((d) => ({
                id: d.id,
                name: d.name,
                requiredMinutesWatched: d.requiredMinutes,
                startAt: d.startsAt,
                endAt: d.endsAt,
                preconditionDrops:
                  d.preconditions.length === 0 ? null : d.preconditions.map((id) => ({ id })),
                benefitEdges: d.benefits.map((b) => ({
                  benefit: { id: b.id, name: b.name, distributionType: b.distribution },
                })),
              })),
            },
          },
  });
};

export const inventory = (world: World, now: Millis) =>
  Schema.encodeSync(Inventory)({
    currentUser: {
      inventory: {
        dropCampaignsInProgress: inventoryView(world, now).map(({ campaign, drops }) => ({
          id: campaign.id,
          endAt: campaign.endsAt,
          timeBasedDrops: drops.map((d) => ({
            id: d.dropId,
            self: {
              currentMinutesWatched: d.minutes,
              isClaimed: d.claimed,
              dropInstanceID: d.instanceId ?? null,
            },
          })),
        })),
        gameEventDrops: awardsAt(world, now).map((a) => ({
          id: a.benefitId,
          lastAwardedAt: a.at,
        })),
      },
    },
  });

/** The `DROPS_ENABLED` directory: live, drops-enabled channels streaming the game, most viewers first. */
export const directory = (world: World, slug: string, limit: number, now: Millis) => {
  const game = GAMES.find((g) => g.slug === slug);
  return Schema.encodeSync(Directory)({
    game:
      game === undefined
        ? null
        : {
            id: game.id,
            streams: {
              edges: world.channels
                .filter(
                  (ch) =>
                    ch.dropsEnabled &&
                    liveAt(world, ch.id, now) &&
                    gameAt(world, ch.id, now) === game.id,
                )
                .toSorted((a, b) => b.viewers - a.viewers || a.login.localeCompare(b.login))
                .slice(0, limit)
                .map((ch) => ({
                  node: {
                    viewersCount: ch.viewers,
                    type: "live",
                    broadcaster: { id: ch.id, login: ch.login },
                  },
                })),
            },
          },
  });
};

export const streamInfo = (world: World, login: string, now: Millis) => {
  const ch = world.channels.find((x) => x.login === login);
  return Schema.encodeSync(StreamInfo)({
    user:
      ch === undefined
        ? null
        : {
            id: ch.id,
            login: ch.login,
            broadcastSettings: { game: { id: gameAt(world, ch.id, now) ?? "" } },
            stream: liveAt(world, ch.id, now) ? { viewersCount: ch.viewers } : null,
          },
  });
};

export const currentDrop = (world: World, channelId: ChannelId, now: Millis) => {
  const view = currentDropView(world, channelId, now);
  return Schema.encodeSync(CurrentDrop)({
    currentUser: {
      dropCurrentSession:
        view === undefined ? null : { dropID: view.dropId, currentMinutesWatched: view.minutes },
    },
  });
};
