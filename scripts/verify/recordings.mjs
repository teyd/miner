#!/usr/bin/env node
// Usage: node scripts/verify/recordings.mjs DATA_DIR|FILE... [--secret VALUE]...
// Every recording (DATA_DIR/recordings/*.jsonl.gz, or the files given) must read whole through
// `miner journal cat`: a reference with nothing to point at fails. With --secret, no file under
// DATA_DIR (recordings, logs, state, status) may contain VALUE, gzip members inflated. The value
// itself is never printed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { args, fail, miner, pass, usage } from "./lib.mjs";

const step = "recordings";
const { values, positionals } = args(step, { secret: { type: "string", multiple: true } }, true);
if (positionals.length === 0) usage(step, "recordings.mjs DATA_DIR|FILE... [--secret VALUE]");

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

const kinds = {};
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
}

function tail(text) {
  return text.split("\n").slice(-5).join("\n");
}

const inflate = (bytes) => {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  try {
    return gunzipSync(bytes);
  } catch {
    return bytes;
  }
};
const secrets = values.secret ?? [];
const scanned = [...new Set([...dirs.flatMap(walk), ...recordings])];
for (const secret of secrets) {
  if (secret.length < 6) usage(step, "a --secret shorter than 6 characters would match by chance");
  for (const file of scanned) {
    if (inflate(readFileSync(file)).includes(secret)) {
      fail(step, `${file} contains a --secret value (redaction failed); the value is not shown`);
    }
  }
}
const counted = Object.entries(kinds)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, n]) => `${n} ${k}`)
  .join(", ");
pass(
  step,
  `${recordings.length} recording(s) read whole (${counted})` +
    (secrets.length > 0 ? `; ${scanned.length} files hold no secret` : "") +
    `. Evidence: ${recordings.join(", ")}`,
);
