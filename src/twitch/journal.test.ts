import { assert, describe, it } from "@effect/vitest";
import fc from "fast-check";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HOUR } from "../core/model.ts";
import { Gzip, nodeGzip } from "../platform/Gzip.ts";
import { memoryFileSystem, type MemoryFiles } from "../store/memoryFileSystem.ts";
import campaignDetails from "./fixtures/campaign-details.json" with { type: "json" };
import inventory from "./fixtures/inventory.json" with { type: "json" };
import leaks from "./fixtures/leaks.json" with { type: "json" };
import {
  type Answer,
  compact,
  DEFAULT_LIMITS,
  expandRecording,
  Journal,
  parseRecording,
  seal,
  type Limits,
} from "./journal.ts";

/** 2026-10-29T12:00:00Z. */
const NOON = 1_793_275_200_000;
const DAY = 24 * HOUR;
const DIR = "/data/recordings";
const TOKEN = "abcdefghij0123456789token";

const gzip = nodeGzip;

const recordings = (files: MemoryFiles) =>
  [...files.files.keys()].filter((k) => k.startsWith(`${DIR}/`)).toSorted();

const entries = (files: MemoryFiles, path: string): ReadonlyArray<Record<string, unknown>> =>
  parseRecording(new TextDecoder().decode(gzip.gunzip(files.files.get(path)!))) as never;

const withJournal = <A>(
  files: MemoryFiles,
  use: (journal: Journal["Service"]) => Effect.Effect<A>,
  limits?: Limits,
) =>
  Effect.gen(function* () {
    return yield* use(yield* Journal);
  }).pipe(
    Effect.provide(
      Journal.rolling(DIR, [TOKEN], limits).pipe(
        Layer.provide(Layer.merge(files.layer, Gzip.layer)),
      ),
    ),
  );

const answer = (body: unknown) => ({ operation: "Inventory", variables: {}, status: 200, body });

