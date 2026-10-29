import type {
  Benefit,
  Campaign,
  CampaignId,
  Channel,
  ChannelId,
  Drop,
  DropId,
  DropInstanceId,
  GameId,
  Progress,
  Settings,
} from "./model.ts";
import { HOUR } from "./model.ts";

/** Test data builders. Times are relative to `T0`, a fixed instant. */
export const T0 = 1_793_275_200_000; // 2026-10-29T12:00:00Z

export const game = (id = "game-1") => ({
  id: id as GameId,
  name: `Game ${id}`,
  slug: `game-${id}`,
});
export const cid = (id: string) => id as CampaignId;
export const did = (id: string) => id as DropId;
export const chid = (id: string) => id as ChannelId;
export const iid = (id: string) => id as DropInstanceId;

export const item: Benefit = { id: "b-item", name: "Skin", distribution: "DIRECT_ENTITLEMENT" };
export const badge: Benefit = { id: "b-badge", name: "Badge", distribution: "BADGE" };

export const drop = (id: string, overrides: Partial<Drop> = {}): Drop => ({
  id: did(id),
  name: `Drop ${id}`,
  requiredMinutes: 60,
  startsAt: T0 - 24 * HOUR,
  endsAt: T0 + 24 * HOUR,
  preconditions: [],
  benefits: [item],
  ...overrides,
});

export const campaign = (id: string, overrides: Partial<Campaign> = {}): Campaign => ({
  id: cid(id),
  name: `Campaign ${id}`,
  game: game(),
  startsAt: T0 - 24 * HOUR,
  endsAt: T0 + 24 * HOUR,
  linked: true,
  allowedChannels: [],
  drops: [drop(`${id}-d1`)],
  ...overrides,
});

/** A live channel streaming `game-1`, or an offline one with `"offline"`. */
export const channel = (
  id: string,
  live: { gameId?: string; viewers?: number; dropsEnabled?: boolean } | "offline" = {},
): Channel =>
  live === "offline"
    ? { id: chid(id), login: id, gameId: "game-1" as GameId, live: undefined }
    : {
        id: chid(id),
        login: id,
        gameId: (live.gameId ?? "game-1") as GameId,
        live: { viewers: live.viewers ?? 100, dropsEnabled: live.dropsEnabled ?? true },
      };

export const progress = (
  c: Campaign,
  dropId: string,
  overrides: Partial<Progress> = {},
): Progress => ({
  dropId: did(dropId),
  campaignId: c.id,
  campaignEndsAt: c.endsAt,
  minutes: 0,
  instanceId: undefined,
  claimed: false,
  ...overrides,
});

export const settings = (overrides: Partial<Settings> = {}): Settings => ({
  games: [],
  excludeChannels: [],
  badgesAndEmotes: true,
  ...overrides,
});
