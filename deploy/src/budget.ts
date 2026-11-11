// NEAR budgeting: what each account is given, what it spends, what it must keep, and the
// allowance of every function-call key. Pure arithmetic over the gas table below, so the plan
// can show every number before anything is sent.
//
// Gas is kept in Ggas (1 Tgas = 1000 Ggas) so that every figure is an exact integer.
import { MARKETS, type MarketId } from "../../agents/src/presets.ts";
import { AGENT_KEY_METHODS, CALLS, KEEPER_KEY_METHODS, REGISTRATION_FEE, REPORTER_KEY_METHODS } from "../../chain/src/weir.ts";
import { STORAGE_DEPOSIT, TOKEN_CALLS } from "../../chain/src/token.ts";
import { fcKeys, type AgentPlan, type FcKeyPlan, type Layout } from "./layout.ts";

export const NEAR = 10n ** 24n;
export const MILLINEAR = 10n ** 21n;
export const GGAS = 10n ** 9n;
export const TGAS = 10n ** 12n;

/** yoctoNEAR per gas unit burnt: the protocol's minimum gas price on testnet and mainnet. The
 * plan assumes it; `apply` reads the real price and says so when it is higher. */
export const MIN_GAS_PRICE = 100_000_000n;
/** yoctoNEAR per gas unit at which attached gas is bought when a transaction is submitted
 * (`runtime_config.min_gas_purchase_price`, protocol 88; read from EXPERIMENTAL_protocol_config on
 * the sandbox and on testnet on 2026-11-12). The signer's balance, and a function-call key's
 * allowance, must cover attached gas x this; what is not burnt comes back. `apply` reads it and
 * stops if the network asks for more. */
export const GAS_PURCHASE_PRICE = 1_000_000_000n;
/** `runtime_config.account_creation_charge`, protocol 88: what every CreateAccount costs its signer. */
export const ACCOUNT_CREATION_CHARGE = 7n * 10n ** 21n;
/** 1 NEAR per 100 kB (`storage_amount_per_byte`). */
export const STORAGE_PER_BYTE = 10n ** 19n;
/** An account using at most this many bytes needs no storage stake (NEP-448 zero-balance accounts). */
export const ZERO_BALANCE_BYTES = 770;
/** What the testnet faucet is expected to give a new account. Not assumed by `apply`: it reads
 * the balance and stops if the ops account cannot pay for what it has to do. */
export const ASSUMED_GRANT = 10n * NEAR;
/** On the sandbox the root account gives each top-level account this much, as the faucet would. */
export const SANDBOX_GRANT = ASSUMED_GRANT;
/** Days of gas each operator is funded for unless `--days` says otherwise: what fits in one
 * faucet grant for all four markets. */
export const DEFAULT_DAYS = 2;
export const MONTH_SECS = 30 * 86_400;

/** Gas burnt per call, Ggas, the worst figure measured on the sandbox. Sources: `integration/RESULTS.md`
 * (gas table, protocol 88, near-sandbox 2.14.0) unless marked; `contracts/README.md` for `settle`
 * and the full `clear`. Gas burnt is what a function-call key's allowance is charged
 * (RESULTS.md: 257.7 Tgas burnt, 0.0240 NEAR of allowance used). */
export const BURNT_GGAS = {
  report: 2_730n,
  /** Not measured; the same work as one `report` deciding a bucket, so taken as `report`. */
  finalize_print: 2_730n,
  commit: 3_600n,
  reveal: 3_330n,
  /** The keeper's books in the integration run, 6 to 9 commits. What our six agents produce. */
  clear: 4_920n,
  /** A round at `max_commits` (64), every commit filled: what anyone filling a round could cost. */
  clear_full: 25_500n,
  /** contracts/README.md: a `settle` that first decides 3 pending buckets. */
  settle: 3_200n,
  redeem: 2_520n,
  /** Not measured; taken as `prune_result` (2.24), the same kind of delete. */
  prune_print: 2_240n,
  prune_result: 2_240n,
  register: 2_230n,
  set_guard: 2_230n,
  deposit: 6_850n,
  storage_deposit: 1_950n,
  mint: 2_040n,
  /** Estimates for transactions of setup actions only (create, transfer, add key): their fees
   * are fractions of a Tgas each; the sandbox run reports the real figures. */
  add_key: 500n,
  create_subaccount: 1_000n,
} as const;

