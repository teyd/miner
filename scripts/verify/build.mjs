#!/usr/bin/env node
// Usage: node scripts/verify/build.mjs
// Bundles the miner (`pnpm build`) and checks the bundle starts. `MINER_VERIFY_BUILD` replaces
// the build command (tests use it to break the build on purpose).
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fail, miner, minerBin, pass, root, shell } from "./lib.mjs";

const step = "build";
const command = process.env.MINER_VERIFY_BUILD ?? "pnpm build";
const built = shell(command);
if (built.status !== 0) {
  fail(step, `\`${command}\` exited ${built.status ?? built.signal}`, built.stdout + built.stderr);
}
const bin = minerBin();
if (!existsSync(bin)) fail(step, `${relative(root, bin)} is missing after \`${command}\``);
const version = miner(["--version"]);
if (version.status !== 0 || !/^miner v\S+/m.test(version.stdout)) {
  fail(
    step,
    `${relative(root, bin)} does not start (miner --version exited ${version.status ?? version.signal})`,
    version.stdout + version.stderr,
  );
}
pass(step, `${relative(root, bin)} built and starts (${version.stdout.trim()})`);
