import {
  MINUTE,
  type Campaign,
  type ChannelId,
  type Drop,
  type DropId,
  type Millis,
} from "../core/model.ts";
import { withReceived } from "../core/rules.ts";
import type { Event } from "../core/protocol.ts";
import type { State, Watch } from "../core/state.ts";

/**
 * What the runtime tells a person: names instead of ids, and progress as minutes of the drop's
 * total. Ids the state can't name yet (a channel before its read) stay as ids.
 */

const findDrop = (state: State, dropId: DropId): { campaign: Campaign; drop: Drop } | undefined => {
  for (const campaign of state.catalog ?? []) {
    const drop = campaign.drops.find((d) => d.id === dropId);
    if (drop !== undefined) return { campaign, drop };
  }
  return undefined;
};

const channelName = (state: State, channelId: ChannelId): string =>
  state.channels.get(channelId)?.login ?? channelId;

/** `Rust: Hoodie`, or the id when the catalog doesn't hold the drop. */
export const dropName = (state: State, dropId: DropId): string => {
  const found = findDrop(state, dropId);
  return found === undefined ? dropId : `${found.campaign.game.name}: ${found.drop.name}`;
};

const minutesOf = (state: State, dropId: DropId): string => {
  const required = findDrop(state, dropId)?.drop.requiredMinutes;
  const minutes = state.progress.get(dropId)?.minutes ?? 0;
  return required === undefined ? `${minutes} min` : `${minutes}/${required} min`;
};

export const describeWatch = (state: State, watch: Watch): string =>
  watch._tag === "Idle"
    ? `idle (${watch.reason})`
    : `watching ${channelName(state, watch.channelId)} for ${dropName(state, watch.dropId)} (${minutesOf(state, watch.dropId)})`;

/** One line per drop whose minutes or claim state changed in this step. */
export const progressLines = (before: State, after: State): ReadonlyArray<string> => {
  if (before.progress.size === 0 && after.progress.size > 0) {
    const open = [...after.progress.values()].filter((p) => !p.claimed).length;
    return [`inventory: ${after.progress.size} drops known, ${open} not claimed yet`];
  }
  const lines: Array<string> = [];
  for (const [dropId, p] of after.progress) {
    const old = before.progress.get(dropId);
    if (old !== undefined && old.minutes === p.minutes && old.claimed === p.claimed) continue;
    if (old === undefined && p.claimed) continue; // an old claim seen in the first inventory read
    if (p.claimed && old?.claimed !== true) lines.push(`claimed ${dropName(after, dropId)}`);
    else if (old === undefined || old.minutes !== p.minutes)
      lines.push(`progress ${dropName(after, dropId)} ${minutesOf(after, dropId)}`);
  }
  return lines;
};

/**
 * Channels and campaigns this step gave up on: a channel until the next start, when it refused
 * playback or credited nothing the plan can use for `STALL_AFTER`; a campaign for a while, when
 * Twitch kept crediting a drop of it that earns nothing (received, past its requirement).
 */
export const avoidLines = (before: State, after: State, now: Millis): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  for (const id of after.avoid) {
    if (before.avoid.has(id)) continue;
    lines.push(
      `skipping ${channelName(after, id)} until restart: it refused playback or never credited what the plan wants`,
    );
  }
  for (const [id, until] of after.avoidCampaigns) {
    if (before.avoidCampaigns.get(id) === until) continue;
    const campaign = after.catalog?.find((c) => c.id === id);
    const name = campaign === undefined ? id : `${campaign.game.name}: ${campaign.name}`;
    const minutes = Math.round((until - now) / MINUTE);
    lines.push(
      `skipping ${name} for ${minutes} min: Twitch credited only a drop of it that earns nothing`,
    );
  }
  return lines;
};

/**
 * Drops the inventory doesn't list that now count as received, by `gameEventDrops` (`isReceived`),
 * once each. A benefit id shared with an overlapping campaign can mark a drop received that
 * isn't; this line is how a person sees it.
 */
export const receivedLines = (before: State, after: State): ReadonlyArray<string> => {
  const catalog = after.catalog ?? [];
  const was = withReceived(
    before.catalog ?? [],
    before.progress,
    before.awarded,
    before.inventoried,
  );
  const is = withReceived(catalog, after.progress, after.awarded, after.inventoried);
  const lines: Array<string> = [];
  for (const [dropId, p] of is) {
    if (!p.claimed || after.progress.get(dropId)?.claimed === true) continue;
    if (was.get(dropId)?.claimed === true) continue;
    lines.push(`received already: ${dropName(after, dropId)}, by the inventory's awarded rewards`);
  }
  return lines;
};

/**
 * Discovery gave up on reads that never answered nor failed (`discoverySettle` ran out): planning
 * goes on without their channels. It should never happen, since every read answers or fails, so
 * it is worth a warning.
 */
export const discoveryExpired = (
  before: State,
  after: State,
  event: Event,
  now: Millis,
): string | undefined => {
  const d = before.discovery;
  if (d === undefined || d.pending.length === 0 || after.discovery !== undefined) return undefined;
  if (event._tag === "Started" || event._tag === "AuthFailed" || now < d.until) return undefined;
  return `discovery: planning without ${d.pending.length} channel read(s) still out: ${d.pending.join(", ")}`;
};