describe("the rolling recorder", () => {
  it.effect("writes answers and intents to a gzip file per UTC day", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      yield* TestClock.setTime(NOON);
      yield* withJournal(files, (journal) =>
        Effect.gen(function* () {
          yield* journal.record(answer({ n: 1 }));
          yield* journal.intent("Claim", { instanceId: "i1" });
          yield* TestClock.adjust(12 * HOUR);
          yield* journal.record(answer({ n: 2 }));
        }),
      );
      assert.deepStrictEqual(recordings(files), [
        `${DIR}/2026-10-29.jsonl.gz`,
        `${DIR}/2026-10-30.jsonl.gz`,
      ]);
      const first = entries(files, `${DIR}/2026-10-29.jsonl.gz`);
      assert.deepStrictEqual(first, [
        {
          kind: "answer",
          at: NOON,
          operation: "Inventory",
          variables: {},
          status: 200,
          body: { n: 1 },
        },
        { kind: "intent", at: NOON, command: "Claim", detail: { instanceId: "i1" } },
      ]);
    }),
  );

  it.effect("keeps N days, and keeps the total under the byte budget", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      yield* TestClock.setTime(NOON);
      const limits = { ...DEFAULT_LIMITS, keepDays: 3 };
      yield* withJournal(
        files,
        (journal) =>
          Effect.gen(function* () {
            for (let day = 0; day < 6; day++) {
              yield* journal.record(answer({ day }));
              yield* TestClock.adjust(DAY);
            }
          }),
        limits,
      );
      assert.deepStrictEqual(
        recordings(files).map((p) => p.slice(DIR.length + 1)),
        ["2026-11-01.jsonl.gz", "2026-11-02.jsonl.gz", "2026-11-03.jsonl.gz"],
      );

      // A budget that holds today's maximum and one more small day keeps just one older day.
      const tight = memoryFileSystem();
      yield* TestClock.setTime(NOON);
      const body = { blob: "x".repeat(2000) };
      const one = gzip.gzip(new TextEncoder().encode(JSON.stringify(answer(body)))).length;
      const small = {
        ...DEFAULT_LIMITS,
        keepDays: 30,
        maxDayBytes: 4 * one,
        maxBytes: 6 * one,
        maxBodyChars: 10_000,
      };
      yield* withJournal(
        tight,
        (journal) =>
          Effect.gen(function* () {
            for (let day = 0; day < 5; day++) {
              yield* journal.record(answer(body));
              yield* TestClock.adjust(DAY);
            }
            yield* journal.record(answer(body));
          }),
        small,
      );
      const total = recordings(tight).reduce((sum, p) => sum + tight.files.get(p)!.length, 0);
      assert.isAtMost(total, small.maxBytes);
      assert.isAtMost(recordings(tight).length, 3);
    }),
  );

  it.effect("replaces an oversized body by its digest and stops a day at its budget", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      yield* TestClock.setTime(NOON);
      const limits = {
        ...DEFAULT_LIMITS,
        maxBytes: 1_000_000,
        maxDayBytes: 600,
        maxBodyChars: 100,
      };
      yield* withJournal(
        files,
        (journal) =>
          Effect.gen(function* () {
            yield* journal.record(answer({ blob: "x".repeat(500) }));
            for (let i = 0; i < 50; i++) yield* journal.record(answer({ i, pad: "y".repeat(40) }));
          }),
        limits,
      );
      const written = entries(files, `${DIR}/2026-10-29.jsonl.gz`);
      assert.deepInclude(written[0]?.["body"] as object, { omitted: "body over the size cap" });
      assert.strictEqual(written.at(-1)?.["kind"], "full");
      assert.isBelow(written.length, 51);
      assert.isAtMost(files.files.get(`${DIR}/2026-10-29.jsonl.gz`)!.length, 600 + 200);
    }),
  );

  it.effect("never fails the miner when the disk does", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      files.failWrites = true;
      yield* TestClock.setTime(NOON);
      yield* withJournal(files, (journal) => journal.record(answer({ n: 1 })));
      assert.deepStrictEqual(recordings(files), []);
    }),
  );

  it.effect(
    "writes no line that holds a secret: the leak corpus as bodies, variables and intents",
    () =>
      Effect.gen(function* () {
        const files = memoryFileSystem();
        yield* TestClock.setTime(NOON);
        yield* withJournal(files, (journal) =>
          Effect.gen(function* () {
            for (const { input } of leaks.cases) {
              yield* journal.record({ operation: "x", variables: input, status: 500, body: input });
              yield* journal.intent("Watch", input);
            }
            // The token where no rule would look for it: the known-secret check stops the line.
            yield* journal.record(answer({ note: `copied ${TOKEN} by mistake` }));
          }),
        );
        const text = new TextDecoder().decode(
          gzip.gunzip(files.files.get(`${DIR}/2026-10-29.jsonl.gz`)!),
        );
        assert.notInclude(text, "SECRET");
        assert.notInclude(text, TOKEN);
        const last = parseRecording(text).at(-1) as Record<string, unknown>;
        assert.strictEqual(last["omitted"], "failed the redaction check");
        assert.strictEqual(parseRecording(text).length, 2 * leaks.cases.length + 1);
      }),
  );

  it("compresses the recorded answers 4-5x, which is why recordings are gzip", () => {
    // Bytes per day are dominated by inventory (every 5 min) and catalog details (hourly).
    for (const fixture of [inventory, campaignDetails]) {
      const plain = new TextEncoder().encode(JSON.stringify(answer(fixture.body)));
      assert.isAbove(plain.length / gzip.gzip(plain).length, 3.5);
    }
  });
});

/** What `seal` alone writes for an answer recorded at `at`: the line before compaction. */
const uncompacted = (at: number, a: Answer, limits: Limits = DEFAULT_LIMITS) =>
  JSON.parse(seal({ kind: "answer", at, ...a }, [TOKEN], limits.maxBodyChars)) as unknown;

const lineSizes = (files: MemoryFiles, path: string) =>
  new TextDecoder()
    .decode(gzip.gunzip(files.files.get(path)!))
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.length);

const TODAY = `${DIR}/2026-10-29.jsonl.gz`;

