// `status`: reads the chain and reports, for every contract account, its code against the
// local wasm, its keys, its NEAR and storage, and its parameters against MARKETS; for every
// operator, its keys with their remaining allowances and its balances. `problems` lists
// everything that is not as the plan says; `notes` what is worth knowing but not wrong.
import type { WireAccount, WireParams } from "../../engine/src/mod.ts";
import { allowanceFor, fmtNear, maxAttachedGgas, operatorBudgets, purchase, STORAGE_PER_BYTE, storageGrowthPerDay, yocto } from "./budget.ts";
import { keyDailyUse } from "./topup.ts";
import type { DeployChain, KeyView } from "./chain.ts";
import type { Keystore } from "./keys.ts";
import { fcKeys, type Layout } from "./layout.ts";
import { expectedParams, paramsDiff, type State } from "./state.ts";
import { gridFor } from "./t0.ts";
import type { Wasm } from "./wasm.ts";
import { MARKETS } from "../../agents/src/presets.ts";

export interface KeyRow {
  public_key: string;
  kind: "full access" | "function call";
  receiver?: string;
  methods?: string[];
  /** Remaining allowance in yoctoNEAR, null for an unlimited one. */
  allowance?: string | null;
  /** Ours: the key this tool generated and saved. */
  ours: boolean;
  /** Days its remaining allowance lasts at the expected load (planned keys only). */
  days_left?: number | null;
}

export interface AccountRow {
  account: string;
  role: string;
  market?: string;
  exists: boolean;
  balance: string;
  locked: string;
  storage_usage: number;
  /** NEAR the storage usage locks, yocto. */
  storage_cost: string;
  code_hash: string;
  keys: KeyRow[];
}

export interface ContractRow extends AccountRow {
  expected_code_hash: string;
  code_ok: boolean;
  sealed: boolean;
  params: WireParams | null;
  params_diff: string[];
  /** Days its spare balance pays for storage growth if no print is pruned (markets only). */
  days_left: number | null;
}

export interface OperatorRow extends AccountRow {
  /** Its record on each market it trades or keeps (agents and the keeper). */
  markets: Record<string, WireAccount | null>;
  token_balance: string | null;
  /** Days of gas left at the planned daily load. */
  days_left: number | null;
  /** Agents: days of commit fees its free test dollars cover at one commit per order per round. */
  dollar_days_left?: number;
}

export interface StatusReport {
  network: string;
  suffix: string;
  chain_now: number;
  contracts: ContractRow[];
  operators: OperatorRow[];
  problems: string[];
  notes: string[];
}

function keyRow(k: KeyView, ours: Set<string>): KeyRow {
  if (k.permission === "FullAccess") return { public_key: k.public_key, kind: "full access", ours: ours.has(k.public_key) };
  const p = k.permission.FunctionCall;
  return { public_key: k.public_key, kind: "function call", receiver: p.receiver_id, methods: [...p.method_names], allowance: p.allowance, ours: ours.has(k.public_key) };
}

async function accountRow(chain: DeployChain, id: string, role: string, ours: Set<string>, market?: string): Promise<AccountRow> {
  const a = await chain.account(id);
  const keys = a ? (await chain.keys(id)).map((k) => keyRow(k, ours)) : [];
  return {
    account: id, role, ...(market ? { market } : {}), exists: a !== null,
    balance: a?.amount ?? "0", locked: a?.locked ?? "0", storage_usage: a?.storage_usage ?? 0,
    storage_cost: (BigInt(a?.storage_usage ?? 0) * STORAGE_PER_BYTE).toString(), code_hash: a?.code_hash ?? "", keys,
  };
}