export const yocto = (ggas: bigint, gasPrice = MIN_GAS_PRICE): bigint => ggas * GGAS * gasPrice;
/** A transaction also buys its own fees (sending the transaction and its receipt) at the purchase
 * price: 0.92 Tgas for a 150 Tgas `clear` on the sandbox. Budgeted as 5 Tgas. */
export const TX_FEES_GGAS = 5_000n;
/** What sending a transaction that attaches `ggas` requires the signer (or key) to hold. */
export const purchase = (ggas: bigint): bigint => (ggas + TX_FEES_GGAS) * GGAS * GAS_PURCHASE_PRICE;
const ceilTo = (v: bigint, step: bigint) => ((v + step - 1n) / step) * step;

/** "1.234 NEAR" with three decimals, rounded up so a budget never reads smaller than it is. */
export function fmtNear(y: bigint, decimals = 3): string {
  const step = 10n ** BigInt(24 - decimals);
  const r = ceilTo(y < 0n ? -y : y, step) / step;
  const s = r.toString().padStart(decimals + 1, "0");
  const body = decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
  return `${y < 0n ? "-" : ""}${body} NEAR`;
}

export const fmtTgas = (ggas: bigint): string => `${(Number(ggas) / 1000).toFixed(2)} Tgas`;

/** Calls per month of one market, from its preset. */
export function rates(market: MarketId): { buckets: bigint; rounds: bigint; series: bigint } {
  const p = MARKETS[market].params;
  return {
    buckets: BigInt(Math.ceil(MONTH_SECS / p.print_interval_secs)),
    rounds: BigInt(Math.ceil(MONTH_SECS / (p.commit_secs + p.reveal_secs))),
    series: BigInt(Math.ceil(MONTH_SECS / p.period_secs)),
  };
}

/** One line of a monthly load: `calls` times `ggas`. */
export interface LoadLine {
  method: keyof typeof BURNT_GGAS;
  calls: bigint;
  ggas: bigint;
  why: string;
}

export const loadGgas = (lines: readonly LoadLine[]): bigint => lines.reduce((s, l) => s + l.calls * l.ggas, 0n);

/** A missed report leaves a bucket for `finalize_print`; budgeted as one bucket in ten. */
const FINALIZE_SHARE = 10n;

/** What one function-call key is expected to sign in a month. `worst` takes `clear` at a full
 * book (for the allowance, which must not run out); otherwise at our six agents' book (for the
 * NEAR the account is funded with). */
export function monthlyLoad(k: { methods: FcKeyPlan["methods"]; market: MarketId; agent?: AgentPlan }, worst: boolean): LoadLine[] {
  const r = rates(k.market);
  const clear = worst ? BURNT_GGAS.clear_full : BURNT_GGAS.clear;
  const clearWhy = worst ? "at a full book of 64 commits" : "at a book of 6 to 9 commits";
  if (k.methods === "reporter") {
    return [
      { method: "report", calls: r.buckets, ggas: BURNT_GGAS.report, why: "one report per print bucket" },
      { method: "finalize_print", calls: r.buckets / FINALIZE_SHARE, ggas: BURNT_GGAS.finalize_print, why: "one bucket in ten finalized after a missed report" },
    ];
  }
  if (k.methods === "agent") {
    const orders = k.agent?.spec.role === "maker" ? 2n : 1n;
    // The housekeeping account clears and settles; agents only trade and redeem.
    return [
      { method: "commit", calls: r.rounds * orders, ggas: BURNT_GGAS.commit, why: `${orders} order(s) every round` },
      { method: "reveal", calls: r.rounds * orders, ggas: BURNT_GGAS.reveal, why: "every order revealed" },
      { method: "redeem", calls: r.series, ggas: BURNT_GGAS.redeem, why: "one redeem per series" },
    ];
  }
  return [
    { method: worst ? "clear_full" : "clear", calls: r.rounds, ggas: clear, why: `every round cleared, ${clearWhy}` },
    { method: "settle", calls: r.series, ggas: BURNT_GGAS.settle, why: "every series settled" },
    { method: "finalize_print", calls: r.buckets / FINALIZE_SHARE, ggas: BURNT_GGAS.finalize_print, why: "one bucket in ten finalized" },
    { method: "prune_print", calls: r.buckets, ggas: BURNT_GGAS.prune_print, why: "every print pruned two periods on" },
    { method: "prune_result", calls: r.rounds, ggas: BURNT_GGAS.prune_result, why: "every round's result pruned after settlement" },
  ];
}

