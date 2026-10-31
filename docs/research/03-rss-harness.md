# 03 harness: the running miner's memory against the twin (2026-10-31)

The scripts behind [research 03 §2c](03-stack-and-ram.md#2c-the-running-miner-130-mb-to-83-mb-measured-2026-10-31-roadmap-c2).
They are research tools, not part of the miner: copy them into a scratch directory `H` outside
the checkout, link `H/node_modules` to the checkout's, and run them from there. They need
`openssl` and the checkout's Node (`node_modules/.bin/node`, which runs the twin's TypeScript
sources directly).

```sh
export REPO=~/projects/miner            # the checkout: its src/twin and node_modules
pnpm build && cp dist/bin.mjs /tmp/after.mjs
H=/tmp/rss && mkdir -p $H && ln -sfn $REPO/node_modules $H/node_modules   # then the files below
cd $H && ./measure.sh /tmp/after.mjs 300 /tmp/after.jsonl
MALLOC_MMAP_THRESHOLD_=16384 ./measure.sh /tmp/after.mjs 300 /tmp/unit.jsonl \
  --optimize-for-size --no-opt --no-maglev --no-sparkplug
./summ.sh /tmp/*.jsonl                  # the mean of each file's last three samples
node_modules/.bin/node --expose-gc subsystems.ts   # retained heap per subsystem, live-sized
```

