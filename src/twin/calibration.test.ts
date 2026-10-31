import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { MINUTE } from "../core/model.ts";
import { TOKEN_MARGIN } from "../twitch/hls.ts";
import {
  CHANNEL_FRAMES_PER_HOUR,
  CLAIM_AFTER_FRAME,
  CLAIM_AFTER_FRAME_MAX,
  CLAIMED_FLAG_LAG_MAX,
  CREDIT_SECONDS,
  DOWN_BURST_SHARE,
  FRAME_GAPS,
  HIDDEN_DROP_MINUTES,
  INVENTORY_LAG_MINUTES,
  PLAYLIST_SEGMENTS,
  RECONNECT_GAP,
  RECORDINGS,
  TOKEN_LIFETIME,
} from "./calibration.ts";
import raw from "./fixtures/calibration-2026-10-30.json" with { type: "json" };

/** Every value of `calibration.ts`, derived again from what the recordings showed. */

const Run = Schema.Literals(RECORDINGS);
const Fixture = Schema.Struct({
  recordings: Schema.Array(Schema.Struct({ id: Run, durationMs: Schema.Int })),
  campaigns: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      linked: Schema.NullOr(Schema.Boolean),
      hidden: Schema.optionalKey(Schema.Boolean),
      drops: Schema.Array(Schema.Struct({ id: Schema.String, requiredMinutes: Schema.Int })),
    }),
  ),
  watches: Schema.Array(
    Schema.Struct({
      run: Run,
      firstTick: Schema.Int,
      lastTick: Schema.Int,
      ticks: Schema.Int,
      tickGapMedianMs: Schema.Int,
      tokens: Schema.Array(Schema.Int),
      segments: Schema.Record(Schema.String, Schema.Int),
    }),
  ),
  frames: Schema.Array(
    Schema.Struct({ run: Run, at: Schema.Int, drop: Schema.String, minutes: Schema.Int }),
  ),
  inventory: Schema.Array(
    Schema.Struct({
      run: Run,
      at: Schema.Int,
      /** Minutes, claimed, has an instance id. */
      drops: Schema.Record(
        Schema.String,
        Schema.Tuple([Schema.Int, Schema.Boolean, Schema.Boolean]),
      ),
    }),
  ),
  claims: Schema.Array(
    Schema.Struct({ run: Run, at: Schema.Int, drop: Schema.String, status: Schema.String }),
  ),
  currentDrop: Schema.Array(
    Schema.Struct({
      run: Run,
      at: Schema.Int,
      drop: Schema.String,
      minutes: Schema.Int,
      required: Schema.Int,
    }),
  ),
  awarded: Schema.Array(Schema.Struct({ run: Run, drop: Schema.String, awardedAt: Schema.Int })),
  pubsub: Schema.Array(
    Schema.Struct({
      run: Run,
      streamUp: Schema.Array(Schema.Tuple([Schema.Int, Schema.String])),
      streamDown: Schema.Array(Schema.Tuple([Schema.Int, Schema.String])),
      /** At, channel, the game stayed the same. */
      settings: Schema.Array(Schema.Tuple([Schema.Int, Schema.String, Schema.Boolean])),
      reconnects: Schema.Array(
        Schema.Struct({ at: Schema.Int, connection: Schema.Int, listenAfterMs: Schema.Int }),
      ),
      userDropEvents: Schema.Record(Schema.String, Schema.Int),
    }),
  ),
});

const fixture = Schema.decodeUnknownSync(Fixture)(raw);
const RUN4H = "2026-10-30/run4h";

const campaignOf = (drop: string) =>
  fixture.campaigns.find((c) => c.drops.some((d) => d.id === drop))!;
const requiredOf = (drop: string) =>
  campaignOf(drop).drops.find((d) => d.id === drop)!.requiredMinutes;
const framesOf = (run: string, drop: string) =>
  fixture.frames.filter((f) => f.run === run && f.drop === drop);
const keys = [...new Set(fixture.frames.map((f) => `${f.run} ${f.drop}`))].map((k) => {
  const [run, drop] = k.split(" ") as [string, string];
  return { run, drop };
});
const sorted = (xs: ReadonlyArray<number>) => xs.toSorted((a, b) => a - b);
const hours = (run: string) =>
  fixture.recordings.find((r) => r.id === run)!.durationMs / (60 * MINUTE);