export const METHODS_OF = { reporter: REPORTER_KEY_METHODS, agent: AGENT_KEY_METHODS, keeper: KEEPER_KEY_METHODS } as const;

/** The most gas any method of the key attaches: the key must hold at least its price when a
 * transaction is submitted, even though it is charged only what is burnt. */
export function maxAttachedGgas(methods: FcKeyPlan["methods"]): bigint {
  return METHODS_OF[methods].reduce((m, x) => (CALLS[x].gas / GGAS > m ? CALLS[x].gas / GGAS : m), 0n);
}

/** Allowance margin over the worst-case month: gas prices above the minimum, calls not counted. */
export const ALLOWANCE_MARGIN_PCT = 125n;

export interface Allowance {
  key: FcKeyPlan;
  lines: LoadLine[];
  monthGgas: bigint;
  headroomGgas: bigint;
  allowance: bigint;
  /** "a × b + ..." as the plan prints it. */
  arithmetic: string;
}

export function allowanceFor(l: Layout, key: FcKeyPlan): Allowance {
  const agent = l.agents.find((a) => a.account === key.account && a.market === key.market);
  const lines = monthlyLoad({ methods: key.methods, market: key.market, ...(agent ? { agent } : {}) }, true);
  const monthGgas = loadGgas(lines);
  const headroomGgas = maxAttachedGgas(key.methods);
  const raw = (yocto(monthGgas) * ALLOWANCE_MARGIN_PCT) / 100n + purchase(headroomGgas);
  const allowance = ceilTo(raw, 10n * MILLINEAR);
  const arithmetic =
    `(${lines.map((x) => `${x.calls} ${x.method} x ${fmtTgas(x.ggas)}`).join(" + ")}) = ${fmtTgas(monthGgas)} a month; ` +
    `x ${MIN_GAS_PRICE} yocto/gas = ${fmtNear(yocto(monthGgas), 4)}; x ${ALLOWANCE_MARGIN_PCT}% + headroom for ${fmtTgas(headroomGgas)} attached and the transaction's fees ` +
    `bought at ${GAS_PURCHASE_PRICE} yocto/gas (${fmtNear(purchase(headroomGgas), 4)}) = ${fmtNear(raw, 4)}, rounded up to ${fmtNear(allowance, 2)}`;
  return { key, lines, monthGgas, headroomGgas, allowance, arithmetic };
}

/** Bytes an account's record and keys take (nearcore storage_usage_config: 100 per account,
 * 40 extra per record; an access key stores its borsh public key, 33 bytes, and its borsh
 * `AccessKey`). Matches the sandbox to the byte for the keeper's account with two market keys
 * (686, e2e-sandbox.json). */
export function storageBytes(_accountId: string, keys: readonly { receiver: string; methods: readonly string[] }[]): number {
  const keyRecord = 33 + 40 + 8;
  let bytes = 100 + keyRecord + 1;
  for (const k of keys) bytes += keyRecord + 1 + 17 + 4 + k.receiver.length + 4 + k.methods.reduce((s, m) => s + 4 + m.length, 0);
  return bytes;
}

