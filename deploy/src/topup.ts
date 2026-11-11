// `topup`: keeps a deployment running for N more days. It reads every operator's and contract's
// balance and every function-call key's remaining allowance, works out what N days need at the
// budget's measured rates, and covers the shortfall:
//   1. if the ops account cannot pay for it, fresh top-level accounts (the faucet on testnet,
//      the root on the sandbox) named weir-fund-<suffix>-<n> are created and swept into ops,
//      each left with FUND_KEEP so it still exists;
//   2. ops sends each short operator enough for N days (plus a tenth, so a re-run right after
//      finds nothing to do), and each market contract whose spare balance covers less than N
//      days of unpruned storage growth enough for N days;
//   3. a key whose allowance will not last N days (NEAR cannot raise an allowance) is replaced:
//      a new key for the same contract and methods is saved, added on chain, written into
//      keeper.env, and only then is the old key deleted.
// Every step reads the chain first, so a re-run after a crash or a faucet outage resumes.
import { MARKETS, type MarketId } from "../../agents/src/presets.ts";
import type { KeyPair } from "../../chain/src/tx.ts";
import { TOKEN_CALLS } from "../../chain/src/token.ts";
import {
  allowanceFor,
  ASSUMED_GRANT,
  fmtNear,
  loadGgas,
  maxAttachedGgas,
  METHODS_OF,
  MILLINEAR,
  monthlyLoad,
  operatorBudgets,
  purchase,
  STORAGE_PER_BYTE,
  storageGrowthPerDay,
  yocto,
} from "./budget.ts";
import type { DeployChain, KeyView } from "./chain.ts";
import type { Keystore } from "./keys.ts";
import { fcKeys, type FcKeyPlan, type Layout } from "./layout.ts";
import { writeState, type State } from "./state.ts";

/** What a swept fund account keeps: enough to exist (a bare account is under NEP-448's 770
 * free bytes) and to send one more transaction. */
export const FUND_KEEP = 10n * MILLINEAR;
/** Top-ups add this share of the N-day need on top, so a re-run straight after finds nothing short. */
export const MARGIN_PCT = 10n;
export const DEFAULT_TOPUP_DAYS = 14;

const ceilMilli = (v: bigint) => ((v + MILLINEAR - 1n) / MILLINEAR) * MILLINEAR;

export interface TopupInputs {
  layout: Layout;
  days: number;
  opsBalance: bigint;
  /** Balance of every operator (reporters, agents, keeper). */
  operators: Record<string, bigint>;
  /** Balance and storage of every market contract. */
  contracts: Record<string, { balance: bigint; storage: number }>;
  /** The current key of each planned (account, contract): its public key and remaining allowance (null: unlimited or missing). */
  keys: { key: FcKeyPlan; publicKey: string | null; allowance: bigint | null }[];
  /** Each agent's free balance on its market, micro-USDC. */
  agentFree: Record<string, bigint>;
}

/** Test dollars for an agent: minted to it by ops (the test token's open mint), then deposited
 * by the agent with its full-access key. */
export interface DollarTopup {
  agent: string;
  market: MarketId;
  amount: bigint;
  why: string;
}

export interface Transfer {
  to: string;
  amount: bigint;
  why: string;
}

export interface Rotation {
  key: FcKeyPlan;
  oldPublicKey: string;
  remaining: bigint;
  need: bigint;
  newAllowance: bigint;
}

export interface TopupPlan {
  dollarTopups: DollarTopup[];
  operatorTransfers: Transfer[];
  contractTransfers: Transfer[];
  rotations: Rotation[];
  /** What ops must pay out, and what it must keep to send it all. */
  need: bigint;
  opsBalance: bigint;
  /** What the fund accounts must bring in (0 when ops can pay). */
  shortfall: bigint;
  /** Fund accounts needed at the assumed grant. */
  fundAccounts: number;
}

