import {
  CLAIM_GRACE,
  MINUTE,
  SPECIAL_GAMES,
  type Campaign,
  type CampaignId,
  type ChannelId,
  type Distribution,
  type Drop,
  type DropId,
  type DropInstanceId,
  type DropsGoal,
  type Game,
  type GameGoal,
  type GameId,
  type Millis,
  type Settings,
} from "../core/model.ts";
import { Event } from "../core/protocol.ts";
import { WATCH_INTERVAL } from "../core/state.ts";
import { SIM_EPOCH, type Fault, type GoalSpec, type Operation, type Scenario } from "./scenario.ts";

/**
 * The twin's model of Twitch for one account: what is live, what credits, what can be claimed.
 * Every rule names its source. The twin reuses the core's `CLAIM_GRACE` and `SPECIAL_GAMES`, so
 * both are only as right as the source those constants cite (research 02 §3).
 */

export const GAMES: ReadonlyArray<Game> = [
  { id: "g0" as GameId, name: "Game 0", slug: "game-0" },
  { id: "g1" as GameId, name: "Game 1", slug: "game-1" },
  { id: "509663" as GameId, name: "Special Events", slug: "special-events" },
];

export const ACCOUNT = { userId: "1", login: "twin" } as const;

/** Inventory shows a claim this long after it happened (the core's "seconds", `CLAIM_RECHECK`). */
export const CLAIMED_FLAG_LAG: Millis = 10_000;

interface Phase {
  readonly at: Millis;
  readonly live: boolean;
  readonly gameId: GameId;
}

export interface ChannelModel {
  readonly id: ChannelId;
  readonly login: string;
  readonly viewers: number;
  readonly dropsEnabled: boolean;
  readonly refuses: boolean;
  /** The schedule: the first phase starts at `SIM_EPOCH`, the others at each change. */
  readonly phases: ReadonlyArray<Phase>;
}

export interface Session {
  readonly channelId: ChannelId;
  readonly openedAt: Millis;
  readonly lastCreditAt: Millis;
  readonly carrySeconds: number;
  readonly creditedSeconds: number;
}

export interface World {
  readonly campaigns: ReadonlyArray<Campaign>;
  /** Unlinked campaigns whose items Twitch credits anyway (`creditsUnlinked`). */
  readonly creditsUnlinked: ReadonlySet<CampaignId>;
  readonly channels: ReadonlyArray<ChannelModel>;
  readonly settings: Settings;
  readonly inventoryLag: Millis;
  readonly faults: ReadonlyArray<Fault>;
  /** Credited minutes per drop, as a history so inventory can lag it. */
  readonly minutes: ReadonlyMap<
    DropId,
    ReadonlyArray<{ readonly at: Millis; readonly minutes: number }>
  >;
  readonly claimed: ReadonlyMap<DropId, Millis>;
  readonly revokedAt: Millis | undefined;
  readonly session: Session | undefined;
  readonly subscriptions: ReadonlySet<ChannelId>;
}

/** A frame the twin's PubSub would send, as the core event it becomes. */
export interface Frame {
  readonly at: Millis;
  readonly event: Event;
}

export interface Credit {
  readonly at: Millis;
  readonly channelId: ChannelId;
  readonly campaignId: CampaignId;
  readonly dropIds: ReadonlyArray<DropId>;
}

const at = (minute: number): Millis => SIM_EPOCH + minute * MINUTE;
const unique = <A>(xs: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(xs)];

export const channelIdOf = (index: number) => `ch${index}` as ChannelId;

