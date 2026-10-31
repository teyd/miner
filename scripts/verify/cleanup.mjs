#!/usr/bin/env node
// Usage: node scripts/verify/cleanup.mjs [--dry-run] [--kill] [--worktrees] [--all]
// Removes what the verify scripts left behind, and reports what it won't touch:
//   - scratch directories $TMPDIR/miner-verify-* that this checkout made (their `.owner` names
//     it; --all takes every checkout's): the only directories it deletes;
//   - miner processes (`run`, `sim`) whose DATA_DIR is such a directory: listed, and stopped
//     with SIGTERM only under --kill. Any other miner (the supervisor's live one) is listed as
//     not ours and never signalled;
//   - git worktrees: listed, with the stale entries `git worktree prune` would drop; --worktrees
//     prunes them. Removing a task's worktree after its merge stays with whoever made it.
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OWNER_FILE, SCRATCH_PREFIX, args, pass, root, shell } from "./lib.mjs";

const step = "cleanup";
const { values } = args(step, {
  "dry-run": { type: "boolean", default: false },
  kill: { type: "boolean", default: false },
  worktrees: { type: "boolean", default: false },
  all: { type: "boolean", default: false },
});
const dry = values["dry-run"];
const base = resolve(process.env.MINER_VERIFY_TMPDIR ?? tmpdir());
const scratches = readdirSync(base, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith(SCRATCH_PREFIX))
  .map((e) => join(base, e.name));
const ownerOf = (dir) => {
  const file = join(dir, OWNER_FILE);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
};
const mine = scratches.filter((dir) => values.all || ownerOf(dir) === root);
const inScratch = (dir) => mine.some((s) => dir === s || dir.startsWith(`${s}/`));

// Linux only: /proc names each process's command line, working directory and DATA_DIR.
const processes = [];
let procs = [];
try {
  procs = readdirSync("/proc").filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
} catch {
  console.log("note: no /proc here, so miner processes are not looked for");
}
for (const pid of procs) {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    const bin = argv.findIndex((a) => /(?:^|\/)(?:dist\/bin\.mjs|src\/bin\.ts|miner)$/.test(a));
    if (bin < 0 || !["run", "sim"].includes(argv[bin + 1])) continue;
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    // Only DATA_DIR is taken from the environment; the rest of it (TOKEN) is never looked at.
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const set = env.find((v) => v.startsWith("DATA_DIR="))?.slice("DATA_DIR=".length);
    const shadowAt =
      argv.indexOf("--shadow", bin) >= 0 && argv[bin + 1] === "sim"
        ? argv[argv.indexOf("--shadow", bin) + 1]
        : undefined;
    const dataDir = resolve(cwd, shadowAt ?? set ?? "./data");
    processes.push({ pid: Number(pid), command: argv.slice(bin).join(" "), dataDir });
  } catch {
    // Gone, or not ours to read.
  }
}

let stopped = 0;
for (const p of processes) {
  const ours = inScratch(p.dataDir);
  if (ours && values.kill && !dry) {
    process.kill(p.pid, "SIGTERM");
    stopped++;
    console.log(`stopped pid ${p.pid}: miner ${p.command} (DATA_DIR ${p.dataDir})`);
  } else {
    const why = ours
      ? "a verify run of this checkout; --kill stops it"
      : "not a verify run of this checkout, never touched";
    console.log(`left pid ${p.pid}: miner ${p.command} (DATA_DIR ${p.dataDir}): ${why}`);
  }
}

const busy = new Set(
  processes.filter((p) => inScratch(p.dataDir) && !(values.kill && !dry)).map((p) => p.dataDir),
);
let removed = 0;
for (const dir of scratches) {
  const owner = ownerOf(dir);
  if (!values.all && owner !== root) {
    console.log(`left ${dir}: made by ${owner ?? "an unknown checkout"}; --all removes it`);
    continue;
  }
  if ([...busy].some((d) => d === dir || d.startsWith(`${dir}/`))) {
    console.log(`left ${dir}: a miner still runs on it`);
    continue;
  }
  if (!dry) rmSync(dir, { recursive: true, force: true });
  removed++;
  console.log(`${dry ? "would remove" : "removed"} ${dir}`);
}

const prune = shell(`git worktree prune ${dry || !values.worktrees ? "--dry-run " : ""}--verbose`);
for (const line of (prune.stdout + prune.stderr).split("\n").filter(Boolean)) console.log(line);
const list = shell("git worktree list");
const worktrees = list.stdout.split("\n").filter(Boolean);
if (worktrees.length > 1) {
  console.log(
    `${worktrees.length} worktrees (remove a merged task's with \`git worktree remove <path>\`):`,
  );
  for (const w of worktrees) console.log(`  ${w}`);
}

pass(
  step,
  `${dry ? "would remove" : "removed"} ${removed} scratch director${removed === 1 ? "y" : "ies"} in ${base}` +
    `, stopped ${stopped} of ${processes.length} miner process(es)`,
);
