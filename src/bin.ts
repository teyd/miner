#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command } from "effect/cli";
import pkg from "../package.json" with { type: "json" };
import { miner } from "./cli/miner.ts";

miner.pipe(
  Command.run({ version: pkg.version }),
  // The command already printed its problems; only the exit code is left to set.
  Effect.catchTags({
    DoctorFailed: () =>
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ConfigInvalid: () =>
      Effect.sync(() => {
        process.exitCode = 2;
      }),
    SimFailed: () =>
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    SimTraceInvalid: () =>
      Effect.sync(() => {
        process.exitCode = 2;
      }),
  }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
