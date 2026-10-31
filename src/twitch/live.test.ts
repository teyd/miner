import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import type { ChannelId, DropInstanceId } from "../core/model.ts";
import claimed from "./fixtures/claim-claimed-instance.json" with { type: "json" };
import unknown from "./fixtures/claim-unknown-instance.json" with { type: "json" };
import unlinked from "./fixtures/claim-unlinked-account.json" with { type: "json" };
import { GQL_LIMITS, makeBudget } from "./budget.ts";
import { makeGql } from "./gql.ts";
import type { WatchMethod } from "./hls.ts";
import { Mutations } from "./identity.ts";
import { Journal } from "./journal.ts";
import { CLAIM_TIMEOUT, liveActuator } from "./live.ts";
import { stubPlayback, type Answer } from "./stub.ts";

const instance = "534562424#b2432aa9#88481443" as DropInstanceId;

const withStatus = (status: string): Answer => ({
  status: 200,
  body: [{ data: { claimDropRewards: { status, isUserAccountConnected: true } } }],
});

/** A watch method that only counts what the actuator asks of it. */
const countingMethod = () => {
  const ticks: Array<string> = [];
  const method: WatchMethod = {
    name: "counting",
    open: (target) => Effect.succeed({ tick: Effect.sync(() => void ticks.push(target.login)) }),
  };
  return { ticks, method };
};

const setup = (claim: Answer = claimed) => {
  const stub = stubPlayback({ claim });
  const budget = Effect.runSync(makeBudget("gql", GQL_LIMITS));
  const gql = makeGql(
    stub.http,
    { token: Redacted.make("test-token"), deviceId: "d".repeat(32) },
    Journal.of({ record: () => Effect.void, intent: () => Effect.void, frame: () => Effect.void }),
    budget,
  );
  const { ticks, method } = countingMethod();
  const actuator = liveActuator({ gql, method });
  const claims = () => stub.requests.filter((r) => r.step === "claim");
  return { stub, actuator, claims, ticks, budget };
};

describe("claim", () => {
  it.effect("sends DropsPage_ClaimDropRewards once with the instance id", () =>
    Effect.gen(function* () {
      const t = setup();
      assert.strictEqual(yield* t.actuator.claim(instance), "claimed");
      assert.lengthOf(t.claims(), 1);
      const [sent] = t.claims()[0]!.body as ReadonlyArray<Record<string, unknown>>;
      assert.deepStrictEqual(sent, {
        operationName: "DropsPage_ClaimDropRewards",
        variables: { input: { dropInstanceID: instance } },
        extensions: {
          persistedQuery: { version: 1, sha256Hash: Mutations.ClaimDrop.sha256Hash },
        },
      });
      assert.strictEqual(t.claims()[0]!.headers["authorization"], "OAuth test-token");
    }),
  );

  it.effect("is never sent when the request budget refuses it, and says so", () =>
    Effect.gen(function* () {
      const t = setup();
      // Twitch answered 429 to something else: the API budget cools down.
      yield* t.budget.backOff;
      const refused = yield* Effect.flip(t.actuator.claim(instance));
      assert.strictEqual(refused._tag, "BudgetExhausted");
      assert.lengthOf(t.stub.requests, 0);
      // A 429 to the claim itself was sent: its outcome is unknown, never "not sent".
      const limited = setup({ status: 429, body: "" });
      const answered = yield* Effect.flip(limited.actuator.claim(instance));
      assert.strictEqual(answered._tag, "TwitchUnavailable");
      assert.lengthOf(limited.claims(), 1);
    }),
  );

  it.effect("classifies the recorded answers", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* setup(unlinked).actuator.claim(instance), "claimed");
      assert.strictEqual(
        yield* setup(withStatus("DROP_INSTANCE_ALREADY_CLAIMED")).actuator.claim(instance),
        "already-claimed",
      );
      const none = yield* Effect.flip(setup(unknown).actuator.claim(instance));
      assert.strictEqual(none._tag, "TwitchDrift");
      const other = yield* Effect.flip(setup(withStatus("NOT_ELIGIBLE")).actuator.claim(instance));
      assert.strictEqual(other._tag, "TwitchDrift");
      assert.include(other._tag === "TwitchDrift" ? other.detail : "", "NOT_ELIGIBLE");
    }),
  );

  it.effect(
    "never retries: a 5xx, a backend error, a lost connection or a 401 is one request",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<[Answer | "down", string]> = [
          [{ status: 503, body: "" }, "TwitchUnavailable"],
          [
            { status: 200, body: [{ errors: [{ message: "service error" }], data: null }] },
            "TwitchUnavailable",
          ],
          [
            { status: 200, body: [{ errors: [{ message: "PersistedQueryNotFound" }] }] },
            "TwitchDrift",
          ],
          [{ status: 401, body: "" }, "AuthRejected"],
          ["down", "TwitchUnavailable"],
        ];
        for (const [answer, expected] of cases) {
          const t = setup(answer === "down" ? claimed : answer);
          if (answer === "down") t.stub.state.down.add("claim");
          const error = yield* Effect.flip(t.actuator.claim(instance));
          assert.strictEqual(error._tag, expected);
          yield* TestClock.adjust("1 hour");
          assert.lengthOf(t.claims(), 1, expected);
        }
      }),
  );

  it.effect("gives up waiting after the timeout without sending again", () =>
    Effect.gen(function* () {
      const t = setup();
      t.stub.state.slow.set("claim", 120_000);
      const fiber = yield* Effect.forkChild(Effect.flip(t.actuator.claim(instance)));
      yield* TestClock.adjust(CLAIM_TIMEOUT);
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error._tag, "TwitchUnavailable");
      yield* TestClock.adjust("1 hour");
      assert.lengthOf(t.claims(), 1);
    }),
  );
});

describe("liveActuator", () => {
  it.effect("ticks the open session only", () =>
    Effect.gen(function* () {
      const t = setup();
      const a = "1" as ChannelId;
      const b = "2" as ChannelId;
      const early = yield* Effect.flip(t.actuator.watchTick(a));
      assert.strictEqual(early._tag === "WatchFailure" && early.reason, "network");
      yield* t.actuator.watch(a, "alpha");
      yield* t.actuator.watchTick(a);
      const stale = yield* Effect.flip(t.actuator.watchTick(b));
      assert.strictEqual(stale._tag === "WatchFailure" && stale.reason, "network");
      yield* t.actuator.watch(b, "beta");
      yield* t.actuator.watchTick(b);
      const old = yield* Effect.flip(t.actuator.watchTick(a));
      assert.strictEqual(old._tag === "WatchFailure" && old.reason, "network");
      yield* t.actuator.stopWatching;
      const stopped = yield* Effect.flip(t.actuator.watchTick(b));
      assert.strictEqual(stopped._tag === "WatchFailure" && stopped.reason, "network");
      assert.deepStrictEqual(t.ticks, ["alpha", "beta"]);
    }),
  );
});
