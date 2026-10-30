import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HOUR } from "../core/model.ts";
import { Gzip, nodeGzip } from "../platform/Gzip.ts";
import { memoryFileSystem, type MemoryFiles } from "../store/memoryFileSystem.ts";
import campaignDetails from "./fixtures/campaign-details.json" with { type: "json" };
import inventory from "./fixtures/inventory.json" with { type: "json" };
import leaks from "./fixtures/leaks.json" with { type: "json" };
import { DEFAULT_LIMITS, Journal, parseRecording, type Limits } from "./journal.ts";

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
      const small = { keepDays: 30, maxDayBytes: 4 * one, maxBytes: 6 * one, maxBodyChars: 10_000 };
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
      const limits = { keepDays: 7, maxBytes: 1_000_000, maxDayBytes: 600, maxBodyChars: 100 };
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
