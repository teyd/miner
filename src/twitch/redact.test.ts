import { assert, describe, it } from "@effect/vitest";
import leaks from "./fixtures/leaks.json" with { type: "json" };
import { isSealed, redact } from "./redact.ts";

/** Leak shapes from real miner logs (just-mining `tests/fixtures/triage`), with fake secrets. */
describe("redact", () => {
  it("removes signed playlist parameters, in query strings and in Twitch's ~-separated tokens", () => {
    const url =
      "https://usher.ttvnw.net/api/channel/hls/forsen.m3u8?allow_source=true&sig=SIGSECRET&token=%7B%22user_id%22%7D";
    assert.strictEqual(
      redact(url),
      "https://usher.ttvnw.net/api/channel/hls/forsen.m3u8?allow_source=true&sig=REDACTED&token=REDACTED",
    );
    const edge =
      "https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/Cq0.m3u8?hdnts=exp%3D1~hmac%3DHMACSECRET";
    assert.notInclude(redact(edge) as string, "HMACSECRET");
  });

  it("removes OAuth tokens inside strings and the access token of a login redirect", () => {
    assert.strictEqual(
      redact("sent Authorization: OAuth OAUTHSECRET2"),
      "sent Authorization: OAuth REDACTED",
    );
    assert.notInclude(
      redact("https://www.twitch.tv/#access_token=FRAGMENTSECRET&scope=") as string,
      "FRAGMENTSECRET",
    );
  });

  it("removes values under secret keys at any depth, and the signed playback token", () => {
    const entry = {
      headers: { Authorization: "OAuth OAUTHSECRET" },
      nested: [{ token: "FIELDTOKEN", login: "forsen" }],
      data: { streamPlaybackAccessToken: { value: '{"user_id":1}', signature: "abc123" } },
    };
    const text = JSON.stringify(redact(entry));
    for (const secret of ["OAUTHSECRET", "FIELDTOKEN", "abc123", "user_id"])
      assert.notInclude(text, secret);
    assert.include(text, "forsen");
  });

  it("keeps ordinary data intact", () => {
    const answer = { data: { currentUser: { inventory: { value: 5, minutes: 30 } } } };
    assert.deepStrictEqual(redact(answer), answer);
  });

  it("catches secrets without a URL around them, encoded, inside JSON strings, or camel-cased", () => {
    const leaks = [
      "error: sig=SECRET1 rejected",
      "next=%2Fhls%3Fsig%3DSECRET2%26x%3D1",
      '{"sig":"SECRET3","login":"forsen"}',
      String.raw`{\"token\":\"SECRET4\"}`,
      "Bearer SECRET5.part.two",
    ];
    for (const leak of leaks) assert.notMatch(redact(leak) as string, /SECRET\d/, leak);
    assert.notInclude(JSON.stringify(redact({ accessToken: "SECRET6" })), "SECRET6");
    assert.include(redact('{"sig":"SECRET3","login":"forsen"}') as string, "forsen");
  });

  it("doesn't touch words that merely contain a secret's name", () => {
    assert.strictEqual(redact("design=compact oauth=none"), "design=compact oauth=none");
  });
});

describe("the leak corpus", () => {
  for (const { shape, input } of leaks.cases) {
    it(`redacts ${shape}`, () => {
      const raw = JSON.stringify(input);
      assert.include(raw, "SECRET", "a corpus case must hold a secret");
      assert.notInclude(JSON.stringify(redact(input)), "SECRET");
      // The pre-write gate rejects the raw shape and passes the redacted one.
      assert.isFalse(isSealed(raw, []));
      assert.isTrue(isSealed(JSON.stringify(redact(input)), []));
    });
  }

  it("seals nothing that holds a known secret, however it is spelled around", () => {
    assert.isFalse(isSealed('{"note":"tokenvalue1234 leaked"}', ["tokenvalue1234"]));
    assert.isTrue(isSealed('{"note":"nothing here"}', ["tokenvalue1234"]));
  });
});
