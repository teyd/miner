import { assert, describe, it } from "@effect/vitest";
import { chid, game } from "./fixtures.ts";
import { Command, readKey, readOfKey } from "./protocol.ts";

describe("readOfKey", () => {
  it("gives back the channel read a key names", () => {
    for (const read of [
      Command.ReadDirectory({ gameId: game("rust").id }),
      Command.ReadChannels({ channelIds: [chid("12"), chid("345")] }),
      Command.ReadChannels({ channelIds: [chid("7")] }),
      Command.ReadChannels({ channelIds: [] }),
    ]) {
      assert.deepStrictEqual(readOfKey(readKey(read)), read);
    }
  });
});
