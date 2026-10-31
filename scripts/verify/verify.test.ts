// The scripts are plain Node CLIs (vite.config.ts), so their test drives them the same way: with
// processes and files, not Effect services.
/* oxlint-disable effecttsgo/node-builtin-import */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";
/* oxlint-enable effecttsgo/node-builtin-import */
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";

/**
 * The verify-miner scripts against the miner built from source (`MINER_BIN=src/bin.ts`, so no
 * bundle is needed): each must pass on good evidence and fail loudly, exit 1, on bad.
 */

const root = resolve(import.meta.dirname, "../..");
const base = mkdtempSync(join(tmpdir(), "verify-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const fresh = (name: string) => {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Runs a script; its scratch directories land in `base` (TMPDIR), never the real tmp. */
const script = (name: string, argv: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [join(root, "scripts/verify", name), ...argv], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MINER_BIN: "src/bin.ts", TMPDIR: base, ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr };
};

/** A stand-in for the miner that prints `stdout` and exits `code`. */
const fakeMiner = (name: string, stdout: string, code: number) => {
  const file = join(fresh("bins"), name);
  writeFileSync(file, `process.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${code});\n`);
  return file;
};

describe("build.mjs", () => {
  it("fails when the build command fails", () => {
    const r = script("build.mjs", [], { MINER_VERIFY_BUILD: "echo broken >&2; exit 3" });
    assert.strictEqual(r.status, 1);
    assert.include(r.out, "FAIL build: `echo broken >&2; exit 3` exited 3");
    assert.include(r.out, "broken");
  });

  it("fails when the bundle does not start", () => {
    const bin = join(fresh("bins"), "throws.mjs");
    writeFileSync(bin, 'throw new Error("bundle broken");\n');
    const r = script("build.mjs", [], { MINER_VERIFY_BUILD: "true", MINER_BIN: bin });
    assert.strictEqual(r.status, 1);
    assert.include(r.out, "does not start");
    assert.include(r.out, "bundle broken");
  });

  it("passes when the bundle starts", () => {
    const r = script("build.mjs", [], { MINER_VERIFY_BUILD: "true" });
    assert.strictEqual(r.status, 0, r.out);
    assert.include(r.out, "PASS build: src/bin.ts built and starts (miner v");
  });
});

describe("sim.mjs", () => {
  it("passes a real seed and keeps sim.json with its digests", () => {
    const out = fresh("sim-pass");
    const r = script("sim.mjs", ["--seed", "2", "--seeds", "1", "--out", out]);
    assert.strictEqual(r.status, 0, r.out);
    const document = JSON.parse(readFileSync(join(out, "sim.json"), "utf8"));
    assert.match(r.out, new RegExp(`sweep digest ${document.sweepDigest}`));
    assert.match(document.digests["2"], /^[0-9a-f]{16}$/);

    const other = script("sim.mjs", [
      "--seed",
      "2",
      "--seeds",
      "1",
      "--expect-digest",
      "0".repeat(16),
    ]);
    assert.strictEqual(other.status, 1);
    assert.include(other.out, `sweep digest ${document.sweepDigest}, expected ${"0".repeat(16)}`);
  });

  it("fails on a failed seed, saving its capsule with the commands to replay it", () => {
    const capsule = {
      seed: 7,
      scenario: {},
      violation: { kind: "DoubleClaim", at: 42, detail: "claimed twice" },
      digest: "ab".repeat(8),
      tail: [],
    };
    const document = {
      ok: false,
      seeds: { first: 7, count: 1 },
      passed: 0,
      watched: 0,
      claimed: 0,
      refused: {},
      sweepDigest: "cd".repeat(8),
      digests: { "7": capsule.digest },
      failures: [capsule],
    };
    const bin = fakeMiner("failing.mjs", JSON.stringify(document), 1);
    const out = fresh("sim-fail");
    const r = script("sim.mjs", ["--seed", "7", "--seeds", "1", "--out", out], { MINER_BIN: bin });
    assert.strictEqual(r.status, 1);
    assert.include(r.out, "FAIL sim: 1 of 1 seeds failed");
    assert.include(r.out, "seed 7: DoubleClaim at +42m: claimed twice");
    const file = join(out, "capsule-seed-7.json");
    assert.deepStrictEqual(JSON.parse(readFileSync(file, "utf8")), capsule);
    assert.include(r.out, `sim --trace ${file}`);
    assert.include(r.out, "sim --seed 7 --seeds 1");
  });

  it("fails when the miner crashes instead of answering", () => {
    const bin = fakeMiner("crash.mjs", "TypeError: boom", 1);
    const r = script("sim.mjs", ["--seeds", "1", "--out", fresh("sim-crash")], { MINER_BIN: bin });
    assert.strictEqual(r.status, 1);
    assert.include(r.out, "crashed (exit 1)");
    assert.include(r.out, "TypeError: boom");
  });
});

describe("status.mjs and recordings.mjs on a shadow run over the twin", () => {
  let data = "";
  const copy = (name: string) => {
    const dir = fresh(name);
    for (const entry of readdirSync(data, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const from = join(entry.parentPath, entry.name);
      const to = join(dir, from.slice(data.length + 1));
      mkdirSync(resolve(to, ".."), { recursive: true });
      writeFileSync(to, readFileSync(from));
    }
    return dir;
  };
  const editStatus = (dir: string, edit: (s: Record<string, unknown>) => unknown) => {
    const file = join(dir, "status.json");
    writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, "utf8")))));
  };
  const recordingOf = (dir: string) => {
    const r = join(dir, "recordings");
    return join(r, readdirSync(r)[0]!);
  };

  beforeAll(() => {
    data = join(fresh("shadow"), "data");
    // Seed 9 (pnpm verify's) writes `$same` references within 20 virtual minutes; seed 3 none.
    const r = script("shadow.mjs", ["--seed", "9", "--minutes", "20", "--dir", data]);
    assert.strictEqual(r.status, 0, r.out);
    assert.include(r.out, `PASS shadow: seed 9, 20 virtual minutes`);
  }, 60_000);

  it("refuses to write a shadow run over an existing data directory", () => {
    const r = script("shadow.mjs", ["--dir", data]);
    assert.strictEqual(r.status, 1);
    assert.include(r.out, "not a fresh scratch directory");
  });

  it("passes a cleanly stopped run, and fails it where a running miner is expected", () => {
    const stopped = script("status.mjs", [data, "--expect", "stopped", "--mode", "shadow"]);
    assert.strictEqual(stopped.status, 0, stopped.out);
    assert.include(stopped.out, "PASS status: stopped cleanly; shadow run, token valid");
    const running = script("status.mjs", [data]);
    assert.strictEqual(running.status, 1);
    assert.include(running.out, "FAIL status: not-running: stopped");
    const mode = script("status.mjs", [data, "--expect", "stopped", "--mode", "live"]);
    assert.strictEqual(mode.status, 1);
    assert.include(mode.out, "written by a shadow run, expected live");
  });

  it("fails a stale status file, and passes one with a fresh heartbeat", () => {
    const stale = copy("stale");
    editStatus(stale, (s) => ({ ...s, stoppedAt: null }));
    const running = script("status.mjs", [stale]);
    assert.strictEqual(running.status, 1);
    assert.match(running.out, /FAIL status: not-running: no heartbeat for \d+ s/);
    const stopped = script("status.mjs", [stale, "--expect", "stopped"]);
    assert.strictEqual(stopped.status, 1);
    assert.include(stopped.out, "names no clean stop");

    const live = copy("fresh");
    // `miner status` judges the heartbeat against the wall clock, so the file must name it.
    // oxlint-disable-next-line effecttsgo/global-date
    const now = Date.now();
    // oxlint-disable-next-line effecttsgo/global-date
    const iso = (ms: number) => new Date(ms).toISOString();
    editStatus(live, (s) => ({
      ...s,
      stoppedAt: null,
      heartbeatAt: iso(now),
      miner: { ...(s["miner"] as object), startedAt: iso(now - 60_000) },
    }));
    const healthy = script("status.mjs", [live]);
    assert.strictEqual(healthy.status, 0, healthy.out);
    assert.include(healthy.out, "PASS status: healthy: running (exit 0)");
  });

  it("fails a missing or unreadable status file", () => {
    const missing = script("status.mjs", [fresh("empty"), "--expect", "stopped"]);
    assert.strictEqual(missing.status, 1);
    assert.include(missing.out, "no status file");
    const garbage = copy("garbage");
    writeFileSync(join(garbage, "status.json"), "{not json");
    const r = script("status.mjs", [garbage, "--expect", "stopped"]);
    assert.strictEqual(r.status, 1);
    assert.include(r.out, "status file unreadable");
  });

  it("reads every recording whole, counts its references and finds no token", () => {
    const r = script("recordings.mjs", [data, "--secret", "twin-token", "--min-refs", "1"]);
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /PASS recordings: 1 recording\(s\) read whole \(\d+ answer/);
    assert.match(r.out, /; [1-9]\d* reference\(s\) resolved; /);
    const more = script("recordings.mjs", [data, "--min-refs", "1000"]);
    assert.strictEqual(more.status, 1);
    assert.match(more.out, /FAIL recordings: \d+ reference\(s\) resolved, --min-refs 1000/);
  });

  it("fails --min-refs on a recording that holds no reference", () => {
    const dir = copy("no-refs");
    const file = recordingOf(dir);
    const lines = gunzipSync(readFileSync(file)).toString("utf8").split("\n").filter(Boolean);
    const plain = lines.filter((l) => !l.includes('"refs":'));
    assert.isBelow(plain.length, lines.length);
    writeFileSync(file, Buffer.concat(plain.map((l) => gzipSync(`${l}\n`))));
    const quiet = script("recordings.mjs", [dir]);
    assert.strictEqual(quiet.status, 0, quiet.out);
    assert.include(quiet.out, "; no references exercised.");
    const r = script("recordings.mjs", [dir, "--min-refs", "1"]);
    assert.strictEqual(r.status, 1);
    assert.include(r.out, "FAIL recordings: no references exercised, --min-refs 1");
  });

  /** The file a crash leaves: a first line (holding `note`), the run's recording, cut mid-member. */
  const tear = (name: string, note: string) => {
    const dir = copy(name);
    const file = recordingOf(dir);
    const first = {
      kind: "answer",
      at: 0,
      operation: "Torn",
      body: { note: `${note} `.repeat(40) },
    };
    const whole = Buffer.concat([gzipSync(`${JSON.stringify(first)}\n`), readFileSync(file)]);
    writeFileSync(file, whole.subarray(0, whole.length - 7));
    return dir;
  };

  it("fails a recording torn by a crash that holds the secret", () => {
    const r = script("recordings.mjs", [
      tear("torn-leak", "OAuth twin-token"),
      "--secret",
      "twin-token",
    ]);
    assert.strictEqual(r.status, 1, r.out);
    assert.include(r.out, "contains a --secret value");
  });

  it("passes a recording torn by a crash that holds no secret", () => {
    const r = script("recordings.mjs", [tear("torn-clean", "nothing"), "--secret", "twin-token"]);
    assert.strictEqual(r.status, 0, r.out);
    assert.include(r.out, "files hold no secret");
  });

  it("fails a gzip file it can't inflate, as it can't be shown clean", () => {
    const dir = copy("corrupt");
    const member = gzipSync("x".repeat(64));
    // A valid header, then deflate data that is not deflate: no plaintext to scan.
    writeFileSync(
      join(dir, "logs", "old.log.gz"),
      Buffer.concat([member.subarray(0, 10), Buffer.alloc(32, 0xff)]),
    );
    const r = script("recordings.mjs", [dir, "--secret", "twin-token"]);
    assert.strictEqual(r.status, 1, r.out);
    assert.include(
      r.out,
      "old.log.gz can't be inflated, so it can't be shown to hold no --secret value",
    );
  });

  it("reads relative paths", () => {
    const r = spawnSync(process.execPath, [join(root, "scripts/verify/recordings.mjs"), "."], {
      cwd: data,
      encoding: "utf8",
      env: { ...process.env, MINER_BIN: "src/bin.ts" },
    });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  });

  it("fails a recording with a reference to a part no earlier line holds", () => {
    const dir = copy("dangling");
    const file = recordingOf(dir);
    const lines = gunzipSync(readFileSync(file)).toString("utf8").split("\n").filter(Boolean);
    // The recorder's shape for a part written earlier in the file (`compact` in journal.ts),
    // here pointing at a part no line holds, as a file cut at its start would.
    const answer = JSON.parse(lines.find((l) => l.includes('"kind":"answer"'))!);
    const dangling = { ...answer, body: { $same: "f".repeat(16) }, refs: 1 };
    writeFileSync(file, gzipSync(`${[...lines, JSON.stringify(dangling)].join("\n")}\n`));
    const r = script("recordings.mjs", [dir]);
    assert.strictEqual(r.status, 1);
    assert.include(r.out, `FAIL recordings: miner journal cat ${file} exited 1`);
    assert.include(r.out, "references to parts no earlier line holds");
  });

  it("fails when a file holds the secret, without printing it", () => {
    const dir = copy("leak");
    const secret = "SECRETabcdef123456";
    writeFileSync(join(dir, "logs", "miner.log"), `{"msg":"Authorization: OAuth ${secret}"}\n`);
    const r = script("recordings.mjs", [dir, "--secret", secret]);
    assert.strictEqual(r.status, 1);
    assert.include(r.out, "miner.log contains a --secret value");
    assert.notInclude(r.out, secret);
  });

  it("fails a data directory without recordings", () => {
    const r = script("recordings.mjs", [fresh("no-recordings")]);
    assert.strictEqual(r.status, 1);
    assert.include(r.out, "FAIL recordings: no recordings");
  });
});

