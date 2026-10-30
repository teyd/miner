import { Result, Schema } from "effect";
import type { ChannelId, DropId, DropInstanceId, GameId } from "../core/model.ts";
import { Event } from "../core/protocol.ts";
import { Topics } from "./identity.ts";

/**
 * PubSub frames, decoded at the boundary. A frame of an unknown type, or a message of an
 * unknown type on a known topic, is `ignored`: Twitch adds types without notice. A frame of a
 * known type that doesn't decode is `malformed`. Neither stops the connection.
 */

const Typed = Schema.Struct({ type: Schema.String });

/** The answer to a LISTEN or UNLISTEN; `error` is empty on success. */
const Response = Schema.Struct({
  type: Schema.Literal("RESPONSE"),
  nonce: Schema.String,
  error: Schema.String,
});

/** `message` is the topic's own JSON document, held as a string. */
const Message = Schema.Struct({
  type: Schema.Literal("MESSAGE"),
  data: Schema.Struct({ topic: Schema.String, message: Schema.String }),
});

export type Inbound =
  | { readonly type: "PONG" }
  | { readonly type: "RECONNECT" }
  | { readonly type: "RESPONSE"; readonly nonce: string; readonly error: string }
  | { readonly type: "MESSAGE"; readonly topic: string; readonly message: string }
  | { readonly type: "unknown"; readonly name: string };

export type Decoded<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "malformed"; readonly detail: string };

const ok = <A>(value: A): Decoded<A> => ({ _tag: "ok", value });
const malformed = (detail: string): Decoded<never> => ({ _tag: "malformed", detail });

const decodeWith =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (input: unknown): Decoded<S["Type"]> => {
    const result = Schema.decodeUnknownResult(schema)(input);
    return Result.isSuccess(result) ? ok(result.success) : malformed(String(result.failure));
  };

const decodeTyped = decodeWith(Typed);
const decodeResponse = decodeWith(Response);
const decodeMessage = decodeWith(Message);

const parse = (text: string): Decoded<unknown> => {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return malformed("not JSON");
  }
};

/** One frame from the socket. Twitch pads some (`{ "type": "PONG" }\r\n`, seen live). */
export const decodeFrame = (text: string): Decoded<Inbound> => {
  const json = parse(text);
  if (json._tag === "malformed") return json;
  const typed = decodeTyped(json.value);
  if (typed._tag === "malformed") return typed;
  switch (typed.value.type) {
    case "PONG":
      return ok({ type: "PONG" });
    case "RECONNECT":
      return ok({ type: "RECONNECT" });
    case "RESPONSE": {
      const r = decodeResponse(json.value);
      return r._tag === "ok"
        ? ok({ type: "RESPONSE", nonce: r.value.nonce, error: r.value.error })
        : r;
    }
    case "MESSAGE": {
      const m = decodeMessage(json.value);
      return m._tag === "ok"
        ? ok({ type: "MESSAGE", topic: m.value.data.topic, message: m.value.data.message })
        : m;
    }
    default:
      return ok({ type: "unknown", name: typed.value.type });
  }
};

/** A topic the miner listens to, by its name `<prefix>.<id>`. */
export type Topic =
  | { readonly kind: "drops"; readonly userId: string }
  | { readonly kind: "playback"; readonly channelId: ChannelId }
  | { readonly kind: "settings"; readonly channelId: ChannelId };

export const dropsTopic = (userId: string): string => `${Topics.drops}.${userId}`;

export const channelTopics = (channelId: ChannelId): ReadonlyArray<string> => [
  `${Topics.playback}.${channelId}`,
  `${Topics.settings}.${channelId}`,
];

export const topicOf = (name: string): Topic | undefined => {
  const dot = name.lastIndexOf(".");
  const prefix = name.slice(0, dot);
  const id = name.slice(dot + 1);
  if (dot <= 0 || id.length === 0) return undefined;
  switch (prefix) {
    case Topics.drops:
      return { kind: "drops", userId: id };
    case Topics.playback:
      return { kind: "playback", channelId: id as ChannelId };
    case Topics.settings:
      return { kind: "settings", channelId: id as ChannelId };
    default:
      return undefined;
  }
};

