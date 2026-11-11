// `WeirPort`: one typed method per contract method of SPEC sections 5 to 14, with the wire
// types of `@weir/engine` as arguments and results. `ChainWeir` sends them to a deployed
// contract; `ModelWeir` sends them to the engine's in-memory `Market`. Code written against
// `WeirPort` runs unchanged on either.
import {
  callChange,
  callView,
  type ChangeMethods,
  type Market,
  type Params,
  type U128,
  type ViewMethod,
  type ViewMethods,
  type WireParams,
} from "@weir/engine";
import { panicMessage, type NearAccount, type NearRpc, type TxOutcome } from "./near.ts";

/** The state-changing methods as a user calls them. `deposit` differs from the contract's
 * `ft_on_transfer` (which only the token calls): it sends `amount` of USDC to Weir with
 * `ft_transfer_call`, crediting `msg` if not empty, else the caller, and returns the amount
 * Weir kept, as `ft_transfer_call` does. */
export type PortChanges = Omit<ChangeMethods, "deposit"> & {
  deposit: { args: { amount: U128; msg?: string }; result: U128 };
};
export type PortChange = keyof PortChanges;

type ViewFns = { [M in ViewMethod]: (args: ViewMethods[M]["args"]) => Promise<ViewMethods[M]["result"]> };
type ChangeFns = { [M in PortChange]: (args: PortChanges[M]["args"]) => Promise<PortChanges[M]["result"]> };

export interface WeirPort extends ViewFns, ChangeFns {
  /** The account state changes are sent as. */
  readonly accountId: string;
  view<M extends ViewMethod>(method: M, args: ViewMethods[M]["args"]): Promise<ViewMethods[M]["result"]>;
  change<M extends PortChange>(method: M, args: PortChanges[M]["args"]): Promise<PortChanges[M]["result"]>;
}

/** The same calls, synchronous. Only the model can offer it; the simulation runs on it. */
export interface SyncWeir {
  readonly accountId: string;
  view<M extends ViewMethod>(method: M, args: ViewMethods[M]["args"]): ViewMethods[M]["result"];
  change<M extends PortChange>(method: M, args: PortChanges[M]["args"]): PortChanges[M]["result"];
}

const TGAS = 1_000_000_000_000n;
/** 0.02 NEAR (section 5). */
export const REGISTRATION_FEE = 20_000_000_000_000_000_000_000n;
export const ONE_YOCTO = 1n;

/** Gas and attached deposit per state-changing method. The gas figures are generous upper
 * bounds (unused gas is refunded), not measurements; `clear` gets the full 300 Tgas that
 * section 14 says a full round must fit in. `deposit` is sent to the token, not to Weir. */
export const CALLS: { readonly [M in PortChange]: { readonly gas: bigint; readonly deposit: bigint } } = {
  register: { gas: 30n * TGAS, deposit: REGISTRATION_FEE },
  deposit: { gas: 100n * TGAS, deposit: ONE_YOCTO },
  withdraw: { gas: 100n * TGAS, deposit: ONE_YOCTO },
  set_guard: { gas: 30n * TGAS, deposit: ONE_YOCTO },
  commit: { gas: 50n * TGAS, deposit: 0n },
  reveal: { gas: 50n * TGAS, deposit: 0n },
  clear: { gas: 300n * TGAS, deposit: 0n },
  mint: { gas: 50n * TGAS, deposit: 0n },
  merge: { gas: 50n * TGAS, deposit: 0n },
  transfer_position: { gas: 50n * TGAS, deposit: ONE_YOCTO },
  report: { gas: 50n * TGAS, deposit: 0n },
  settle: { gas: 100n * TGAS, deposit: 0n },
  redeem: { gas: 50n * TGAS, deposit: 0n },
  prune_result: { gas: 50n * TGAS, deposit: 0n },
};

/** What an agent's function-call key may call (SPEC section 15). Everything else either
 * needs 1 yoctoNEAR (withdraw, set_guard, transfer_position) or is not an agent's business. */
export const AGENT_KEY_METHODS = ["commit", "reveal", "clear", "mint", "merge", "settle", "redeem"] as const satisfies readonly PortChange[];

const VIEWS: { readonly [M in ViewMethod]: true } = {
  get_params: true,
  get_status: true,
  get_series: true,
  get_account: true,
  get_position: true,
  get_round: true,
  get_result: true,
  get_results: true,
  get_print: true,
  get_last_print: true,
  get_prints: true,
  get_accumulator: true,
  get_totals: true,
  commit_hash: true,
};

export const VIEW_METHODS = Object.keys(VIEWS) as ViewMethod[];
export const CHANGE_METHODS = Object.keys(CALLS) as PortChange[];

type AnyFn = (method: string, args: unknown) => Promise<unknown>;

/** Adds one method per contract method to `target`, each forwarding to `view` or `change`. */
function installMethods(target: object, view: AnyFn, change: AnyFn): void {
  const t = target as Record<string, unknown>;
  t.view = view;
  t.change = change;
  for (const m of VIEW_METHODS) t[m] = (args: unknown) => view(m, args);
  for (const m of CHANGE_METHODS) t[m] = (args: unknown) => change(m, args);
}

