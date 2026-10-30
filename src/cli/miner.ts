import { Command } from "effect/cli";
import { config } from "./config.ts";
import { doctor } from "./doctor.ts";
import { run } from "./run.ts";
import { sim } from "./sim.ts";

export const miner = Command.make("miner").pipe(
  Command.withDescription("A headless Twitch drops and channel-points miner for homelabs."),
  Command.withSubcommands([config, doctor, run, sim]),
);
