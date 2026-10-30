import { assert, describe, it } from "@effect/vitest";
import { Exit, Schema } from "effect";
import committed from "../../schema/status.v1.json" with { type: "json" };
import {
  campaign,
  channel,
  chid,
  cid,
  did,
  iid,
  progress,
  settings,
  T0,
} from "../core/fixtures.ts";
import { claimKey } from "../core/model.ts";
import { Event } from "../core/protocol.ts";
import { initial, type State, type Watching } from "../core/state.ts";
import {
  encodeStatusFile,
  StatusFile,
  StatusReport,
  STATUS_SCHEMA_URL,
  statusJsonSchema,
} from "./schema.ts";
import {
  changeKey,
  health,
  observe,
  parseStatus,
  snapshot,
  startFacts,
  type Read,
} from "./snapshot.ts";

const c1 = campaign("c1");
const meta = { version: "1.0.0", pid: 7, mode: "live" } as const;
const sockets = { connections: 1, listening: 1, topics: 5, dropped: 0 };

const watching: Watching = {
  _tag: "Watching",
  channelId: chid("ch1"),
  campaignId: c1.id,
  dropId: did("c1-d1"),
  credited: true,
  confirmedAt: T0,
  confirmedMinutes: 12,
  estimatedMinutes: 13,
  lastCurrentDropRead: undefined,
};

const running: State = {
  ...initial(settings()),
  auth: "valid",
  catalog: [c1],
  catalogStatus: "ok",
  progress: new Map([[did("c1-d1"), progress(c1, "c1-d1", { minutes: 12 })]]),
  channels: new Map([[chid("ch1"), channel("ch1")]]),
  watch: watching,
};

const at = (state: State, now = T0) =>
  snapshot({ state, facts: startFacts(T0 - 60_000), meta, sockets, now });

const read = (status: StatusFile): Read => ({ _tag: "Read", status });

describe("snapshot", () => {
  it("names the watch: channel login, game, campaign, drop and confirmed minutes", () => {
    const s = at(running);
    assert.deepStrictEqual(s.watch, {
      state: "watching",
      channel: { id: "ch1", login: "ch1" },
      game: "Game game-1",
      campaign: { id: "c1", name: "Campaign c1" },
      drop: { id: "c1-d1", name: "Drop c1-d1" },
      minutes: 12,
      requiredMinutes: 60,
    });
    assert.strictEqual(s.auth, "valid");
    assert.deepStrictEqual(s.catalog, { status: "ok", campaigns: 1 });
    assert.deepStrictEqual(s.miner, { ...meta, startedAt: T0 - 60_000 });
    assert.strictEqual(s.heartbeatAt, T0);
    assert.isNull(s.stoppedAt);
  });

  it("keeps ids where names are unknown, and reports idle reasons and a token being checked", () => {
    const unnamed = at({ ...running, catalog: [], channels: new Map() });
    assert.deepInclude(unnamed.watch, {
      channel: { id: "ch1", login: null },
      game: null,
      drop: { id: "c1-d1", name: null },
      requiredMinutes: null,
    });
    const fresh = at(initial(settings()));
    assert.strictEqual(fresh.auth, "checking");
    assert.deepStrictEqual(fresh.watch, { state: "idle", reason: "starting" });
    assert.deepStrictEqual(fresh.catalog, { status: "unknown", campaigns: 0 });
  });

  it("lists claims in flight with their drop names", () => {
    const claims = new Map([
      [
        claimKey(c1.id, did("c1-d1")),
        { campaignId: c1.id, dropId: did("c1-d1"), status: "unknown" as const, recheckAt: T0 },
      ],
    ]);
    assert.deepStrictEqual(at({ ...running, claims }).claims.inFlight, [
      { campaignId: "c1", dropId: "c1-d1", drop: "Game game-1: Drop c1-d1", status: "unknown" },
    ]);
  });

  it("encodes to JSON that decodes back to the same document", () => {
    const s = at(running);
    const json = JSON.parse(JSON.stringify(encodeStatusFile(s)));
    assert.strictEqual(json.heartbeatAt, "2026-10-29T12:00:00.000Z");
    assert.deepStrictEqual(Schema.decodeUnknownSync(StatusFile)(json), s);
  });

  it("still encodes when Twitch gives a drop fractional minutes", () => {
    const odd = campaign("c1", { drops: [{ ...c1.drops[0]!, requiredMinutes: 60.5 }] });
    const s = at({ ...running, catalog: [odd] });
    assert.strictEqual(s.watch.state === "watching" && s.watch.requiredMinutes, 60);
    assert.doesNotThrow(() => encodeStatusFile(s));
  });

  it("changes only when something but the heartbeat and the read times changes", () => {
    const a = at(running);
    const facts = { ...startFacts(T0), reads: { ...startFacts(T0).reads, inventory: T0 + 5 } };
    const b = snapshot({ state: running, facts, meta, sockets, now: T0 + 30_000 });
    assert.strictEqual(changeKey(a), changeKey({ ...b, miner: a.miner }));
    const progressed = new Map([[did("c1-d1"), progress(c1, "c1-d1", { minutes: 13 })]]);
    assert.notStrictEqual(changeKey(a), changeKey(at({ ...running, progress: progressed })));
  });
});