export const buildWorld = (scenario: Scenario): World => {
  const n = scenario.channels.length;
  const channels = scenario.channels.map((spec, i): ChannelModel => {
    const phases: Array<Phase> = [
      { at: SIM_EPOCH, live: spec.liveAtStart, gameId: GAMES[spec.game]!.id },
    ];
    const changes = scenario.channels[i]!.changes.toSorted((a, b) => a.atMinute - b.atMinute);
    for (const change of changes) {
      const last = phases.at(-1)!;
      const next =
        change.to === "up"
          ? { ...last, live: true }
          : change.to === "down"
            ? { ...last, live: false }
            : { ...last, gameId: GAMES[Number(change.to.slice(-1))]!.id };
      phases.push({ ...next, at: at(change.atMinute) });
    }
    return {
      id: channelIdOf(i),
      login: `chan${i}`,
      viewers: spec.viewers,
      dropsEnabled: spec.dropsEnabled,
      refuses: spec.refuses,
      phases,
    };
  });
  const campaigns = scenario.campaigns.map((spec, i): Campaign => {
    const id = `c${i}` as CampaignId;
    const startsAt = at(spec.startMinute);
    const endsAt = startsAt + spec.durationMinutes * MINUTE;
    const dropId = (j: number) => `${id}-d${j}` as DropId;
    return {
      id,
      name: `Campaign ${i}`,
      game: GAMES[spec.game]!,
      startsAt,
      endsAt,
      linked: spec.linked,
      allowedChannels: unique(spec.allowList.map((k) => channelIdOf(k % n))),
      drops: spec.drops.map((d, j): Drop => ({
        id: dropId(j),
        name: `Drop ${i}.${j}`,
        requiredMinutes: d.requiredMinutes,
        startsAt,
        endsAt,
        preconditions: j > 0 && d.after !== null ? [dropId(d.after % j)] : [],
        benefits: [
          {
            id: `${dropId(j)}-b`,
            name: `Reward ${i}.${j}`,
            distribution: d.benefit as Distribution,
          },
        ],
      })),
    };
  });
  const revokes = scenario.faults.flatMap((f) =>
    f.kind === "revoke-token" ? [at(f.atMinute)] : [],
  );
  return {
    campaigns,
    creditsUnlinked: new Set(
      scenario.campaigns.flatMap((spec, i) =>
        spec.creditsUnlinked === true ? [`c${i}` as CampaignId] : [],
      ),
    ),
    channels,
    settings: { goals: scenario.settings.goals.map((goal) => goalOf(goal, n)) },
    inventoryLag: scenario.inventoryLagMinutes * MINUTE,
    faults: scenario.faults,
    minutes: new Map(),
    claimed: new Map(),
    revokedAt: revokes.length === 0 ? undefined : Math.min(...revokes),
    session: undefined,
    subscriptions: new Set(),
  };
};

/**
 * A goal spec as `toSettings` maps it (`src/runtime/settings.ts`): an excluded game leaves the
 * list, a game listed twice keeps its first entry, a game without rewards takes the goal's.
 */
const goalOf = (spec: GoalSpec, channels: number): DropsGoal => {
  const excludeGames = unique(spec.excludeGames.map((g) => GAMES[g]!.id)).toSorted();
  const listed: Array<GameGoal> = [];
  for (const entry of spec.games ?? []) {
    const id = GAMES[entry.game]!.id;
    if (excludeGames.includes(id) || listed.some((g) => g.id === id)) continue;
    listed.push({ id, rewards: entry.rewards ?? spec.rewards });
  }
  return {
    games: spec.games === null ? "all" : listed,
    rewards: spec.rewards,
    excludeGames,
    excludeChannels: unique(spec.exclude.map((k) => channelIdOf(k % channels))).toSorted(),
    linkedOnly: spec.linkedOnly,
    order: spec.order,
  };
};

export const channelOf = (world: World, id: ChannelId): ChannelModel | undefined =>
  world.channels.find((ch) => ch.id === id);

const phaseAt = (channel: ChannelModel, now: Millis): Phase =>
  channel.phases.findLast((p) => p.at <= now) ?? channel.phases[0]!;

export const liveAt = (world: World, id: ChannelId, now: Millis): boolean => {
  const channel = channelOf(world, id);
  return channel !== undefined && phaseAt(channel, now).live;
};

export const gameAt = (world: World, id: ChannelId, now: Millis): GameId | undefined => {
  const channel = channelOf(world, id);
  return channel === undefined ? undefined : phaseAt(channel, now).gameId;
};

export const isRevoked = (world: World, now: Millis): boolean =>
  world.revokedAt !== undefined && now >= world.revokedAt;

/** Times at which the world changes on its own: schedule changes and campaign boundaries. */
export const edges = (world: World): ReadonlyArray<Millis> =>
  unique([
    ...world.channels.flatMap((ch) => ch.phases.slice(1).map((p) => p.at)),
    ...world.campaigns.flatMap((c) => [c.startsAt, c.endsAt]),
  ]).toSorted((a, b) => a - b);

