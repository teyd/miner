import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Logger, Redacted } from "effect";
import { formatJson, formatPretty, rotatingFile } from "./logging.ts";

const capture = (format: Logger.Logger<unknown, string>) => {
  const lines: Array<string> = [];
  const logger = Logger.make<unknown, void>((options) => {
    lines.push(format.log(options));
  });
  return { lines, layer: Logger.layer([logger]) };
};

describe("formatJson", () => {
  it.effect("writes one flat object per line with annotations, spans and extra data", () =>
    Effect.gen(function* () {
      const { lines, layer } = capture(formatJson);
      yield* Effect.logWarning("catalog read", { campaigns: 3 }).pipe(
        Effect.annotateLogs({ op: "catalog" }),
        Effect.withLogSpan("rescan"),
        Effect.provide(layer),
      );
      const line = JSON.parse(lines[0] ?? "");
      expect(line).toMatchObject({
        level: "WARN",
        msg: "catalog read",
        op: "catalog",
        data: { campaigns: 3 },
      });
      expect(line.spans).toHaveProperty("rescan");
      expect(typeof line.time).toBe("string");
    }),
  );

  it.effect("never prints a token, a signed URL or an Authorization header", () =>
    Effect.gen(function* () {
      const { lines, layer } = capture(formatJson);
      yield* Effect.logError("GET https://usher.ttvnw.net/x.m3u8?sig=abc123&token=%7Bsecret%7D", {
        Authorization: "OAuth abcdefghij0123456789",
        token: Redacted.make("abcdefghij0123456789"),
      }).pipe(Effect.annotateLogs({ access_token: "abcdefghij0123456789" }), Effect.provide(layer));
      const out = lines.join("\n");
      expect(out).not.toContain("abc123");
      expect(out).not.toContain("secret");
      expect(out).not.toContain("abcdefghij0123456789");
    }),
  );
});

describe("formatPretty", () => {
  it.effect("puts level, message and fields on one line", () =>
    Effect.gen(function* () {
      const { lines, layer } = capture(formatPretty(false));
      yield* Effect.logInfo("watching").pipe(
        Effect.annotateLogs({ channel: "some_streamer", game: "Rust Game" }),
        Effect.provide(layer),
      );
      expect(lines[0]).toMatch(
        /^\d\d:\d\d:\d\d\.\d{3} INFO {2}watching channel=some_streamer game="Rust Game"$/,
      );
    }),
  );
});

describe("rotatingFile", () => {
  it.effect("rotates by size and keeps only the newest files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = `${dir}/logs/miner.log`;
      const line = Logger.make((options) => String(options.message));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const logger = yield* rotatingFile(line, file, { maxBytes: 10, keep: 2, window: 1 });
          const layer = Logger.layer([logger]);
          // 6 bytes per line ("aaaaa\n"), so every file holds one line.
          for (const c of ["a", "b", "c", "d"])
            yield* Effect.log(c.repeat(5)).pipe(Effect.provide(layer));
        }),
      );
      expect(yield* fs.readFileString(file)).toBe("ddddd\n");
      expect(yield* fs.readFileString(`${file}.1`)).toBe("ccccc\n");
      expect(yield* fs.readFileString(`${file}.2`)).toBe("bbbbb\n");
      expect(yield* fs.exists(`${file}.3`)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates nothing until something is logged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* Effect.scoped(rotatingFile(Logger.formatSimple, `${dir}/logs/miner.log`));
      expect(yield* fs.exists(`${dir}/logs`)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
