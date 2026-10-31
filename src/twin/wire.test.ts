import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";
import { PUBSUB_OPEN_TIMEOUT_MS, PUBSUB_URL } from "../twitch/identity.ts";
import { CLAIM_GRANTED, Mutations } from "../twitch/identity.ts";
import { Connector, PubSubLost, webSocketConnection, type Connection } from "../twitch/PubSub.ts";
import { Credentials } from "../twitch/Twitch.ts";
import { cdnOperation } from "./cdn.ts";
import type { Plant } from "./process.ts";
import { respond, respondJson } from "./response.ts";
import { DEFAULT_GOAL_SPEC, type Scenario } from "./scenario.ts";
import { runScenario, runTwice } from "./sim.ts";
import { Issued, TWIN_TOKEN } from "./twin.ts";

/**
 * The miner's own wire code (`hlsWatch`, `PubSub`, `Connector.webSocket`) runs in the simulator
 * over the twin's HTTP surface and websockets. Each test plants a bug in it, the kind the typed
 * twin could not see, and checks the twin catches it, and that the real code passes the same
 * world.
 */

const live = { dropsEnabled: true, refuses: false, liveAtStart: true, changes: [] } as const;

/** One long campaign on game 0 with two live channels, the busier one first. */
const world: Scenario = {
  latencySeed: 3,
  horizonMinutes: 60,
  inventoryLagMinutes: 1,
  settings: { goals: [DEFAULT_GOAL_SPEC] },
  campaigns: [
    {
      game: 0,
      startMinute: -10,
      durationMinutes: 600,
      linked: true,
      allowList: [],
      drops: [{ requiredMinutes: 300, after: null, benefit: "DIRECT_ENTITLEMENT" }],
    },
  ],
  channels: [
    { ...live, game: 0, viewers: 10_000 },
    { ...live, game: 0, viewers: 50 },
  ],
  faults: [],
};

/** The bug of #15, as it was: one Effect `Socket` for every connection. */
const sharedSocket: Plant = {
  connector: Layer.effect(
    Connector,
    Effect.map(
      Socket.makeWebSocket(PUBSUB_URL, { openTimeout: Duration.millis(PUBSUB_OPEN_TIMEOUT_MS) }),
      (socket) => Connector.of({ connect: webSocketConnection(socket) }),
    ),
  ),
};

/** Rewrites what the miner hears from the CDN, as a bug in its own reading would. */
const misreadCdn =
  (
    rewrite: (
      request: HttpClientRequest.HttpClientRequest,
      status: number,
    ) => number | "skip" | undefined,
  ): NonNullable<Plant["http"]> =>
  (client) =>
    HttpClient.make((request) => {
      const op = cdnOperation(request.url);
      const before = op === undefined ? undefined : rewrite(request, 0);
      if (before === "skip") return Effect.succeed(respond(request, 200, ""));
      return Effect.map(client.execute(request), (response) => {
        const status = op === undefined ? undefined : rewrite(request, response.status);
        return typeof status === "number" && status !== response.status
          ? respond(request, status, "")
          : response;
      });
    });

/** Wraps every connection the miner opens. */
const wrapConnections = (wrap: (connection: Connection) => Connection): Plant => ({
  connector: Layer.effect(
    Connector,
    Effect.map(Connector, (real) => Connector.of({ connect: Effect.map(real.connect, wrap) })),
  ).pipe(Layer.provide(Connector.webSocket)),
});

/** A 2-minute drop on a busy channel, claimed within the first half-hour. */
const claiming: Scenario = {
  ...world,
  horizonMinutes: 30,
  campaigns: [
    {
      ...world.campaigns[0]!,
      drops: [{ requiredMinutes: 2, after: null, benefit: "DIRECT_ENTITLEMENT" }],
    },
  ],
};

const isClaim = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" &&
  new TextDecoder().decode(request.body.body).includes(Mutations.ClaimDrop.operationName);