export async function status(l: Layout, state: State | null, chain: DeployChain, keys: Keystore, wasm: { weir: Wasm; usdc: Wasm }, days = 3): Promise<StatusReport> {
  const problems: string[] = [];
  const notes: string[] = [];
  const ours = new Set<string>();
  for (const a of l.accounts) {
    const fa = await keys.existingFullAccess(a.id);
    if (fa) ours.add(fa.publicKeyString);
  }
  const planned = fcKeys(l);
  for (const k of planned) {
    const kp = await keys.existingFunctionCall(k.account, k.receiver);
    if (kp) ours.add(kp.publicKeyString);
  }
  const chainNow = await chain.now();

  const contracts: ContractRow[] = [];
  for (const a of l.accounts.filter((x) => x.role === "market" || x.role === "usdc")) {
    const row = await accountRow(chain, a.id, a.role, ours, a.market);
    const w = a.role === "market" ? wasm.weir : wasm.usdc;
    const c: ContractRow = { ...row, expected_code_hash: w.codeHash, code_ok: row.code_hash === w.codeHash, sealed: row.exists && row.keys.length === 0, params: null, params_diff: [], days_left: null };
    if (a.role === "market" && row.exists) c.days_left = days2((BigInt(row.balance) - BigInt(row.storage_cost)) * 100n / storageGrowthPerDay(a.market!));
    if (!row.exists) problems.push(`${a.id} does not exist`);
    else if (!c.code_ok) problems.push(`${a.id}: code hash ${row.code_hash} is not the local ${w.name}.wasm (${w.codeHash})`);
    if (a.role === "market" && c.code_ok) {
      const m = a.market!;
      c.params = await chain.view<WireParams>(a.id, "get_params", {});
      c.params_diff = paramsDiff(c.params, expectedParams(l, m, c.params.t0));
      for (const d of c.params_diff) problems.push(`${a.id}: ${d}`);
      const g = gridFor(MARKETS[m].params);
      if ((c.params.t0 - g.offset) % g.step !== 0) problems.push(`${a.id}: t0 ${c.params.t0} is not on ${g.name}`);
      const recorded = state?.t0[m]?.t0;
      if (recorded !== undefined && recorded !== c.params.t0) problems.push(`${a.id}: t0 ${c.params.t0} differs from the ${recorded} in the state file`);
    }
    if (row.exists) {
      const free = BigInt(row.balance) - BigInt(row.storage_cost);
      if (free < 0n) problems.push(`${a.id}: its balance no longer covers its storage`);
      if (a.role === "market") notes.push(`${a.id}: ${c.sealed ? "sealed (no keys)" : `${row.keys.length} key(s), not sealed`}; ${fmtNear(free)} free for storage beyond the ${row.storage_usage} bytes it uses`);
    }
    contracts.push(c);
  }

  const budgets = operatorBudgets(l, days);
  const operators: OperatorRow[] = [];
  for (const a of l.accounts.filter((x) => x.role === "reporter" || x.role === "agent" || x.role === "keeper" || x.role === "ops")) {
    const row = await accountRow(chain, a.id, a.role, ours, a.market);
    const op: OperatorRow = { ...row, markets: {}, token_balance: null, days_left: null };
    if (!row.exists) {
      problems.push(`${a.id} does not exist`);
      operators.push(op);
      continue;
    }
    for (const k of planned.filter((x) => x.account === a.id)) {
      const kp = await keys.existingFunctionCall(k.account, k.receiver);
      const on = kp ? row.keys.find((x) => x.public_key === kp.publicKeyString) : undefined;
      if (!on) {
        problems.push(`${a.id}: no function-call key for ${k.receiver}`);
        continue;
      }
      if (on.receiver !== k.receiver) problems.push(`${a.id}: key ${on.public_key} is for ${on.receiver}, expected ${k.receiver}`);
      if (on.allowance) on.days_left = days2((BigInt(on.allowance) - purchase(maxAttachedGgas(k.methods))) * 100n / keyDailyUse(l, k));
      const planAllowance = allowanceFor(l, k).allowance;
      if (on.allowance !== null && on.allowance !== undefined && BigInt(on.allowance) * 10n < planAllowance) {
        problems.push(`${a.id}: the key for ${k.receiver} has ${fmtNear(BigInt(on.allowance))} of allowance left, under a tenth of ${fmtNear(planAllowance, 2)}; add a new key before it runs out`);
      }
    }
    const b = budgets.find((x) => x.account === a.id);
    if (b && b.dailyGgas > 0n) op.days_left = days2(((BigInt(row.balance) - b.keepYocto) * 100n) / yocto(b.dailyGgas));
    if (op.days_left !== null && op.days_left < 1) problems.push(`${a.id}: about ${op.days_left} days of gas left at the planned load; send it NEAR`);
    if (a.role === "agent" || a.role === "keeper") {
      const ms = a.role === "agent" ? [a.market!] : l.markets;
      for (const m of ms) {
        const acct = await chain.view<WireAccount | null>(l.contracts[m]!, "get_account", { account_id: a.id }).catch(() => null);
        op.markets[m] = acct;
        if (!acct) problems.push(`${a.id} is not registered on ${m}`);
      }
      if (a.role === "agent") {
        const plan = l.agents.find((x) => x.account === a.id)!;
        const acct = op.markets[a.market!];
        if (acct) op.dollar_days_left = days2((BigInt(acct.balance) * 100n) / plan.feesPerDay);
        if (acct && (acct.guard !== plan.guard || acct.max_round_lock !== plan.maxRoundLock.toString())) {
          problems.push(`${a.id}: guard ${acct.guard} and max_round_lock ${acct.max_round_lock}, planned ${plan.guard} and ${plan.maxRoundLock}`);
        }
      }
    }
    op.token_balance = await chain.view<string>(l.usdc, "ft_balance_of", { account_id: a.id }).catch(() => null);
    operators.push(op);
  }
  return { network: l.network.id, suffix: l.suffix, chain_now: chainNow, contracts, operators, problems, notes };
}

