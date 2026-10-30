import { Clock, Console, Effect, Layer, Option, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { isActive, isClaimable, isEligible } from "../core/rules.ts";
import type { TwitchError } from "../twitch/errors.ts";
import { Journal } from "../twitch/journal.ts";
import { Credentials, Twitch, type Account } from "../twitch/Twitch.ts";

/** Default settings: every game, badges and emotes included. */
const everything = { games: [], excludeChannels: [], badgesAndEmotes: true };

export class DoctorFailed extends Schema.TaggedError<
  DoctorFailed,
  { readonly brand: unique symbol }
>()("DoctorFailed", { problems: Schema.Array(Schema.String) }) {}

const describe = (error: TwitchError): string => {
  switch (error._tag) {
    case "AuthRejected":
      return `token rejected: ${error.reason}. A new token needs a browser login.`;
    case "TwitchUnavailable":
      return `${error.operation}: Twitch unavailable after retries (${error.detail})`;
    case "TwitchDrift":
      return `${error.operation}: Twitch's answer changed shape or was null (${error.detail})`;
  }
};

/** What `miner doctor --json` prints. A section is missing when its read failed. */
export interface Report {
  readonly ok: boolean;
  readonly account?: Account;
  readonly catalog?: {
    readonly active: number;
    readonly eligible: number;
    readonly linked: number;
  };
  readonly inventory?: {
    readonly drops: number;
    readonly inProgress: number;
    readonly claimable: number;
  };
  readonly problems: ReadonlyArray<string>;
}

/** Reads everything the miner needs, writes nothing, and says what works. */
export const diagnose: Effect.Effect<Report, never, Twitch> = Effect.gen(function* () {
  const twitch = yield* Twitch;
  const now = yield* Clock.currentTimeMillis;
  const problems: Array<string> = [];
  const account = yield* twitch.validate.pipe(
    Effect.catch((e) => Effect.sync(() => problems.push(describe(e))).pipe(Effect.as(undefined))),
  );
  if (account === undefined) return { ok: false, problems };

  const catalog = yield* twitch.catalog(account).pipe(
    Effect.map((c) => {
      const active = c.campaigns.filter((x) => isActive(x, now));
      return {
        active: active.length,
        eligible: active.filter((x) => isEligible(x, everything)).length,
        linked: active.filter((x) => x.linked).length,
      };
    }),
    Effect.catch((e) => Effect.sync(() => problems.push(describe(e))).pipe(Effect.as(undefined))),
  );
  const inventory = yield* twitch.inventory.pipe(
    Effect.map((progress) => ({
      drops: progress.length,
      inProgress: progress.filter((p) => !p.claimed && p.minutes > 0).length,
      claimable: progress.filter((p) => isClaimable(p, now)).length,
    })),
    Effect.catch((e) => Effect.sync(() => problems.push(describe(e))).pipe(Effect.as(undefined))),
  );
  return {
    ok: problems.length === 0,
    account,
    ...(catalog === undefined ? {} : { catalog }),
    ...(inventory === undefined ? {} : { inventory }),
    problems,
  };
});

export const doctor = Command.make(
  "doctor",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print one JSON document"),
      Flag.withDefault(false),
    ),
    record: Flag.String("record").pipe(
      Flag.withDescription("Append every Twitch answer, redacted, to this JSONL file"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ json, record }) {
    const journal = Option.match(record, {
      onNone: () => Journal.none,
      onSome: (path) =>
        Layer.unwrap(
          Effect.gen(function* () {
            const { token } = yield* Credentials;
            return Journal.file(path, [Redacted.value(token)]);
          }),
        ),
    });
    const live = Twitch.layer.pipe(
      Layer.provide(journal),
      Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Credentials.layer)),
    );
    const report = yield* Effect.provide(diagnose, live).pipe(
      Effect.catchTag("AuthRejected", (e): Effect.Effect<Report> =>
        Effect.succeed({ ok: false, problems: [describe(e)] }),
      ),
    );
    if (json) {
      yield* Console.log(JSON.stringify(report, null, 2));
    } else {
      if (report.account !== undefined)
        yield* Console.log(`token: ok, ${report.account.login} (user ${report.account.userId})`);
      if (report.catalog !== undefined) {
        const c = report.catalog;
        yield* Console.log(
          `catalog: ${c.active} active campaigns, ${c.eligible} eligible, ${c.linked} linked`,
        );
      }
      if (report.inventory !== undefined) {
        const i = report.inventory;
        yield* Console.log(
          `inventory: ${i.drops} drops, ${i.inProgress} in progress, ${i.claimable} claimable`,
        );
      }
      for (const problem of report.problems) yield* Console.log(`problem: ${problem}`);
    }
    if (!report.ok) return yield* new DoctorFailed({ problems: report.problems });
  }),
).pipe(
  Command.withDescription("Check the token and read the catalog and inventory, writing nothing."),
);
