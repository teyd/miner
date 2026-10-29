import { Command } from "effect/cli";
import { doctor } from "./doctor.ts";

export const miner = Command.make("miner").pipe(
  Command.withDescription("A headless Twitch drops miner for homelabs."),
  Command.withSubcommands([doctor]),
);