describe("all.mjs", () => {
  it("passes every step and names the evidence", () => {
    const r = script("all.mjs", ["--seeds", "1", "--minutes", "20"], {
      MINER_VERIFY_CHECK: "true",
      MINER_VERIFY_BUILD: "true",
    });
    assert.strictEqual(r.status, 0, r.out);
    for (const step of ["check", "build", "sim", "shadow", "status", "recordings"]) {
      assert.match(r.out, new RegExp(`^PASS  ${step} `, "m"));
    }
    const evidence = /^evidence: (\S+)/m.exec(r.out)?.[1];
    assert.isDefined(evidence);
    assert.isTrue(existsSync(join(evidence!, "sim.json")));
    assert.isTrue(existsSync(join(evidence!, "data", "status.json")));
    assert.match(r.out, /^PASS {2}recordings .*[1-9]\d* reference\(s\) resolved/m);
    assert.include(r.out, "PASS: every step passed");
  }, 60_000);

  it("fails the recordings step when the shadow run exercises no reference", () => {
    const r = script("all.mjs", ["--seeds", "1", "--shadow-seed", "3", "--minutes", "20"], {
      MINER_VERIFY_CHECK: "true",
      MINER_VERIFY_BUILD: "true",
    });
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /^FAIL {2}recordings .*no references exercised, --min-refs 1/m);
  }, 60_000);

  it("leaves no scratch directory behind on a usage error", () => {
    const runs = () => readdirSync(base).filter((n) => n.startsWith("miner-verify-run-")).length;
    const before = runs();
    const r = script("all.mjs", ["--seeds", "many"]);
    assert.strictEqual(r.status, 2);
    assert.include(r.out, "--seeds takes a whole number, got many");
    assert.strictEqual(runs(), before);
  });

  it("fails the run and skips what needs a broken build", () => {
    const r = script("all.mjs", ["--seeds", "1"], {
      MINER_VERIFY_CHECK: "true",
      MINER_VERIFY_BUILD: "exit 7",
      // Outside a git checkout, the summary says so instead of naming an empty commit.
      GIT_DIR: join(base, "not-a-repository"),
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.out, /^FAIL {2}build /m);
    assert.match(r.out, /^FAIL {2}sim .*not run: build did not pass/m);
    assert.match(r.out, /^FAIL {2}status .*not run: shadow did not pass/m);
    assert.include(r.out, "FAIL: 5 step(s) failed");
    assert.include(r.out, "verify-miner outside a git checkout");
  });
});

