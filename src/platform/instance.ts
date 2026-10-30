import { Context, Layer } from "effect";
import pkg from "../../package.json" with { type: "json" };

/** This process, as `status.json` names it. */
export class Instance extends Context.Service<
  Instance,
  { readonly version: string; readonly pid: number }
>()("miner/platform/Instance") {
  static readonly layer = Layer.sync(Instance, () =>
    Instance.of({ version: pkg.version, pid: process.pid }),
  );
}