/** A key's expected use for one day, in yoctoNEAR of allowance (charged at the gas burnt). */
export function keyDailyUse(l: Layout, k: FcKeyPlan): bigint {
  const agent = l.agents.find((a) => a.account === k.account && a.market === k.market);
  return yocto(loadGgas(monthlyLoad({ methods: k.methods, market: k.market, ...(agent ? { agent } : {}) }, false))) / 30n;
}

export function planTopup(i: TopupInputs): TopupPlan {
  if (!Number.isInteger(i.days) || i.days < 1 || i.days > 365) throw new Error("--days must be a whole number from 1 to 365");
  const days = BigInt(i.days);
  const l = i.layout;
  const budgets = operatorBudgets(l, 1);
  const operatorTransfers: Transfer[] = [];
  for (const b of budgets) {
    const have = i.operators[b.account] ?? 0n;
    const target = yocto(b.dailyGgas) * days + b.keepYocto;
    if (have >= target) continue;
    const amount = ceilMilli(target - have + (yocto(b.dailyGgas) * days * MARGIN_PCT) / 100n);
    operatorTransfers.push({ to: b.account, amount, why: `holds ${fmtNear(have)}; ${i.days} days at ${fmtNear(yocto(b.dailyGgas), 4)} a day plus ${fmtNear(b.keepYocto)} kept need ${fmtNear(target)}` });
  }
  const contractTransfers: Transfer[] = [];
  for (const m of l.markets) {
    const id = l.contracts[m]!;
    const c = i.contracts[id];
    if (!c) continue;
    const spare = c.balance - BigInt(c.storage) * STORAGE_PER_BYTE;
    const growth = storageGrowthPerDay(m) * days;
    if (spare >= growth) continue;
    const amount = ceilMilli(growth - spare + (growth * MARGIN_PCT) / 100n);
    contractTransfers.push({ to: id, amount, why: `${fmtNear(spare)} spare covers less than ${i.days} days of unpruned prints (${fmtNear(storageGrowthPerDay(m))} a day)` });
  }
  // An agent is short of test dollars when its free balance covers less than N days of commit
  // fees plus half its working balance; it is brought back to its working balance plus N days.
  const dollarTopups: DollarTopup[] = [];
  for (const a of l.agents) {
    const free = i.agentFree[a.account];
    if (free === undefined) continue;
    const fees = a.feesPerDay * days;
    if (free >= fees + a.working / 2n) continue;
    const want = a.working + fees - free;
    const amount = ((want + 999_999n) / 1_000_000n) * 1_000_000n;
    dollarTopups.push({ agent: a.account, market: a.market, amount, why: `$${(Number(free) / 1e6).toFixed(2)} free; ${i.days} days of fees ($${(Number(fees) / 1e6).toFixed(2)}) plus a $${(Number(a.working) / 1e6).toFixed(2)} working balance` });
  }
  const rotations: Rotation[] = [];
  for (const k of i.keys) {
    if (k.publicKey === null || k.allowance === null) continue;
    const need = keyDailyUse(l, k.key) * days + purchase(maxAttachedGgas(k.key.methods));
    if (k.allowance >= need) continue;
    const month = allowanceFor(l, k.key).allowance;
    const scaled = ceilMilli((need * 125n) / 100n);
    rotations.push({ key: k.key, oldPublicKey: k.publicKey, remaining: k.allowance, need, newAllowance: month > scaled ? month : scaled });
  }
  // Each transfer from ops attaches no gas but buys its own fees; keep enough for the last one.
  const out = [...operatorTransfers, ...contractTransfers].reduce((s, t) => s + t.amount, 0n);
  const fees = BigInt(operatorTransfers.length + contractTransfers.length + 1) * purchase(0n);
  const need = out + fees;
  const shortfall = i.opsBalance >= need ? 0n : need - i.opsBalance;
  const perFund = ASSUMED_GRANT - FUND_KEEP - purchase(0n);
  const fundAccounts = Number((shortfall + perFund - 1n) / perFund);
  return { dollarTopups, operatorTransfers, contractTransfers, rotations, need, opsBalance: i.opsBalance, shortfall, fundAccounts };
}

