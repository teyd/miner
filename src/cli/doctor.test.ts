import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import campaignDetails from "../twitch/fixtures/campaign-details.json" with { type: "json" };
import campaigns from "../twitch/fixtures/campaigns.json" with { type: "json" };
import inventory from "../twitch/fixtures/inventory.json" with { type: "json" };
import invalidToken from "../twitch/fixtures/validate-invalid-token.json" with { type: "json" };
import valid from "../twitch/fixtures/validate-valid.json" with { type: "json" };
import { stubTwitch, type Answer } from "../twitch/stub.ts";
import { Twitch } from "../twitch/Twitch.ts";
import { diagnose } from "./doctor.ts";

/** 2026-10-28T18:00Z, while the recorded campaigns were running. */
const RECORDED_AT = 1_793_210_400_000;

const diagnoseWith = (script: Record<string, ReadonlyArray<Answer>>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(RECORDED_AT);
    return yield* diagnose;
  }).pipe(Effect.provide(Twitch.layer.pipe(Layer.provide(stubTwitch(script).layer))));

describe("doctor", () => {
  it.effect("reports the account, the catalog and the inventory", () =>
    Effect.gen(function* () {
      const report = yield* diagnoseWith({
        validate: [valid],
        ViewerDropsDashboard: [campaigns],
        DropCampaignDetails: [campaignDetails],
        Inventory: [inventory],
      });
      assert.isTrue(report.ok);
      assert.deepStrictEqual(report.account, { userId: "123456789", login: "testuser" });
      assert.strictEqual(report.catalog?.active, 3);
      assert.strictEqual(report.inventory?.drops, 8);
    }),
  );

  it.effect("names a withheld catalog as a problem and keeps reading the inventory", () =>
    Effect.gen(function* () {
      const withheld = { status: 200, body: [{ data: { currentUser: { dropCampaigns: null } } }] };
      const report = yield* diagnoseWith({
        validate: [valid],
        ViewerDropsDashboard: [withheld],
        Inventory: [inventory],
      });
      assert.isFalse(report.ok);
      assert.match(report.problems[0] ?? "", /ViewerDropsDashboard.*null/);
      assert.strictEqual(report.inventory?.drops, 8);
    }),
  );

  it.effect("stops at a rejected token", () =>
    Effect.gen(function* () {
      const report = yield* diagnoseWith({ validate: [invalidToken] });
      assert.isFalse(report.ok);
      assert.isUndefined(report.catalog);
      assert.match(report.problems[0] ?? "", /token rejected/);
    }),
  );
});
