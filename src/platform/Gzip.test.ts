import { assert, describe, it } from "@effect/vitest";
import { nodeGzip } from "./Gzip.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const member = (line: string) => nodeGzip.gzip(encode(`${line}\n`));
const join = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const torn = (bytes: Uint8Array) => bytes.subarray(0, bytes.length >> 1);
const long = JSON.stringify({ blob: "x".repeat(2000), n: 1 });

describe("gunzip", () => {
  it("reads one member per line", () => {
    assert.strictEqual(decode(nodeGzip.gunzip(join(member("a"), member("b")))), "a\nb\n");
    assert.strictEqual(decode(nodeGzip.gunzip(new Uint8Array())), "");
  });

  it("reads past a member torn by a crash, wherever it sits", () => {
    // A restart appends behind the torn member: every later line must still be read.
    const text = decode(nodeGzip.gunzip(join(member("a"), torn(member(long)), member("c"))));
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "a");
    assert.strictEqual(lines.at(-2), "c");
    // The torn line ends with a newline of its own, so it can't swallow the next.
    assert.notInclude(lines.slice(1, -2).join(""), "c");
    assert.strictEqual(decode(nodeGzip.gunzip(join(member("a"), torn(member(long))))).at(0), "a");
  });
});