/** A contract call that failed on chain. `message` is the contract's panic message, the
 * same text `ModelWeir` throws, and `outcome` holds the rest. */
export class CallFailed extends Error {
  override readonly name = "CallFailed";
  readonly outcome: TxOutcome;

  constructor(outcome: TxOutcome) {
    super(panicMessage(outcome.error ?? "call failed"));
    this.outcome = outcome;
  }
}

export interface ChainWeirOptions {
  rpc: NearRpc;
  /** The signer. Leave it out for a read-only port; state changes then throw. */
  account?: NearAccount;
  /** The Weir contract account. */
  contractId: string;
  /** The USDC token, for `deposit`. Read from `get_params` when left out. */
  usdcId?: string;
  /** Called with every transaction outcome, for logging tx hashes and gas. */
  onOutcome?: (method: string, outcome: TxOutcome) => void;
}

export interface ChainWeir extends WeirPort {}

/** `WeirPort` over NEAR JSON-RPC. Views are free `query` calls; state changes are signed
 * function calls with the gas and deposit of `CALLS`. */
export class ChainWeir {
  readonly contractId: string;
  readonly #opts: ChainWeirOptions;
  #usdc: string | undefined;

  constructor(opts: ChainWeirOptions) {
    this.#opts = opts;
    this.contractId = opts.contractId;
    this.#usdc = opts.usdcId;
    installMethods(
      this,
      (m, a) => opts.rpc.view(opts.contractId, m, a as object),
      (m, a) => this.#change(m as PortChange, a as object),
    );
  }

  get accountId(): string {
    return this.#opts.account?.accountId ?? "";
  }

  async #change(method: PortChange, args: object): Promise<unknown> {
    const account = this.#opts.account;
    if (!account) throw new Error("this ChainWeir has no signer");
    const { gas, deposit } = CALLS[method];
    let outcome: TxOutcome;
    if (method === "deposit") {
      const { amount, msg } = args as PortChanges["deposit"]["args"];
      this.#usdc ??= (await this.view("get_params", {})).usdc;
      const ftArgs = { receiver_id: this.contractId, amount, msg: msg ?? "" };
      outcome = await account.functionCall(this.#usdc, "ft_transfer_call", ftArgs, gas, deposit);
    } else {
      outcome = await account.functionCall(this.contractId, method, args, gas, deposit);
    }
    this.#opts.onOutcome?.(method, outcome);
    if (!outcome.ok) throw new CallFailed(outcome);
    return outcome.result;
  }
}

/** JSON in and out, so the model hands back exactly what a chain client would parse:
 * no shared objects, `undefined` fields dropped, numbers as numbers. */
const json = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export interface ModelWeir extends WeirPort {}

/** `WeirPort` over an engine `Market`, through the engine's `callView` and `callChange`.
 * Several `ModelWeir`s, one per account, can share one market (`as`). */
export class ModelWeir {
  readonly market: Market;
  readonly accountId: string;
  /** The same calls without promises, for code that must stay synchronous. */
  readonly sync: SyncWeir;

  constructor(market: Market, accountId: string) {
    this.market = market;
    this.accountId = accountId;
    const view = (m: string, a: unknown) => json(callView(market, m as ViewMethod, json(a) as never));
    const change = (m: string, a: unknown) => this.#change(m as PortChange, json(a));
    this.sync = { accountId, view, change } as SyncWeir;
    installMethods(
      this,
      async (m, a) => view(m, a),
      async (m, a) => change(m, a),
    );
  }

  /** A port for another account on the same market. */
  as(accountId: string): ModelWeir {
    return new ModelWeir(this.market, accountId);
  }

  now(): number {
    return this.market.now;
  }

  setTime(time: number): void {
    this.market.setTime(time);
  }

  advance(secs: number): void {
    this.market.advance(secs);
  }

  #change(method: PortChange, args: unknown): unknown {
    if (method === "deposit") {
      const { amount, msg } = args as PortChanges["deposit"]["args"];
      const usdc = this.market.params.usdc;
      const refunded = callChange(this.market, usdc, "deposit", { sender_id: this.accountId, amount, msg: msg ?? "" });
      return (BigInt(amount) - BigInt(refunded)).toString();
    }
    return json(callChange(this.market, this.accountId, method, args as never));
  }
}

/** The engine's `Params` from the contract's JSON parameters (section 3). */
export function paramsFromWire(p: WireParams): Params {
  return {
    usdc: p.usdc,
    underlying: p.underlying,
    t0: p.t0,
    periodSecs: p.period_secs,
    leadSecs: p.lead_secs,
    cutoffSecs: p.cutoff_secs,
    commitSecs: p.commit_secs,
    revealSecs: p.reveal_secs,
    bandBps: p.band_bps,
    tick: p.tick,
    printIntervalSecs: p.print_interval_secs,
    reportGraceSecs: p.report_grace_secs,
    maxMoveBps: p.max_move_bps,
    minPrints: p.min_prints,
    voidAfterSecs: p.void_after_secs,
    maxAnchorAgeSecs: p.max_anchor_age_secs,
    forfeitBps: p.forfeit_bps,
    minLock: BigInt(p.min_lock),
    maxCommits: p.max_commits,
    maxOrderSize: p.max_order_size,
    reporters: [...p.reporters],
    quorum: p.quorum,
  };
}
