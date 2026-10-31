#!/usr/bin/env node
// Usage: node scripts/verify/shadow.mjs [--seed N | --trace capsule.json] [--minutes M]
//          [--config config.json] [--dir DATA_DIR] [--out DIR]
// `miner run --shadow` over the twin of a seed (`miner sim --shadow`): the real run loop,
// recorder and status writer, with the twin as Twitch, under virtual time. It writes
// state.shadow.json, status.json, recordings/ and logs/ to DATA_DIR (new or empty; a scratch
// directory by default). Then check them with status.mjs --expect stopped and recordings.mjs.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { args, fail, int, json, miner, pass, scratch } from "./lib.mjs";

const step = "shadow";
const { values } = args(step, {
  seed: { type: "string", default: "3" },
  trace: { type: "string" },
  minutes: { type: "string", default: "60" },
  config: { type: "string" },
  dir: { type: "string" },
  out: { type: "string" },
});
const seed = int(step, "seed", values.seed);
const minutes = int(step, "minutes", values.minutes);
const dir = values.dir ?? join(scratch("shadow"), "data");
mkdirSync(dir, { recursive: true });
if (values.config !== undefined) copyFileSync(values.config, join(dir, "config.json"));

const world = values.trace === undefined ? ["--seed", String(seed)] : ["--trace", values.trace];
const result = miner(["sim", "--json", ...world, "--minutes", String(minutes), "--shadow", dir]);
const document = json(result.stdout);
if (result.status !== 0 || document === undefined || !document.ok) {
  fail(
    step,
    `miner sim --shadow ${dir} exited ${result.status ?? result.signal}` +
      (document?.stopped ? `: the run stopped by itself (${document.stopped})` : ""),
    result.stdout + result.stderr,
  );
}
if (values.out !== undefined) {
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "shadow.json"), `${JSON.stringify(document, null, 2)}\n`);
}
pass(
  step,
  `${document.world}, ${minutes} virtual minutes, ${document.requests} requests to the twin. ` +
    `DATA_DIR: ${document.dataDir} (${document.files.join(", ")})`,
);