describe("observe", () => {
  const intent = { campaignId: c1.id, dropId: did("c1-d1"), status: "sent" as const };
  const withIntent: State = {
    ...running,
    claims: new Map([[claimKey(c1.id, did("c1-d1")), { ...intent, recheckAt: undefined }]]),
    progress: new Map([
      [did("c1-d1"), progress(c1, "c1-d1", { minutes: 60, instanceId: iid("i1") })],
    ]),
  };
  const claimed: State = {
    ...withIntent,
    claims: new Map(),
    progress: new Map([
      [did("c1-d1"), progress(c1, "c1-d1", { minutes: 60, instanceId: iid("i1"), claimed: true })],
    ]),
  };

  it("records the time of each successful read", () => {
    const facts = observe(startFacts(T0), running, running, Event.TokenValid(), T0 + 1);
    const later = observe(facts, running, running, Event.InventoryRead({ progress: [] }), T0 + 2);
    assert.strictEqual(later.reads.validate, T0 + 1);
    assert.strictEqual(later.reads.inventory, T0 + 2);
    assert.isUndefined(later.reads.catalog);
    assert.strictEqual(observe(later, running, running, Event.Tick(), T0 + 3), later);
  });

  it("counts a claim settled by its answer or by inventory, not one made elsewhere", () => {
    const answer = Event.ClaimResult({ ...intent, outcome: "claimed" });
    assert.deepStrictEqual(observe(startFacts(T0), withIntent, claimed, answer, T0 + 9).claimed, [
      { campaignId: cid("c1"), dropId: did("c1-d1"), at: T0 + 9 },
    ]);
    const inventory = Event.InventoryRead({ progress: [] });
    assert.lengthOf(observe(startFacts(T0), withIntent, claimed, inventory, T0).claimed, 1);
    // An unknown claim dropped after its recheck failed was not claimed.
    const failed = { ...claimed, progress: withIntent.progress };
    assert.lengthOf(observe(startFacts(T0), withIntent, failed, inventory, T0).claimed, 0);
    // A drop claimed in a browser had no intent.
    const before = { ...withIntent, claims: new Map() };
    assert.lengthOf(observe(startFacts(T0), before, claimed, inventory, T0).claimed, 0);
  });
});

describe("health", () => {
  const ok = at(running);

  it("is healthy while the heartbeat is fresh, and not running once it is stale or stopped", () => {
    assert.deepInclude(health(read(ok), T0 + 90_000), { state: "healthy", exitCode: 0 });
    assert.deepInclude(health(read(ok), T0 + 90_001), { state: "not-running", exitCode: 1 });
    assert.deepInclude(health(read({ ...ok, stoppedAt: T0 }), T0 + 1), {
      state: "not-running",
      exitCode: 1,
    });
    assert.deepInclude(health({ _tag: "Missing" }, T0), { state: "not-running", exitCode: 1 });
  });

  it("puts needs-login before discovery broken", () => {
    const parked = { ...ok, auth: "needs-login" as const };
    assert.deepInclude(health(read(parked), T0), { state: "needs-login", exitCode: 2 });
    const broken = { ...ok, catalog: { status: "unavailable" as const, campaigns: 0 } };
    assert.deepInclude(health(read(broken), T0), { state: "discovery-broken", exitCode: 3 });
    assert.strictEqual(
      health(read({ ...broken, auth: "needs-login" }), T0).state,
      "needs-login",
      "a parked miner reads no catalog",
    );
  });

  it("allows ten minutes to start, then calls Twitch unreachable", () => {
    const starting = at(initial(settings()));
    const started = starting.miner.startedAt;
    assert.deepInclude(health(read(starting), T0), { state: "starting", exitCode: 0 });
    const late = { ...starting, heartbeatAt: started + 601_000 };
    const verdict = health(read(late), started + 601_000);
    assert.deepInclude(verdict, { state: "discovery-broken", exitCode: 3 });
    assert.match(verdict.detail, /token check/);
  });

  it("refuses a file it can't read rather than guessing", () => {
    assert.deepInclude(parseStatus("{"), { _tag: "Unreadable" });
    assert.match(
      (parseStatus(JSON.stringify({ version: 2 })) as { detail: string }).detail,
      /version 2/,
    );
    assert.deepInclude(parseStatus(JSON.stringify({ version: 1 })), { _tag: "Unreadable" });
    const good = parseStatus(JSON.stringify(encodeStatusFile(ok)));
    assert.deepStrictEqual(good, { _tag: "Read", status: ok });
    // A reason a newer miner added within version 1 still reads, and the verdict stands.
    const encoded = encodeStatusFile(ok) as { watch: unknown };
    const newer = parseStatus(
      JSON.stringify({ ...encoded, watch: { state: "idle", reason: "some-future-reason" } }),
    );
    assert.deepInclude(newer, { _tag: "Read" });
    assert.deepInclude(health(newer, T0), { exitCode: 0 });
    const unreadable = health({ _tag: "Unreadable", detail: "x" }, T0);
    assert.deepInclude(unreadable, { state: "not-running", exitCode: 1 });
  });
});

describe("the report schema", () => {
  it("decodes a report with and without a status file", () => {
    const decode = Schema.decodeUnknownExit(StatusReport);
    const report = {
      $schema: STATUS_SCHEMA_URL,
      version: 1,
      checkedAt: "2026-10-29T12:00:00.000Z",
      health: { state: "not-running", exitCode: 1, detail: "no status file" },
      status: null,
    };
    assert.isTrue(Exit.isSuccess(decode(report)));
    const full = { ...report, status: encodeStatusFile(at(running)) };
    assert.isTrue(Exit.isSuccess(decode(full)));
    assert.isTrue(Exit.isFailure(decode({ ...report, health: { ...report.health, exitCode: 4 } })));
  });

  it("matches the committed schema/status.v1.json; run `pnpm schema` after changing it", () => {
    assert.deepStrictEqual(statusJsonSchema(), committed);
  });
});
