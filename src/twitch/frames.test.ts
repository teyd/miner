import { assert, describe, it } from "@effect/vitest";
import type { ChannelId } from "../core/model.ts";
import { Event } from "../core/protocol.ts";
import fixtures from "./fixtures/pubsub-frames.json" with { type: "json" };
import { classify, decodeFrame, topicOf, type Classified, type Inbound } from "./frames.ts";

const frame = (name: string): string => {
  const found = [...fixtures.live, ...fixtures.shapes].find((f) => f.name === name);
  if (found === undefined) throw new Error(`no fixture ${name}`);
  return found.text;
};

const decoded = (text: string): Inbound => {
  const d = decodeFrame(text);
  if (d._tag === "malformed") throw new Error(d.detail);
  return d.value;
};

/** Decodes a MESSAGE fixture down to what the core is told. */
const told = (name: string): Classified => {
  const f = decoded(frame(name));
  if (f.type !== "MESSAGE") throw new Error(`${name} is not a MESSAGE`);
  const topic = topicOf(f.topic);
  if (topic === undefined) throw new Error(`unknown topic ${f.topic}`);
  return classify(topic, f.message);
};

const ch1 = "100000001" as ChannelId;

describe("PubSub frames", () => {
  it("decodes every recorded and documented frame", () => {
    for (const f of [...fixtures.live, ...fixtures.shapes]) {
      assert.strictEqual(decodeFrame(f.text)._tag, "ok", f.name);
    }
  });

  it("reads Twitch's padded PONG and the LISTEN answer, as recorded live", () => {
    assert.deepStrictEqual(decoded(frame("PONG")), { type: "PONG" });
    assert.match(frame("PONG"), /\r\n$/);
    const response = decoded(frame("RESPONSE"));
    assert.strictEqual(response.type, "RESPONSE");
    assert.deepStrictEqual(decoded(frame("ERR_BADAUTH")), {
      type: "RESPONSE",
      nonce: "n1",
      error: "ERR_BADAUTH",
    });
    assert.deepStrictEqual(decoded(frame("RECONNECT")), { type: "RECONNECT" });
  });

  it("turns drop frames into the drop's total minutes and its claim id", () => {
    assert.deepStrictEqual(told("drop-progress"), {
      _tag: "event",
      event: Event.DropProgress({
        dropId: "67c68932-c292-11f1-b553-0a58a9feac02" as never,
        minutes: 163,
      }),
    });
    const claim = told("drop-claim");
    assert.strictEqual(claim._tag, "event");
    if (claim._tag === "event") {
      assert.strictEqual(claim.event._tag, "DropClaimable");
      assert.strictEqual(
        claim.event._tag === "DropClaimable" ? claim.event.instanceId : undefined,
        "900000001#67c68932-c292-11f1-b553-0a58a9feac02#c0ffee",
      );
    }
  });

  it("takes the channel from the topic, for live, offline and category changes", () => {
    assert.deepStrictEqual(told("stream-up"), {
      _tag: "event",
      event: Event.StreamUp({ channelId: ch1 }),
    });
    assert.deepStrictEqual(told("stream-down"), {
      _tag: "event",
      event: Event.StreamDown({ channelId: ch1 }),
    });
    assert.deepStrictEqual(told("broadcast_settings_update"), {
      _tag: "event",
      event: Event.GameChanged({ channelId: ch1, gameId: "33214" as never }),
    });
  });

  it("tells the core nothing for viewcount, commercials or a title-only change", () => {
    assert.deepStrictEqual(told("viewcount"), { _tag: "ignored", type: "viewcount" });
    assert.deepStrictEqual(told("commercial"), { _tag: "ignored", type: "commercial" });
    const settings = { kind: "settings", channelId: ch1 } as const;
    const titleOnly = JSON.stringify({
      type: "broadcast_settings_update",
      status: "new title",
      old_game_id: 33214,
      game_id: 33214,
    });
    assert.strictEqual(classify(settings, titleOnly)._tag, "ignored");
    const noCategory = JSON.stringify({
      type: "broadcast_settings_update",
      old_game_id: 1,
      game_id: 0,
    });
    assert.deepStrictEqual(classify(settings, noCategory), {
      _tag: "event",
      event: Event.GameChanged({ channelId: ch1, gameId: undefined }),
    });
  });

  it("ignores unknown types and drops malformed known ones without throwing", () => {
    assert.deepStrictEqual(decoded('{"type":"SOMETHING_NEW","data":1}'), {
      type: "unknown",
      name: "SOMETHING_NEW",
    });
    for (const bad of ["not json", "{}", '{"type":"RESPONSE"}', '{"type":"MESSAGE","data":{}}']) {
      assert.strictEqual(decodeFrame(bad)._tag, "malformed", bad);
    }
    const drops = { kind: "drops", userId: "1" } as const;
    assert.deepStrictEqual(classify(drops, '{"type":"drop-new-kind"}'), {
      _tag: "ignored",
      type: "drop-new-kind",
    });
    for (const bad of [
      '{"type":"drop-progress","data":{"drop_id":"d"}}',
      '{"type":"drop-claim","data":{"drop_id":"d","drop_instance_id":null}}',
      "{",
    ]) {
      assert.strictEqual(classify(drops, bad)._tag, "malformed", bad);
    }
    assert.strictEqual(
      classify({ kind: "settings", channelId: ch1 }, '{"type":"broadcast_settings_update"}')._tag,
      "malformed",
    );
  });

  it("knows its topics by name", () => {
    assert.deepStrictEqual(topicOf("user-drop-events.42"), { kind: "drops", userId: "42" });
    assert.deepStrictEqual(topicOf("video-playback-by-id.7"), {
      kind: "playback",
      channelId: "7" as ChannelId,
    });
    assert.deepStrictEqual(topicOf("broadcast-settings-update.7"), {
      kind: "settings",
      channelId: "7" as ChannelId,
    });
    for (const name of ["community-points-user-v1.1", "user-drop-events.", "nodot"]) {
      assert.isUndefined(topicOf(name), name);
    }
  });
});