/**
 * `stream-up`, `stream-down` and `broadcast-settings-update` frames for subscribed channels whose
 * schedule changed in `(from, to]`, arriving 1 s later (TDM `twitch.py:1129-1180`).
 */
export const channelFrames = (world: World, from: Millis, to: Millis): ReadonlyArray<Frame> => {
  const frames: Array<Frame> = [];
  for (const channel of world.channels) {
    if (!world.subscriptions.has(channel.id)) continue;
    for (const [i, phase] of channel.phases.entries()) {
      if (i === 0 || phase.at <= from || phase.at > to) continue;
      const before = channel.phases[i - 1]!;
      const frameAt = phase.at + 1_000;
      const channelId = channel.id;
      if (phase.live !== before.live) {
        const event = phase.live ? Event.StreamUp({ channelId }) : Event.StreamDown({ channelId });
        frames.push({ at: frameAt, event });
      }
      if (phase.gameId !== before.gameId) {
        frames.push({ at: frameAt, event: Event.GameChanged({ channelId, gameId: phase.gameId }) });
      }
    }
  }
  return frames;
};

/**
 * Source: TDM `inventory.py:394-404` (linked, or a badge or emote). Unlinked item progress is
 * campaign-dependent (research 02 §3: Funcom FAQ, Twitch dev forums 62731) and unmeasured
 * (lane-D E7), so the scenario decides per campaign.
 */
export const accountEarns = (world: World, campaign: Campaign): boolean =>
  campaign.linked ||
  world.creditsUnlinked.has(campaign.id) ||
  campaign.drops.some((d) =>
    d.benefits.some((b) => b.distribution === "BADGE" || b.distribution === "EMOTE"),
  );

/** Source: TDM `inventory.py:352-355, 469-476`, `utils.py:422` (special games earn on any game). */
export const channelCredits = (
  world: World,
  campaign: Campaign,
  id: ChannelId,
  now: Millis,
): boolean => {
  const channel = channelOf(world, id);
  if (channel === undefined || !liveAt(world, id, now) || channel.refuses) return false;
  const allowed =
    campaign.allowedChannels.length === 0
      ? channel.dropsEnabled
      : campaign.allowedChannels.includes(id);
  return (
    allowed && (gameAt(world, id, now) === campaign.game.id || SPECIAL_GAMES.has(campaign.game.id))
  );
};

export const minutesAt = (world: World, dropId: DropId, now: Millis): number =>
  world.minutes.get(dropId)?.findLast((m) => m.at <= now)?.minutes ?? 0;

export const isClaimedAt = (world: World, dropId: DropId, now: Millis): boolean => {
  const claimedAt = world.claimed.get(dropId);
  return claimedAt !== undefined && claimedAt <= now;
};

/** Source: TDM `inventory.py:97-105, 262-271`: an unclaimed precondition blocks all credit. */
export const earnable = (world: World, drop: Drop, now: Millis): boolean =>
  drop.startsAt <= now &&
  now < drop.endsAt &&
  !world.claimed.has(drop.id) &&
  minutesAt(world, drop.id, now) < drop.requiredMinutes &&
  drop.preconditions.every((id) => world.claimed.has(id));

/**
 * The campaign a minute on this channel credits. When several could, the newest wins (TDM #756,
 * research 02 §3: Twitch progresses one campaign per stream, which one is undocumented).
 */
export const creditedCampaign = (world: World, id: ChannelId, now: Millis): Campaign | undefined =>
  world.campaigns
    .filter(
      (c) =>
        c.startsAt <= now &&
        now < c.endsAt &&
        accountEarns(world, c) &&
        channelCredits(world, c, id, now) &&
        c.drops.some((d) => earnable(world, d, now)),
    )
    .toSorted((a, b) => b.startsAt - a.startsAt || a.id.localeCompare(b.id))[0];

export const instanceOf = (dropId: DropId) => `${dropId}#i` as DropInstanceId;

const findDrop = (world: World, dropId: DropId) => {
  for (const campaign of world.campaigns) {
    const drop = campaign.drops.find((d) => d.id === dropId);
    if (drop !== undefined) return { campaign, drop };
  }
  return undefined;
};

/** Source: help.twitch.tv "How Drops Work" (research 02 §3): one channel credits at a time. */
export const openSession = (world: World, channelId: ChannelId, now: Millis): World => ({
  ...world,
  session: { channelId, openedAt: now, lastCreditAt: now, carrySeconds: 0, creditedSeconds: 0 },
});

