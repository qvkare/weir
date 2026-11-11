// `plan`: everything `apply` would do, worked out offline and printed. No network is touched.
import { MARKETS } from "../../agents/src/presets.ts";
import {
  allowanceFor,
  ASSUMED_GRANT,
  BURNT_GGAS,
  contractNeed,
  fmtNear,
  fmtTgas,
  MIN_GAS_PRICE,
  monthlyTotal,
  opsBudget,
  yocto,
} from "./budget.ts";
import { fcKeys } from "./layout.ts";
import { NEW_GAS_TGAS, type Plan } from "./steps.ts";
import { chooseT0 } from "./t0.ts";

export interface PlanFigures {
  accounts: number;
  transactions: number;
  opsNeed: bigint;
  opsFits: boolean;
  topLevel: number;
  operatorFunding: bigint;
  monthlyGas: bigint;
  contractNeed: bigint;
  usdcNeed: bigint;
}

export function figures(p: Plan, sizes: { weir: number; usdc: number }): PlanFigures {
  const ops = opsBudget(p.layout, p.budgets);
  return {
    accounts: p.layout.accounts.length,
    transactions: p.steps.length,
    opsNeed: ops.total,
    opsFits: ops.total <= ASSUMED_GRANT,
    topLevel: p.layout.accounts.filter((a) => a.createdBy === "top-level").length,
    operatorFunding: ops.transfers,
    monthlyGas: monthlyTotal(p.budgets),
    contractNeed: contractNeed(sizes.weir, NEW_GAS_TGAS).total,
    usdcNeed: contractNeed(sizes.usdc, 0n).total,
  };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function renderPlan(p: Plan, sizes: { weir: number; usdc: number }, now: number): string {
  const l = p.layout;
  const f = figures(p, sizes);
  const ops = opsBudget(l, p.budgets);
  const grantWord = l.network.creation === "faucet" ? "the faucet's grant" : "the root account's grant";
  const o: string[] = [];
  o.push(`Weir deployment plan: ${l.network.id}, suffix ${l.suffix}, markets ${l.markets.join(", ")}`);
  o.push(`Nothing has been sent. ${f.accounts} accounts, ${f.transactions} transactions. Gas priced at ${MIN_GAS_PRICE} yocto/gas (the protocol minimum; apply reads the real price).`);
  o.push("The dollar is the test token tUSDC (mock_usdc.wasm, with an open mint). Real USDC is out of scope for this tool.");
  o.push("");
  o.push(`Accounts (${f.accounts})`);
  const w = Math.max(...l.accounts.map((a) => a.id.length)) + 2;
  for (const a of l.accounts) {
    const by = a.createdBy === "ops" ? `from ${l.ops.split(".")[0]}` : l.network.creation === "faucet" ? "faucet" : `from ${l.network.root}`;
    o.push(`  ${pad(a.id, w)} ${pad(by, 22)} ${a.why}`);
  }
  o.push("");
  o.push("NEAR");
  o.push(`  Top-level accounts each get ${grantWord}: assumed ${fmtNear(ASSUMED_GRANT, 0)}. ${l.network.creation === "faucet" ? "Not assumed by apply: it reads the balances and stops if one is short." : ""}`.trimEnd());
  const weirNeed = contractNeed(sizes.weir, NEW_GAS_TGAS);
  const usdcNeed = contractNeed(sizes.usdc, 0n);
  o.push(`  each market contract: weir.wasm is ${sizes.weir} bytes = ${fmtNear(weirNeed.storage)} of storage at 1 NEAR per 100 kB (with its initial state), plus ${fmtNear(weirNeed.prepaid)} of prepaid gas to deploy: needs ${fmtNear(weirNeed.total)}, keeps the rest (about ${fmtNear(ASSUMED_GRANT - weirNeed.total)}) to pay for the state it accumulates`);
  o.push(`  ${l.usdc}: mock_usdc.wasm is ${sizes.usdc} bytes = ${fmtNear(usdcNeed.storage)}; every holder's record is paid by its storage_deposit`);
  o.push(`  ${l.ops} pays ${fmtNear(ops.total)} of its grant (${f.opsFits ? "fits" : `DOES NOT FIT in ${fmtNear(ASSUMED_GRANT, 0)}: lower --days or fund it`}):`);
  for (const line of ops.lines) o.push(`    ${line}`);
  o.push(`  Operator funding, for setup plus ${p.days} days of gas at the expected load, plus what each must keep (largest attached gas, storage over 770 bytes):`);
  o.push(`    ${pad("account", w)} ${pad("funding", 14)} ${pad("gas/day", 14)} gas/month`);
  for (const b of p.budgets) {
    o.push(`    ${pad(b.account, w)} ${pad(fmtNear(b.funding), 14)} ${pad(fmtNear(yocto(b.dailyGgas), 4), 14)} ${fmtNear(yocto(b.monthGgas))}`);
  }
  o.push(`  A month of operator gas at the expected load: ${fmtNear(f.monthlyGas)} in all. ${f.monthlyGas > ops.transfers ? `The grant funds ${p.days} days of it; \`topup --days N\` keeps it running (status shows days left).` : ""}`.trimEnd());
  o.push(`  Total NEAR: ${f.topLevel} top-level accounts x ${fmtNear(ASSUMED_GRANT, 0)} = ${fmtNear(BigInt(f.topLevel) * ASSUMED_GRANT, 0)} from ${l.network.creation === "faucet" ? "the faucet" : l.network.root}; nothing else is needed to deploy.`);
  o.push("");
  o.push(`Transactions (${f.transactions}), in order`);
  const tw = String(p.steps.length).length;
  for (const [i, s] of p.steps.entries()) {
    const att = s.attached === 0n ? "" : `, attaches ${s.attached === 1n ? "1 yoctoNEAR" : fmtNear(s.attached, 5)}`;
    const gas = s.gasTgas === 0n ? "" : `, ${s.gasTgas} Tgas`;
    o.push(`  ${String(i + 1).padStart(tw)}. ${s.signer} -> ${s.receiver}${att}${gas}: ${s.purpose}`);
  }
  o.push("");
  o.push(`t0 (computed here for now = ${new Date(now * 1000).toISOString()}; apply recomputes it from the chain's clock when it sends each deploy)`);
  for (const m of l.markets) o.push(`  ${m}: ${chooseT0(MARKETS[m].params, now).reason}`);
  o.push("");
  o.push(`Agents: test dollars, guards and round lock limits (deposit = working balance + ${p.days} days of commit fees)`);
  const usd = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;
  for (const a of l.agents) {
    const mp = MARKETS[a.market].params;
    const rounds = 86_400 / (mp.commit_secs + mp.reveal_secs);
    const orders = a.spec.role === "maker" ? 2 : 1;
    o.push(
      `  ${pad(a.account, w)} ${pad(a.spec.role, 7)} ${usd(a.working)} + ${rounds} rounds x ${orders} x ${usd(BigInt(mp.commit_fee))} x ${p.days} days = deposit ${usd(a.deposit)}; ` +
        `guard $${(a.guard / 1e6).toFixed(3)}, max_round_lock ${usd(a.maxRoundLock)}` +
        `${a.spec.need !== undefined ? `, need ${a.spec.need}` : ""}${a.spec.capacity !== undefined ? `, capacity ${a.spec.capacity}` : ""}${a.spec.role === "maker" ? `, max_size ${a.spec.max_size}` : ""}`,
    );
  }
  o.push("  Working balance and needs, capacities and the maker's size follow the agents package's simulation: the fast market's");
  o.push("  figures, x8.4 on a weekly market, working balance also x the chip's price over the H100's. Fees: one commit per order per");
  o.push("  round (a maker commits on both sides). guard: 20% of the band the market opens with at the chip's start price (6% of the");
  o.push("  index); max_round_lock: 25% of the working balance, at least $10. topup mints and deposits more when an agent runs low.");
  o.push("");
  o.push("Function-call key allowances (a month of calls at the worst measured gas, clear at a full 64-commit book)");
  for (const k of fcKeys(l)) {
    const al = allowanceFor(l, k);
    o.push(`  ${k.account} on ${k.receiver}: ${fmtNear(al.allowance, 2)}`);
    o.push(`    ${al.arithmetic}`);
  }
  o.push(`  Gas per call (worst measured, Tgas): ${Object.entries(BURNT_GGAS).map(([m, g]) => `${m} ${fmtTgas(g).replace(" Tgas", "")}`).join(", ")}.`);
  o.push("  A function-call key cannot attach a deposit, so it can never register, deposit, withdraw or change a guard. An exhausted allowance stops the key: status shows what is left.");
  o.push("");
  o.push("Sealing");
  o.push("  `seal` deletes every access key of the market contracts after checking their code and parameters. A sealed account can never be");
  o.push("  upgraded or recovered: no new code, no new keys, its NEAR stays where it is for good. The test token and operators are not sealed.");
  return o.join("\n");
}
