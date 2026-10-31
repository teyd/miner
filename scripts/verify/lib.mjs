// Shared by the verify-miner scripts (.agents/skills/verify-miner/SKILL.md). Node built-ins only.
// Every script prints `PASS <step>: …` or `FAIL <step>: …` and exits 0 on a pass, 1 on a failure,
// 2 on a usage error. They never talk to Twitch: the miner runs over its twin.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Scratch directories the scripts make, and the only ones `cleanup.mjs` removes. */
export const SCRATCH_PREFIX = "miner-verify-";

/** The twin's token (`src/twin/twin.ts` TWIN_TOKEN): it must never reach a file. */
export const TWIN_TOKEN = "twin-token";

/** The miner to run: the bundle `pnpm build` makes, or `MINER_BIN` (tests use `src/bin.ts`). */
export const minerBin = () => resolve(root, process.env.MINER_BIN ?? "dist/bin.mjs");

/** `miner …args` with JSON logs on stderr and no log file, so nothing lands in `./data`. */
export const miner = (args, env = {}) =>
  spawnSync(process.execPath, [minerBin(), ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: { ...process.env, LOG_FILE: "false", LOG_FORMAT: "json", ...env },
  });

/** A shell command from the repository root, its output captured. */
export const shell = (command, env = {}) =>
  spawnSync("sh", ["-c", command], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: { ...process.env, ...env },
  });

/** Names the checkout that made a scratch directory, so cleanup leaves other worktrees' alone. */
export const OWNER_FILE = ".owner";

export const scratch = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `${SCRATCH_PREFIX}${label}-`));
  writeFileSync(join(dir, OWNER_FILE), `${root}\n`);
  return dir;
};

export const pass = (step, message) => {
  console.log(`PASS ${step}: ${message}`);
};

export const fail = (step, message, details = "") => {
  console.log(`FAIL ${step}: ${message}`);
  if (details.trim() !== "") console.log(indent(tail(details)));
  process.exit(1);
};

export const usage = (step, message) => {
  console.log(`usage ${step}: ${message}`);
  process.exit(2);
};

export const tail = (text, lines = 30) => text.trimEnd().split("\n").slice(-lines).join("\n");

export const indent = (text) =>
  text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

/** `node:util` parseArgs, with a usage error instead of a throw. */
export const args = (step, options, allowPositionals = false) => {
  try {
    return parseArgs({ options, allowPositionals, strict: true });
  } catch (e) {
    return usage(step, e.message);
  }
};

export const int = (step, name, value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) usage(step, `--${name} takes a whole number, got ${value}`);
  return n;
};

/** The JSON document a `--json` command printed on stdout, or `undefined`. */
export const json = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
};
