import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Random } from "effect";
import { TestClock } from "effect/testing";
import campaignDetails from "./fixtures/campaign-details.json" with { type: "json" };
import campaigns from "./fixtures/campaigns.json" with { type: "json" };
import gameDirectory from "./fixtures/game-directory.json" with { type: "json" };
import inventoryServiceError from "./fixtures/inventory-service-error.json" with { type: "json" };
import inventory from "./fixtures/inventory.json" with { type: "json" };
import streamOffline from "./fixtures/stream-info-offline.json" with { type: "json" };
import streamInfo from "./fixtures/stream-info.json" with { type: "json" };
import invalidToken from "./fixtures/validate-invalid-token.json" with { type: "json" };
import valid from "./fixtures/validate-valid.json" with { type: "json" };
import wrongClient from "./fixtures/validate-wrong-client.json" with { type: "json" };
import { chid, game } from "../core/fixtures.ts";
import { stubTwitch, type Answer, type Hang } from "./stub.ts";
import { REQUEST_TIMEOUT, deviceIdOf, Twitch } from "./Twitch.ts";

const account = { userId: "123456789", login: "testuser" };

const run = <A, E>(
  script: Record<string, ReadonlyArray<Answer | Hang>>,
  use: (twitch: Twitch["Service"]) => Effect.Effect<A, E>,
) => {
  const stub = stubTwitch(script);
  const program = Effect.gen(function* () {
    return yield* use(yield* Twitch);
  }).pipe(Effect.provide(Twitch.layer.pipe(Layer.provide(stub.layer))));
  return { program, stub };
};

const errorTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => (r._tag === "Fail" ? r.error._tag : r._tag))
    : [];

describe("validate", () => {
  it.effect("returns the account of an Android-client token", () =>
    Effect.gen(function* () {
      const { program } = run({ validate: [valid] }, (t) => t.validate);
      assert.deepStrictEqual(yield* program, account);
    }),
  );

  it.effect("rejects an invalid token and one issued to another client, without retrying", () =>
    Effect.gen(function* () {
      for (const answer of [invalidToken, wrongClient]) {
        const { program, stub } = run({ validate: [answer] }, (t) => t.validate);
        assert.deepStrictEqual(errorTag(yield* Effect.exit(program)), ["AuthRejected"]);
        assert.strictEqual(stub.calls["validate"], 1);
      }
    }),
  );
});

describe("catalog", () => {
  it.effect("reads active campaigns with their drops and allow-lists", () =>
    Effect.gen(function* () {
      const { program, stub } = run(
        { ViewerDropsDashboard: [campaigns], DropCampaignDetails: [campaignDetails] },
        (t) => t.catalog(account),
      );
      const catalog = yield* program;
      assert.strictEqual(catalog.campaigns.length, 3);
      const tanki = catalog.campaigns[0]!;
      assert.strictEqual(tanki.name, "WMR3 2026 R3");
      assert.deepStrictEqual(tanki.game, {
        id: "417810",
        name: "Tanki Online",
        slug: "tanki-online",
      });
      assert.isFalse(tanki.linked);
      assert.strictEqual(tanki.allowedChannels.length, 4);
      assert.strictEqual(tanki.drops[0]?.requiredMinutes, 30);
      assert.strictEqual(tanki.endsAt, Date.parse("2026-10-28T19:29:59.999Z"));
      assert.strictEqual(catalog.logins.get(tanki.allowedChannels[0]!), "tankisport_ru");
      // One dashboard read, then all details in one batch.
      assert.deepStrictEqual(stub.calls, { ViewerDropsDashboard: 1, DropCampaignDetails: 1 });
    }),
  );

  it.effect("fails loudly when Twitch withholds the campaign list", () =>
    Effect.gen(function* () {
      const withheld = { status: 200, body: [{ data: { currentUser: { dropCampaigns: null } } }] };
      const { program } = run({ ViewerDropsDashboard: [withheld] }, (t) => t.catalog(account));
      assert.deepStrictEqual(errorTag(yield* Effect.exit(program)), ["TwitchDrift"]);
    }),
  );

  it.effect("treats a shape change as drift, not as an empty catalog", () =>
    Effect.gen(function* () {
      const renamed = { status: 200, body: [{ data: { currentUser: { campaigns: [] } } }] };
      const { program } = run({ ViewerDropsDashboard: [renamed] }, (t) => t.catalog(account));
      assert.deepStrictEqual(errorTag(yield* Effect.exit(program)), ["TwitchDrift"]);
    }),
  );
});