describe("calibration, 2026-10-30 recordings", () => {
  it("frame gaps: the credited minutes between consecutive frames of one drop", () => {
    const gaps = keys.flatMap(({ run, drop }) => {
      const fs = framesOf(run, drop);
      return fs.slice(1).map((f, i) => f.minutes - fs[i]!.minutes);
    });
    assert.deepStrictEqual(sorted(gaps), sorted(FRAME_GAPS));
  });

  it("frames: completion always framed, and one drop of a campaign at a time, closest to done", () => {
    const completions = keys.filter(({ run, drop }) =>
      framesOf(run, drop).some((f) => f.minutes >= requiredOf(drop)),
    );
    const claimed = fixture.claims.filter((c) => fixture.frames.some((f) => f.drop === c.drop));
    assert.strictEqual(completions.length, 5);
    assert.strictEqual(claimed.length, 5);
    for (const { run, drop } of keys) {
      const siblings = campaignOf(drop).drops.filter((d) => d.id !== drop);
      for (const sibling of siblings) {
        const mine = framesOf(run, drop);
        const theirs = framesOf(run, sibling.id);
        if (theirs.length === 0 || mine.length === 0) continue;
        // Never interleaved: the shorter drop's frames all come first.
        const [first, second] =
          requiredOf(drop) < sibling.requiredMinutes ? [mine, theirs] : [theirs, mine];
        assert.isBelow(first.at(-1)!.at, second[0]!.at);
      }
    }
  });

  it("credit: a minute per minute watched, within 2 %", () => {
    for (const w of fixture.watches) {
      const fs = fixture.frames.filter(
        (f) => f.run === w.run && f.at >= w.firstTick && f.at <= w.lastTick + MINUTE,
      );
      const byDrop = Map.groupBy(fs, (f) => f.drop);
      for (const series of byDrop.values()) {
        if (series.length < 2) continue;
        const first = series[0]!;
        const last = series.at(-1)!;
        if (last.at - first.at < 10 * MINUTE) continue;
        const rate = (last.minutes - first.minutes) / ((last.at - first.at) / MINUTE);
        assert.isAbove(rate, 0.97);
        assert.isBelow(rate, 1.02);
      }
    }
    assert.strictEqual(CREDIT_SECONDS, 60);
    assert.isAtLeast(Math.min(...fixture.watches.map((w) => w.tickGapMedianMs)), 19_990);
  });

  it("inventory lag: a read never shows less than a frame before it said", () => {
    const behind: Array<number> = [];
    for (const read of fixture.inventory) {
      for (const [drop, [minutes, claimed]] of Object.entries(read.drops)) {
        if (claimed) continue;
        const fs = framesOf(read.run, drop);
        const before = fs.findLast((f) => f.at <= read.at);
        const after = fs.find((f) => f.at > read.at);
        if (before === undefined || after === undefined) continue;
        behind.push(before.minutes - minutes);
        assert.isAtMost(minutes, after.minutes);
      }
    }
    assert.isAtLeast(behind.length, 25);
    assert.strictEqual(Math.max(...behind), INVENTORY_LAG_MINUTES);
  });

  it("claims: 0.6–0.9 s after the completing frame, ELIGIBLE_FOR_ALL, and no drop-claim frame", () => {
    const delays: Array<number> = [];
    for (const claim of fixture.claims) {
      assert.strictEqual(claim.status, "ELIGIBLE_FOR_ALL");
      const done = framesOf(claim.run, claim.drop).find((f) => f.minutes >= requiredOf(claim.drop));
      if (done !== undefined) delays.push(claim.at - done.at);
    }
    assert.lengthOf(delays, 5);
    assert.deepStrictEqual(
      { min: Math.min(...delays), max: Math.max(...delays) },
      CLAIM_AFTER_FRAME,
    );
    assert.isAtMost(CLAIM_AFTER_FRAME.max, CLAIM_AFTER_FRAME_MAX);
    for (const p of fixture.pubsub)
      assert.deepStrictEqual(Object.keys(p.userDropEvents), ["drop-progress"]);
  });

  it("claimed flag: the next read shows it, or the campaign is gone; never for an unlinked item", () => {
    const nextReads: Array<number> = [];
    for (const claim of fixture.claims) {
      const later = fixture.inventory.filter((r) => r.run === claim.run && r.at > claim.at);
      const linked = campaignOf(claim.drop).linked === true;
      if (!linked) {
        // Marvel Rivals Spray: answered ELIGIBLE_FOR_ALL, unclaimed with its instance id after.
        assert.isAtLeast(later.length, 8);
        for (const r of later) assert.deepStrictEqual(r.drops[claim.drop]?.slice(1), [false, true]);
        continue;
      }
      const next = later[0]!;
      nextReads.push(next.at - claim.at);
      const shown = next.drops[claim.drop];
      assert.isTrue(shown === undefined || shown[1]);
    }
    // The longest wait for that read, to the minute: no read came sooner to show the flag.
    assert.strictEqual(Math.round(Math.max(...nextReads) / MINUTE) * MINUTE, CLAIMED_FLAG_LAG_MAX);
  });

  it("inventory: a campaign leaves once all its drops are claimed, even claimed the day before", () => {
    const left = fixture.claims.filter((claim) => {
      const campaign = campaignOf(claim.drop);
      const rest = campaign.drops.filter((d) => d.id !== claim.drop);
      const allClaimed = rest.every((d) =>
        fixture.claims.some((c) => c.drop === d.id && c.at < claim.at),
      );
      if (!allClaimed || campaign.linked !== true) return false;
      const later = fixture.inventory.filter((r) => r.run === claim.run && r.at > claim.at);
      return later.every((r) => campaign.drops.every((d) => r.drops[d.id] === undefined));
    });
    assert.strictEqual(left.length, 3);
    // Witchspire: two badges awarded the day before, no read of run4h lists the campaign.
    const before = fixture.awarded.filter((a) => a.run === RUN4H && a.awardedAt < 0);
    assert.strictEqual(before.length, 2);
    const witchspire = campaignOf(before[0]!.drop);
    for (const r of fixture.inventory.filter((x) => x.run === RUN4H)) {
      for (const d of witchspire.drops) assert.isUndefined(r.drops[d.id]);
    }
  });

  it("current drop: a drop claimed the day before, counting past its requirement", () => {
    const reads = fixture.currentDrop;
    assert.strictEqual(reads.length, 7);
    assert.strictEqual(new Set(reads.map((r) => r.drop)).size, 1);
    const drop = reads[0]!.drop;
    assert.isTrue(fixture.awarded.some((a) => a.drop === drop && a.awardedAt < 0));
    for (const r of reads) assert.isAbove(r.minutes, r.required);
    const rate =
      (reads.at(-1)!.minutes - reads[0]!.minutes) / ((reads.at(-1)!.at - reads[0]!.at) / MINUTE);
    assert.isAbove(rate, 0.97);
    assert.isBelow(rate, 1.01);
  });

  it("hidden campaign: a drop in no dashboard nor inventory, framed beside a listed one", () => {
    const hidden = fixture.campaigns.filter((c) => c.hidden === true);
    assert.strictEqual(hidden.length, 1);
    const drop = hidden[0]!.drops[0]!.id;
    assert.strictEqual(requiredOf(drop), HIDDEN_DROP_MINUTES);
    assert.isAtLeast(framesOf(RUN4H, drop).length, 10);
    for (const r of fixture.inventory) assert.isUndefined(r.drops[drop]);
  });

  it("playback: a token every 19 minutes, 15/16 or 30/31 segments a tick", () => {
    const intervals = fixture.watches.flatMap((w) =>
      w.tokens.slice(1).map((t, i) => t - w.tokens[i]!),
    );
    const exact = intervals.filter((i) => Math.abs(i - (TOKEN_LIFETIME - TOKEN_MARGIN)) < 1_000);
    assert.deepStrictEqual([exact.length, intervals.length], [10, 11]);
    const counts = fixture.watches.flatMap((w) => Object.entries(w.segments));
    const total = counts.reduce((n, [, k]) => n + k, 0);
    const steady = counts
      .filter(([segments]) => PLAYLIST_SEGMENTS.includes(Number(segments)))
      .reduce((n, [, k]) => n + k, 0);
    assert.isAbove(steady / total, 0.97);
  });

  it("pubsub: rates for 100 followed channels, down bursts, one RECONNECT roll-out", () => {
    const p = fixture.pubsub.find((x) => x.run === RUN4H)!;
    const h = hours(RUN4H);
    const rate = (n: number) => Math.round((n / h) * 4) / 4;
    assert.deepStrictEqual(
      {
        streamUp: rate(p.streamUp.length),
        streamDown: rate(p.streamDown.length),
        settings: rate(p.settings.length),
        gameChange: rate(p.settings.filter(([, , same]) => !same).length),
      },
      CHANNEL_FRAMES_PER_HOUR,
    );
    const downs = p.streamDown.map(([at]) => at);
    const bursts = downs.slice(1).filter((at, i) => at - downs[i]! < MINUTE).length;
    assert.strictEqual(bursts / (downs.length - 1), DOWN_BURST_SHARE);
    assert.strictEqual(p.reconnects.length, 5);
    const ats = p.reconnects.map((r) => r.at);
    assert.isBelow(Math.max(...ats) - Math.min(...ats), 4 * MINUTE);
    const gaps = p.reconnects.map((r) => r.listenAfterMs);
    assert.deepStrictEqual({ min: Math.min(...gaps), max: Math.max(...gaps) }, RECONNECT_GAP);
  });
});
