#!/usr/bin/env node
// Usage: node scripts/verify/cleanup.mjs [--dry-run] [--kill] [--worktrees] [--all]
// Removes what the verify scripts left behind, and reports what it won't touch:
//   - scratch directories $TMPDIR/miner-verify-* that this checkout made (their `.owner` names
//     it; --all takes every checkout's): the only directories it deletes;
//   - miner processes (`run`, `sim`) whose DATA_DIR is such a directory: listed, and under
//     --kill sent SIGTERM and waited for (up to MINER_VERIFY_KILL_WAIT_MS, 15 s) before their
//     directory goes. Only miners on this checkout's directories are signalled, --all or not: a
//     miner on another checkout's directory, or any other miner (the supervisor's live one), is
//     listed and never signalled, and its directory stays. A pid is signalled only if it is still
//     the same process (start time, command line) and runs as this user;
//   - git worktrees: listed, with the stale entries `git worktree prune` would drop; --worktrees
//     prunes them, and the step fails if that fails. Removing a task's worktree after its merge
//     stays with whoever made it.
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OWNER_FILE, SCRATCH_PREFIX, args, fail, pass, root, shell } from "./lib.mjs";

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
const removable = scratches.filter((dir) => values.all || ownerOf(dir) === root);
const ours = scratches.filter((dir) => ownerOf(dir) === root);
const within = (dirs, dir) => dirs.some((s) => dir === s || dir.startsWith(`${s}/`));

/** State and start time (clock ticks since boot) of a process, from /proc/PID/stat. */
const procStat = (pid) => {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], start: fields[19] };
  } catch {
    return undefined;
  }
};
const cmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return undefined;
  }
};
/** Gone, or a zombie: it has exited and only waits for its parent to reap it. */
const exited = (p) => {
  const now = procStat(p.pid);
  return now === undefined || now.start !== p.start || now.state === "Z" || now.state === "X";
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitMs = Number(process.env.MINER_VERIFY_KILL_WAIT_MS ?? 15_000);

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
    const line = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const argv = line.split("\0");
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
    processes.push({
      pid: Number(pid),
      command: argv.slice(bin).join(" "),
      dataDir,
      line,
      start: procStat(pid)?.start,
      uid: statSync(`/proc/${pid}`).uid,
    });
  } catch {
    // Gone, or not ours to read.
  }
}

/** SIGTERM, then wait for the miner's clean stop. Never throws: a failure is reported. */
const stop = (p) => {
  if (p.start === undefined || procStat(p.pid)?.start !== p.start || cmdline(p.pid) !== p.line) {
    return "it is no longer the process that was listed (its pid may be reused); not signalled";
  }
  if (typeof process.getuid === "function" && p.uid !== process.getuid()) {
    return `it runs as uid ${p.uid}, not this user; not signalled`;
  }
  try {
    process.kill(p.pid, "SIGTERM");
  } catch (e) {
    return e.code === "ESRCH" ? undefined : `SIGTERM failed (${e.code ?? e.message})`;
  }
  for (const until = performance.now() + waitMs; performance.now() < until; sleep(50)) {
    if (exited(p)) return undefined;
  }
  return exited(p) ? undefined : `still running ${waitMs} ms after SIGTERM`;
};

let stopped = 0;
const busy = new Set();
const problems = [];
for (const p of processes) {
  const killable = within(ours, p.dataDir);
  if (killable && values.kill && !dry) {
    const problem = stop(p);
    if (problem === undefined) {
      stopped++;
      console.log(`stopped pid ${p.pid}: miner ${p.command} (DATA_DIR ${p.dataDir})`);
      continue;
    }
    problems.push(`pid ${p.pid}: ${problem}`);
    console.log(`left pid ${p.pid}: miner ${p.command} (DATA_DIR ${p.dataDir}): ${problem}`);
  } else {
    const why = killable
      ? values.kill
        ? "a verify run of this checkout; --dry-run, so not signalled"
        : "a verify run of this checkout; --kill stops it"
      : within(scratches, p.dataDir)
        ? "a verify run of another checkout, never signalled"
        : "not a verify run of this checkout, never touched";
    console.log(`left pid ${p.pid}: miner ${p.command} (DATA_DIR ${p.dataDir}): ${why}`);
  }
  busy.add(p.dataDir);
}

let removed = 0;
for (const dir of scratches) {
  const owner = ownerOf(dir);
  if (!removable.includes(dir)) {
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
if (prune.status !== 0) {
  const what = `git worktree prune exited ${prune.status ?? prune.signal}`;
  // Only --worktrees asks for it; otherwise it is the listing, and its absence is a note.
  if (values.worktrees) problems.push(what);
  else console.log(`note: ${what}, so stale worktrees are not listed`);
}
const list = shell("git worktree list");
const worktrees = list.stdout.split("\n").filter(Boolean);
if (worktrees.length > 1) {
  console.log(
    `${worktrees.length} worktrees (remove a merged task's with \`git worktree remove <path>\`):`,
  );
  for (const w of worktrees) console.log(`  ${w}`);
}

const summary =
  `${dry ? "would remove" : "removed"} ${removed} scratch director${removed === 1 ? "y" : "ies"} in ${base}` +
  `, stopped ${stopped} of ${processes.length} miner process(es)`;
if (problems.length > 0) fail(step, `${summary}; ${problems.join("; ")}`);
pass(step, summary);
