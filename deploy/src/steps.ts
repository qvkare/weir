// The ordered list of transactions a deployment consists of. Pure: built from the layout and
// the budget alone, so `plan` prints exactly the list `apply` works through.
import { MARKETS, type MarketId } from "../../agents/src/presets.ts";
import { CALLS, REGISTRATION_FEE } from "../../chain/src/weir.ts";
import { STORAGE_DEPOSIT, TOKEN_CALLS } from "../../chain/src/token.ts";
import { allowanceFor, fmtNear, METHODS_OF, operatorBudgets, TGAS, type OperatorBudget } from "./budget.ts";
import { fcKeys, type AgentPlan, type FcKeyPlan, type Layout } from "./layout.ts";

export type StepKind = "create-top" | "deploy-usdc" | "create-sub" | "deploy-market" | "storage" | "mint" | "register" | "deposit" | "guard" | "add-key";

/** Gas attached to `new(params)` in the deploy transaction. */
export const NEW_GAS_TGAS = 100n;

export interface Step {
  /** Stable across runs: the key of the state file. */
  id: string;
  kind: StepKind;
  purpose: string;
  /** Who signs: an account, or "faucet" / the sandbox root for a top-level account. */
  signer: string;
  receiver: string;
  /** NEAR attached: transfers plus deposits. */
  attached: bigint;
  /** Gas attached to function calls, in Tgas (0 for transactions of setup actions only). */
  gasTgas: bigint;
  account?: string;
  market?: MarketId;
  agent?: AgentPlan;
  key?: FcKeyPlan & { methodNames: readonly string[]; allowance: bigint };
}

export interface Plan {
  layout: Layout;
  days: number;
  budgets: OperatorBudget[];
  steps: Step[];
}

export function buildPlan(l: Layout, days: number): Plan {
  const budgets = operatorBudgets(l, days);
  const fundingOf = (id: string) => budgets.find((b) => b.account === id)!.funding;
  const creator = l.network.creation === "faucet" ? "faucet" : l.network.root;
  const s: Step[] = [];
  const top = l.accounts.filter((a) => a.createdBy === "top-level");
  for (const a of top) {
    s.push({ id: `account:${a.id}`, kind: "create-top", purpose: `create ${a.id}: ${a.why}`, signer: creator, receiver: a.id, attached: 0n, gasTgas: 0n, account: a.id, ...(a.market ? { market: a.market } : {}) });
  }
  s.push({ id: `deploy:${l.usdc}`, kind: "deploy-usdc", purpose: "deploy mock_usdc.wasm (no init: its state starts empty)", signer: l.usdc, receiver: l.usdc, attached: 0n, gasTgas: 0n, account: l.usdc });
  for (const a of l.accounts.filter((x) => x.createdBy === "ops")) {
    s.push({
      id: `account:${a.id}`, kind: "create-sub", purpose: `create ${a.id} with a full-access key, funded for its gas`,
      signer: l.ops, receiver: a.id, attached: fundingOf(a.id), gasTgas: 0n, account: a.id, ...(a.market ? { market: a.market } : {}),
    });
  }
  for (const m of l.markets) {
    const c = l.contracts[m]!;
    s.push({ id: `deploy:${c}`, kind: "deploy-market", purpose: `deploy weir.wasm and call new(params) in the same transaction (${MARKETS[m].label}; t0 chosen when sent)`, signer: c, receiver: c, attached: 0n, gasTgas: NEW_GAS_TGAS, account: c, market: m });
  }
  const storageFor = [...l.markets.map((m) => l.contracts[m]!), ...l.accounts.filter((a) => a.createdBy === "ops").map((a) => a.id)];
  for (const id of storageFor) {
    s.push({ id: `storage:${id}`, kind: "storage", purpose: `token storage_deposit for ${id}`, signer: l.ops, receiver: l.usdc, attached: STORAGE_DEPOSIT, gasTgas: TOKEN_CALLS.storage_deposit.gas / TGAS, account: id });
  }
  for (const a of l.agents) {
    s.push({ id: `mint:${a.account}`, kind: "mint", purpose: `mint $${(Number(a.deposit) / 1e6).toFixed(2)} test dollars to ${a.account}`, signer: l.ops, receiver: l.usdc, attached: 0n, gasTgas: TOKEN_CALLS.mint.gas / TGAS, account: a.account, agent: a, market: a.market });
  }
  for (const m of l.markets) {
    const regs = [...l.agents.filter((a) => a.market === m).map((a) => a.account), l.keeper];
    for (const id of regs) {
      s.push({ id: `register:${m}:${id}`, kind: "register", purpose: `register ${id} on ${m}`, signer: l.ops, receiver: l.contracts[m]!, attached: REGISTRATION_FEE, gasTgas: CALLS.register.gas / TGAS, account: id, market: m });
    }
  }
  for (const a of l.agents) {
    s.push({ id: `deposit:${a.account}`, kind: "deposit", purpose: `${a.account} deposits $${(Number(a.deposit) / 1e6).toFixed(2)} into ${a.market} (ft_transfer_call)`, signer: a.account, receiver: l.usdc, attached: TOKEN_CALLS.ft_transfer_call.deposit, gasTgas: TOKEN_CALLS.ft_transfer_call.gas / TGAS, account: a.account, agent: a, market: a.market });
  }
  for (const a of l.agents) {
    s.push({
      id: `guard:${a.account}`, kind: "guard", purpose: `${a.account} sets guard $${(a.guard / 1e6).toFixed(3)} and max_round_lock $${a.maxRoundLock / 1_000_000n}`,
      signer: a.account, receiver: l.contracts[a.market]!, attached: CALLS.set_guard.deposit, gasTgas: CALLS.set_guard.gas / TGAS, account: a.account, agent: a, market: a.market,
    });
  }
  for (const k of fcKeys(l)) {
    const al = allowanceFor(l, k);
    s.push({
      id: `key:${k.account}:${k.receiver}`, kind: "add-key", purpose: `${k.account} adds a function-call key for ${k.receiver} (${k.methods} methods, allowance ${fmtNear(al.allowance, 2)})`,
      signer: k.account, receiver: k.account, attached: 0n, gasTgas: 0n, account: k.account, market: k.market,
      key: { ...k, methodNames: METHODS_OF[k.methods], allowance: al.allowance },
    });
  }
  return { layout: l, days, budgets, steps: s };
}
