// A `Chain` over the engine's in-memory market (`ModelWeir`), for tests, the benchmark and
// local demos. Each transaction gets a made-up hash `model-<n>` so the log has something to show.
import type { ModelWeir } from "@weir/chain";
import type { Chain } from "./ports.ts";

export function modelChain(models: Readonly<Record<string, ModelWeir>>): Chain {
  let n = 0;
  return {
    perCall: true,
    async connect(market, signer, hooks) {
      const model = models[market.contract];
      if (!model) throw new Error(`no model for ${market.contract}`);
      const port = model.as(signer?.account_id ?? "keeper-viewer");
      const change = port.change.bind(port);
      port.change = (async (method: never, args: never) => {
        const tx_hash = `model-${++n}`;
        try {
          return await change(method, args);
        } finally {
          hooks.onOutcome({ tx_hash });
        }
      }) as typeof port.change;
      return port;
    },
  };
}
