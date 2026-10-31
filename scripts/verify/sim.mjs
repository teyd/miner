#!/usr/bin/env node
// Usage: node scripts/verify/sim.mjs [--seed N] [--seeds M] [--trace capsule.json]
//          [--expect-digest HEX] [--out DIR]
// Runs `miner sim --json` and keeps the evidence in DIR (a new scratch directory by default):
// sim.json, and for every failed seed its shrunk capsule with the commands to replay it.
// `--expect-digest` fails a sweep whose digest differs: a change meant to keep behaviour keeps it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { args, fail, int, json, miner, minerBin, pass, root, scratch } from "./lib.mjs";

const step = "sim";
const { values } = args(step, {
  seed: { type: "string", default: "1" },
  seeds: { type: "string", default: "20" },
  trace: { type: "string" },
  "expect-digest": { type: "string" },
  out: { type: "string" },
});
const seed = int(step, "seed", values.seed);
const seeds = int(step, "seeds", values.seeds);
const out = values.out ?? scratch("sim");
mkdirSync(out, { recursive: true });
const bin = relative(root, minerBin());

const flags =
  values.trace === undefined
    ? ["--seed", String(seed), "--seeds", String(seeds)]
    : ["--trace", values.trace];
const result = miner(["sim", "--json", ...flags]);
const document = json(result.stdout);
if (document === undefined || (result.status !== 0 && result.status !== 1)) {
  fail(
    step,
    `miner sim ${flags.join(" ")} crashed (exit ${result.status ?? result.signal})`,
    result.stdout + result.stderr,
  );
}
const evidence = join(out, "sim.json");
writeFileSync(evidence, `${JSON.stringify(document, null, 2)}\n`);

if (values.trace !== undefined) {
  const line = `${values.trace}: digest ${document.digest} (${document.digestMatches ? "matches the capsule" : "differs from the capsule"})`;
  if (!document.ok) {
    const v = document.violation;
    fail(step, `${line}; still fails: ${v.kind} at +${v.at}m: ${v.detail}`);
  }
  pass(step, `${line}; no violation. Evidence: ${evidence}`);
  process.exit(0);
}

const lines = [];
for (const capsule of document.failures) {
  const file = join(out, `capsule-seed-${capsule.seed}.json`);
  writeFileSync(file, `${JSON.stringify(capsule, null, 2)}\n`);
  const v = capsule.violation;
  lines.push(
    `seed ${capsule.seed}: ${v.kind} at +${v.at}m: ${v.detail}`,
    `  capsule: ${file}`,
    `  replay:  node ${bin} sim --trace ${file}`,
    `  rerun:   node ${bin} sim --seed ${capsule.seed} --seeds 1`,
    `  files:   node ${bin} sim --trace ${file} --shadow "$(mktemp -d)"`,
  );
}
const last = seed + seeds - 1;
const summary =
  `${seeds} seeds (${seed}-${last}), ${document.passed} passed; ${document.watched} watched, ` +
  `${document.claimed} claimed; sweep digest ${document.sweepDigest}`;
if (result.status !== 0 || !document.ok) {
  fail(step, `${document.failures.length} of ${seeds} seeds failed. ${summary}`, lines.join("\n"));
}
const expected = values["expect-digest"];
if (expected !== undefined && expected !== document.sweepDigest) {
  fail(
    step,
    `sweep digest ${document.sweepDigest}, expected ${expected}: some seed's trace changed. ` +
      `Compare the per-seed digests in ${evidence}.`,
  );
}
pass(step, `${summary}. Evidence: ${evidence}`);