describe("the wire, with bugs planted in the miner", () => {
  // B1 review P1-1: the twin took any token, and a miner given the wrong one passed 20 of 20.
  it.effect("a miner wired to a token the account doesn't hold", () =>
    Effect.gen(function* () {
      const stolen: Plant = {
        credentials: Layer.succeed(
          Credentials,
          Credentials.of({ token: Redacted.make("some-other-token"), deviceId: "0".repeat(32) }),
        ),
      };
      const bug = yield* runScenario({ ...world, horizonMinutes: 10 }, { plant: stolen });
      assert.strictEqual(bug.violation?.kind, "WrongToken");
      assert.isUndefined((yield* runScenario({ ...world, horizonMinutes: 10 })).violation);
    }),
  );

  // B1 review P1-2: a claim the miner reports as claimed when Twitch granted none.
  it.effect("an executor that reports a failed claim as claimed", () =>
    Effect.gen(function* () {
      const storm: Scenario = {
        ...claiming,
        faults: [{ kind: "http-5xx", operation: "ClaimDrop", atMinute: 0, durationSeconds: 1800 }],
      };
      const fine = yield* runTwice(storm);
      assert.isUndefined(fine.violation, JSON.stringify(fine.violation));
      assert.include(fine.tail.join("\n"), '"outcome":"unknown"');
      const optimist: NonNullable<Plant["http"]> = (client) =>
        HttpClient.make((request) =>
          Effect.map(client.execute(request), (response) =>
            isClaim(request) && response.status !== 200
              ? respondJson(request, 200, [
                  {
                    data: {
                      claimDropRewards: { status: CLAIM_GRANTED, isUserAccountConnected: true },
                    },
                  },
                ])
              : response,
          ),
        );
      const bug = yield* runScenario(storm, { plant: { http: optimist } });
      assert.strictEqual(bug.violation?.kind, "ClaimMisread");
    }),
  );

  // B1 review P2 (b): nothing checked that a RECONNECT was obeyed.
  it.effect("a PubSub client that ignores RECONNECT", () =>
    Effect.gen(function* () {
      const deaf = wrapConnections((c) => {
        const receive: Connection["receive"] = Effect.filterOrElse(
          c.receive,
          (text) => !text.includes('"RECONNECT"'),
          () => receive,
        );
        return { ...c, receive };
      });
      const stormy: Scenario = {
        ...world,
        horizonMinutes: 10,
        faults: [{ kind: "pubsub-reconnect", atMinute: 5 }],
      };
      assert.isUndefined((yield* runTwice(stormy)).violation);
      const bug = yield* runScenario(stormy, { plant: deaf });
      assert.strictEqual(bug.violation?.kind, "ReconnectIgnored");
    }),
  );

  // B1 review P2 (c): a request no command sent was never an orphan.
  it.effect("a request sent outside any command", () =>
    Effect.gen(function* () {
      const stray: NonNullable<Plant["http"]> = (client) =>
        HttpClient.make((request) =>
          client.execute(request).pipe(Effect.provideService(Issued, undefined)),
        );
      const bug = yield* runScenario({ ...world, horizonMinutes: 5 }, { plant: { http: stray } });
      assert.strictEqual(bug.violation?.kind, "Orphan");
      assert.include(bug.violation?.detail ?? "", "sent by no command");
    }),
  );

  // B1 review P2 (f): any close within 30 s of a Subscribe passed as a shrink.
  it.effect("a PubSub client that drops its first connection for no reason", () =>
    Effect.gen(function* () {
      let dropped = false;
      const flaky = wrapConnections((c) => ({
        ...c,
        receive: Effect.flatMap(c.receive, (text) => {
          if (dropped || !text.includes('"RESPONSE"')) return Effect.succeed(text);
          dropped = true;
          return Effect.fail(new PubSubLost({ detail: "planted" }));
        }),
      }));
      const bug = yield* runScenario({ ...world, horizonMinutes: 5 }, { plant: flaky });
      assert.strictEqual(bug.violation?.kind, "SocketChurn");
    }),
  );

  // B1 review P2 (i): the CDN never required the player's identity.
  it.effect("a watch that drops the Referer from CDN requests", () =>
    Effect.gen(function* () {
      const bare: NonNullable<Plant["http"]> = (client) =>
        HttpClient.make((request) =>
          client.execute(
            cdnOperation(request.url) === undefined
              ? request
              : HttpClientRequest.removeHeader(request, "Referer"),
          ),
        );
      const bug = yield* runScenario({ ...world, horizonMinutes: 5 }, { plant: { http: bare } });
      assert.strictEqual(bug.violation?.kind, "CdnIdentity");
    }),
  );

  // B1 review P2 (h): the token in a cookie to the CDN went unseen.
  it.effect("a watch that sends the auth-token cookie to the CDN", () =>
    Effect.gen(function* () {
      const cookie: NonNullable<Plant["http"]> = (client) =>
        HttpClient.make((request) =>
          client.execute(
            cdnOperation(request.url) === undefined
              ? request
              : HttpClientRequest.setHeader(request, "Cookie", `auth-token=${TWIN_TOKEN}`),
          ),
        );
      const bug = yield* runScenario({ ...world, horizonMinutes: 5 }, { plant: { http: cookie } });
      assert.strictEqual(bug.violation?.kind, "TokenLeak");
    }),
  );

  it.effect("#15: one shared Socket sends every PING and LISTEN down the newest websocket", () =>
    Effect.gen(function* () {
      // 60 more channels: the directory's 30 of game 0 need two PubSub connections.
      const crowded: Scenario = { ...world, horizonMinutes: 30, crowd: { count: 60 } };
      const fine = yield* runScenario(crowded);
      assert.isUndefined(fine.violation);
      assert.isAtLeast(fine.wire["peak sockets"] ?? 0, 2);
      assert.strictEqual(fine.wire["sockets"], fine.wire["peak sockets"]);
      const bug = yield* runScenario(crowded, { plant: sharedSocket });
      assert.include(["SocketChurn", "SocketBudget", "NotListening"], bug.violation?.kind);
    }),
  );

  it.effect("an HLS client that reads a 404 as a network failure", () =>
    Effect.gen(function* () {
      // The busy channel 1 ends at minute 10; its playlist answers 404 at once (odd index). With
      // PubSub down the core learns it only from the tick.
      const ending: Scenario = {
        ...world,
        horizonMinutes: 20,
        channels: [
          { ...live, game: 0, viewers: 50 },
          { ...live, game: 0, viewers: 10_000, changes: [{ atMinute: 10, to: "down" }] },
        ],
        faults: [{ kind: "frames-down", atMinute: 0, durationSeconds: 1800 }],
      };
      const fine = yield* runTwice(ending);
      assert.isUndefined(fine.violation);
      assert.include(fine.tail.join("\n"), '"reason":"offline"');
      const bug = yield* runScenario(ending, {
        plant: { http: misreadCdn((_, status) => (status === 404 ? 503 : undefined)) },
      });
      assert.strictEqual(bug.violation?.kind, "WatchMisread");
      assert.include(bug.violation?.detail ?? "", "answered offline");
    }),
  );

  it.effect("a watch that HEADs only the first segment of each playlist", () =>
    Effect.gen(function* () {
      let first = true;
      const lazy = misreadCdn((request) => {
        if (cdnOperation(request.url) === "playlist") first = true;
        if (cdnOperation(request.url) !== "segment") return undefined;
        const skip = !first;
        first = false;
        return skip ? "skip" : undefined;
      });
      const bug = yield* runScenario({ ...world, horizonMinutes: 10 }, { plant: { http: lazy } });
      assert.strictEqual(bug.violation?.kind, "WatchMisread");
      assert.include(bug.violation?.detail ?? "", "reported WatchTicked");
    }),
  );

  it.effect("a client that sends the OAuth token to the CDN", () =>
    Effect.gen(function* () {
      const leaky: NonNullable<Plant["http"]> = (client) =>
        HttpClient.make((request) =>
          client.execute(
            cdnOperation(request.url) === undefined
              ? request
              : HttpClientRequest.setHeader(request, "Authorization", "OAuth twin-token"),
          ),
        );
      const bug = yield* runScenario({ ...world, horizonMinutes: 10 }, { plant: { http: leaky } });
      assert.strictEqual(bug.violation?.kind, "TokenLeak");
    }),
  );
  it.effect("a PubSub client that never PINGs", () =>
    Effect.gen(function* () {
      const silent: Plant = {
        connector: Layer.effect(
          Connector,
          Effect.map(Connector, (real) =>
            Connector.of({
              connect: Effect.map(real.connect, (c) => ({
                ...c,
                send: (text: string) => (text.includes('"PING"') ? Effect.void : c.send(text)),
              })),
            }),
          ),
        ).pipe(Layer.provide(Connector.webSocket)),
      };
      // It waits for a PONG that never comes and drops the socket itself, before the edge
      // would close it for want of a PING.
      const bug = yield* runScenario({ ...world, horizonMinutes: 10 }, { plant: silent });
      assert.include(["SocketChurn", "SocketBudget"], bug.violation?.kind);
    }),
  );
});

describe("the wire's faults", () => {
  it.effect(
    "reconnects through RECONNECTs and an edge outage, and replays to the same digest",
    () =>
      Effect.gen(function* () {
        const stormy: Scenario = {
          ...world,
          horizonMinutes: 40,
          crowd: { count: 60 },
          faults: [
            { kind: "pubsub-reconnect", atMinute: 5 },
            { kind: "pubsub-outage", atMinute: 15, durationSeconds: 90 },
            { kind: "http-5xx", operation: "segment", atMinute: 25, durationSeconds: 60 },
            { kind: "timeout", operation: "usher", atMinute: 0, durationSeconds: 30 },
          ],
        };
        const result = yield* runTwice(stormy);
        assert.isUndefined(result.violation);
        // A socket per slot at the start, again after the RECONNECTs, again after the outage.
        assert.isAtLeast(result.wire["sockets"] ?? 0, 3 * (result.wire["peak sockets"] ?? 0));
        assert.isAtLeast(result.creditedMinutes, 25);
      }),
  );
});
