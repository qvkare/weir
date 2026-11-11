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

/** Gas per state-changing method, in Tgas: one table, easy to adjust. From the sandbox
 * measurements in `integration/RESULTS.md`: every simple method burns under 3.7 Tgas, so 10
 * leaves at least 2.7x; `clear` burns 25.5 Tgas at 64 commits and 51.25 at 128, so 150;
 * `withdraw` needs 24 (it reserves gas for the transfer and its callback), so 50; the token
 * deposit keeps 100 because the real USDC's needs are unmeasured. `commit` gets 15: evicting
 * from a full round burnt 4.11. `settle` gets 15: deciding two pending buckets burnt 3.12; a
 * settle that decides many pending buckets is not measured. */
export const GAS_TGAS: { readonly [M in PortChange]: number } = {
  register: 10,
  deposit: 100,
  withdraw: 50,
  set_guard: 10,
  commit: 15,
  reveal: 10,
  clear: 150,
  mint: 10,
  merge: 10,
  transfer_position: 10,
  report: 10,
  finalize_print: 10,
  prune_print: 10,
  settle: 15,
  redeem: 10,
  prune_result: 10,
};

/** Attached deposits: the registration fee, and 1 yoctoNEAR where the spec requires it (so a
 * function-call key cannot make the call). */
const DEPOSITS: { readonly [M in PortChange]?: bigint } = {
  register: REGISTRATION_FEE,
  deposit: ONE_YOCTO,
  withdraw: ONE_YOCTO,
  set_guard: ONE_YOCTO,
  transfer_position: ONE_YOCTO,
};

/** Gas and attached deposit per state-changing method. `deposit` is sent to the token, not to Weir. */
export const CALLS = Object.fromEntries(
  Object.entries(GAS_TGAS).map(([m, tgas]) => [m, { gas: BigInt(tgas) * TGAS, deposit: DEPOSITS[m as PortChange] ?? 0n }]),
) as { readonly [M in PortChange]: { readonly gas: bigint; readonly deposit: bigint } };

/** What an agent's function-call key may call (SPEC section 15). Everything else either
 * needs 1 yoctoNEAR (withdraw, set_guard, transfer_position) or is not an agent's business. */
export const AGENT_KEY_METHODS = ["commit", "reveal", "clear", "mint", "merge", "settle", "redeem"] as const satisfies readonly PortChange[];

/** The keeper's housekeeping key: an agent's methods plus deciding and pruning prints and pruning results. */
export const KEEPER_KEY_METHODS = [...AGENT_KEY_METHODS, "finalize_print", "prune_print", "prune_result"] as const satisfies readonly PortChange[];

/** A reporter's key. */
export const REPORTER_KEY_METHODS = ["report", "finalize_print"] as const satisfies readonly PortChange[];

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
  get_pending_prints: true,
  get_last_print: true,
  get_prints: true,
  get_accumulator: true,
  get_totals: true,
  commit_hash: true,
};

export const VIEW_METHODS = Object.keys(VIEWS) as ViewMethod[];
export const CHANGE_METHODS = Object.keys(GAS_TGAS) as PortChange[];

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
    maxSpreadBps: p.max_spread_bps,
    minPrints: p.min_prints,
    voidAfterSecs: p.void_after_secs,
    maxAnchorAgeSecs: p.max_anchor_age_secs,
    forfeitBps: p.forfeit_bps,
    minLock: BigInt(p.min_lock),
    commitFee: BigInt(p.commit_fee),
    maxCommits: p.max_commits,
    maxOrderSize: p.max_order_size,
    reporters: [...p.reporters],
    quorum: p.quorum,
  };
}
