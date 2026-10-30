import { assert, describe, it } from "@effect/vitest";
import master from "./fixtures/usher-master.json" with { type: "json" };
import media from "./fixtures/media-playlist.json" with { type: "json" };
import { lowest, parseMaster, parseMedia } from "./playlist.ts";
const USHER = "https://usher.ttvnw.net/api/channel/hls/oilrats.m3u8";
const MEDIA = "https://euc12.playlist.ttvnw.net/v1/playlist/REDACTED-160p30.m3u8";

describe("parseMaster", () => {
  it("lists every variant of a recorded master playlist and picks the lowest", () => {
    const parsed = parseMaster(master.body, USHER);
    assert.isTrue(parsed.ok);
    if (!parsed.ok) return;
    assert.deepStrictEqual(
      parsed.value.map((v) => v.bandwidth),
      [3422999, 1427999, 630000, 230000],
    );
    assert.strictEqual(lowest(parsed.value)?.url, MEDIA);
  });

  it("resolves relative URIs against the playlist", () => {
    const text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5\nlow/index.m3u8\n";
    const parsed = parseMaster(text, "https://cdn.example/a/master.m3u8");
    assert.deepStrictEqual(parsed, {
      ok: true,
      value: [{ bandwidth: 5, url: "https://cdn.example/a/low/index.m3u8" }],
    });
  });

  it("rejects what isn't a master playlist: usher's JSON error, no variant, a bare URI", () => {
    assert.isFalse(parseMaster('[{"error":"Can not find channel"}]', USHER).ok);
    assert.isFalse(parseMaster("#EXTM3U\n", USHER).ok);
    assert.isFalse(parseMaster("#EXTM3U\nhttps://x/y.m3u8\n", USHER).ok);
  });
});

describe("parseMedia", () => {
  it("lists the segments of a recorded live playlist, oldest first", () => {
    const parsed = parseMedia(media.body, MEDIA);
    assert.isTrue(parsed.ok);
    if (!parsed.ok) return;
    assert.lengthOf(parsed.value.segments, 16);
    assert.isFalse(parsed.value.ended);
    assert.match(parsed.value.segments[0]!, /\/v1\/segment\/REDACTED-0\.ts\?dna=REDACTED$/);
  });

  it("marks a playlist that ended", () => {
    const parsed = parseMedia("#EXTM3U\n#EXTINF:2.0,\na.ts\n#EXT-X-ENDLIST\n", MEDIA);
    assert.isTrue(parsed.ok && parsed.value.ended);
  });

  it("rejects a playlist without segments that hasn't ended, and HTML", () => {
    assert.isFalse(parseMedia("#EXTM3U\n#EXT-X-VERSION:3\n", MEDIA).ok);
    assert.isFalse(parseMedia("<html>", MEDIA).ok);
  });
});
