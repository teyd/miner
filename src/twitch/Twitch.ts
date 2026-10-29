import { Config, Context, Effect, Layer, Random, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Campaign, Channel, ChannelId, DropId, Progress } from "../core/model.ts";
import { AuthRejected, TwitchDrift, TwitchUnavailable, type TwitchError } from "./errors.ts";
import {
  CLIENT_ID,
  GQL_BATCH_LIMIT,
  GQL_URL,
  Queries,
  TRANSIENT_GQL_ERRORS,
  USER_AGENT,
  VALIDATE_URL,
  dropsDirectory,
  type PersistedQuery,
} from "./identity.ts";
import { Journal, redact } from "./journal.ts";
import {
  CampaignDetails,
  CurrentDrop,
  Dashboard,
  Directory,
  Envelope,
  Inventory,
  StreamInfo,
  Validation,
  allowedLogins,
  toCampaign,
  toChannel,
  toDirectoryChannels,
  toProgress,
} from "./wire.ts";

export interface Account {
  readonly userId: string;
  readonly login: string;
}

export interface Catalog {
  readonly campaigns: ReadonlyArray<Campaign>;
  /** Logins of allow-listed channels: stream reads go by login. */
  readonly logins: ReadonlyMap<ChannelId, string>;
}

/** Every read the miner makes of Twitch. Production, the simulator and replay implement it. */
export class Twitch extends Context.Service<
  Twitch,
  {
    readonly validate: Effect.Effect<Account, TwitchError>;
    /**
     * Active campaigns with their drops and allow-lists. A `null` catalog fails with
     * `TwitchDrift`: discovery is broken, which is not the same as nothing to mine.
     */
    readonly catalog: (account: Account) => Effect.Effect<Catalog, TwitchError>;
    readonly inventory: Effect.Effect<ReadonlyArray<Progress>, TwitchError>;
    /** Live drops-enabled streams of a game, most viewers first. */
    readonly directory: (
      slug: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<Channel>, TwitchError>;
    readonly streams: (
      logins: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Channel>, TwitchError>;
    readonly currentDrop: (
      channelId: ChannelId,
    ) => Effect.Effect<
      { readonly dropId: DropId | undefined; readonly minutes: number },
      TwitchError
    >;
  }
>()("miner/twitch/Twitch") {
  static readonly layer = Layer.effect(
    Twitch,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const credentials = yield* Credentials;
      const journal = yield* Journal;
      return make(http, credentials, journal);
    }),
  );
}

/** The token from the environment and a device id for this process. */
export class Credentials extends Context.Service<
  Credentials,
  { readonly token: Redacted.Redacted<string>; readonly deviceId: string }
>()("miner/twitch/Credentials") {
  static readonly layer = Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const token = yield* Config.Redacted("TOKEN").pipe(
        Effect.mapError(() => new AuthRejected({ reason: "TOKEN is not set" })),
      );
      const deviceId = yield* deviceIdOf;
      return Credentials.of({ token, deviceId });
    }),
  );
}

/** 32 lowercase hex characters, the shape of Twitch's `X-Device-Id`. */
export const deviceIdOf = Effect.gen(function* () {
  let id = "";
  for (let i = 0; i < 32; i++) id += (yield* Random.nextIntBetween(0, 15)).toString(16);
  return id;
});

/** Reads retry three times, 2, 4 and 8 s apart, and only when the failure may pass. */
const retryReads = <A, E extends TwitchError>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.exponential("2 seconds"),
      times: 3,
      while: (error) => error._tag === "TwitchUnavailable",
    }),
  );