describe("compaction", () => {
  const campaigns = (inventory.body[0] as { data: { currentUser: { inventory: unknown } } }).data
    .currentUser.inventory as { dropCampaignsInProgress: ReadonlyArray<unknown> };
  /** The inventory fixture with its campaigns in another order, as Twitch sends it between reads. */
  const reordered = [
    {
      data: {
        currentUser: {
          inventory: {
            ...campaigns,
            dropCampaignsInProgress: campaigns.dropCampaignsInProgress.toReversed(),
          },
        },
      },
    },
  ];

  it.effect("writes a part of a body once per file, and reads it back whole", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      yield* TestClock.setTime(NOON);
      yield* withJournal(files, (journal) =>
        Effect.gen(function* () {
          yield* journal.record(answer(inventory.body));
          yield* journal.record(answer(reordered));
          yield* journal.record(answer(inventory.body));
        }),
      );
      const written = entries(files, TODAY);
      const [first, second, third] = lineSizes(files, TODAY);
      // The first read is whole; a reordered read refers to each campaign; a repeat is one ref.
      assert.notProperty(written[0], "refs");
      assert.isAtLeast(written[1]?.["refs"] as number, campaigns.dropCampaignsInProgress.length);
      assert.isBelow(second!, first! / 4);
      assert.strictEqual(written[2]?.["refs"], 1);
      assert.isBelow(third!, 200);
      const expanded = expandRecording(written);
      assert.deepStrictEqual(expanded.missing, []);
      assert.deepStrictEqual(expanded.entries, [
        uncompacted(NOON, answer(inventory.body)),
        uncompacted(NOON, answer(reordered)),
        uncompacted(NOON, answer(inventory.body)),
      ]);
    }),
  );

  it.effect("refers only to the same file: a new day writes every part again", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      yield* TestClock.setTime(NOON);
      yield* withJournal(files, (journal) =>
        Effect.gen(function* () {
          yield* journal.record(answer(campaignDetails.body));
          yield* TestClock.adjust(DAY);
          yield* journal.record(answer(campaignDetails.body));
        }),
      );
      const [first, second] = recordings(files).map((path) => {
        const [line] = entries(files, path);
        assert.deepStrictEqual(expandRecording(entries(files, path)).missing, []);
        return { ...line, at: 0 };
      });
      // The second day refers to nothing in the first: its line is the first day's line.
      assert.deepStrictEqual(second, first);
    }),
  );

  it.effect("writes again what a failed or redacted line would have held", () =>
    Effect.gen(function* () {
      const files = memoryFileSystem();
      yield* TestClock.setTime(NOON);
      const part = { blob: "z".repeat(400) };
      yield* withJournal(files, (journal) =>
        Effect.gen(function* () {
          // Fails the seal: nothing it holds is written, so nothing may refer to it.
          yield* journal.record(answer({ part, note: `copied ${TOKEN} by mistake` }));
          files.tearNextWrite = true;
          yield* journal.record(answer({ part, n: 1 }));
          files.failWrites = true;
          yield* journal.record(answer({ part, n: 2 }));
          files.failWrites = false;
          yield* journal.record(answer({ part, n: 3 }));
          yield* journal.record(answer({ part, n: 4 }));
        }),
      );
      const written = entries(files, TODAY);
      assert.strictEqual(written[0]?.["omitted"], "failed the redaction check");
      assert.deepStrictEqual(
        written.slice(1).map((e) => e["refs"]),
        [undefined, 1],
      );
      const expanded = expandRecording(written);
      assert.deepStrictEqual(expanded.missing, []);
      assert.deepStrictEqual(expanded.entries.slice(1), [
        uncompacted(NOON, answer({ part, n: 3 })),
        uncompacted(NOON, answer({ part, n: 4 })),
      ]);
    }),
  );

  it("leaves a body alone that already holds something shaped like a reference", () => {
    const body = { a: { $same: "0123456789abcdef" }, b: [{ blob: "q".repeat(300) }] };
    const twice = { ...body, c: body.b };
    const result = compact(twice, () => true);
    assert.strictEqual(result.refs, 0);
    assert.deepStrictEqual(result.body, twice);
    // The reader treats it as data, and still notes its parts as the writer did.
    const lines = [
      { kind: "answer", at: 1, operation: "x", variables: {}, status: 200, body: twice },
      {
        kind: "answer",
        at: 2,
        operation: "x",
        variables: {},
        status: 200,
        refs: 1,
        body: compact(body.b, (id) => result.parts.includes(id)).body,
      },
    ];
    const expanded = expandRecording(lines);
    assert.deepStrictEqual(expanded.missing, []);
    assert.deepStrictEqual((expanded.entries[1] as { body: unknown }).body, body.b);
  });

  it("reports a reference no earlier line defines and leaves it in place", () => {
    const ref = { $same: "00000000deadbeef" };
    const line = { kind: "answer", at: 1, operation: "x", variables: {}, status: 200, refs: 1 };
    const expanded = expandRecording([{ ...line, body: [ref] }]);
    assert.deepStrictEqual(expanded.missing, ["00000000deadbeef"]);
    assert.deepStrictEqual(expanded.entries, [
      { kind: "answer", at: 1, operation: "x", variables: {}, status: 200, body: [ref] },
    ]);
  });

  /**
   * Bodies built from a few shared parts in any order and nesting, recorded across day rolls,
   * restarts, failed and torn writes, and a small memory of written parts. Every file must read
   * back to exactly the lines `seal` alone would have written, with no reference left dangling.
   */
  it.effect("never leaves a reference dangling, across days, restarts and torn writes", () =>
    Effect.gen(function* () {
      const part = fc.record({
        id: fc.string({ maxLength: 8 }),
        pad: fc.string({ minLength: 150, maxLength: 400 }),
        n: fc.integer(),
      });
      const op = fc.oneof(
        {
          weight: 6,
          arbitrary: fc
            .tuple(fc.array(fc.nat(5), { maxLength: 6 }), fc.jsonValue({ maxDepth: 2 }), fc.nat(3))
            .map(([picks, extra, nest]) => ({ _tag: "record" as const, picks, extra, nest })),
        },
        { weight: 1, arbitrary: fc.constant({ _tag: "day" as const }) },
        { weight: 1, arbitrary: fc.constant({ _tag: "restart" as const }) },
        { weight: 1, arbitrary: fc.constant({ _tag: "fail" as const }) },
        { weight: 1, arbitrary: fc.constant({ _tag: "tear" as const }) },
      );
      const run = fc.record({
        parts: fc.array(part, { minLength: 6, maxLength: 6 }),
        ops: fc.array(op, { maxLength: 40 }),
        remembered: fc.integer({ min: 1, max: 64 }),
      });
      // What the samples exercised, so a generator change can't quietly test nothing.
      const seen = { refs: 0, tornThenRead: 0, days: 0, restartsWithFiles: 0 };
      for (const sample of fc.sample(run, { seed: 29, numRuns: 300 })) {
        const files = memoryFileSystem();
        const limits = { ...DEFAULT_LIMITS, rememberedParts: sample.remembered };
        yield* TestClock.setTime(NOON);
        const expected = new Map<string, Array<unknown>>();
        const torn = new Set<number>();
        let ops = sample.ops;
        while (ops.length > 0) {
          if (files.files.size > 0) seen.restartsWithFiles++;
          const restart = ops.findIndex((o) => o._tag === "restart");
          const session = restart === -1 ? ops : ops.slice(0, restart);
          ops = restart === -1 ? [] : ops.slice(restart + 1);
          yield* withJournal(
            files,
            (journal) =>
              Effect.gen(function* () {
                let failNext = false;
                for (const o of session) {
                  yield* TestClock.adjust(1000);
                  if (o._tag === "day") yield* TestClock.adjust(DAY);
                  else if (o._tag === "fail") failNext = true;
                  else if (o._tag === "tear") files.tearNextWrite = true;
                  else if (o._tag === "record") {
                    let body: unknown = {
                      list: o.picks.map((i) => sample.parts[i]),
                      extra: o.extra,
                    };
                    for (let i = 0; i < o.nest; i++) body = { wrapped: body, again: o.picks[i] };
                    const now = yield* Effect.clockWith((c) => c.currentTimeMillis);
                    const tearing = files.tearNextWrite;
                    files.failWrites = failNext;
                    yield* journal.record(answer(body));
                    files.failWrites = false;
                    if (tearing) torn.add(now);
                    else if (!failNext) {
                      const day = recordings(files).at(-1)!;
                      expected.set(day, [
                        ...(expected.get(day) ?? []),
                        uncompacted(now, answer(body), limits),
                      ]);
                    }
                    failNext = false;
                  }
                }
              }),
            limits,
          );
        }
        for (const path of recordings(files)) {
          const read = expandRecording(entries(files, path));
          assert.deepStrictEqual(read.missing, [], JSON.stringify(sample));
          const kept = read.entries.filter((e) => !torn.has((e as { at: number }).at));
          assert.deepStrictEqual(kept, expected.get(path) ?? [], JSON.stringify(sample));
          const written = entries(files, path);
          seen.refs += written.reduce((n, e) => n + ((e["refs"] as number | undefined) ?? 0), 0);
          const last = Math.max(...written.map((e) => e["at"] as number));
          seen.tornThenRead += [...torn].filter((at) => at < last).length;
        }
        seen.days += recordings(files).length > 1 ? 1 : 0;
      }
      assert.isAtLeast(seen.refs, 400);
      assert.isAtLeast(seen.tornThenRead, 40);
      assert.isAtLeast(seen.days, 30);
      assert.isAtLeast(seen.restartsWithFiles, 60);
    }),
  );
});
