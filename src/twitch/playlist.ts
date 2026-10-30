/**
 * The two HLS playlist shapes the watcher reads (RFC 8216). URIs resolve against the playlist's
 * own URL. A playlist that isn't one fails with a reason, never with a guess.
 */

export interface Variant {
  readonly bandwidth: number;
  readonly url: string;
}

export type Parsed<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim());

const isPlaylist = (text: string) => text.trimStart().startsWith("#EXTM3U");

/** Every variant with its `BANDWIDTH`. Twitch lists them best first (live 2026-10-30). */
export const parseMaster = (text: string, base: string): Parsed<ReadonlyArray<Variant>> => {
  if (!isPlaylist(text)) return { ok: false, reason: "the master playlist lacks #EXTM3U" };
  const all = lines(text);
  const variants: Array<Variant> = [];
  for (const [i, line] of all.entries()) {
    if (line === "" || line.startsWith("#")) continue;
    const bandwidth = /^#EXT-X-STREAM-INF:.*\bBANDWIDTH=(\d+)/.exec(all[i - 1] ?? "")?.[1];
    if (bandwidth === undefined) {
      return { ok: false, reason: "a master playlist URI has no #EXT-X-STREAM-INF" };
    }
    variants.push({ bandwidth: Number(bandwidth), url: new URL(line, base).toString() });
  }
  return variants.length === 0
    ? { ok: false, reason: "the master playlist lists no variant" }
    : { ok: true, value: variants };
};

/**
 * The cheapest variant. Watching at the lowest quality credits drops like any other (TDM takes the
 * last, lowest entry since 2026-10-09; just-mining the lowest bandwidth).
 */
export const lowest = (variants: ReadonlyArray<Variant>): Variant | undefined =>
  variants.reduce<Variant | undefined>(
    (best, v) => (best === undefined || v.bandwidth < best.bandwidth ? v : best),
    undefined,
  );

export interface Media {
  /** Segment URLs, oldest first. A live Twitch playlist lists about 15 of 2 s each. */
  readonly segments: ReadonlyArray<string>;
  /** `#EXT-X-ENDLIST`: the stream ended and no segment will follow. */
  readonly ended: boolean;
}

export const parseMedia = (text: string, base: string): Parsed<Media> => {
  if (!isPlaylist(text)) return { ok: false, reason: "the media playlist lacks #EXTM3U" };
  const all = lines(text);
  const segments = all
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => new URL(line, base).toString());
  const ended = all.includes("#EXT-X-ENDLIST");
  return segments.length === 0 && !ended
    ? { ok: false, reason: "the media playlist lists no segment" }
    : { ok: true, value: { segments, ended } };
};
