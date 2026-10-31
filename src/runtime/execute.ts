import { Effect, Ref } from "effect";
import type { ChannelId, GameId } from "../core/model.ts";
import { Event, readKey, type Command } from "../core/protocol.ts";
import { Actuator } from "../twitch/Actuator.ts";
import type { TwitchError } from "../twitch/errors.ts";
import { Twitch, type Account } from "../twitch/Twitch.ts";

/**
 * Runs one core command against `Twitch` and `Actuator` and reports what happened as core
 * events. It depends on nothing else, so the runtime can reuse or replace it. It never retries a
 * claim: `Twitch` retries reads, and a lost claim answer is the core's to resolve from inventory.
 */

/** What the executor remembers between commands. Lost on a restart, like the process. */
export interface Memory {
  readonly account: Account | undefined;
  /** Stream reads go by login, the core by id. */
  readonly logins: ReadonlyMap<ChannelId, string>;
  /** The directory goes by slug, the core by game id. */
  readonly slugs: ReadonlyMap<GameId, string>;
}

export const emptyMemory: Memory = { account: undefined, logins: new Map(), slugs: new Map() };

/** Directory channels asked for per game; the planner wants the most-viewed few. */
export const DIRECTORY_LIMIT = 30;

const none: ReadonlyArray<Event> = [];

/** A rejected token parks the core; anything else on a read is retried by its next deadline. */
const onReadError = (error: TwitchError): ReadonlyArray<Event> =>
  error._tag === "AuthRejected" ? [Event.AuthFailed()] : none;

/** A channel read that gave up still answers, so discovery stops waiting for it. */
const onChannelsError = (error: TwitchError, read: string): ReadonlyArray<Event> =>
  error._tag === "AuthRejected" ? [Event.AuthFailed()] : [Event.ChannelsReadFailed({ read })];

const remember = (memory: Ref.Ref<Memory>, f: (m: Memory) => Memory) => Ref.update(memory, f);

export const execute = (
  memory: Ref.Ref<Memory>,
  command: Command,
): Effect.Effect<ReadonlyArray<Event>, never, Twitch | Actuator> =>
  Effect.gen(function* () {
    const twitch = yield* Twitch;
    const actuator = yield* Actuator;
    switch (command._tag) {
      case "ValidateToken":
        return yield* twitch.validate.pipe(
          Effect.tap((account) => remember(memory, (m) => ({ ...m, account }))),
          Effect.as([Event.TokenValid()]),
          Effect.catch((e) => Effect.succeed(onReadError(e))),
        );

      case "ReadCatalog": {
        const known = (yield* Ref.get(memory)).account;
        return yield* (known === undefined ? twitch.validate : Effect.succeed(known)).pipe(
          Effect.flatMap((account) => twitch.catalog(account)),
          Effect.tap((catalog) =>
            remember(memory, (m) => ({
              ...m,
              logins: new Map([...m.logins, ...catalog.logins]),
              slugs: new Map([
                ...m.slugs,
                ...catalog.campaigns.map((c) => [c.game.id, c.game.slug] as const),
              ]),
            })),
          ),
          Effect.map((catalog) => [Event.CatalogRead({ campaigns: catalog.campaigns })]),
          Effect.catch((e) =>
            Effect.succeed(
              e._tag === "AuthRejected"
                ? [Event.AuthFailed()]
                : [Event.CatalogUnavailable({ reason: `${e.operation}: ${e.detail}` })],
            ),
          ),
        );
      }

      case "ReadInventory":
        return yield* twitch.inventory.pipe(
          Effect.map(({ progress, awarded }) => [Event.InventoryRead({ progress, awarded })]),
          Effect.catch((e) => Effect.succeed(onReadError(e))),
        );

      case "ReadDirectory": {
        const read = readKey(command);
        const failed = [Event.ChannelsReadFailed({ read })];
        const slug = (yield* Ref.get(memory)).slugs.get(command.gameId);
        if (slug === undefined) return failed;
        return yield* twitch.directory(slug, DIRECTORY_LIMIT).pipe(
          Effect.tap((channels) =>
            remember(memory, (m) => ({
              ...m,
              logins: new Map([...m.logins, ...channels.map((c) => [c.id, c.login] as const)]),
            })),
          ),
          Effect.map((channels) => [Event.ChannelsRead({ channels, read })]),
          Effect.catch((e) => Effect.succeed(onChannelsError(e, read))),
        );
      }

      case "ReadChannels": {
        const read = readKey(command);
        const logins = (yield* Ref.get(memory)).logins;
        const known = command.channelIds.flatMap((id) => logins.get(id) ?? []);
        if (known.length === 0) return [Event.ChannelsReadFailed({ read })];
        return yield* twitch.streams(known).pipe(
          Effect.map((channels) => [Event.ChannelsRead({ channels, read })]),
          Effect.catch((e) => Effect.succeed(onChannelsError(e, read))),
        );
      }

      case "ReadCurrentDrop":
        return yield* twitch.currentDrop(command.channelId).pipe(
          Effect.map((read) => [Event.CurrentDropRead({ channelId: command.channelId, ...read })]),
          Effect.catch((e) => Effect.succeed(onReadError(e))),
        );

      case "Subscribe":
        return yield* Effect.as(actuator.subscribe(command.channelIds), none);

      case "Watch": {
        const channelId = command.channelId;
        const login = (yield* Ref.get(memory)).logins.get(channelId);
        // The core plans only channels a read returned, and every read leaves its logins here.
        if (login === undefined) {
          yield* Effect.logError(`runtime: no login known for channel ${channelId}, not watching`);
          return [Event.WatchFailed({ channelId, reason: "refused" })];
        }
        return yield* Effect.as(actuator.watch(channelId, login), none);
      }

      case "StopWatching":
        return yield* Effect.as(actuator.stopWatching, none);

      case "WatchTick": {
        const channelId = command.channelId;
        return yield* actuator.watchTick(channelId).pipe(
          Effect.as([Event.WatchTicked({ channelId })]),
          Effect.catch((e) =>
            Effect.succeed(
              e._tag === "AuthRejected"
                ? [Event.AuthFailed()]
                : [Event.WatchFailed({ channelId, reason: e.reason })],
            ),
          ),
        );
      }

      case "Claim": {
        const { campaignId, dropId } = command;
        return yield* actuator.claim(command.instanceId).pipe(
          Effect.map((outcome) => [Event.ClaimResult({ campaignId, dropId, outcome })]),
          // Any failure may hide a success: report `unknown` and let inventory decide.
          Effect.catch((e) =>
            Effect.succeed([
              Event.ClaimResult({ campaignId, dropId, outcome: "unknown" }),
              ...(e._tag === "AuthRejected" ? [Event.AuthFailed()] : []),
            ]),
          ),
        );
      }
    }
  });
