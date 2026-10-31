import { strict } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

// Simulator seeds must replay exactly, so time, randomness, timers, network, env,
// console and Node built-ins are reachable only through Effect services. Only the
// IO shell (the entry point and src/platform/) may touch them directly.
const entropy = {
  "effecttsgo/global-date": "error",
  "effecttsgo/global-date-in-effect": "error",
  "effecttsgo/global-random": "error",
  "effecttsgo/global-random-in-effect": "error",
  "effecttsgo/global-timers": "error",
  "effecttsgo/global-timers-in-effect": "error",
  "effecttsgo/global-fetch": "error",
  "effecttsgo/global-fetch-in-effect": "error",
  "effecttsgo/process-env": "error",
  "effecttsgo/process-env-in-effect": "error",
  "effecttsgo/node-builtin-import": "error",
  "effecttsgo/global-console": "error",
  "effecttsgo/global-console-in-effect": "error",
} as const;

export default defineConfig({
  lint: {
    plugins: ["unicorn", "typescript", "oxc", "effecttsgo"],
    rules: {
      ...strict.rules,
      ...entropy,
      // effect/cli and other modules we use are marked unstable; that is accepted.
      "effecttsgo/unstable-api-usage": "off",
      "effecttsgo/experimental-api-usage": "off",
    },
    // Not app code, like scripts/hooks/*.sh: plain Node CLIs that spawn the built miner and read
    // files. They never run under the simulator, so the determinism rules do not apply to them,
    // and the override list below stays what AGENTS.md says it is. Their test is linted.
    ignorePatterns: ["scripts/verify/**/*.mjs"],
    overrides: [
      {
        files: ["src/bin.ts", "src/platform/**"],
        rules: Object.fromEntries(Object.keys(entropy).map((rule) => [rule, "off"])),
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Simulator-driven tests take seconds here and 2–3× that on CI's 4-core runner (#22, #25).
    testTimeout: 30_000,
  },
  pack: {
    entry: ["src/bin.ts"],
    format: ["esm"],
    platform: "node",
    dts: false,
    // V8 keeps the source of the whole bundle for the process's life, as two bytes a character
    // once one isn't ASCII (a comment's "—" was enough), and parses it at start: minified ASCII is
    // 0.8 MB instead of 4.4 (research 03 §2). Names stay, for stack traces.
    minify: { compress: true, mangle: { keepNames: true }, codegen: { removeWhitespace: true } },
    outputOptions: { charset: "ascii" },
    clean: true,
    // One self-contained file: research 03 measured 104 MB RSS unbundled vs 66 MB bundled.
    deps: {
      alwaysBundle: [/./],
      onlyBundle: false,
    },
  },
});
