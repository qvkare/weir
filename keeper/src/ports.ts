// How the keeper reaches a contract: a `Chain` makes one `WeirPort` per signer, and a
// `Meter` wraps every port of one market so that each call is charged to the request
// budget before it is made, reads are cached until the next state change, and calls a step
// is not allowed to make are deferred to a later step instead of being sent.
import {
  CHANGE_METHODS,
  ChainWeir,
  KeyPair,
  NearAccount,
  NearRpc,
  VIEW_METHODS,
  type FetchLike,
  type PortChange,
  type WeirPort,
} from "@weir/chain";
import type { WireParams, WireStatus } from "@weir/engine";
import { Budget, BudgetExhausted } from "./budget.ts";
import type { MarketDeployment, Signer } from "./config.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface TxRecord {
  method: string;
  signer: string;
  /** Null when no transaction hash is known (the model, or a call that never reached a node). */
  tx_hash: string | null;
  ok: boolean;
  error: string | null;
}

export interface PortHooks {
  /** Outbound fetch, already charged to the budget. */
  fetch: Fetch;
  /** Called with every transaction outcome the port sees. */
  onOutcome(o: { tx_hash: string }): void;
}

export interface Chain {
  /** True when the ports do not use `hooks.fetch` (the model): the meter then charges each
   * call what it would cost on chain, a view 1 request and a transaction 2. */
  perCall: boolean;
  /** A port for `market` that signs as `signer` (read-only when null). Makes no request. */
  connect(market: MarketDeployment, signer: Signer | null, hooks: PortHooks): Promise<WeirPort>;
}

/** Requests one call costs on chain: a view is one `query`; a transaction reads the access
 * key (nonce and block hash) and then sends `send_tx`. Retries and failover can add more,
 * and those are charged by the metered fetch as they happen. */
export const COST = { view: 1, change: 2 } as const;

/** `WeirPort`s over NEAR JSON-RPC (`ChainWeir`). Key pairs are derived once per isolate. */
export function nearChain(rpcUrls: readonly string[]): Chain {
  const keys = new Map<string, Promise<KeyPair>>();
  const keyOf = (secret: string): Promise<KeyPair> => {
    let k = keys.get(secret);
    if (!k) {
      k = KeyPair.fromString(secret);
      keys.set(secret, k);
      k.catch(() => keys.delete(secret));
    }
    return k;
  };
  return {
    perCall: false,
    async connect(market, signer, hooks) {
      const rpc = new NearRpc({ urls: rpcUrls, fetch: hooks.fetch as unknown as FetchLike });
      const account = signer ? new NearAccount(rpc, signer.account_id, await keyOf(signer.secret_key)) : undefined;
      return new ChainWeir({
        rpc,
        ...(account ? { account } : {}),
        contractId: market.contract,
        usdcId: market.usdc,
        onOutcome: (_m, o) => hooks.onOutcome(o),
      });
    },
  };
}

export const DEFERRED = "deferred to a later step of this tick";

export class Deferred extends Error {
  override readonly name = "Deferred";
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** One market's view of the budget, shared by every port of that market in one tick. */
export class Meter {
  readonly budget: Budget;
  readonly perCall: boolean;
  /** State changes allowed in the current step; null allows all. */
  allow: ReadonlySet<PortChange> | null = null;
  /** Never change (SPEC section 3), so cached across ticks by the keeper. */
  params: WireParams | null = null;
  /** Read once per tick: phases come from the clock, and a tick is short. */
  status: WireStatus | null = null;
  readonly txs: TxRecord[] = [];
  readonly #cache = new Map<string, string>();
  #outcome: { tx_hash: string } | null = null;

  constructor(budget: Budget, perCall: boolean) {
    this.budget = budget;
    this.perCall = perCall;
  }

  readonly onOutcome = (o: { tx_hash: string }): void => {
    this.#outcome = o;
  };

  #lastHash(): string | null {
    return this.#outcome?.tx_hash ?? null;
  }

  #charge(n: number, what: string): void {
    if (this.perCall) this.budget.spend(n, what);
    else this.budget.need(n, what);
  }

  wrap(inner: WeirPort): WeirPort {
    const view = async (method: string, args: unknown): Promise<unknown> => {
      if (method === "get_params" && this.params) return clone(this.params);
      if (method === "get_status" && this.status) return clone(this.status);
      const key = `${method}|${JSON.stringify(args)}`;
      const hit = this.#cache.get(key);
      if (hit !== undefined) return JSON.parse(hit);
      this.#charge(COST.view, `view ${method}`);
      const result = await inner.view(method as never, args as never);
      if (method === "get_params") this.params = clone(result as WireParams);
      else if (method === "get_status") this.status = clone(result as WireStatus);
      else this.#cache.set(key, JSON.stringify(result ?? null));
      return result;
    };
    const change = async (method: string, args: unknown): Promise<unknown> => {
      if (this.allow && !this.allow.has(method as PortChange)) throw new Deferred(`${method} ${DEFERRED}`);
      this.#charge(COST.change, method);
      this.#cache.clear();
      this.#outcome = null;
      try {
        const result = await inner.change(method as never, args as never);
        this.txs.push({ method, signer: inner.accountId, tx_hash: this.#lastHash(), ok: true, error: null });
        return result;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const sent = this.#lastHash();
        // A refusal before anything was sent is not a transaction.
        if (sent !== null || !(e instanceof BudgetExhausted)) {
          this.txs.push({ method, signer: inner.accountId, tx_hash: sent, ok: false, error });
        }
        throw e;
      }
    };
    const port: Record<string, unknown> = { accountId: inner.accountId, view, change };
    for (const m of VIEW_METHODS) port[m] = (a: unknown) => view(m, a);
    for (const m of CHANGE_METHODS) port[m] = (a: unknown) => change(m, a);
    return port as unknown as WeirPort;
  }
}
