#!/usr/bin/env node
// Usage: node scripts/verify/status.mjs DATA_DIR [--expect running|stopped] [--mode live|shadow]
// Reads DATA_DIR/status.json through `miner status --json` (never Twitch).
//   running (default): the miner there must be healthy or starting (exit 0). A stale heartbeat,
//     a stopped run, a parked token (2) or broken discovery (3) fail, with the miner's verdict.
//   stopped: a finished run, such as shadow.mjs's: the file must read, name a clean stop
//     (stoppedAt), a valid token and a catalog that was read. A run that died without a stop
//     (stale, no stoppedAt) fails.
import { args, fail, json, miner, pass, usage } from "./lib.mjs";

const step = "status";
const { values, positionals } = args(
  step,
  {
    expect: { type: "string", default: "running" },
    mode: { type: "string" },
  },
  true,
);
const dir = positionals[0];
if (dir === undefined || positionals.length > 1)
  usage(step, "status.mjs DATA_DIR [--expect running|stopped]");
if (values.expect !== "running" && values.expect !== "stopped") {
  usage(step, `--expect is running or stopped, got ${values.expect}`);
}

const result = miner(["status", "--json"], { DATA_DIR: dir });
const report = json(result.stdout);
if (report === undefined || ![0, 1, 2, 3].includes(result.status)) {
  fail(
    step,
    `miner status --json crashed (exit ${result.status ?? result.signal})`,
    result.stdout + result.stderr,
  );
}
const { health, status } = report;
const verdict = `${health.state}: ${health.detail} (exit ${result.status})`;
if (status !== null && values.mode !== undefined && status.miner.mode !== values.mode) {
  fail(
    step,
    `${dir}/status.json was written by a ${status.miner.mode} run, expected ${values.mode}`,
  );
}
const describe = (s) => {
  const watch =
    s.watch.state === "idle"
      ? `idle (${s.watch.reason})`
      : `watching ${s.watch.channel.login ?? s.watch.channel.id} for ${s.watch.drop.name ?? s.watch.drop.id} (${s.watch.minutes} min)`;
  return (
    `${s.miner.mode} run, token ${s.auth}, catalog ${s.catalog.status} (${s.catalog.campaigns} campaigns), ` +
    `${watch}, ${s.claims.claimedThisRun.length} claimed, pubsub ${s.pubsub.listening}/${s.pubsub.connections} listening`
  );
};

if (values.expect === "running") {
  if (result.status !== 0) fail(step, verdict);
  pass(step, `${verdict}; ${describe(status)}`);
  process.exit(0);
}
if (status === null) fail(step, verdict);
if (status.stoppedAt === null) {
  fail(step, `${dir}/status.json names no clean stop: the run died or still runs (${verdict})`);
}
const at = (time) => Date.parse(time);
if (
  at(status.heartbeatAt) < at(status.miner.startedAt) ||
  at(status.stoppedAt) < at(status.miner.startedAt)
) {
  fail(step, `${dir}/status.json is inconsistent: heartbeat or stop before the start`);
}
if (status.auth !== "valid") fail(step, `the token was ${status.auth} when the run stopped`);
if (status.catalog.status !== "ok")
  fail(step, `the catalog was ${status.catalog.status} when the run stopped`);
pass(step, `stopped cleanly; ${describe(status)}. Evidence: ${dir}/status.json`);