const short = (k: string) => `${k.slice(0, 16)}...`;
/** Hundredths of a day to days, never below zero. */
function days2(hundredths: bigint): number {
  return hundredths < 0n ? 0 : Number(hundredths) / 100;
}

function keysText(keys: KeyRow[]): string[] {
  if (keys.length === 0) return ["    keys: none"];
  return keys.map((k) =>
    k.kind === "full access"
      ? `    key ${short(k.public_key)} full access${k.ours ? "" : " (not generated by this tool)"}`
      : `    key ${short(k.public_key)} function call on ${k.receiver} [${k.methods!.join(", ")}], allowance left ${k.allowance === null ? "unlimited" : fmtNear(BigInt(k.allowance!), 4)}${k.days_left != null ? ` (${k.days_left} days)` : ""}${k.ours ? "" : " (not ours)"}`,
  );
}

export function renderStatus(r: StatusReport): string {
  const out: string[] = [`Weir deployment status: ${r.network}, suffix ${r.suffix}, chain time ${new Date(r.chain_now * 1000).toISOString()}`, ""];
  out.push("Contracts");
  for (const c of r.contracts) {
    if (!c.exists) {
      out.push(`  ${c.account}: missing`);
      continue;
    }
    out.push(`  ${c.account} (${c.role}${c.market ? ` ${c.market}` : ""})`);
    out.push(`    code ${c.code_hash} ${c.code_ok ? "= local wasm" : `!= local wasm ${c.expected_code_hash}`}`);
    out.push(`    balance ${fmtNear(BigInt(c.balance), 4)}, storage ${c.storage_usage} bytes (${fmtNear(BigInt(c.storage_cost), 4)} locked by it)`);
    if (c.params) out.push(`    params ${c.params_diff.length === 0 ? "= MARKETS preset with usdc, reporters and t0 replaced" : `differ: ${c.params_diff.join("; ")}`}; t0 ${c.params.t0} (${new Date(c.params.t0 * 1000).toISOString()})`);
    if (c.days_left !== null) out.push(`    days left: ${c.days_left} of storage growth if no print is pruned`);
    out.push(c.sealed ? "    sealed: no access keys, the code can never change" : `    not sealed: ${c.keys.length} key(s)`);
    out.push(...keysText(c.keys));
  }
  out.push("", "Operators");
  for (const o of r.operators) {
    if (!o.exists) {
      out.push(`  ${o.account}: missing`);
      continue;
    }
    out.push(`  ${o.account} (${o.role}): ${fmtNear(BigInt(o.balance), 4)}, storage ${o.storage_usage} bytes${o.token_balance !== null ? `, ${(Number(o.token_balance) / 1e6).toFixed(2)} tUSDC in wallet` : ""}`);
    out.push(`    days left: ${o.days_left === null ? "n/a (pays only for setup and top-ups)" : `${o.days_left} of gas at the expected load`}${o.dollar_days_left !== undefined ? `; ${o.dollar_days_left} of commit fees in test dollars` : ""}`);
    for (const [m, a] of Object.entries(o.markets)) {
      out.push(a ? `    on ${m}: free $${(Number(a.balance) / 1e6).toFixed(2)}, guard ${a.guard ?? "none"}, max_round_lock ${a.max_round_lock ?? "none"}` : `    on ${m}: not registered`);
    }
    out.push(...keysText(o.keys));
  }
  out.push("", r.problems.length === 0 ? "Problems: none" : `Problems (${r.problems.length}):`);
  for (const p of r.problems) out.push(`  - ${p}`);
  if (r.notes.length > 0) out.push("Notes:", ...r.notes.map((n) => `  - ${n}`));
  return out.join("\n");
}
