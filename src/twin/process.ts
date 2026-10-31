import { Layer } from "effect";
import { HttpClient } from "effect/http";
import type * as Socket from "effect/socket/Socket";
import { liveServices } from "../runtime/live.ts";
import { Budgets } from "../twitch/budget.ts";
import { Journal } from "../twitch/journal.ts";
import { Connector } from "../twitch/PubSub.ts";
import type { Credentials } from "../twitch/Twitch.ts";
import { webSocketConstructor } from "./edge.ts";
import { twinCredentials, twinHttp } from "./http.ts";
import type { Twin } from "./twin.ts";

/**
 * Seams a test may replace to plant a bug in the miner's own wiring and watch the twin catch it.
 * The defaults are what a real run uses.
 */
export interface Plant {
  readonly connector?: Layer.Layer<Connector, never, Socket.WebSocketConstructor>;
  /** Wraps the HTTP client the miner sends everything through. */
  readonly http?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
  /** The token and device id the miner is given. */
  readonly credentials?: Layer.Layer<Credentials>;
}

/**
 * One miner process over the twin: the `Twitch` reads, the live actuator (`hlsWatch`, `ClaimDrop`)
 * and PubSub over `Connector.webSocket`, wired exactly as `miner run` wires them (`liveServices`).
 * Only the wire is the twin's: its HTTP surface and its websockets. Every request takes its turn at
 * `budgets` inside the miner's own code (`gql.ts`, `hls.ts`), as live: the twin charges nothing.
 * The real limits unless the simulator passes the run's own.
 */
export const twinProcess = (twin: Twin, budgets?: Budgets["Service"], plant?: Plant) => {
  const http = twinHttp(twin);
  return liveServices.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, plant?.http?.(http) ?? http),
        plant?.credentials ?? twinCredentials(twin),
        Journal.none,
        budgets === undefined ? Budgets.layer : Layer.succeed(Budgets, budgets),
        (plant?.connector ?? Connector.webSocket).pipe(Layer.provide(webSocketConstructor(twin))),
      ),
    ),
  );
};