export const storageStake = (bytes: number): bigint => (bytes <= ZERO_BALANCE_BYTES ? 0n : BigInt(bytes) * STORAGE_PER_BYTE);

export interface OperatorBudget {
  account: string;
  role: "reporter" | "agent" | "keeper";
  /** Gas of its own setup transactions (deposit, guard, keys). */
  setupGgas: bigint;
  /** Gas a day at the expected load, all its keys together. */
  dailyGgas: bigint;
  /** Gas a month at the expected load. */
  monthGgas: bigint;
  /** Kept, never spent: the purchase price of the most gas its keys attach, plus storage stake. */
  keepYocto: bigint;
  /** What it must hold when it sends its setup transactions (the deposit attaches 100 Tgas). */
  setupHeadroom: bigint;
  storageBytes: number;
  /** What the ops account transfers to it when creating it. */
  funding: bigint;
}

export function operatorBudgets(l: Layout, days: number): OperatorBudget[] {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days must be a whole number from 1 to 365");
  const keys = fcKeys(l);
  const out: OperatorBudget[] = [];
  for (const a of l.accounts) {
    if (a.role !== "reporter" && a.role !== "agent" && a.role !== "keeper") continue;
    const mine = keys.filter((k) => k.account === a.id);
    let monthGgas = 0n;
    let maxAttached = 0n;
    for (const k of mine) {
      const agent = l.agents.find((x) => x.account === k.account);
      const att = maxAttachedGgas(k.methods);
      if (att > maxAttached) maxAttached = att;
      monthGgas += loadGgas(monthlyLoad({ methods: k.methods, market: k.market, ...(agent ? { agent } : {}) }, false));
    }
    let setupGgas = BigInt(mine.length) * BURNT_GGAS.add_key;
    // Its own setup transactions: add-key ones attach no gas; an agent's deposit attaches 100 Tgas
    // and its set_guard 10, each bought at the purchase price when sent and mostly refunded.
    let setupHeadroom = 0n;
    if (a.role === "agent") {
      setupGgas += BURNT_GGAS.deposit + BURNT_GGAS.set_guard;
      setupHeadroom = purchase(TOKEN_CALLS.ft_transfer_call.gas / GGAS) + 2n;
    }
    const bytes = storageBytes(a.id, mine.map((k) => ({ receiver: k.receiver, methods: METHODS_OF[k.methods] })));
    const keepYocto = purchase(maxAttached) + storageStake(bytes);
    const dailyGgas = monthGgas / 30n;
    const float = yocto(dailyGgas) * BigInt(days) + keepYocto;
    // The setup headroom is needed only while setting up, before any trading gas is spent.
    const funding = ceilTo(yocto(setupGgas) + (float > setupHeadroom + storageStake(bytes) ? float : setupHeadroom + storageStake(bytes)), MILLINEAR);
    out.push({ account: a.id, role: a.role, setupGgas, dailyGgas, monthGgas, keepYocto, setupHeadroom, storageBytes: bytes, funding });
  }
  return out;
}

export interface OpsBudget {
  transfers: bigint;
  creation: bigint;
  storageDeposits: bigint;
  registrations: bigint;
  gasGgas: bigint;
  keep: bigint;
  total: bigint;
  lines: string[];
}

/** What the ops account pays out of its grant: every operator's funding, a token storage
 * record for every market contract and operator, a market registration for every agent and
 * for the keeper on every market, and the gas of all the transactions it signs. */