export function renderTopup(p: TopupPlan, days: number): string {
  const o = [`Top-up for ${days} more days at the measured rates`];
  o.push(`  ops holds ${fmtNear(p.opsBalance)} and would pay out ${fmtNear(p.need)}${p.shortfall > 0n ? `: short by ${fmtNear(p.shortfall)}, about ${p.fundAccounts} fund account(s) at ${fmtNear(ASSUMED_GRANT, 0)} each` : ""}`);
  for (const t of p.operatorTransfers) o.push(`  send ${fmtNear(t.amount)} to ${t.to}: ${t.why}`);
  for (const t of p.contractTransfers) o.push(`  send ${fmtNear(t.amount)} to ${t.to}: ${t.why}`);
  for (const d of p.dollarTopups) o.push(`  mint and deposit $${(Number(d.amount) / 1e6).toFixed(2)} test dollars for ${d.agent}: ${d.why}`);
  for (const r of p.rotations) {
    o.push(`  replace ${r.key.account}'s key for ${r.key.receiver}: ${fmtNear(r.remaining, 4)} of allowance left, ${days} days need ${fmtNear(r.need, 4)}; new key with ${fmtNear(r.newAllowance, 2)}, then the old one deleted`);
  }
  if (p.operatorTransfers.length + p.contractTransfers.length + p.rotations.length + p.dollarTopups.length === 0) o.push("  nothing is short");
  return o.join("\n");
}

const allowanceOf = (k: KeyView | undefined): bigint | null =>
  !k || k.permission === "FullAccess" ? null : k.permission.FunctionCall.allowance === null ? null : BigInt(k.permission.FunctionCall.allowance);

/** Reads what `planTopup` needs from the chain. */
export async function readTopupInputs(l: Layout, days: number, chain: DeployChain, keys: Keystore): Promise<TopupInputs> {
  const balance = async (id: string) => BigInt((await chain.account(id))?.amount ?? "0");
  const operators: Record<string, bigint> = {};
  for (const a of l.accounts.filter((x) => x.role === "reporter" || x.role === "agent" || x.role === "keeper")) operators[a.id] = await balance(a.id);
  const contracts: TopupInputs["contracts"] = {};
  for (const m of l.markets) {
    const a = await chain.account(l.contracts[m]!);
    if (a) contracts[l.contracts[m]!] = { balance: BigInt(a.amount), storage: a.storage_usage };
  }
  const onChain = new Map<string, KeyView[]>();
  const keyRows: TopupInputs["keys"] = [];
  for (const k of fcKeys(l)) {
    if (!onChain.has(k.account)) onChain.set(k.account, await chain.keys(k.account));
    const kp = await keys.existingFunctionCall(k.account, k.receiver);
    const view = kp ? onChain.get(k.account)!.find((x) => x.public_key === kp.publicKeyString) : undefined;
    keyRows.push({ key: k, publicKey: view ? view.public_key : null, allowance: allowanceOf(view) });
  }
  const agentFree: Record<string, bigint> = {};
  for (const a of l.agents) {
    const acc = await chain.view<{ balance: string } | null>(l.contracts[a.market]!, "get_account", { account_id: a.account }).catch(() => null);
    if (acc) agentFree[a.account] = BigInt(acc.balance);
  }
  return { layout: l, days, opsBalance: await balance(l.ops), operators, contracts, keys: keyRows, agentFree };
}

export interface TopupContext {
  chain: DeployChain;
  keys: Keystore;
  layout: Layout;
  state: State;
  out: string;
  days: number;
  log: (s: string) => void;
  maxFundAccounts: number;
  /** Rewrites keeper.env (and the other outputs) from the keystore's current keys. */
  writeOutputs: () => Promise<void>;
}

export interface TopupResult {
  plan: TopupPlan;
  sent: number;
  fundAccountsUsed: string[];
}