describe("cleanup.mjs", () => {
  it("removes the verify scratch directories and nothing else", () => {
    const tmp = fresh("cleanup");
    mkdirSync(join(tmp, "miner-verify-run-abc", "data"), { recursive: true });
    writeFileSync(join(tmp, "miner-verify-run-abc", ".owner"), `${root}\n`);
    mkdirSync(join(tmp, "miner-verify-run-other"));
    writeFileSync(join(tmp, "miner-verify-run-other", ".owner"), "/another/worktree\n");
    mkdirSync(join(tmp, "someone-elses"));
    const env = { MINER_VERIFY_TMPDIR: tmp };
    const dry = script("cleanup.mjs", ["--dry-run"], env);
    assert.strictEqual(dry.status, 0, dry.out);
    assert.include(dry.out, `would remove ${join(tmp, "miner-verify-run-abc")}`);
    assert.isTrue(existsSync(join(tmp, "miner-verify-run-abc")));
    const r = script("cleanup.mjs", [], env);
    assert.strictEqual(r.status, 0, r.out);
    assert.include(r.out, "PASS cleanup: removed 1 scratch directory");
    assert.include(r.out, "made by /another/worktree; --all removes it");
    assert.deepStrictEqual(readdirSync(tmp).toSorted(), [
      "miner-verify-run-other",
      "someone-elses",
    ]);
    const all = script("cleanup.mjs", ["--all"], env);
    assert.strictEqual(all.status, 0, all.out);
    assert.deepStrictEqual(readdirSync(tmp), ["someone-elses"]);
  });

  /**
   * A stand-in miner (`…/dist/bin.mjs run` with DATA_DIR in `dir`) that takes `stopMs` to stop
   * on SIGTERM and then writes `stopped` beside its binary, as a clean stop writes its files.
   */
  const fakeRun = async (dir: string, stopMs: number) => {
    const home = fresh(`fake-miner-${stopMs}-${dir.length}`);
    const bin = join(home, "dist", "bin.mjs");
    mkdirSync(join(home, "dist"));
    writeFileSync(
      bin,
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => setTimeout(() => {
  writeFileSync(${JSON.stringify(join(home, "stopped"))}, "");
  process.exit(130);
}, ${stopMs}));
writeFileSync(${JSON.stringify(join(home, "ready"))}, "");
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, [bin, "run"], {
      env: { ...process.env, DATA_DIR: join(dir, "data") },
      stdio: "ignore",
    });
    while (!existsSync(join(home, "ready"))) await delay(20);
    return { child, bin, stopped: () => existsSync(join(home, "stopped")) };
  };

  it("stops this checkout's miner with --kill and waits for it before removing its directory", async () => {
    const tmp = fresh("cleanup-kill");
    const dir = join(tmp, "miner-verify-run-kill");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, ".owner"), `${root}\n`);
    const miner = await fakeRun(dir, 400);
    try {
      const r = script("cleanup.mjs", ["--kill"], { MINER_VERIFY_TMPDIR: tmp });
      assert.strictEqual(r.status, 0, r.out);
      assert.include(r.out, `stopped pid ${miner.child.pid}: miner ${miner.bin} run`);
      // It returned only after the miner's clean stop, and then removed the directory.
      assert.isTrue(miner.stopped());
      assert.isFalse(existsSync(dir));
    } finally {
      miner.child.kill("SIGKILL");
    }
  });

  it("fails, and keeps the directory, when the miner does not stop in time", async () => {
    const tmp = fresh("cleanup-slow");
    const dir = join(tmp, "miner-verify-run-slow");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, ".owner"), `${root}\n`);
    const miner = await fakeRun(dir, 5_000);
    try {
      const r = script("cleanup.mjs", ["--kill"], {
        MINER_VERIFY_TMPDIR: tmp,
        MINER_VERIFY_KILL_WAIT_MS: "300",
      });
      assert.strictEqual(r.status, 1, r.out);
      assert.include(r.out, `pid ${miner.child.pid}: still running 300 ms after SIGTERM`);
      assert.include(r.out, `left ${dir}: a miner still runs on it`);
      assert.isTrue(existsSync(dir));
    } finally {
      miner.child.kill("SIGKILL");
    }
  });

  it("never signals a miner on another checkout's directory, even with --all --kill", async () => {
    const tmp = fresh("cleanup-other");
    const dir = join(tmp, "miner-verify-run-other");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, ".owner"), "/another/worktree\n");
    const miner = await fakeRun(dir, 0);
    try {
      const r = script("cleanup.mjs", ["--all", "--kill"], { MINER_VERIFY_TMPDIR: tmp });
      assert.strictEqual(r.status, 0, r.out);
      assert.include(r.out, `left pid ${miner.child.pid}: miner ${miner.bin} run`);
      assert.include(r.out, "a verify run of another checkout, never signalled");
      assert.include(r.out, `left ${dir}: a miner still runs on it`);
      assert.isTrue(existsSync(dir));
      assert.isNull(miner.child.exitCode);
      assert.isFalse(miner.stopped());
    } finally {
      miner.child.kill("SIGKILL");
    }
  });

  it("fails when --worktrees can't prune", () => {
    const env = { MINER_VERIFY_TMPDIR: fresh("cleanup-prune"), GIT_DIR: join(base, "nowhere") };
    const r = script("cleanup.mjs", ["--worktrees"], env);
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /FAIL cleanup: .*git worktree prune exited \d+/);
    const listing = script("cleanup.mjs", [], env);
    assert.strictEqual(listing.status, 0, listing.out);
    assert.include(listing.out, "so stale worktrees are not listed");
  });

  it("marks the scratch directories a script makes with the checkout that made it", () => {
    const r = script("sim.mjs", ["--seed", "2", "--seeds", "1"]);
    assert.strictEqual(r.status, 0, r.out);
    const evidence = /Evidence: (\S+)\/sim\.json/.exec(r.out)?.[1];
    assert.isDefined(evidence);
    assert.strictEqual(readFileSync(join(evidence!, ".owner"), "utf8"), `${root}\n`);
  });
});