export const closeSession = (world: World): World => ({ ...world, session: undefined });

export type TickResult = "ticked" | "offline" | "refused" | "network" | "auth";

export interface Ticked {
  readonly world: World;
  readonly result: TickResult;
  readonly frames: ReadonlyArray<Frame>;
  readonly credits: ReadonlyArray<Credit>;
}

/**
 * One watch tick. It credits the time since the last credit, at most one interval, so ticks that
 * bunch up after a delay earn no more than the wall time they cover (TDM `channel.py:432-487`;
 * exact accounting is lane-D E1, inference). Every 60 s of credit is one minute for every
 * earnable drop of the credited campaign.
 */
export const tick = (world: World, channelId: ChannelId, now: Millis): Ticked => {
  const fail = (result: TickResult): Ticked => ({ world, result, frames: [], credits: [] });
  if (isRevoked(world, now)) return fail("auth");
  const session = world.session;
  if (session === undefined || session.channelId !== channelId) return fail("network");
  if (!liveAt(world, channelId, now)) return fail("offline");
  if (channelOf(world, channelId)?.refuses === true) return fail("refused");
  const seconds = Math.max(0, Math.min(WATCH_INTERVAL, now - session.lastCreditAt)) / 1000;
  let carry = session.carrySeconds + seconds;
  let next: World = {
    ...world,
    session: {
      ...session,
      lastCreditAt: now,
      carrySeconds: 0,
      creditedSeconds: session.creditedSeconds + seconds,
    },
  };
  const frames: Array<Frame> = [];
  const credits: Array<Credit> = [];
  while (carry >= 60) {
    carry -= 60;
    const minute = creditMinute(next, channelId, now);
    next = minute.world;
    frames.push(...minute.frames);
    if (minute.credit !== undefined) credits.push(minute.credit);
  }
  return {
    world: { ...next, session: { ...next.session!, carrySeconds: carry } },
    result: "ticked",
    frames,
    credits,
  };
};

/** One credited minute, with its `drop-progress` and `drop-claim` frames (TDM `twitch.py:1239-1297`). */
const creditMinute = (world: World, channelId: ChannelId, now: Millis) => {
  const campaign = creditedCampaign(world, channelId, now);
  if (campaign === undefined) return { world, frames: [], credit: undefined };
  const minutes = new Map(world.minutes);
  const frames: Array<Frame> = [];
  const dropIds: Array<DropId> = [];
  for (const drop of campaign.drops) {
    if (!earnable(world, drop, now)) continue;
    const total = minutesAt(world, drop.id, now) + 1;
    minutes.set(drop.id, [...(minutes.get(drop.id) ?? []), { at: now, minutes: total }]);
    dropIds.push(drop.id);
    frames.push({
      at: now + 1_000,
      event: Event.DropProgress({ dropId: drop.id, minutes: total }),
    });
    if (total >= drop.requiredMinutes) {
      const instanceId = instanceOf(drop.id);
      frames.push({ at: now + 1_000, event: Event.DropClaimable({ dropId: drop.id, instanceId }) });
    }
  }
  return {
    world: { ...world, minutes },
    frames,
    credit: { at: now, channelId, campaignId: campaign.id, dropIds },
  };
};

export type ClaimOutcome = "claimed" | "already-claimed" | "rejected" | "auth";

/** Source: TDM `inventory.py:143-151, 200-215`; the window is the core's `CLAIM_GRACE`. */
export const claim = (
  world: World,
  instanceId: DropInstanceId,
  now: Millis,
): {
  readonly world: World;
  readonly outcome: ClaimOutcome;
  readonly dropId: DropId | undefined;
} => {
  if (isRevoked(world, now)) return { world, outcome: "auth", dropId: undefined };
  const found = world.campaigns
    .flatMap((c) => c.drops.map((drop) => ({ campaign: c, drop })))
    .find(({ drop }) => instanceOf(drop.id) === instanceId);
  if (found === undefined) return { world, outcome: "rejected", dropId: undefined };
  const { campaign, drop } = found;
  if (world.claimed.has(drop.id)) return { world, outcome: "already-claimed", dropId: drop.id };
  const complete = minutesAt(world, drop.id, now) >= drop.requiredMinutes;
  if (!complete || now >= campaign.endsAt + CLAIM_GRACE) {
    return { world, outcome: "rejected", dropId: drop.id };
  }
  const claimed = new Map(world.claimed);
  claimed.set(drop.id, now);
  return { world: { ...world, claimed }, outcome: "claimed", dropId: drop.id };
};

