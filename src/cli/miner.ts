import { Command } from "effect/cli";

export const miner = Command.make("miner").pipe(
  Command.withDescription("A headless Twitch drops miner for homelabs."),
);
