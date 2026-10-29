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
    include: ["src/**/*.test.ts"],
  },
  pack: {
    entry: ["src/bin.ts"],
    format: ["esm"],
    platform: "node",
    dts: false,
    clean: true,
    // One self-contained file: research 03 measured 104 MB RSS unbundled vs 66 MB bundled.
    deps: {
      alwaysBundle: [/./],
      onlyBundle: false,
    },
  },
});