/** Whether a claim of this drop at `now` is legal by twin truth (for invariant 2b). */
export const claimableAt = (world: World, dropId: DropId, now: Millis): boolean => {
  const found = findDrop(world, dropId);
  return (
    found !== undefined &&
    !world.claimed.has(dropId) &&
    minutesAt(world, dropId, now) >= found.drop.requiredMinutes &&
    now < found.campaign.endsAt + CLAIM_GRACE
  );
};

export interface InventoryDrop {
  readonly dropId: DropId;
  readonly minutes: number;
  readonly instanceId: DropInstanceId | undefined;
  readonly claimed: boolean;
}

export interface InventoryCampaign {
  readonly campaign: Campaign;
  readonly drops: ReadonlyArray<InventoryDrop>;
}

/**
 * What the Inventory read shows: campaigns with any progress, until their claim window closes.
 * Minutes lag by `inventoryLag` and the claimed flag by `CLAIMED_FLAG_LAG` (research 02 §3; the
 * lag values are inference).
 */
export const inventoryView = (world: World, now: Millis): ReadonlyArray<InventoryCampaign> => {
  const seen = now - world.inventoryLag;
  return world.campaigns
    .filter(
      (c) =>
        now < c.endsAt + CLAIM_GRACE &&
        c.drops.some((d) => minutesAt(world, d.id, seen) > 0 || world.claimed.has(d.id)),
    )
    .map((campaign) => ({
      campaign,
      drops: campaign.drops.map((d) => {
        const minutes = minutesAt(world, d.id, seen);
        return {
          dropId: d.id,
          minutes,
          instanceId: minutes >= d.requiredMinutes ? instanceOf(d.id) : undefined,
          claimed: isClaimedAt(world, d.id, now - CLAIMED_FLAG_LAG),
        };
      }),
    }));
};

/** Source: TDM `twitch.py:996-1010`; the answer's shape is unverified, as `wire.ts` says. */
export const currentDropView = (
  world: World,
  channelId: ChannelId,
  now: Millis,
): { readonly dropId: DropId; readonly minutes: number } | undefined => {
  if (world.session?.channelId !== channelId) return undefined;
  const campaign = creditedCampaign(world, channelId, now);
  const drop = campaign?.drops
    .filter((d) => earnable(world, d, now))
    .toSorted((a, b) => a.id.localeCompare(b.id))[0];
  return drop === undefined
    ? undefined
    : { dropId: drop.id, minutes: minutesAt(world, drop.id, now) };
};

const windowEnd = (fault: { readonly atMinute: number; readonly durationSeconds: number }) =>
  at(fault.atMinute) + fault.durationSeconds * 1000;

/** The window fault (5xx, 429, timeout, service error, null catalog) covering this request. */
export const windowFaultAt = (world: World, operation: Operation, now: Millis) =>
  world.faults.find(
    (f) =>
      (f.kind === "http-5xx" ||
        f.kind === "http-429" ||
        f.kind === "timeout" ||
        f.kind === "service-error" ||
        f.kind === "null-catalog") &&
      (f.operation === "any" || f.operation === operation) &&
      at(f.atMinute) <= now &&
      now < windowEnd(f),
  );

/** A `timeout` window on `any` operation: the network itself hangs, CDN requests included. */
export const networkDownAt = (world: World, now: Millis): boolean =>
  world.faults.some(
    (f) =>
      f.kind === "timeout" && f.operation === "any" && at(f.atMinute) <= now && now < windowEnd(f),
  );

export const framesDownAt = (world: World, now: Millis): boolean =>
  world.faults.some((f) => f.kind === "frames-down" && at(f.atMinute) <= now && now < windowEnd(f));

/** Start and end of every fault window, for wake-ups and the idle clock. */
export const faultWindows = (
  world: World,
): ReadonlyArray<{ readonly from: Millis; readonly to: Millis }> =>
  world.faults.flatMap((f) =>
    "durationSeconds" in f ? [{ from: at(f.atMinute), to: windowEnd(f) }] : [],
  );