`measure.sh` starts the twin (`twin-server.ts`) on a localhost port with a self-signed
certificate, then the bundle's `run` with a scratch `DATA_DIR`, both preloaded with `clock.mjs`
(simulated time 10× real from the twin's epoch). `route.mjs` sends the miner's `fetch` and
`WebSocket` to the twin and appends `process.memoryUsage()` and `/proc/self/smaps_rollup` to the
output every 20 real seconds, without forcing a collection. A 300 s run is 50 simulated minutes.
Several runs can go at once on different `RSS_TWIN_PORT`s.

## `measure.sh`

```sh
#!/usr/bin/env bash
# measure.sh <bundle> <seconds> <out.jsonl> [node flags...]: the bundled miner's `run` against the
# twin over TLS on localhost, simulated time 10x real. REPO is the checkout (its node_modules,
# src/twin), H this directory. Run from H, which must have node_modules -> $REPO/node_modules.
set -u
B=$1; SECS=$2; OUT=$3; shift 3
N=$REPO/node_modules/.bin/node; H=$(cd "$(dirname "$0")" && pwd)
PORT=${RSS_TWIN_PORT:-$((20000 + RANDOM % 9000))}
export RSS_START=$(date +%s%3N) RSS_SPEED=10 RSS_TWIN_PORT=$PORT RSS_TLS=1 TOKEN=twintokentwintokentwintoken0
[ -f $H/twin.key ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout $H/twin.key -out $H/twin.crt -days 30 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 2>/dev/null
D=$(mktemp -d)
RSS_KEY=$H/twin.key RSS_CERT=$H/twin.crt $N --import $H/clock.mjs $H/twin-server.ts $PORT > $D/twin.log 2>&1 &
TP=$!
sleep 3
NODE_EXTRA_CA_CERTS=$H/twin.crt RSS_OUT=$OUT DATA_DIR=$D LOG_FILE=false LOG_FORMAT=json \
  timeout -s INT $SECS $N --import $H/clock.mjs --import $H/route.mjs "$@" $B run > $D/miner.log 2>&1
kill $TP
echo "$D: $(grep -c 'watching' $D/miner.log) watch lines, last: $(tail -1 $OUT)"
```

## `summ.sh`

```sh
#!/usr/bin/env bash
# summ.sh files...: mean of the last 3 samples of each
for f in "$@"; do echo "$(basename $f .jsonl) $(tail -3 $f | $REPO/node_modules/.bin/node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse); const avg=k=>(l.reduce((s,x)=>s+x[k],0)/l.length).toFixed(1); console.log(["rss","anon","file","heapUsed","heapTotal","external"].map(k=>k+"="+avg(k)).join(" "))') cpu=$(tail -1 $f.time 2>/dev/null)"; done
```

## `clock.mjs`

```js
// Preload for both processes: the twin's epoch (SIM_EPOCH) at RSS_START, time RSS_SPEED times faster.
const SIM_EPOCH = 1_793_275_200_000;
const start = Number(process.env.RSS_START);
const speed = Number(process.env.RSS_SPEED ?? 1);
const realNow = Date.now.bind(Date);
const now = () => SIM_EPOCH + Math.round((realNow() - start) * speed);
globalThis.Date = class extends Date {
  constructor(...args) {
    if (args.length === 0) super(now());
    else super(...args);
  }
  static now() {
    return now();
  }
};
const hr = process.hrtime.bigint.bind(process.hrtime);
const hr0 = hr();
process.hrtime.bigint = () => hr0 + (hr() - hr0) * BigInt(speed);
const { setTimeout: later, setInterval: every } = globalThis;
globalThis.setTimeout = (fn, ms, ...a) => later(fn, Math.max(0, (ms ?? 0) / speed), ...a);
globalThis.setInterval = (fn, ms, ...a) => every(fn, Math.max(1, (ms ?? 0) / speed), ...a);
```

## `route.mjs`

```js
// Preload for the miner: Twitch's HTTP and websockets go to the twin; memory to RSS_OUT.
import { appendFileSync, readFileSync } from "node:fs";
import { setInterval as realEvery } from "node:timers";
const port = process.env.RSS_TWIN_PORT;
const tls = process.env.RSS_TLS === "1";
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = `${tls ? "https" : "http"}://127.0.0.1:${port}/?u=${encodeURIComponent(request.url)}`;
  return realFetch(new Request(url, request));
};
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWebSocket {
  constructor(_url, options) {
    super(`${tls ? "wss" : "ws"}://127.0.0.1:${port}/ws`, options);
  }
};
const mb = (bytes) => Math.round(bytes / 1e5) / 10;
const smaps = (key) => {
  const s = readFileSync("/proc/self/smaps_rollup", "utf8");
  return Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(s)?.[1] ?? 0) * 1024;
};
// Real seconds, not clock.mjs's. No forced collection: the process as it runs.
realEvery(() => {
  const m = process.memoryUsage();
  const anon = smaps("Anonymous");
  const line = {
    rss: mb(m.rss),
    anon: mb(anon),
    file: mb(smaps("Rss") - anon),
    heapUsed: mb(m.heapUsed),
    heapTotal: mb(m.heapTotal),
    external: mb(m.external),
  };
  appendFileSync(process.env.RSS_OUT, `${JSON.stringify(line)}\n`);
}, 20_000).unref();
```

## `twin-server.ts`

```ts
// The twin's HTTP and PubSub over real localhost sockets, TLS when given a key and certificate.
// node --import ./clock.mjs twin-server.ts <port>   (REPO=<checkout>, RSS_KEY/RSS_CERT for TLS)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import type { Socket as NetSocket } from "node:net";
import { Context, Effect, Layer } from "effect";
import { HttpBody, HttpClientRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";

const repo = process.env.REPO!;
const { bindClock, makeTwin } = await import(`${repo}/src/twin/twin.ts`);
const { twinHttp } = await import(`${repo}/src/twin/http.ts`);
const edge = await import(`${repo}/src/twin/edge.ts`);
const { buildWorld, channelFrames } = await import(`${repo}/src/twin/world.ts`);
const { SIM_EPOCH } = await import(`${repo}/src/twin/scenario.ts`);
const { weekScenario } = await import(`${repo}/src/twin/heap.ts`);
const { PUBSUB_URL } = await import(`${repo}/src/twitch/identity.ts`);

const port = Number(process.argv[2]);
const scenario = weekScenario();
const world = buildWorld(scenario);
const twin = makeTwin(world, { token: process.env.TOKEN });
const http = twinHttp(twin);
const sockets = Context.get(
  Effect.runSync(Effect.scoped(Layer.build(edge.webSocketConstructor(twin)))),
  Socket.WebSocketConstructor,
);
await Effect.runPromise(bindClock(twin));
edge.scheduleFaults(twin);
edge.sendFrames(
  twin,
  channelFrames(world, SIM_EPOCH, SIM_EPOCH + scenario.horizonMinutes * 60_000),
);
Effect.runFork(edge.runEdge(twin));
// Nobody drains the twin's activity log here, so it would grow: empty it.
setInterval(() => {
  for (const v of Object.values(twin.activity)) if (Array.isArray(v)) v.length = 0;
}, 5_000);

/** `/?u=<the URL the miner asked for>`: the twin answers it as Twitch would. */
const answer = (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Array<Buffer> = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://x").searchParams.get("u") ?? "";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && !["host", "content-length", "connection"].includes(k))
        headers[k] = v;
    }
    const body = Buffer.concat(chunks);
    let request = HttpClientRequest.make(req.method as "GET")(url, { headers });
    if (body.length > 0) {
      request = HttpClientRequest.setBody(
        request,
        HttpBody.uint8Array(new Uint8Array(body), headers["content-type"]),
      );
    }
    void Effect.runPromise(
      Effect.flatMap(http.execute(request), (r: any) =>
        Effect.map(r.text, (text: string) => ({ status: r.status as number, text })),
      ).pipe(Effect.catch((e) => Effect.succeed({ status: 599, text: String(e) }))),
    ).then(({ status, text }) =>
      res.writeHead(status, { "content-type": "application/json" }).end(text),
    );
  });
};
const server =
  process.env.RSS_KEY === undefined
    ? createHttp(answer)
    : createHttps(
        { key: readFileSync(process.env.RSS_KEY), cert: readFileSync(process.env.RSS_CERT!) },
        answer,
      );

