#!/usr/bin/env node
// Usage: node scripts/verify/recordings.mjs DATA_DIR|FILE... [--secret VALUE]... [--min-refs N]
// Every recording (DATA_DIR/recordings/*.jsonl.gz, or the files given) must read whole through
// `miner journal cat`: a reference with nothing to point at fails. It counts the references
// (`{"$same": …}`) it resolved, and with --min-refs fails fewer, so a run that never wrote one
// can't pass for proof that they resolve. With --secret, no file under DATA_DIR (recordings,
// logs, state, status) may contain VALUE, in its raw bytes or its gzip members inflated; a gzip
// file whose plaintext can't be produced fails, as it can't be shown clean. The value itself is
// never printed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { constants, gunzipSync } from "node:zlib";
import { args, fail, int, miner, pass, usage } from "./lib.mjs";

const step = "recordings";
const parsed = args(
  step,
  { secret: { type: "string", multiple: true }, "min-refs": { type: "string", default: "0" } },
  true,
);
const values = parsed.values;
// `miner journal cat` runs from the repository root, so a relative path must not reach it.
const positionals = parsed.positionals.map((p) => resolve(p));
if (positionals.length === 0) {
  usage(step, "recordings.mjs DATA_DIR|FILE... [--secret VALUE]... [--min-refs N]");
}
const minRefs = int(step, "min-refs", values["min-refs"]);
const secrets = values.secret ?? [];
for (const secret of secrets) {
  if (secret.length < 6) usage(step, "a --secret shorter than 6 characters would match by chance");
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

const dirs = positionals.filter((p) => existsSync(p) && statSync(p).isDirectory());
const recordings = positionals.flatMap((p) => {
  if (!existsSync(p)) return fail(step, `${p} does not exist`);
  if (!dirs.includes(p)) return [p];
  const r = join(p, "recordings");
  return existsSync(r)
    ? walk(r)
        .filter((f) => /\.jsonl(\.gz)?$/.test(f))
        .sort()
    : [];
});
if (recordings.length === 0) fail(step, `no recordings in ${positionals.join(", ")}`);

// How every member the recorder writes begins (src/platform/Gzip.ts MEMBER).
const MEMBER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);

/**
 * The plaintext of a file: itself, or every gzip member inflated on its own, as
 * src/platform/Gzip.ts reads them. A member torn by a crash gives the text it holds
 * (Z_SYNC_FLUSH); one that can't be inflated at all makes the file unreadable (`undefined`).
 */
const plaintext = (bytes) => {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const starts = [];
  for (let at = bytes.indexOf(MEMBER); at !== -1; at = bytes.indexOf(MEMBER, at + 1)) {
    starts.push(at);
  }
  if (starts[0] !== 0) starts.unshift(0);
  const parts = [];
  for (const [n, start] of starts.entries()) {
    try {
      parts.push(
        gunzipSync(bytes.subarray(start, starts[n + 1] ?? bytes.length), {
          finishFlush: constants.Z_SYNC_FLUSH,
        }),
        Buffer.from("\n"),
      );
    } catch {
      return undefined;
    }
  }
  return Buffer.concat(parts);
};

const kinds = {};
let refs = 0;
for (const file of recordings) {
  const result = miner(["journal", "cat", file]);
  if (result.status !== 0) {
    fail(
      step,
      `miner journal cat ${file} exited ${result.status ?? result.signal}`,
      result.stderr + tail(result.stdout),
    );
  }
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue;
    const kind = JSON.parse(line).kind ?? "?";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  // `journal cat` resolved them all; the recorder's `refs` on a line says how many it held.
  const text = plaintext(readFileSync(file));
  if (text === undefined) fail(step, `${file} has a gzip member that can't be inflated`);
  for (const line of text.toString("utf8").split("\n")) {
    try {
      const n = JSON.parse(line).refs;
      if (typeof n === "number") refs += n;
    } catch {
      // A line torn by a crash: `journal cat` skipped it too.
    }
  }
}

function tail(text) {
  return text.split("\n").slice(-5).join("\n");
}

const scanned = [...new Set([...dirs.flatMap(walk), ...recordings])];
for (const file of scanned) {
  if (secrets.length === 0) break;
  const raw = readFileSync(file);
  const text = plaintext(raw);
  if (text === undefined) {
    fail(step, `${file} can't be inflated, so it can't be shown to hold no --secret value`);
  }
  if (secrets.some((secret) => raw.includes(secret) || text.includes(secret))) {
    fail(step, `${file} contains a --secret value (redaction failed); the value is not shown`);
  }
}
if (refs < minRefs) {
  fail(
    step,
    `${refs === 0 ? "no references exercised" : `${refs} reference(s) resolved`}, ` +
      `--min-refs ${minRefs}: run a seed whose recording repeats a part (pnpm verify uses seed 9)`,
  );
}
const counted = Object.entries(kinds)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, n]) => `${n} ${k}`)
  .join(", ");
pass(
  step,
  `${recordings.length} recording(s) read whole (${counted}); ` +
    (refs === 0 ? "no references exercised" : `${refs} reference(s) resolved`) +
    (secrets.length > 0 ? `; ${scanned.length} files hold no secret` : "") +
    `. Evidence: ${recordings.join(", ")}`,
);