export async function topup(ctx: TopupContext): Promise<TopupResult> {
  const { chain, keys, layout: l, state, log } = ctx;
  const record = (id: string, purpose: string, tx: string | null) => {
    state.steps[id] = { purpose, tx, at: new Date().toISOString(), how: "sent" };
    state.updated_at = state.steps[id]!.at;
    writeState(ctx.out, state, keys.redactor);
    log(`sent  ${id}: tx ${tx ?? "(not returned by the faucet)"}`);
  };
  const signer = async (id: string): Promise<{ accountId: string; key: KeyPair }> => {
    const key = await keys.existingFullAccess(id);
    if (!key) throw new Error(`no full-access key for ${id} in ${keys.dir}`);
    return { accountId: id, key };
  };
  const send = async (id: string, from: string, to: string, actions: Parameters<DeployChain["send"]>[2], purpose: string) => {
    const o = await chain.send(await signer(from), to, actions);
    if (!o.ok) throw new Error(`${id} failed on chain (tx ${o.hash}): ${o.error}`);
    record(id, purpose, o.hash);
    sent++;
  };
  let sent = 0;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "");
  const plan = planTopup(await readTopupInputs(l, ctx.days, chain, keys));
  log(renderTopup(plan, ctx.days));

  // 1. Bring the ops account up to what it pays out.
  const fundAccountsUsed: string[] = [];
  const opsBalance = async () => BigInt((await chain.account(l.ops))?.amount ?? "0");
  for (let n = 1; (await opsBalance()) < plan.need; n++) {
    if (n > ctx.maxFundAccounts) throw new Error(`${l.ops} is still short after ${ctx.maxFundAccounts} fund accounts; raise --max-fund-accounts or send it NEAR, then run topup again`);
    const id = `weir-fund-${l.suffix}-${n}.${l.network.root}`;
    let acct = await chain.account(id);
    if (!acct) {
      const key = await keys.fullAccess(id);
      const r = await chain.createTopLevel(id, key);
      record(`fund:${id}`, `create ${id} to fund ${l.ops}`, r.hash);
      sent++;
      acct = await chain.account(id);
    } else {
      // Not ours (or not in this keys directory): leave it and try the next number.
      const mine = await keys.existingFullAccess(id);
      if (!mine || !(await chain.keys(id)).some((k) => k.public_key === mine.publicKeyString)) continue;
    }
    const amount = BigInt(acct!.amount) - FUND_KEEP - purchase(0n);
    if (amount <= 0n) continue;
    fundAccountsUsed.push(id);
    await send(`sweep:${id}:${stamp}`, id, l.ops, [{ type: "Transfer", deposit: amount }], `sweep ${fmtNear(amount)} from ${id} to ${l.ops}, leaving ${fmtNear(FUND_KEEP)}`);
  }

  // 2. Operators and contracts. Re-read each balance first: a resumed run does not pay twice.
  const budgets = operatorBudgets(l, 1);
  for (const t of plan.operatorTransfers) {
    const b = budgets.find((x) => x.account === t.to)!;
    const have = BigInt((await chain.account(t.to))?.amount ?? "0");
    if (have >= yocto(b.dailyGgas) * BigInt(ctx.days) + b.keepYocto) continue;
    await send(`topup:${t.to}:${stamp}`, l.ops, t.to, [{ type: "Transfer", deposit: t.amount }], `send ${fmtNear(t.amount)} to ${t.to}: ${t.why}`);
  }
  for (const t of plan.contractTransfers) {
    const m = l.markets.find((x) => l.contracts[x] === t.to)! as MarketId;
    const a = await chain.account(t.to);
    if (a && BigInt(a.amount) - BigInt(a.storage_usage) * STORAGE_PER_BYTE >= storageGrowthPerDay(m) * BigInt(ctx.days)) continue;
    await send(`topup:${t.to}:${stamp}`, l.ops, t.to, [{ type: "Transfer", deposit: t.amount }], `send ${fmtNear(t.amount)} to ${t.to} (${MARKETS[m].label}): ${t.why}`);
  }

  // 3. Test dollars: mint to the agent unless its wallet already holds them (a resumed run), then
  // the agent deposits with its full-access key. Re-read the free balance first.
  for (const d of plan.dollarTopups) {
    const a = l.agents.find((x) => x.account === d.agent)!;
    const acc = await chain.view<{ balance: string } | null>(l.contracts[d.market]!, "get_account", { account_id: d.agent });
    if (acc && BigInt(acc.balance) >= a.feesPerDay * BigInt(ctx.days) + a.working / 2n) continue;
    const wallet = BigInt(await chain.view<string>(l.usdc, "ft_balance_of", { account_id: d.agent }));
    const fn = (methodName: string, args: object, gas: bigint, deposit: bigint) => ({ methodName, args: new TextEncoder().encode(JSON.stringify(args)), gas, deposit });
    if (wallet < d.amount) {
      await send(`mint:${d.agent}:${stamp}`, l.ops, l.usdc, [fn("mint", { account_id: d.agent, amount: (d.amount - wallet).toString() }, TOKEN_CALLS.mint.gas, 0n)], `mint $${(Number(d.amount - wallet) / 1e6).toFixed(2)} to ${d.agent}`);
    }
    await send(`deposit:${d.agent}:${stamp}`, d.agent, l.usdc, [
      fn("ft_transfer_call", { receiver_id: l.contracts[d.market], amount: d.amount.toString(), msg: "" }, TOKEN_CALLS.ft_transfer_call.gas, TOKEN_CALLS.ft_transfer_call.deposit),
    ], `${d.agent} deposits $${(Number(d.amount) / 1e6).toFixed(2)} into ${d.market}: ${d.why}`);
  }

  // 4. Keys: new key saved and added, keeper.env rewritten, then the old key deleted.
  for (const r of plan.rotations) {
    const k = r.key;
    const gen = keys.generationOf(k.account, k.receiver);
    const all = await keys.allFunctionCall(k.account, k.receiver);
    const old = all.find((x) => x.key.publicKeyString === r.oldPublicKey);
    const next = await keys.nextFunctionCall(k.account, k.receiver, METHODS_OF[k.methods], old ? old.generation : gen);
    const onChain = await chain.keys(k.account);
    if (!onChain.some((x) => x.public_key === next.publicKeyString)) {
      await send(`rotate:${k.account}:${k.receiver}:${next.publicKeyString}`, k.account, k.account, [
        { type: "AddKey", publicKey: next.publicKey, permission: { receiverId: k.receiver, methodNames: [...METHODS_OF[k.methods]], allowance: r.newAllowance } },
      ], `${k.account} adds a new key for ${k.receiver} with ${fmtNear(r.newAllowance, 2)} (the old one had ${fmtNear(r.remaining, 4)} left)`);
    }
  }
  // Older keys still on chain whose successor is on chain too: this run's rotations, or those of
  // a run that stopped between adding the new key and deleting the old one.
  const stale: { k: FcKeyPlan; key: KeyPair }[] = [];
  for (const k of fcKeys(l)) {
    const all = await keys.allFunctionCall(k.account, k.receiver);
    if (all.length < 2) continue;
    const onChain = new Set((await chain.keys(k.account)).map((x) => x.public_key));
    if (!onChain.has(all[all.length - 1]!.key.publicKeyString)) continue;
    for (const x of all.slice(0, -1)) if (onChain.has(x.key.publicKeyString)) stale.push({ k, key: x.key });
  }
  if (stale.length > 0 || plan.rotations.length > 0) {
    await ctx.writeOutputs();
    log("keeper.env rewritten with the current keys; restart the keeper so it loads them");
  }
  for (const { k, key } of stale) {
    await send(`retire:${k.account}:${key.publicKeyString}`, k.account, k.account, [{ type: "DeleteKey", publicKey: key.publicKey }], `${k.account} deletes its replaced key for ${k.receiver}`);
  }
  return { plan, sent, fundAccountsUsed };
}