/**
 * `user-drop-events`. `drop-progress` sends the drop's total minutes (just-mining logs,
 * 2026-10-29); `drop-claim` the instance id to claim with (TDM `twitch.py:1239-1260`).
 */
const DropProgress = Schema.Struct({
  type: Schema.Literal("drop-progress"),
  data: Schema.Struct({ drop_id: Schema.String, current_progress_min: Schema.Finite }),
});
const DropClaim = Schema.Struct({
  type: Schema.Literal("drop-claim"),
  data: Schema.Struct({ drop_id: Schema.String, drop_instance_id: Schema.String }),
});

/**
 * `broadcast-settings-update`. Twitch sends `game_id` as a number (TDM `twitch.py:1155-1166`);
 * a string is accepted too. 0, `""` or `null` means no category (inference).
 */
const GameIdField = Schema.NullOr(Schema.Union([Schema.Finite, Schema.String]));
const SettingsUpdate = Schema.Struct({
  type: Schema.Literal("broadcast_settings_update"),
  game_id: GameIdField,
  old_game_id: Schema.optionalKey(GameIdField),
});

const decodeProgress = decodeWith(DropProgress);
const decodeClaim = decodeWith(DropClaim);
const decodeSettings = decodeWith(SettingsUpdate);

export type Classified =
  | { readonly _tag: "event"; readonly event: Event }
  /** A known topic, but a message the core has no event for (`viewcount`, `commercial`, …). */
  | { readonly _tag: "ignored"; readonly type: string }
  | { readonly _tag: "malformed"; readonly detail: string };

const event = (e: Event): Classified => ({ _tag: "event", event: e });

const gameIdOf = (raw: number | string | null): GameId | undefined =>
  raw === null || raw === 0 || raw === "" || raw === "0" ? undefined : (String(raw) as GameId);

/** The core event a MESSAGE on `topic` stands for, if any. */
export const classify = (topic: Topic, message: string): Classified => {
  const json = parse(message);
  if (json._tag === "malformed") return json;
  const typed = decodeTyped(json.value);
  if (typed._tag === "malformed") return typed;
  const type = typed.value.type;
  switch (topic.kind) {
    case "drops":
      if (type === "drop-progress") {
        const p = decodeProgress(json.value);
        if (p._tag === "malformed") return p;
        return event(
          Event.DropProgress({
            dropId: p.value.data.drop_id as DropId,
            minutes: p.value.data.current_progress_min,
          }),
        );
      }
      if (type === "drop-claim") {
        const c = decodeClaim(json.value);
        if (c._tag === "malformed") return c;
        return event(
          Event.DropClaimable({
            dropId: c.value.data.drop_id as DropId,
            instanceId: c.value.data.drop_instance_id as DropInstanceId,
          }),
        );
      }
      return { _tag: "ignored", type };
    case "playback":
      if (type === "stream-up") return event(Event.StreamUp({ channelId: topic.channelId }));
      if (type === "stream-down") return event(Event.StreamDown({ channelId: topic.channelId }));
      // `viewcount` comes every ~30 s per live channel (seen live 2026-10-30). Forwarding it as
      // `StreamUp` would push the core's online re-read back forever, so it stays here.
      return { _tag: "ignored", type };
    case "settings": {
      if (type !== "broadcast_settings_update") return { _tag: "ignored", type };
      const s = decodeSettings(json.value);
      if (s._tag === "malformed") return s;
      const gameId = gameIdOf(s.value.game_id);
      // Title and tag changes come on this topic too; only a category change is news.
      if (s.value.old_game_id !== undefined && gameIdOf(s.value.old_game_id) === gameId) {
        return { _tag: "ignored", type: "broadcast_settings_update (same game)" };
      }
      return event(Event.GameChanged({ channelId: topic.channelId, gameId }));
    }
  }
};
