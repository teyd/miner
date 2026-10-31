#!/usr/bin/env node
// Usage: pnpm verify [--skip-check] [--seed N] [--seeds M] [--shadow-seed N] [--minutes M]
// The whole verify-miner suite, cheaply, without Twitch: the gate (`pnpm check`), the bundle,
// a seed sweep, a shadow run over the twin, its status and its recordings. Prints PASS/FAIL per
// step with the evidence, and exits 1 unless every step passed. Evidence stays in one scratch
// directory, printed at the end (cleanup.mjs removes it). The shadow run's recordings must hold
// at least one `{"$same": …}` reference, so the recordings step proves they resolve: the default
// seed 9 writes its first one within 20 virtual minutes (seeds 3 and 7 write none by then).
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TWIN_TOKEN, args, int, root, scratch, shell } from "./lib.mjs";

const { values } = args("verify", {
  "skip-check": { type: "boolean", default: false },
  seed: { type: "string", default: "1" },
  seeds: { type: "string", default: "20" },
  "shadow-seed": { type: "string", default: "9" },
  minutes: { type: "string", default: "60" },
});
// Every argument is checked before the scratch directory exists, so a usage error leaves none.
const seed = String(int("verify", "seed", values.seed));
const seeds = String(int("verify", "seeds", values.seeds));
const shadowSeed = String(int("verify", "shadow-seed", values["shadow-seed"]));
const minutes = String(int("verify", "minutes", values.minutes));
const evidence = scratch("run");
const data = join(evidence, "data");
const script = (name, ...rest) => [process.execPath, join(root, "scripts/verify", name), ...rest];

const steps = [
  {
    name: "check",
    skip: values["skip-check"] ? "--skip-check" : undefined,
    argv: ["sh", "-c", process.env.MINER_VERIFY_CHECK ?? "pnpm check"],
  },
  { name: "build", argv: script("build.mjs") },
  {
    name: "sim",
    needs: "build",
    argv: script("sim.mjs", "--seed", seed, "--seeds", seeds, "--out", evidence),
  },
  {
    name: "shadow",
    needs: "build",
    argv: script(
      "shadow.mjs",
      "--seed",
      shadowSeed,
      "--minutes",
      minutes,
      "--dir",
      data,
      "--out",
      evidence,
    ),
  },
  {
    name: "status",
    needs: "shadow",
    argv: script("status.mjs", data, "--expect", "stopped", "--mode", "shadow"),
  },
  {
    name: "recordings",
    needs: "shadow",
    argv: script("recordings.mjs", data, "--secret", TWIN_TOKEN, "--min-refs", "1"),
  },
];

const results = new Map();
const rows = [];
for (const s of steps) {
  const log = join(evidence, `${s.name}.log`);
  let verdict;
  let line = "";
  const started = performance.now();
  if (s.skip !== undefined) {
    verdict = "SKIP";
    line = s.skip;
  } else if (s.needs !== undefined && results.get(s.needs) !== "PASS") {
    verdict = "FAIL";
    line = `not run: ${s.needs} did not pass`;
  } else {
    console.log(`... ${s.name}`);
    const r = spawnSync(s.argv[0], s.argv.slice(1), {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    const output = (r.stdout ?? "") + (r.stderr ?? "");
    writeFileSync(log, output);
    verdict = r.status === 0 ? "PASS" : "FAIL";
    // A script's own verdict line; for the gate, vitest's count of tests.
    const tests = /^\s*Tests\s+(.+)$/m.exec(output)?.[1];
    line =
      output
        .split("\n")
        .find((l) => /^(PASS|FAIL) /.test(l))
        ?.replace(/^(PASS|FAIL) [^:]+: /, "") ??
      `exit ${r.status ?? r.signal}${tests === undefined ? "" : `, tests ${tests}`}. Evidence: ${log}`;
    if (verdict === "FAIL")
      console.log(
        output
          .trimEnd()
          .split("\n")
          .slice(-25)
          .map((l) => `  | ${l}`)
          .join("\n"),
      );
  }
  results.set(s.name, verdict);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  rows.push(`${verdict.padEnd(4)}  ${s.name.padEnd(10)} ${seconds.padStart(6)} s  ${line}`);
}

const failed = [...results.values()].filter((v) => v === "FAIL").length;
const rev = shell("git rev-parse --short HEAD");
const head = rev.status === 0 ? rev.stdout.trim() : "";
const porcelain = shell("git status --porcelain");
const dirty =
  porcelain.status === 0 && porcelain.stdout.trim() !== "" ? " with uncommitted changes" : "";
console.log(
  head === "" ? "\nverify-miner outside a git checkout" : `\nverify-miner at ${head}${dirty}`,
);
for (const row of rows) console.log(row);
console.log(`evidence: ${evidence} (step logs, sim.json, capsules, data/)`);
console.log(failed === 0 ? "PASS: every step passed" : `FAIL: ${failed} step(s) failed`);
process.exit(failed === 0 ? 0 : 1);