describe("inventory", () => {
  it.effect("reads progress, instance ids and claims, ended campaigns included", () =>
    Effect.gen(function* () {
      const { program } = run({ Inventory: [inventory] }, (t) => t.inventory);
      const progress = yield* program;
      assert.strictEqual(progress.length, 8);
      assert.deepStrictEqual(
        progress.map((p) => p.minutes),
        [4, 1, 6, 120, 153, 153, 153, 60],
      );
      const claimed = progress.filter((p) => p.claimed);
      assert.strictEqual(claimed.length, 2);
      assert.isDefined(claimed[0]?.instanceId);
    }),
  );

  it.effect("retries a backend error, 2 s later", () =>
    Effect.gen(function* () {
      const { program, stub } = run(
        { Inventory: [inventoryServiceError, inventory] },
        (t) => t.inventory,
      );
      const fiber = yield* Effect.forkChild(program);
      yield* TestClock.adjust("2 seconds");
      const progress = yield* Fiber.join(fiber);
      assert.strictEqual(progress.length, 8);
      assert.strictEqual(stub.calls["Inventory"], 2);
    }),
  );

  it.effect("gives up after three retries and reports Twitch unavailable", () =>
    Effect.gen(function* () {
      const { program, stub } = run({ Inventory: [inventoryServiceError] }, (t) => t.inventory);
      const fiber = yield* Effect.forkChild(Effect.exit(program));
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(errorTag(yield* Fiber.join(fiber)), ["TwitchUnavailable"]);
      assert.strictEqual(stub.calls["Inventory"], 4);
    }),
  );

  it.effect("gives up on a request that never answers and tries again", () =>
    Effect.gen(function* () {
      const { program, stub } = run({ Inventory: ["hang", inventory] }, (t) => t.inventory);
      const fiber = yield* Effect.forkChild(program);
      yield* TestClock.adjust(REQUEST_TIMEOUT - 1);
      assert.strictEqual(stub.calls["Inventory"], 1);
      yield* TestClock.adjust(1 + 2_000);
      assert.strictEqual((yield* Fiber.join(fiber)).length, 8);
      assert.strictEqual(stub.calls["Inventory"], 2);
    }),
  );

  it.effect("reports Twitch unavailable, not a defect, when every attempt hangs", () =>
    Effect.gen(function* () {
      for (const hang of ["hang", "hang-body"] as const) {
        const { program, stub } = run({ Inventory: [hang] }, (t) => t.inventory);
        const fiber = yield* Effect.forkChild(Effect.exit(program));
        // Four attempts of 30 s and backoffs of 2, 4 and 8 s: 134 s, well inside 5 min.
        yield* TestClock.adjust(4 * REQUEST_TIMEOUT + 14_000);
        const exit = yield* Fiber.join(fiber);
        assert.deepStrictEqual(errorTag(exit), ["TwitchUnavailable"]);
        assert.strictEqual(stub.calls["Inventory"], 4);
      }
    }),
  );

  it.effect("records every answer it reads", () =>
    Effect.gen(function* () {
      const { program, stub } = run({ Inventory: [inventory] }, (t) => t.inventory);
      yield* program;
      assert.deepStrictEqual(
        stub.recorded.map((e) => [e.operation, e.status]),
        [["Inventory", 200]],
      );
    }),
  );
});

describe("channels", () => {
  it.effect("lists live drops-enabled streams from the directory", () =>
    Effect.gen(function* () {
      const { program } = run({ DirectoryPage_Game: [gameDirectory] }, (t) =>
        t.directory("street-fighter-6", 30),
      );
      const channels = yield* program;
      assert.strictEqual(channels.length, 5);
      assert.deepStrictEqual(channels[0], {
        id: chid("38822100"),
        login: "forsen",
        gameId: game("55453844").id,
        live: { viewers: 463, dropsEnabled: true },
      });
    }),
  );

  it.effect("reads stream state, keeping an offline channel's category", () =>
    Effect.gen(function* () {
      const { program } = run(
        { VideoPlayerStreamInfoOverlayChannel: [streamInfo, streamOffline] },
        (t) => Effect.all([t.streams(["forsen"]), t.streams(["farchasir"])]),
      );
      const [[online], [offline]] = yield* program;
      assert.strictEqual(online?.live?.viewers, 463);
      assert.deepStrictEqual(offline, {
        id: chid("1243686068"),
        login: "farchasir",
        gameId: game("417528").id,
        live: undefined,
      });
    }),
  );
});

const gqlAnswer = (
  data: unknown,
  errors?: ReadonlyArray<{ readonly message: string }>,
): Answer => ({
  status: 200,
  body: [{ data, ...(errors === undefined ? {} : { errors }) }],
});