export function opsBudget(l: Layout, ops: readonly OperatorBudget[]): OpsBudget {
  const transfers = ops.reduce((s, o) => s + o.funding, 0n);
  const nStorage = BigInt(l.markets.length + ops.length);
  const nRegister = BigInt(l.agents.length + l.markets.length);
  const nMint = BigInt(l.agents.length);
  const storageDeposits = nStorage * STORAGE_DEPOSIT;
  const registrations = nRegister * REGISTRATION_FEE;
  const gasGgas =
    BigInt(ops.length) * BURNT_GGAS.create_subaccount +
    nStorage * BURNT_GGAS.storage_deposit +
    nMint * BURNT_GGAS.mint +
    nRegister * BURNT_GGAS.register;
  const creation = BigInt(ops.length) * ACCOUNT_CREATION_CHARGE;
  const keep = purchase(CALLS.register.gas / GGAS) + REGISTRATION_FEE;
  const total = transfers + creation + storageDeposits + registrations + yocto(gasGgas) + keep;
  const lines = [
    `${ops.length} operator accounts funded: ${fmtNear(transfers)}`,
    `${ops.length} account creation charges x ${fmtNear(ACCOUNT_CREATION_CHARGE)}: ${fmtNear(creation)}`,
    `${nStorage} token storage records x ${fmtNear(STORAGE_DEPOSIT, 5)}: ${fmtNear(storageDeposits)}`,
    `${nRegister} market registrations x ${fmtNear(REGISTRATION_FEE, 2)}: ${fmtNear(registrations)}`,
    `gas of ${BigInt(ops.length) + nStorage + nMint + nRegister} transactions it signs, ${fmtTgas(gasGgas)}: ${fmtNear(yocto(gasGgas))}`,
    `kept to send its last transaction (10 Tgas bought at ${GAS_PURCHASE_PRICE} yocto/gas, plus 0.02 NEAR attached): ${fmtNear(keep)}`,
  ];
  return { transfers, creation, storageDeposits, registrations, gasGgas, keep, total, lines };
}

/** What a contract account needs: its code's storage, plus the deploy transaction. The rest of
 * its grant pays for the state it accumulates (SPEC section 14). */
export function contractNeed(codeBytes: number, deployAttachedTgas: bigint): { storage: bigint; prepaid: bigint; total: bigint } {
  const storage = BigInt(codeBytes + 100 + 200) * STORAGE_PER_BYTE;
  const prepaid = purchase(deployAttachedTgas * 1000n);
  return { storage, prepaid, total: storage + prepaid };
}

/** The monthly gas of every operator together, and the days the ops grant would carry them. */
export function monthlyTotal(ops: readonly OperatorBudget[]): bigint {
  return yocto(ops.reduce((s, o) => s + o.monthGgas, 0n));
}

/** Storage one final print with three reports adds to a market contract: 516 bytes, measured on
 * the sandbox (deploy/e2e, `print_storage`). A print is the only record that accrues every
 * bucket whoever trades; the keeper prunes it two periods later. */
export const PRINT_BYTES = 516n;

/** NEAR a market contract's storage grows by in a day if nothing is pruned. */
export function storageGrowthPerDay(market: MarketId): bigint {
  return BigInt(86_400 / MARKETS[market].params.print_interval_secs) * PRINT_BYTES * STORAGE_PER_BYTE;
}

/** What running one market costs a day at the expected load: its three reporters' reports, its
 * six agents' trading and the keeper's housekeeping, all at the worst measured gas, plus the
 * contract's storage growth if prints are not pruned (with pruning it levels off at two periods
 * of prints). */
export function marketDailyCost(l: Layout, market: MarketId): { reporters: bigint; agents: bigint; keeper: bigint; gas: bigint; storageUnpruned: bigint } {
  const keys = fcKeys(l).filter((k) => k.market === market);
  const sum = (m: FcKeyPlan["methods"]) =>
    keys.filter((k) => k.methods === m).reduce((s, k) => {
      const agent = l.agents.find((a) => a.account === k.account && a.market === market);
      return s + yocto(loadGgas(monthlyLoad({ methods: k.methods, market, ...(agent ? { agent } : {}) }, false))) / 30n;
    }, 0n);
  const reporters = sum("reporter");
  const agents = sum("agent");
  const keeper = sum("keeper");
  return { reporters, agents, keeper, gas: reporters + agents + keeper, storageUnpruned: storageGrowthPerDay(market) };
}
