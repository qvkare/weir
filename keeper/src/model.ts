// A `Chain` over the engine's in-memory market (`ModelWeir`), for tests, the benchmark and
// local demos. Each transaction gets a made-up hash `model-<n>` so the log has something to show.
//
// The engine model has no keys. Pass `keys` to have the transport enforce them the way a NEAR
// node does: a function-call key names one receiver and a list of methods, and a transaction
// outside them is refused before it runs, with the node's error. A key not in `keys` is
// treated as a full-access key.
import type { ModelWeir } from "@weir/chain";
import type { Chain } from "./ports.ts";

export interface ModelKey {
  receiver: string;
  /** Allowed methods; empty allows every method of the receiver, as on NEAR. */
  methods: readonly string[];
}

export function modelChain(models: Readonly<Record<string, ModelWeir>>, keys: Readonly<Record<string, ModelKey>> = {}): Chain & { refused: string[] } {
  let n = 0;
  const refused: string[] = [];
  return {
    refused,
    perCall: true,
    async connect(market, signer, hooks) {
      const model = models[market.contract];
      if (!model) throw new Error(`no model for ${market.contract}`);
      const port = model.as(signer?.account_id ?? "keeper-viewer");
      const key = signer ? keys[signer.secret_key] : undefined;
      const change = port.change.bind(port);
      port.change = (async (method: never, args: never) => {
        if (key && key.receiver !== market.contract) {
          refused.push(`${signer!.account_id} ${method} ${market.contract} ReceiverMismatch`);
          throw new Error(`INVALID_TRANSACTION: {"InvalidAccessKeyError":{"ReceiverMismatch":{"ak_receiver":"${key.receiver}","tx_receiver":"${market.contract}"}}}`);
        }
        if (key && key.methods.length > 0 && !key.methods.includes(method)) {
          refused.push(`${signer!.account_id} ${method} ${market.contract} MethodNameMismatch`);
          throw new Error(`INVALID_TRANSACTION: {"InvalidAccessKeyError":{"MethodNameMismatch":{"method_name":"${method}"}}}`);
        }
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