// Just enough of RFC 6455 for PubSub: text, ping and close frames.
const frame = (op: number, payload: Buffer) => {
  const n = payload.length;
  const head = Buffer.alloc(n < 126 ? 2 : n < 65_536 ? 4 : 10);
  head[0] = 0x80 | op;
  if (n < 126) head[1] = n;
  else if (n < 65_536) ((head[1] = 126), head.writeUInt16BE(n, 2));
  else ((head[1] = 127), head.writeBigUInt64BE(BigInt(n), 2));
  return Buffer.concat([head, payload]);
};
server.on("upgrade", (req: IncomingMessage, socket: NetSocket) => {
  const accept = createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const ws = sockets(PUBSUB_URL) as any;
  if (ws.readyState !== 1) return void socket.destroy();
  ws.addEventListener("message", (e: { data: string }) =>
    socket.write(frame(1, Buffer.from(e.data))),
  );
  ws.addEventListener("close", () => socket.end(frame(8, Buffer.alloc(0))));
  let buf = Buffer.alloc(0);
  socket.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0]! & 15;
      let n = buf[1]! & 127;
      let off = 2;
      if (n === 126) ((n = buf.readUInt16BE(2)), (off = 4));
      else if (n === 127) ((n = Number(buf.readBigUInt64BE(2))), (off = 10));
      if (buf.length < off + 4 + n) return;
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + n));
      for (let i = 0; i < n; i++) data[i]! ^= buf[off + (i % 4)]!;
      buf = buf.subarray(off + 4 + n);
      if (op === 1) {
        try {
          ws.send(data.toString());
        } catch {}
      } else if (op === 8) (ws.close(), socket.end(frame(8, Buffer.alloc(0))));
      else if (op === 9) socket.write(frame(10, data));
    }
  });
  socket.on("close", () => ws.close());
  socket.on("error", () => ws.close());
});
server.listen(port, "127.0.0.1");
```

## `subsystems.ts`

```ts
// node --expose-gc subsystems.ts: retained heap of what the miner holds, at the live catalog's size
// (123 campaigns, research 02, 2026-10-29). REPO is the checkout.
import { readFileSync } from "node:fs";
const repo = process.env.REPO!;
const { Schema } = await import(`${repo}/node_modules/effect/dist/index.js`);
const wire = await import(`${repo}/src/twitch/wire.ts`);
const { canonical, encodeState } = await import(`${repo}/src/store/codec.ts`);
const { initial } = await import(`${repo}/src/core/state.ts`);
const { digest } = await import(`${repo}/src/twitch/journal.ts`);
const gc = (globalThis as any).gc as () => void;
const used = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};
const kb = (n: number) => `${Math.round(n / 1024)} kB`;
const hold: Array<unknown> = [];
const measure = (label: string, make: () => unknown) => {
  const before = used();
  const v = make();
  hold.push(v);
  const after = used();
  console.log(label.padEnd(58), kb(after - before));
  return v as any;
};
const fixture = JSON.parse(
  readFileSync(`${repo}/src/twitch/fixtures/campaign-details.json`, "utf8"),
);
const decode = Schema.decodeUnknownSync(wire.CampaignDetails);
const one = fixture.body[0].data;
const raw = (i: number) =>
  JSON.parse(
    JSON.stringify(one)
      .replaceAll(one.user.dropCampaign.id, `${one.user.dropCampaign.id}-${i}`)
      .replace(/"(\d{9,})"/g, (_m: string, d: string) => `"${d}${i}"`),
  );
const N = 123;
// Schema compiles its decoders lazily: warm them so the first measure does not count them.
for (let i = 0; i < 3; i++) wire.toCampaign(decode(raw(1000 + i)).user!.dropCampaign!);
measure(`raw answers of ${N} campaigns (parsed JSON, transient)`, () =>
  Array.from({ length: N }, (_, i) => raw(i)),
);
const catalog = measure(`decoded core catalog of ${N} campaigns (State.catalog)`, () =>
  Array.from({ length: N }, (_, i) => wire.toCampaign(decode(raw(i)).user!.dropCampaign!)),
);
const state = { ...initial({ goals: [] } as any), catalog };
measure("run.ts `saved`: canonical string of the durable state", () =>
  canonical([
    state.catalog,
    state.catalogStatus,
    state.progress,
    state.awarded,
    state.inventoried,
    state.claims,
  ]),
);
measure("run.ts `saved` as a sha256 digest", () => digest(canonical([state.catalog])));
const encoded = encodeState(state as any);
console.log("state.json bytes".padEnd(58), kb(encoded.length));
measure("journal remembered parts at the cap (16,384 ids)", () => {
  const m = new Map<string, true>();
  for (let i = 0; i < 16_384; i++) m.set(digest(String(i)), true);
  return m;
});
measure("device id", () => "x".repeat(32).split("").join(""));
measure("80 PubSub topics", () =>
  Array.from({ length: 80 }, (_, i) => `video-playback-by-id.${100000000 + i}`),
);
measure("a deep copy of the core catalog (JSON round trip)", () =>
  JSON.parse(JSON.stringify(catalog)),
);
measure("the decoded answers (wire types, transient)", () =>
  Array.from({ length: N }, (_, i) => decode(raw(i))),
);
```