const make = (
  http: HttpClient.HttpClient,
  credentials: Credentials["Service"],
  journal: Journal["Service"],
): Twitch["Service"] => {
  const oauth = () => `OAuth ${Redacted.value(credentials.token)}`;

  const send = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    variables: unknown,
  ) =>
    Effect.gen(function* () {
      const response = yield* http
        .execute(request)
        .pipe(Effect.mapError((e) => new TwitchUnavailable({ operation, detail: e.message })));
      // Keep the raw text when it isn't JSON (an HTML error page): that is the answer to record.
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      const body: unknown = yield* Effect.try(() => JSON.parse(text) as unknown).pipe(
        Effect.orElseSucceed(() => text),
      );
      yield* journal.record({ operation, variables, status: response.status, body });
      if (response.status === 401)
        return yield* new AuthRejected({ reason: `${operation} answered 401` });
      if (response.status === 429 || response.status >= 500) {
        return yield* new TwitchUnavailable({ operation, detail: `HTTP ${response.status}` });
      }
      if (response.status !== 200) {
        return yield* new TwitchDrift({ operation, detail: `unexpected HTTP ${response.status}` });
      }
      return body;
    });

  const decode =
    <S extends Schema.Top & { readonly DecodingServices: never }>(operation: string, schema: S) =>
    (input: unknown) =>
      Schema.decodeUnknownEffect(schema)(input).pipe(
        // Schema messages quote the input they rejected, so they pass through `redact` too.
        Effect.mapError((e) => new TwitchDrift({ operation, detail: String(redact(e.message)) })),
      );

  /** One persisted query, sent in batches of up to 35 variable sets; results keep their order. */
  const gql = <S extends Schema.Top & { readonly DecodingServices: never }>(
    query: PersistedQuery,
    variables: ReadonlyArray<unknown>,
    schema: S,
  ): Effect.Effect<ReadonlyArray<S["Type"]>, TwitchError> => {
    const operation = query.operationName;
    const chunk = (batch: ReadonlyArray<unknown>) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(GQL_URL).pipe(
          HttpClientRequest.setHeaders({
            "Client-Id": CLIENT_ID,
            "User-Agent": USER_AGENT,
            "X-Device-Id": credentials.deviceId,
            Authorization: oauth(),
          }),
          HttpClientRequest.bodyJsonUnsafe(
            batch.map((v) => ({
              operationName: operation,
              variables: v,
              extensions: { persistedQuery: { version: 1, sha256Hash: query.sha256Hash } },
            })),
          ),
        );
        const body = yield* send(operation, request, batch);
        const envelopes = yield* decode(operation, Schema.Array(Envelope))(body);
        if (envelopes.length !== batch.length) {
          const detail = `${batch.length} requests got ${envelopes.length} answers`;
          return yield* new TwitchDrift({ operation, detail });
        }
        return yield* Effect.forEach(envelopes, (envelope) =>
          Effect.gen(function* () {
            const errors = envelope.errors ?? [];
            const transient = errors.find((e) => TRANSIENT_GQL_ERRORS.includes(e.message));
            if (transient !== undefined) {
              return yield* new TwitchUnavailable({ operation, detail: transient.message });
            }
            if (envelope.data === undefined || envelope.data === null) {
              const detail = errors.map((e) => e.message).join("; ") || "no data";
              return yield* new TwitchDrift({ operation, detail });
            }
            // Twitch may null one field and say why in `errors`: keep that reason with the drift.
            return yield* decode(
              operation,
              schema,
            )(envelope.data).pipe(
              Effect.mapError((e) =>
                errors.length === 0
                  ? e
                  : new TwitchDrift({
                      operation,
                      detail: `${e.detail} (Twitch: ${errors.map((x) => x.message).join("; ")})`,
                    }),
              ),
            );
          }),
        );
      }).pipe(retryReads);
    const batches: Array<ReadonlyArray<unknown>> = [];
    for (let i = 0; i < variables.length; i += GQL_BATCH_LIMIT) {
      batches.push(variables.slice(i, i + GQL_BATCH_LIMIT));
    }
    return Effect.forEach(batches, chunk).pipe(Effect.map((results) => results.flat()));
  };

  const one = <S extends Schema.Top & { readonly DecodingServices: never }>(
    query: PersistedQuery,
    variables: unknown,
    schema: S,
  ) =>
    gql(query, [variables], schema).pipe(
      Effect.flatMap((results) =>
        results[0] === undefined
          ? Effect.fail(
              new TwitchDrift({ operation: query.operationName, detail: "empty response" }),
            )
          : Effect.succeed(results[0]),
      ),
    );

  const validate = Effect.gen(function* () {
    const request = HttpClientRequest.get(VALIDATE_URL).pipe(
      HttpClientRequest.setHeaders({ Authorization: oauth() }),
    );
    const body = yield* send("validate", request, null);
    const validation = yield* decode("validate", Validation)(body);
    // Only Android-client tokens can read the drop catalog (research 02 §1).
    if (validation.client_id !== CLIENT_ID) {
      return yield* new AuthRejected({ reason: "the token belongs to another Twitch client" });
    }
    return { userId: validation.user_id, login: validation.login };
  }).pipe(retryReads);

  const catalog = (account: Account) =>
    Effect.gen(function* () {
      const dashboard = yield* one(
        Queries.ViewerDropsDashboard,
        { fetchRewardCampaigns: false },
        Dashboard,
      );
      const listed = dashboard.currentUser?.dropCampaigns;
      if (listed === null || listed === undefined) {
        return yield* new TwitchDrift({
          operation: "ViewerDropsDashboard",
          detail: "the campaign list is null",
        });
      }
      const active = listed.filter((c) => c.status === "ACTIVE");
      const details = yield* gql(
        Queries.DropCampaignDetails,
        active.map((c) => ({ channelLogin: account.userId, dropID: c.id })),
        CampaignDetails,
      );
      const campaigns: Array<Campaign> = [];
      const logins = new Map<ChannelId, string>();
      for (const [i, detail] of details.entries()) {
        const campaign = detail.user?.dropCampaign;
        if (campaign === null || campaign === undefined) {
          const detailText = `campaign ${active[i]?.id ?? "?"} is null`;
          return yield* new TwitchDrift({ operation: "DropCampaignDetails", detail: detailText });
        }
        campaigns.push(toCampaign(campaign));
        for (const [id, login] of allowedLogins(campaign)) logins.set(id, login);
      }
      return { campaigns, logins };
    });

  const inventory = one(Queries.Inventory, { fetchRewardCampaigns: false }, Inventory).pipe(
    Effect.map(toProgress),
  );

  const directory = (slug: string, limit: number) =>
    one(Queries.DirectoryPage_Game, dropsDirectory(slug, limit), Directory).pipe(
      Effect.flatMap((data) =>
        data.game === null
          ? Effect.fail(
              new TwitchDrift({
                operation: "DirectoryPage_Game",
                detail: `no game with slug ${slug}`,
              }),
            )
          : Effect.succeed(toDirectoryChannels(data.game)),
      ),
    );

  const streams = (logins: ReadonlyArray<string>) =>
    gql(
      Queries.VideoPlayerStreamInfoOverlayChannel,
      logins.map((channel) => ({ channel })),
      StreamInfo,
    ).pipe(Effect.map((infos) => infos.flatMap((info) => toChannel(info) ?? [])));

  const currentDrop = (channelId: ChannelId) =>
    one(
      Queries.DropCurrentSessionContext,
      { channelID: channelId, channelLogin: "" },
      CurrentDrop,
    ).pipe(
      Effect.map((data) => {
        const session = data.currentUser?.dropCurrentSession;
        return session === null || session === undefined
          ? { dropId: undefined, minutes: 0 }
          : { dropId: session.dropID as DropId, minutes: session.currentMinutesWatched };
      }),
    );

  return Twitch.of({ validate, catalog, inventory, directory, streams, currentDrop });
};
