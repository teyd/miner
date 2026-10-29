import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { Cause, Exit } from "effect";
import example from "../../schema/config.example.json" with { type: "json" };
import committed from "../../schema/config.v1.json" with { type: "json" };
import { decode, jsonSchema, load, starter, type Problem } from "./load.ts";
import { SCHEMA_URL } from "./schema.ts";

const problems = (input: unknown): ReadonlyArray<Problem> => {
  const exit = decode(input);
  return Exit.isFailure(exit) ? (Cause.squash(exit.cause) as ReadonlyArray<Problem>) : [];
};

describe("config", () => {
  it("accepts the documented example and fills the defaults", () => {
    const exit = decode(example);
    assert.isTrue(Exit.isSuccess(exit));
    if (Exit.isFailure(exit)) return;
    const [first, second, third] = exit.value.priorities;
    assert.strictEqual(first?.type, "drops");
    assert.deepStrictEqual(first?.type === "drops" ? first.rewards : [], [
      "item",
      "badge",
      "emote",
    ]);
    assert.deepStrictEqual(second?.type === "points" ? second.channels : [], [
      "oilrats",
      "riqqeloff",
    ]);
    assert.deepStrictEqual(third?.type === "drops" ? third.exclude.games : [], [
      "League of Legends",
    ]);
    assert.deepStrictEqual(exit.value.exclude.games, []);
  });

  it("turns an empty file into one drops goal for every game", () => {
    const exit = decode({});
    assert.isTrue(Exit.isSuccess(exit));
    if (Exit.isFailure(exit)) return;
    assert.deepStrictEqual(
      exit.value.priorities.map((g) => g.type),
      ["drops"],
    );
    assert.strictEqual(exit.value.streams.max, 1);
  });

  it("accepts the starter that `config init` writes", () => {
    assert.isTrue(Exit.isSuccess(decode(starter)));
  });

  it("points at each mistake with a JSON pointer", () => {
    assert.deepStrictEqual(
      problems({
        priorities: [
          { type: "drops", games: [{ name: "Rust", reward: ["badge"] }], order: "fastest" },
          { type: "points", channels: ["not a login"] },
        ],
        streams: { max: 3 },
      }).map((p) => p.pointer),
      [
        "/priorities/0/games/0/reward",
        "/priorities/0/order",
        "/priorities/1/channels/0",
        "/streams/max",
      ],
    );
  });

  it("explains an unknown goal type", () => {
    assert.deepStrictEqual(problems({ priorities: [{ type: "drop", games: "all" }] }), [
      { pointer: "/priorities/0", message: 'each goal needs "type": "drops" or "type": "points"' },
    ]);
  });

  it("rejects empty lists where an empty list would mean nothing", () => {
    const channels = problems({ priorities: [{ type: "points", channels: [] }] })[0];
    assert.match(channels?.pointer ?? "", /^\/priorities\/0\/channels/);
    const games = problems({ priorities: [{ type: "drops", games: [] }] })[0];
    assert.match(games?.pointer ?? "", /^\/priorities\/0\/games/);
  });
});

describe("jsonSchema", () => {
  it("matches the committed schema/config.v1.json; run `pnpm schema` after changing the config", () => {
    assert.deepStrictEqual(jsonSchema(), committed);
  });

  it("rejects unknown keys and documents every field, at any depth", () => {
    const undocumented: Array<string> = [];
    const open: Array<string> = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}/${i}`));
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (record["type"] === "object" && record["additionalProperties"] !== false) open.push(at);
      const properties = record["properties"] as
        | Record<string, Record<string, unknown>>
        | undefined;
      for (const [key, field] of Object.entries(properties ?? {})) {
        const documented =
          typeof field["description"] === "string" || "$ref" in field || key === "type";
        if (!documented) undocumented.push(`${at}/${key}`);
      }
      for (const [key, value] of Object.entries(record)) walk(value, `${at}/${key}`);
    };
    walk(jsonSchema(), "");
    assert.deepStrictEqual(undocumented, []);
    assert.deepStrictEqual(open, []);
  });

  it("carries the login pattern, so editors reject what the decoder rejects", () => {
    const text = JSON.stringify(jsonSchema());
    assert.include(text, JSON.stringify("^[A-Za-z0-9_]{1,25}$"));
  });
});

describe("load", () => {
  const inTemp = <A, E>(
    use: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* use(yield* fs.makeTempDirectoryScoped());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("treats a missing file as the defaults", () =>
    inTemp((dir) =>
      Effect.gen(function* () {
        const loaded = yield* load(`${dir}/config.json`);
        assert.strictEqual(loaded._tag, "Missing");
      }),
    ),
  );

  it.effect("reports a directory at the path, or an empty file, as a problem", () =>
    inTemp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${dir}/config.json`);
        assert.strictEqual((yield* load(`${dir}/config.json`))._tag, "Invalid");
        yield* fs.writeFileString(`${dir}/empty.json`, "");
        const empty = yield* load(`${dir}/empty.json`);
        assert.strictEqual(empty._tag === "Invalid" ? empty.problems[0]?.pointer : "?", "");
      }),
    ),
  );

  it.effect("warns about a $schema that points elsewhere", () =>
    inTemp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${dir}/a.json`, JSON.stringify({ $schema: SCHEMA_URL }));
        yield* fs.writeFileString(
          `${dir}/b.json`,
          JSON.stringify({ $schema: "./old/config.v1.json" }),
        );
        const a = yield* load(`${dir}/a.json`);
        const b = yield* load(`${dir}/b.json`);
        assert.deepStrictEqual(a._tag === "Valid" ? a.warnings : "?", []);
        assert.strictEqual(b._tag === "Valid" ? b.warnings[0]?.pointer : "?", "/$schema");
      }),
    ),
  );

  it.effect("keeps points behaviour inside each goal, with defaults", () =>
    Effect.sync(() => {
      const exit = decode({
        priorities: [
          { type: "points", channels: ["oilrats"], raids: { follow: false } },
          { type: "drops", games: "all", claimBonus: false },
        ],
      });
      assert.isTrue(Exit.isSuccess(exit));
      if (Exit.isFailure(exit)) return;
      const [points, drops] = exit.value.priorities;
      assert.deepStrictEqual(
        points?.type === "points" ? [points.claimBonus, points.watchStreaks, points.raids] : [],
        [true, true, { follow: false, stayMinutes: 1 }],
      );
      assert.isFalse(drops?.type === "drops" ? drops.claimBonus : true);
    }),
  );

  it("refuses points-only options on a drops goal and the old top-level block", () => {
    assert.deepStrictEqual(
      problems({
        priorities: [{ type: "drops", games: "all", raids: { follow: true } }],
        points: { claimBonus: true },
      }).map((p) => p.message),
      ['unknown key "points"', 'unknown key "raids"'],
    );
  });
});
