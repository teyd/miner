import {
  CLAIM_GRACE,
  HOUR,
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
import { compareText } from "../core/plan.ts";
import { Event } from "../core/protocol.ts";
import { WATCH_INTERVAL } from "../core/state.ts";
import { CREDIT_SECONDS } from "./calibration.ts";
import { GQL_LIMITS } from "../twitch/budget.ts";
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

/**
 * `otherGames` campaigns: one each, started, running three days, with one linked item drop of an
 * hour, in a game of its own that no channel streams. They add to the catalog and to discovery's
 * reads, and never to what can earn.
 */
const otherCampaigns = (count: number): ReadonlyArray<Campaign> =>
  Array.from({ length: count }, (_, i): Campaign => {
    const id = `o${i}` as CampaignId;
    const startsAt = SIM_EPOCH - HOUR;
    const endsAt = SIM_EPOCH + 72 * HOUR;
    return {
      id,
      name: `Other ${i}`,
      game: { id: `x${i}` as GameId, name: `Other game ${i}`, slug: `other-${i}` },
      startsAt,
      endsAt,
      linked: true,
      allowedChannels: [],
      drops: [
        {
          id: `${id}-d0` as DropId,
          name: `Other drop ${i}`,
          requiredMinutes: 60,
          startsAt,
          endsAt,
          preconditions: [],
          benefits: [
            { id: `${id}-d0-b`, name: `Other reward ${i}`, distribution: "DIRECT_ENTITLEMENT" },
          ],
        },
      ],
    };
  });

/**
 * Inventory shows a claim this long after it happened, when the scenario doesn't say: the core's
 * "seconds" (`CLAIM_RECHECK`). Measured at most 5 minutes (`CLAIMED_FLAG_LAG_MAX`).
 */
export const CLAIMED_FLAG_LAG: Millis = 10_000;

/** When drops claimed before the run were claimed: a day before it starts, at the earliest. */
const BEFORE_RUN: Millis = SIM_EPOCH - 24 * 60 * MINUTE;

/**
 * Drops claimed before the run: of the first `claimedBefore`, those that could have been earned
 * and claimed by then (started, their minutes watched from the start, preconditions claimed),
 * claimed when earned or a day before the run, whichever is later (Witchspire, run4h).
 */
const claimedBeforeRun = (
  campaign: Campaign,
  count: number,
): ReadonlyArray<{ readonly drop: Drop; readonly at: Millis }> => {
  const claimed: Array<{ readonly drop: Drop; readonly at: Millis }> = [];
  for (const drop of campaign.drops.slice(0, count)) {
    const earned = drop.startsAt + drop.requiredMinutes * MINUTE;
    const preconditions = drop.preconditions.every((id) => claimed.some((x) => x.drop.id === id));
    if (earned < SIM_EPOCH && preconditions) {
      claimed.push({ drop, at: Math.max(earned, BEFORE_RUN) });
    }
  }
  return claimed;
};

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

/** Twitch's view of the account watching one channel: what its player asked for, and when. */
export interface Session {
  readonly channelId: ChannelId;
  readonly openedAt: Millis;
  /** The last beat: a media playlist and a `HEAD` of each of its segments. */
  readonly lastBeatAt: Millis;
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
  readonly claimedFlagLag: Millis;
  /** Campaigns Twitch credits but lists nowhere (`hidden`). */
  readonly hidden: ReadonlySet<CampaignId>;
  /** Credited minutes between two progress frames of a campaign, used in turn (`frameGaps`). */
  readonly frameGaps: ReadonlyArray<number>;
  /** Twitch sends `drop-claim` frames (`claimFrames`). */
  readonly claimFrames: boolean;
  /** Every credited drop frames, not only the session drop (`framesAll`). */
  readonly framesAll: boolean;
  readonly faults: ReadonlyArray<Fault>;
  /** Credited minutes per drop, as a history so inventory can lag it. */
  readonly minutes: ReadonlyMap<
    DropId,
    ReadonlyArray<{ readonly at: Millis; readonly minutes: number }>
  >;
  /** Claims, with when they happened; those before `SIM_EPOCH` were received before the run. */
  readonly claimed: ReadonlyMap<DropId, Millis>;
  /**
   * Rewards the account received from campaigns outside the world, by benefit id: a benefit a
   * world drop repeats, awarded before that drop's window (`received: "before-window"`).
   */
  readonly awardedElsewhere: ReadonlyMap<string, Millis>;
  /** Campaigns whose watch credits one drop only (`creditsOnly`), by campaign. */
  readonly creditsOnly: ReadonlyMap<CampaignId, DropId>;
  /** `creditsOnly` campaigns that credit their drop only while it can earn (`creditsMoveOn`). */
  readonly creditsMoveOn: ReadonlySet<CampaignId>;
  /** Credited minutes each campaign has left before its next progress frame. */
  readonly framesIn: ReadonlyMap<CampaignId, number>;
  /** How many gaps of `frameGaps` have been used. */
  readonly frameCursor: number;
  /** Minutes watched on a campaign with nothing left to earn, which only the session counter shows. */
  readonly overtime: ReadonlyMap<CampaignId, number>;
  readonly revokedAt: Millis | undefined;
  /** The `gql-cooldown` windows begun so far (`startCooldown`). */
  readonly cooldowns: ReadonlyArray<{ readonly from: Millis; readonly to: Millis }>;
  readonly session: Session | undefined;
}

/**
 * A frame the twin's PubSub edge sends, as the core event it stands for; the edge writes it in
 * Twitch's wire shape (`edge.ts`). A drop frame names the channel that credited it.
 */
export interface Frame {
  readonly at: Millis;
  readonly event: Event;
  readonly channelId?: ChannelId;
}

export interface Credit {
  readonly at: Millis;
  /** When the core asked for the tick whose beat credited. */
  readonly sentAt?: Millis;
  readonly channelId: ChannelId;
  readonly campaignId: CampaignId;
  readonly dropIds: ReadonlyArray<DropId>;
}

const at = (minute: number): Millis => SIM_EPOCH + minute * MINUTE;
const unique = <A>(xs: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(xs)];

export const channelIdOf = (index: number) => `ch${index}` as ChannelId;

/** A drop's own window, cut to its campaign's and at least a minute long. */
const windowOf = (
  window: { readonly startMinute: number; readonly durationMinutes: number } | undefined,
  startsAt: Millis,
  endsAt: Millis,
): { readonly startsAt: Millis; readonly endsAt: Millis } => {
  if (window === undefined) return { startsAt, endsAt };
  const from = Math.min(startsAt + window.startMinute * MINUTE, endsAt - MINUTE);
  return { startsAt: from, endsAt: Math.min(endsAt, from + window.durationMinutes * MINUTE) };
};

/**
 * Crowd channel `k` at index `index`: on game 0 or 1 by turns, with few viewers, live from the
 * start and offline for 45 minutes once a day at a time of its own.
 */
const crowdChannel = (index: number, k: number): ChannelModel => {
  const game = GAMES[k % 2]!.id;
  const down = (17 + 53 * k) % 1440;
  return {
    id: channelIdOf(index),
    login: `chan${index}`,
    viewers: 1 + ((k * 7) % 40),
    dropsEnabled: true,
    refuses: false,
    phases: [
      { at: SIM_EPOCH, live: true, gameId: game },
      { at: at(down), live: false, gameId: game },
      { at: at(down + 45), live: true, gameId: game },
    ],
  };
};

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
  for (let k = 0; k < (scenario.crowd?.count ?? 0); k++) channels.push(crowdChannel(n + k, k));
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
        ...windowOf(d.window, startsAt, endsAt),
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
  const claimed = new Map<DropId, Millis>();
  const minutes = new Map<
    DropId,
    ReadonlyArray<{ readonly at: Millis; readonly minutes: number }>
  >();
  const awardedElsewhere = new Map<string, Millis>();
  const creditsOnly = new Map<CampaignId, DropId>();
  const creditsMoveOn = new Set<CampaignId>();
  for (const [i, spec] of scenario.campaigns.entries()) {
    const campaign = campaigns[i]!;
    if (spec.creditsOnly !== undefined) {
      creditsOnly.set(campaign.id, campaign.drops[spec.creditsOnly % campaign.drops.length]!.id);
      if (spec.creditsMoveOn === true) creditsMoveOn.add(campaign.id);
    }
    for (const [j, d] of spec.drops.entries()) {
      const drop = campaign.drops[j]!;
      // Claimed at the drop's start, so only a drop open before the run can have been received.
      if (d.received === "in-window" && drop.startsAt < SIM_EPOCH) {
        claimed.set(drop.id, drop.startsAt);
        minutes.set(drop.id, [{ at: drop.startsAt, minutes: drop.requiredMinutes }]);
      }
      if (d.received === "before-window") {
        for (const b of drop.benefits) awardedElsewhere.set(b.id, drop.startsAt - 24 * HOUR);
      }
      if (d.received === "overlapping") {
        for (const b of drop.benefits) awardedElsewhere.set(b.id, drop.startsAt);
      }
    }
    for (const { drop, at } of claimedBeforeRun(campaign, spec.claimedBefore ?? 0)) {
      if (claimed.has(drop.id)) continue;
      claimed.set(drop.id, at);
      minutes.set(drop.id, [{ at, minutes: drop.requiredMinutes }]);
    }
  }
  return {
    campaigns: [...campaigns, ...otherCampaigns(scenario.otherGames ?? 0)],
    creditsUnlinked: new Set(
      scenario.campaigns.flatMap((spec, i) =>
        spec.creditsUnlinked === true ? [`c${i}` as CampaignId] : [],
      ),
    ),
    channels,
    settings: { goals: scenario.settings.goals.map((goal) => goalOf(goal, n)) },
    inventoryLag: scenario.inventoryLagMinutes * MINUTE,
    claimedFlagLag:
      scenario.claimedFlagLagSeconds === undefined
        ? CLAIMED_FLAG_LAG
        : scenario.claimedFlagLagSeconds * 1000,
    hidden: new Set(
      scenario.campaigns.flatMap((spec, i) =>
        spec.hidden === true ? [`c${i}` as CampaignId] : [],
      ),
    ),
    frameGaps: scenario.frameGaps ?? [1],
    claimFrames: scenario.claimFrames ?? false,
    framesAll: scenario.framesAll ?? false,
    faults: scenario.faults,
    minutes,
    claimed,
    awardedElsewhere,
    creditsOnly,
    creditsMoveOn,
    framesIn: new Map(),
    frameCursor: 0,
    overtime: new Map(),
    revokedAt: revokes.length === 0 ? undefined : Math.min(...revokes),
    cooldowns: [],
    session: undefined,
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

/** Channels by id, per channel list: the checker looks channels up on every observation. */
const byId = new WeakMap<ReadonlyArray<ChannelModel>, ReadonlyMap<ChannelId, ChannelModel>>();

export const channelOf = (world: World, id: ChannelId): ChannelModel | undefined => {
  let index = byId.get(world.channels);
  if (index === undefined) {
    index = new Map(world.channels.map((ch) => [ch.id, ch]));
    byId.set(world.channels, index);
  }
  return index.get(id);
};

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
 * `stream-up`, `stream-down` and `broadcast-settings-update` frames for channels whose schedule
 * changed in `(from, to]`, sent 1 s later (TDM `twitch.py:1129-1180`). The edge delivers each only
 * to a connection listening to its topic.
 */
export const channelFrames = (world: World, from: Millis, to: Millis): ReadonlyArray<Frame> => {
  const frames: Array<Frame> = [];
  for (const channel of world.channels) {
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
 * The drops of a campaign a credited minute goes to: every earnable one, or for a `creditsOnly`
 * campaign that one drop while its window is open, whatever its state. Source: the live run of
 * 2026-10-30 (research 02 §3): `DropCurrentSessionContext` showed Witchspire's "Golden Stamp" at
 * 263, then 352 of 240 minutes, a drop received the day before, while the campaign's unreceived
 * drops never moved. Why Twitch picks such a drop is unknown; the twin only replays that it does.
 * A `creditsMoveOn` campaign credits its drop only while it can earn, then every earnable drop.
 */
export const creditedDrops = (
  world: World,
  campaign: Campaign,
  now: Millis,
): ReadonlyArray<Drop> => {
  const only = world.creditsOnly.get(campaign.id);
  const stuck = campaign.drops.find((d) => d.id === only);
  const moveOn = world.creditsMoveOn.has(campaign.id);
  if (
    stuck !== undefined &&
    stuck.startsAt <= now &&
    now < stuck.endsAt &&
    (!moveOn || earnable(world, stuck, now))
  ) {
    return [stuck];
  }
  return campaign.drops.filter((d) => earnable(world, d, now));
};

/**
 * The campaign a minute on this channel credits. When several could, the newest wins (TDM #756,
 * research 02 §3: Twitch progresses one campaign per stream, which one is undocumented).
 */
export const creditedCampaign = (world: World, id: ChannelId, now: Millis): Campaign | undefined =>
  creditable(world, id, now).filter((c) => !world.hidden.has(c.id))[0];

/** Active campaigns this channel can credit now, newest first. */
const creditable = (world: World, id: ChannelId, now: Millis): ReadonlyArray<Campaign> =>
  world.campaigns
    .filter(
      (c) =>
        c.startsAt <= now &&
        now < c.endsAt &&
        accountEarns(world, c) &&
        channelCredits(world, c, id, now) &&
        creditedDrops(world, c, now).length > 0,
    )
    .toSorted((a, b) => b.startsAt - a.startsAt || compareText(a.id, b.id));

/**
 * Campaigns Twitch credits on this channel besides the one `creditedCampaign` names, and lists in
 * no answer: a 900-minute drop moved in step with the Apex campaign on its channel, in neither the
 * dashboard nor the inventory (run4h, 2026-10-30).
 */
export const hiddenCampaigns = (
  world: World,
  id: ChannelId,
  now: Millis,
): ReadonlyArray<Campaign> =>
  world.hidden.size === 0 ? [] : creditable(world, id, now).filter((c) => world.hidden.has(c.id));

/**
 * The drop a campaign's frames and session counter name: of its credited drops (`creditedDrops`),
 * the one closest
 * to done, first in the campaign on a tie (APEX Pack 15 framed while Holospray 60 moved silently,
 * then Holospray; run4h, 2026-10-30).
 */
export const sessionDrop = (world: World, campaign: Campaign, now: Millis): Drop | undefined => {
  const credited = new Set(creditedDrops(world, campaign, now));
  return campaign.drops
    .map((d, i) => ({ d, i, left: d.requiredMinutes - minutesAt(world, d.id, now) }))
    .filter(({ d }) => credited.has(d))
    .toSorted((a, b) => a.left - b.left || a.i - b.i)[0]?.d;
};

const doneAt = (world: World, drop: Drop, now: Millis): boolean =>
  world.claimed.has(drop.id) || minutesAt(world, drop.id, now) >= drop.requiredMinutes;

/**
 * A campaign the channel would credit if anything were left to earn: every drop claimed or
 * complete. Twitch's session counter keeps counting on it (`currentDropView`).
 */
const spentCampaign = (world: World, id: ChannelId, now: Millis): Campaign | undefined =>
  world.campaigns
    .filter(
      (c) =>
        !world.hidden.has(c.id) &&
        c.startsAt <= now &&
        now < c.endsAt &&
        accountEarns(world, c) &&
        channelCredits(world, c, id, now) &&
        c.drops.every((d) => doneAt(world, d, now)),
    )
    .toSorted((a, b) => b.startsAt - a.startsAt || compareText(a.id, b.id))[0];

export const instanceOf = (dropId: DropId) => `${dropId}#i` as DropInstanceId;

export const findDrop = (world: World, dropId: DropId) => {
  for (const campaign of world.campaigns) {
    const drop = campaign.drops.find((d) => d.id === dropId);
    if (drop !== undefined) return { campaign, drop };
  }
  return undefined;
};

/**
 * A view ends when the player stops asking for this long. Twitch doesn't say; the miner beats every
 * 20 s, so a minute is three missed beats (inference).
 */
export const SESSION_GAP: Millis = 60_000;

/** Source: help.twitch.tv "How Drops Work" (research 02 §3): one channel credits at a time. */
export const openSession = (world: World, channelId: ChannelId, now: Millis): World => ({
  ...world,
  session: {
    channelId,
    openedAt: now,
    lastBeatAt: now,
    lastCreditAt: now,
    carrySeconds: 0,
    creditedSeconds: 0,
  },
});

/** The account is watching, as Twitch sees it: a beat came within `SESSION_GAP`. */
export const sessionAt = (world: World, now: Millis): Session | undefined =>
  world.session !== undefined && now - world.session.lastBeatAt <= SESSION_GAP
    ? world.session
    : undefined;

export type TickResult = "ticked" | "offline" | "refused" | "auth";

export interface Ticked {
  readonly world: World;
  readonly result: TickResult;
  readonly frames: ReadonlyArray<Frame>;
  readonly credits: ReadonlyArray<Credit>;
}

/**
 * One beat: the CDN served a media playlist and a `HEAD` of every segment it listed, the request
 * pattern Twitch credited live (research 02 §4, 2026-10-30: one per 20 s, about a minute per
 * minute). A beat on another channel, or after a gap of `SESSION_GAP`, opens a new view that
 * credits from then on. Within a view a beat credits the time since the last credit, at most one
 * interval, so beats that bunch up after a delay earn no more than the wall time they cover (TDM
 * `channel.py:432-487`; exact accounting is lane-D E1, inference). Every `CREDIT_SECONDS` of credit is
 * one minute for every earnable drop of the credited campaign (measured, `calibration.ts`). A
 * revoked token credits nothing.
 */
export const tick = (world: World, channelId: ChannelId, now: Millis): Ticked => {
  const fail = (result: TickResult): Ticked => ({ world, result, frames: [], credits: [] });
  if (isRevoked(world, now)) return fail("auth");
  if (!liveAt(world, channelId, now)) return fail("offline");
  if (channelOf(world, channelId)?.refuses === true) return fail("refused");
  const session = world.session;
  if (
    session === undefined ||
    session.channelId !== channelId ||
    now - session.lastBeatAt > SESSION_GAP
  ) {
    return { ...fail("ticked"), world: openSession(world, channelId, now) };
  }
  const seconds = Math.max(0, Math.min(WATCH_INTERVAL, now - session.lastCreditAt)) / 1000;
  let carry = session.carrySeconds + seconds;
  let next: World = {
    ...world,
    session: {
      ...session,
      lastBeatAt: now,
      lastCreditAt: now,
      carrySeconds: 0,
      creditedSeconds: session.creditedSeconds + seconds,
    },
  };
  const frames: Array<Frame> = [];
  const credits: Array<Credit> = [];
  while (carry >= CREDIT_SECONDS) {
    carry -= CREDIT_SECONDS;
    const minute = creditMinute(next, channelId, now);
    next = minute.world;
    frames.push(...minute.frames);
    credits.push(...minute.credits);
  }
  return {
    world: { ...next, session: { ...next.session!, carrySeconds: carry } },
    result: "ticked",
    frames,
    credits,
  };
};

/**
 * One credited minute for every drop the credited campaign credits (`creditedDrops`) and those of
 * any hidden one (APEX Pack and Holospray moved together, run4h). Each campaign frames its session drop when its
 * countdown runs out or the drop completes (`calibration.ts`, `FRAME_GAPS`); with nothing listed
 * to earn, the minute goes to a spent campaign's session counter, with no frame, and hidden
 * campaigns still earn theirs. With `framesAll`, every credited drop frames with it. `drop-claim`
 * frames only
 * when the scenario asks (none in 4.6 h live). TDM `twitch.py:1239-1297`.
 */
const creditMinute = (world: World, channelId: ChannelId, now: Millis) => {
  const visible = creditedCampaign(world, channelId, now);
  let next = world;
  if (visible === undefined) {
    const spent = spentCampaign(world, channelId, now);
    if (spent !== undefined) {
      const overtime = new Map(world.overtime);
      overtime.set(spent.id, (overtime.get(spent.id) ?? 0) + 1);
      next = { ...world, overtime };
    }
  }
  const frames: Array<Frame> = [];
  const credits: Array<Credit> = [];
  // Hidden campaigns earn on their own, whether or not a listed one has anything left.
  const credited = [
    ...(visible === undefined ? [] : [visible]),
    ...hiddenCampaigns(world, channelId, now),
  ];
  for (const campaign of credited) {
    const framed = sessionDrop(world, campaign, now);
    const minutes = new Map(next.minutes);
    const dropIds: Array<DropId> = [];
    for (const drop of creditedDrops(world, campaign, now)) {
      const total = minutesAt(world, drop.id, now) + 1;
      minutes.set(drop.id, [...(minutes.get(drop.id) ?? []), { at: now, minutes: total }]);
      dropIds.push(drop.id);
    }
    next = { ...next, minutes };
    credits.push({ at: now, channelId, campaignId: campaign.id, dropIds });
    if (framed === undefined) continue;
    // The session drop, and with `framesAll` every other drop credited this minute.
    const shown = next.framesAll
      ? [framed, ...campaign.drops.filter((d) => d !== framed && dropIds.includes(d.id))]
      : [framed];
    const complete = (d: Drop) => minutesAt(next, d.id, now) >= d.requiredMinutes;
    let cursor = next.frameCursor;
    const gap = () => next.frameGaps[cursor++ % next.frameGaps.length] ?? 1;
    const left = (next.framesIn.get(campaign.id) ?? gap()) - 1;
    const due = left <= 0 || shown.some(complete);
    const framesIn = new Map(next.framesIn);
    framesIn.set(campaign.id, due ? gap() : left);
    next = { ...next, framesIn, frameCursor: cursor };
    if (!due) continue;
    for (const drop of shown) {
      frames.push({
        at: now + 1_000,
        event: Event.DropProgress({ dropId: drop.id, minutes: minutesAt(next, drop.id, now) }),
        channelId,
      });
      if (complete(drop) && next.claimFrames && !next.claimed.has(drop.id)) {
        frames.push({
          at: now + 1_000,
          event: Event.DropClaimable({ dropId: drop.id, instanceId: instanceOf(drop.id) }),
          channelId,
        });
      }
    }
  }
  return { world: next, frames, credits };
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
export const claimableAt = (world: World, dropId: DropId, now: Millis): boolean =>
  !world.claimed.has(dropId) && completeAt(world, dropId, now);

/** Complete and within its claim window, claimed or not. */
export const completeAt = (world: World, dropId: DropId, now: Millis): boolean => {
  const found = findDrop(world, dropId);
  return (
    found !== undefined &&
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
 * Whether the Inventory read shows this drop claimed: `claimedFlagLag` after the claim, and never
 * for an item of an unlinked campaign. Twitch answered `ELIGIBLE_FOR_ALL` to such a claim and still
 * listed the drop unclaimed, with its instance id, 2.5 hours later (Marvel Rivals, run37min and
 * run4h, 2026-10-30).
 */
const flagShown = (world: World, campaign: Campaign, drop: Drop, now: Millis): boolean =>
  isClaimedAt(world, drop.id, now - world.claimedFlagLag) && showsClaim(campaign, drop);

const showsClaim = (campaign: Campaign, drop: Drop): boolean =>
  campaign.linked ||
  drop.benefits.some((b) => b.distribution === "BADGE" || b.distribution === "EMOTE");

/** Whether the Inventory read ever shows this drop claimed (`flagShown`). */
export const claimShows = (world: World, dropId: DropId): boolean => {
  const found = findDrop(world, dropId);
  return found !== undefined && showsClaim(found.campaign, found.drop);
};

/**
 * What the Inventory read shows: campaigns with progress or a claim made in the run, until their
 * claim window closes or every drop shows claimed. A campaign left `dropCampaignsInProgress` at the
 * first read after its last claim showed (Apex, Destiny and CFB, both recordings), and a drop
 * received before the run doesn't list its campaign: Witchspire, claimed the day before, was in no
 * read of run4h, and only `gameEventDrops` named its rewards (`awardsAt`). Minutes lag by `inventoryLag` (measured 0) and the claimed
 * flag by `claimedFlagLag` (measured at most 5 minutes). Hidden campaigns are never listed.
 */
export const inventoryView = (world: World, now: Millis): ReadonlyArray<InventoryCampaign> => {
  const seen = now - world.inventoryLag;
  const receivedBefore = (d: Drop) => (world.claimed.get(d.id) ?? Infinity) < SIM_EPOCH;
  const shows = (d: Drop) =>
    !receivedBefore(d) && (minutesAt(world, d.id, seen) > 0 || world.claimed.has(d.id));
  return world.campaigns
    .filter(
      (c) =>
        !world.hidden.has(c.id) &&
        c.startsAt <= now &&
        now < c.endsAt + CLAIM_GRACE &&
        c.drops.some(shows) &&
        !c.drops.every((d) => flagShown(world, c, d, now)),
    )
    .map((campaign) => ({
      campaign,
      drops: campaign.drops.map((d) => {
        const minutes = minutesAt(world, d.id, seen);
        return {
          dropId: d.id,
          minutes,
          instanceId: minutes >= d.requiredMinutes ? instanceOf(d.id) : undefined,
          claimed: flagShown(world, campaign, d, now),
        };
      }),
    }));
};

/**
 * `gameEventDrops`: every reward received, one entry per benefit with its last award, claims
 * showing after `claimedFlagLag` like the claimed flag, and never an unlinked item's: the four
 * linked claims of 2026-10-30 first showed at the next read, 300 s on, and the Marvel Rivals
 * Spray claimed unlinked never did (`awarded` in the calibration fixture). Shape: the live
 * Inventory of 2026-10-30.
 */
export const awardsAt = (
  world: World,
  now: Millis,
): ReadonlyArray<{ readonly benefitId: string; readonly at: Millis }> => {
  const last = new Map(world.awardedElsewhere);
  for (const campaign of world.campaigns) {
    for (const drop of campaign.drops) {
      const at = world.claimed.get(drop.id);
      if (at === undefined || !flagShown(world, campaign, drop, now)) continue;
      for (const b of drop.benefits) last.set(b.id, Math.max(at, last.get(b.id) ?? at));
    }
  }
  return [...last]
    .map(([benefitId, at]) => ({ benefitId, at }))
    .toSorted((a, b) => compareText(a.benefitId, b.benefitId));
};

/**
 * The account looks like it has this drop's rewards though it never claimed it: another campaign
 * awarded each of them inside the drop's window (`received: "overlapping"`), and the inventory
 * doesn't list the drop. TDM's rule, which the miner follows (`isReceived` in `rules.ts`), takes it
 * as received; nothing the account reads tells otherwise, so it is no opportunity.
 */
export const looksReceived = (world: World, drop: Drop, now: Millis): boolean =>
  drop.benefits.length > 0 &&
  drop.benefits.every((b) => {
    const at = world.awardedElsewhere.get(b.id);
    return at !== undefined && drop.startsAt <= at && at < drop.endsAt;
  }) &&
  minutesAt(world, drop.id, now) === 0;

/**
 * Whether a credited minute was one the settings could use: the drop earned at that moment
 * (window open, unclaimed, short of its requirement, preconditions claimed). A credit past the
 * requirement or to a claimed drop (`creditsOnly`) earns nothing.
 */
export const earnedAt = (world: World, drop: Drop, at: Millis): boolean =>
  drop.startsAt <= at &&
  at < drop.endsAt &&
  !isClaimedAt(world, drop.id, at) &&
  minutesAt(world, drop.id, at - 1) < drop.requiredMinutes &&
  drop.preconditions.every((id) => isClaimedAt(world, id, at));

/**
 * `DropCurrentSessionContext` on the watched channel: the session drop of the campaign the channel
 * credits (TDM `twitch.py:996-1010`). With nothing left to earn there, it names the spent
 * campaign's longest drop with every minute watched since, past its requirement: it reported
 * Golden Stamp, claimed the day before, at 263, then 278 … 352 of 240 minutes, 15 per 15-minute
 * read, while the miner watched for Witchspire Logo (run4h, 2026-10-30).
 */
export const currentDropView = (
  world: World,
  channelId: ChannelId,
  now: Millis,
): { readonly dropId: DropId; readonly minutes: number } | undefined => {
  if (sessionAt(world, now)?.channelId !== channelId) return undefined;
  const campaign = creditedCampaign(world, channelId, now);
  if (campaign !== undefined) {
    const drop = sessionDrop(world, campaign, now);
    return drop === undefined
      ? undefined
      : { dropId: drop.id, minutes: minutesAt(world, drop.id, now) };
  }
  const spent = spentCampaign(world, channelId, now);
  const longest = spent?.drops.reduce((a, b) => (b.requiredMinutes >= a.requiredMinutes ? b : a));
  return spent === undefined || longest === undefined
    ? undefined
    : {
        dropId: longest.id,
        minutes: minutesAt(world, longest.id, now) + (world.overtime.get(spent.id) ?? 0),
      };
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

/**
 * PubSub drops frames for a `frames-down` window. A `RECONNECT` (`reconnect`, `pubsub-reconnect`)
 * loses frames on the wire instead: the edge sends it, and frames reach no socket until the
 * client listens again on a new one, after its own gap (`RECONNECT_GAP` is what live clients took).
 */
export const framesDownAt = (world: World, now: Millis): boolean =>
  faultWindows(world, ["frames-down"]).some((w) => w.from <= now && now < w.to);

/**
 * Start and end of every fault window (of these kinds), for wake-ups and the idle clock. A GQL
 * cooldown is left out: ticks are CDN requests, so the miner can still watch and earn through one
 * (its own window, `cooldownWindows`, excuses only a late claim).
 */
export const faultWindows = (
  world: World,
  kinds?: ReadonlyArray<Fault["kind"]>,
): ReadonlyArray<{ readonly from: Millis; readonly to: Millis }> =>
  world.faults.flatMap((f) => {
    if (kinds !== undefined && !kinds.includes(f.kind)) return [];
    if (f.kind === "gql-cooldown") return [];
    if ("durationSeconds" in f) return [{ from: at(f.atMinute), to: windowEnd(f) }];
    if (f.kind === "reconnect") return [{ from: at(f.atMinute), to: at(f.atMinute) + f.gapMillis }];
    return [];
  });

/** The GQL cooldowns begun so far, which excuse a claim that could not go out meanwhile. */
export const cooldownWindows = (
  world: World,
): ReadonlyArray<{ readonly from: Millis; readonly to: Millis }> => world.cooldowns;

/**
 * Starts the next `gql-cooldown` due at `now`, if this answer shows a drop ready to claim: the
 * moment the miner learns of a claim, someone else on its IP spends Twitch's rate. Anchored there
 * rather than to a minute, because without `drop-claim` frames the claim waits on an inventory
 * read, which a cooldown already open refuses too: the claim then goes out after the window and
 * is never the request refused. Returns the world with the window and when the simulator must
 * back the API budget off (`Budget.backOff`, one cooldown each) to keep it cooling from start to
 * end: one a cooldown apart, the last one cooldown before the end.
 */
export const startCooldown = (
  world: World,
  now: Millis,
  answer: ReadonlyArray<InventoryCampaign>,
): readonly [World, ReadonlyArray<Millis>] => {
  const due = world.faults
    .filter((f) => f.kind === "gql-cooldown" && at(f.atMinute) <= now)
    .toSorted((a, b) => a.atMinute - b.atMinute);
  const fault = due[world.cooldowns.length];
  if (fault === undefined || !("durationSeconds" in fault)) return [world, []];
  if (world.cooldowns.some((w) => now < w.to)) return [world, []];
  const ready = answer.some((c) =>
    c.drops.some(
      (d) => d.instanceId !== undefined && !d.claimed && claimableAt(world, d.dropId, now),
    ),
  );
  if (!ready) return [world, []];
  const to = now + Math.max(fault.durationSeconds * 1000, GQL_LIMITS.cooldown);
  const last = to - GQL_LIMITS.cooldown;
  const calls: Array<Millis> = [];
  for (let t = now; t < last; t += GQL_LIMITS.cooldown) calls.push(t);
  calls.push(last);
  return [{ ...world, cooldowns: [...world.cooldowns, { from: now, to }] }, calls];
};