describe("failure classes", () => {
  it.effect("treats a null inventory as drift, not as no drops", () =>
    Effect.gen(function* () {
      const nulled = gqlAnswer({ currentUser: { id: "1", inventory: null } });
      const { program } = run({ Inventory: [nulled] }, (t) => t.inventory);
      assert.deepStrictEqual(errorTag(yield* Effect.exit(program)), ["TwitchDrift"]);
    }),
  );

  it.effect("keeps a drop Twitch sent without progress, at zero minutes", () =>
    Effect.gen(function* () {
      const campaign = {
        id: "c",
        endAt: "2026-10-30T00:00:00Z",
        timeBasedDrops: [{ id: "d", self: null }],
      };
      const answer = gqlAnswer({
        currentUser: { inventory: { dropCampaignsInProgress: [campaign] } },
      });
      const { program } = run({ Inventory: [answer] }, (t) => t.inventory);
      const [progress] = yield* program;
      assert.strictEqual(progress?.minutes, 0);
      assert.isFalse(progress?.claimed);
    }),
  );

  it.effect("retries the backend errors TDM retries", () =>
    Effect.gen(function* () {
      const cancelled = gqlAnswer(null, [{ message: "request cancelled" }]);
      const { program, stub } = run({ Inventory: [cancelled, inventory] }, (t) => t.inventory);
      const fiber = yield* Effect.forkChild(program);
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual((yield* Fiber.join(fiber)).length, 8);
      assert.strictEqual(stub.calls["Inventory"], 2);
    }),
  );

  it.effect("stops at a 401 from GQL, without retrying", () =>
    Effect.gen(function* () {
      const { program, stub } = run(
        { Inventory: [{ status: 401, body: { error: "Unauthorized" } }] },
        (t) => t.inventory,
      );
      assert.deepStrictEqual(errorTag(yield* Effect.exit(program)), ["AuthRejected"]);
      assert.strictEqual(stub.calls["Inventory"], 1);
    }),
  );

  it.effect("records a non-JSON answer as text and reports drift", () =>
    Effect.gen(function* () {
      const html = { status: 200, body: "<html>blocked</html>" };
      const { program, stub } = run({ Inventory: [html] }, (t) => t.inventory);
      assert.deepStrictEqual(errorTag(yield* Effect.exit(program)), ["TwitchDrift"]);
      assert.strictEqual(stub.recorded[0]?.body, "<html>blocked</html>");
    }),
  );

  it.effect("reports drift when a batch comes back with fewer answers than requests", () =>
    Effect.gen(function* () {
      const short = { status: 200, body: streamInfo.body.slice(0, 1) };
      const { program } = run({ VideoPlayerStreamInfoOverlayChannel: [short] }, (t) =>
        t.streams(["a", "b"]),
      );
      // The stub repeats a one-element fixture per request, so give it a two-element batch of one.
      const twoForOne = run(
        {
          VideoPlayerStreamInfoOverlayChannel: [
            { status: 200, body: [...short.body, ...short.body, ...short.body] },
          ],
        },
        (t) => t.streams(["a", "b"]),
      );
      assert.deepStrictEqual(errorTag(yield* Effect.exit(twoForOne.program)), ["TwitchDrift"]);
      assert.strictEqual((yield* program).length, 2);
    }),
  );

  it.effect("splits more than 35 reads into batches and keeps their order", () =>
    Effect.gen(function* () {
      const logins = Array.from({ length: 40 }, (_, i) => `c${i}`);
      const { program, stub } = run({ VideoPlayerStreamInfoOverlayChannel: [streamInfo] }, (t) =>
        t.streams(logins),
      );
      assert.strictEqual((yield* program).length, 40);
      assert.strictEqual(stub.calls["VideoPlayerStreamInfoOverlayChannel"], 2);
    }),
  );

  it.effect("fails loudly on an unknown game slug and skips streams that aren't live", () =>
    Effect.gen(function* () {
      const unknown = run({ DirectoryPage_Game: [gqlAnswer({ game: null })] }, (t) =>
        t.directory("nope", 30),
      );
      assert.deepStrictEqual(errorTag(yield* Effect.exit(unknown.program)), ["TwitchDrift"]);
      const node = (type: string, broadcaster: unknown) => ({
        node: { viewersCount: 1, type, broadcaster },
      });
      const mixed = gqlAnswer({
        game: {
          id: "g",
          streams: {
            edges: [
              node("rerun", { id: "1", login: "a" }),
              node("live", null),
              node("live", { id: "3", login: "c" }),
            ],
          },
        },
      });
      const { program } = run({ DirectoryPage_Game: [mixed] }, (t) => t.directory("g", 30));
      assert.deepStrictEqual(
        (yield* program).map((c) => c.login),
        ["c"],
      );
    }),
  );

  it.effect("reads which drop the watch credits (shape per TDM, unverified live)", () =>
    Effect.gen(function* () {
      const session = gqlAnswer({
        currentUser: { dropCurrentSession: { dropID: "d1", currentMinutesWatched: 12 } },
      });
      const none = gqlAnswer({ currentUser: { dropCurrentSession: null } });
      const { program } = run({ DropCurrentSessionContext: [session, none] }, (t) =>
        Effect.all([t.currentDrop(chid("1")), t.currentDrop(chid("1"))]),
      );
      assert.deepStrictEqual(yield* program, [
        { dropId: "d1", minutes: 12 },
        { dropId: undefined, minutes: 0 },
      ]);
    }),
  );
});

describe("deviceIdOf", () => {
  it.effect("makes 32 lowercase hex characters", () =>
    Effect.gen(function* () {
      for (let seed = 0; seed < 50; seed++) {
        const id = yield* deviceIdOf.pipe(Random.withSeed(seed));
        assert.match(id, /^[0-9a-f]{32}$/);
      }
    }),
  );
});
