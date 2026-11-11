import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { allowanceFor, ASSUMED_GRANT, marketDailyCost, maxAttachedGgas, MILLINEAR, NEAR, operatorBudgets, purchase, storageGrowthPerDay, STORAGE_PER_BYTE, yocto } from "../src/budget.ts";
import { apply } from "../src/apply.ts";
import { Keystore, Redactor } from "../src/keys.ts";
import { fcKeys, layout, sandboxNetwork, TESTNET, type MarketId } from "../src/layout.ts";
import { checkKeeperEnv, writeOutputs } from "../src/outputs.ts";
import { newState, readState } from "../src/state.ts";
import { buildPlan } from "../src/steps.ts";
import { FUND_KEEP, keyDailyUse, planTopup, readTopupInputs, topup, type TopupInputs } from "../src/topup.ts";
import { FakeChain, fakeWasm, Killed } from "./fake.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "weir-topup-test-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const MARKETS: MarketId[] = ["h100-fast", "h100-weekly"];

/** Inputs for a deployment where everyone holds exactly what N days need. */
function healthy(days: number): TopupInputs {
  const l = layout(TESTNET, "t1", MARKETS);
  const budgets = operatorBudgets(l, 1);
  const operators = Object.fromEntries(budgets.map((b) => [b.account, yocto(b.dailyGgas) * BigInt(days) + b.keepYocto]));
  const contracts = Object.fromEntries(MARKETS.map((m) => [l.contracts[m]!, { balance: 400_000n * STORAGE_PER_BYTE + storageGrowthPerDay(m) * BigInt(days), storage: 400_000 }]));
  const keys = fcKeys(l).map((k) => ({ key: k, publicKey: `ed25519:${k.account}|${k.receiver}`, allowance: allowanceFor(l, k).allowance }));
  const agentFree = Object.fromEntries(l.agents.map((a) => [a.account, a.working + a.feesPerDay * BigInt(days)]));
  return { layout: l, days, opsBalance: NEAR, operators, contracts, keys, agentFree };
}

test("nothing is short when everyone holds exactly N days", () => {
  const p = planTopup(healthy(14));
  assert.deepEqual([p.dollarTopups, p.operatorTransfers, p.contractTransfers, p.rotations, p.shortfall], [[], [], [], [], 0n]);
});

test("an agent below N days of fees plus half its working balance is brought back to working + N days, in whole dollars", () => {
  const i = healthy(14);
  const a = i.layout.agents.find((x) => x.market === "h100-fast" && x.spec.role === "maker")!;
  const floor = a.feesPerDay * 14n + a.working / 2n;
  i.agentFree[a.account] = floor;
  assert.equal(planTopup(i).dollarTopups.length, 0, "at the floor: nothing");
  i.agentFree[a.account] = floor - 1n;
  const d = planTopup(i).dollarTopups;
  assert.equal(d.length, 1);
  const want = a.working + a.feesPerDay * 14n - (floor - 1n);
  assert.ok(d[0]!.amount >= want && d[0]!.amount - want < 1_000_000n && d[0]!.amount % 1_000_000n === 0n);
  // The fast maker pays 288 x 2 x $0.10 = $57.60 a day.
  assert.equal(a.feesPerDay, 57_600_000n);
});

test("an operator short by X gets X plus a tenth of its N-day need, rounded up to 0.001 NEAR", () => {
  const i = healthy(14);
  const b = operatorBudgets(i.layout, 1).find((x) => x.account.includes("h100-fast-maker-1"))!;
  const short = 123_456_789_000_000_000_000_000n;
  i.operators[b.account] = i.operators[b.account]! - short;
  const p = planTopup(i);
  assert.equal(p.operatorTransfers.length, 1);
  const want = short + (yocto(b.dailyGgas) * 14n * 10n) / 100n;
  const got = p.operatorTransfers[0]!.amount;
  assert.ok(got >= want && got - want < MILLINEAR);
  // After it, the operator is above target, so the next plan is empty for it.
  i.operators[b.account] = i.operators[b.account]! + got;
  assert.equal(planTopup(i).operatorTransfers.length, 0);
});

test("a contract is topped up for N days of unpruned prints: fast 1.49 NEAR a day, weekly 0.12", () => {
  assert.equal(storageGrowthPerDay("h100-fast"), 288n * 516n * 10n ** 19n);
  assert.equal(storageGrowthPerDay("h100-weekly"), 24n * 516n * 10n ** 19n);
  const i = healthy(14);
  const c = i.layout.contracts["h100-fast"]!;
  i.contracts[c] = { balance: 400_000n * STORAGE_PER_BYTE + NEAR, storage: 400_000 };
  const p = planTopup(i);
  assert.equal(p.contractTransfers.length, 1);
  const growth = storageGrowthPerDay("h100-fast") * 14n;
  assert.ok(p.contractTransfers[0]!.amount >= growth - NEAR + growth / 10n);
});

test("a key whose allowance will not last N days is rotated to a fresh month (or N days x 1.25 if more)", () => {
  const i = healthy(14);
  const row = i.keys.find((k) => k.key.methods === "keeper" && k.key.market === "h100-fast")!;
  const need = keyDailyUse(i.layout, row.key) * 14n + purchase(maxAttachedGgas("keeper"));
  row.allowance = need - 1n;
  let p = planTopup(i);
  assert.equal(p.rotations.length, 1);
  assert.equal(p.rotations[0]!.newAllowance, allowanceFor(i.layout, row.key).allowance);
  row.allowance = need;
  assert.equal(planTopup(i).rotations.length, 0, "exactly enough is enough");
  // 60 days need more than a month's allowance: the new key gets 60 days x 1.25.
  const j = healthy(60);
  const r2 = j.keys.find((k) => k.key.methods === "keeper" && k.key.market === "h100-fast")!;
  r2.allowance = 0n;
  p = planTopup(j);
  const need60 = keyDailyUse(j.layout, r2.key) * 60n + purchase(maxAttachedGgas("keeper"));
  const rot = p.rotations.find((x) => x.key === r2.key)!;
  assert.ok(rot.newAllowance >= (need60 * 125n) / 100n);
});

test("fund accounts: ops short by S needs ceil(S / (grant - kept - fees)) of them", () => {
  const i = healthy(14);
  i.opsBalance = 0n;
  for (const k of Object.keys(i.operators)) i.operators[k] = 0n;
  const p = planTopup(i);
  const per = ASSUMED_GRANT - FUND_KEEP - purchase(0n);
  assert.equal(p.shortfall, p.need);
  assert.equal(p.fundAccounts, Number((p.need + per - 1n) / per));
  assert.ok(p.fundAccounts >= 2);
});

test("daily cost per market: the fast market's gas is about 12 times a weekly one's", () => {
  const l = layout(TESTNET, "t1", ["h100-fast", "h100-weekly"]);
  const f = marketDailyCost(l, "h100-fast");
  const w = marketDailyCost(l, "h100-weekly");
  assert.equal(f.gas, f.reporters + f.agents + f.keeper);
  assert.ok(f.gas > 10n * w.gas && f.gas < 14n * w.gas, `${f.gas} vs ${w.gas}`);
  assert.equal(f.storageUnpruned, 12n * w.storageUnpruned);
});

test("topup on a fake chain: drained operator and contract, an exhausted key; resumable, then idempotent", async () => {
  const wasm = { weir: fakeWasm("weir", 1), usdc: fakeWasm("mock_usdc", 2) };
  const chain = new FakeChain(wasm);
  const out = tmp();
  const keysDir = tmp();
  const redactor = new Redactor();
  let n = 5000;
  const seed = () => {
    const s = new Uint8Array(32).fill(7);
    s[0] = ++n >> 8;
    s[1] = n & 0xff;
    return s;
  };
  const keys = new Keystore(keysDir, { seed, redactor });
  const l = layout(sandboxNetwork("http://fake"), "t1", MARKETS);
  const plan = buildPlan(l, 2);
  const state = newState("sandbox", "t1", MARKETS, "2026-11-12T00:00:00.000Z");
  const lines: string[] = [];
  const log = (s: string) => lines.push(redactor.redact(s));
  await apply({ chain, keys, plan, wasm, out, state, log });
  await writeOutputs(out, plan, state, chain, keys, wasm);
  // Drain: an agent's NEAR, the fast contract's spare, the keeper's fast key allowance; and ops.
  const agent = l.agents.find((a) => a.market === "h100-fast")!.account;
  chain.accounts.get(agent)!.amount = 1000n;
  // ...and another agent's test dollars, as if spent on fees.
  const poor = l.agents.find((a) => a.market === "h100-weekly")!;
  chain.weir.get(l.contracts["h100-weekly"]!)!.accounts.get(poor.account)!.balance = "1000000";
  chain.accounts.get(l.contracts["h100-fast"]!)!.amount = 0n;
  const kOld = await keys.existingFunctionCall(l.keeper, l.contracts["h100-fast"]!);
  const perm = chain.accounts.get(l.keeper)!.keys.get(kOld!.publicKeyString)!;
  if (perm !== "FullAccess") perm.FunctionCall.allowance = "1000";
  chain.accounts.get(l.ops)!.amount = 10n ** 21n;
  const ctx = { chain, keys, layout: l, state, out, days: 14, log, maxFundAccounts: 20, writeOutputs: async () => void (await writeOutputs(out, plan, state, chain, keys, wasm)) };
  const before = planTopup(await readTopupInputs(l, 14, chain, keys));
  assert.ok(before.operatorTransfers.some((t) => t.to === agent));
  assert.ok(before.contractTransfers.some((t) => t.to === l.contracts["h100-fast"]));
  assert.equal(before.rotations.length, 1);
  // The drained weekly agent, and every fast agent: deposited for 2 days of fees, asked for 14.
  assert.deepEqual(before.dollarTopups.map((d) => d.agent).sort(), [...l.agents.filter((a) => a.market === "h100-fast").map((a) => a.account), poor.account].sort());
  // Killed in the middle (after the fund sweep), then resumed.
  chain.dieAfter = chain.txCount + 4;
  await assert.rejects(topup(ctx), Killed);
  chain.dieAfter = null;
  const resumedState = readState(out)!;
  const r = await topup({ ...ctx, state: resumedState });
  assert.ok(r.sent > 0);
  const after = planTopup(await readTopupInputs(l, 14, chain, keys));
  assert.deepEqual([after.dollarTopups, after.operatorTransfers, after.contractTransfers, after.rotations], [[], [], [], []], "nothing short afterwards");
  assert.ok(BigInt(chain.weir.get(l.contracts["h100-weekly"]!)!.accounts.get(poor.account)!.balance) >= poor.working + poor.feesPerDay * 14n);
  // The new key is on chain with a fresh allowance, the old one gone, keeper.env holds the new one.
  const kNew = (await keys.existingFunctionCall(l.keeper, l.contracts["h100-fast"]!))!;
  assert.notEqual(kNew.publicKeyString, kOld!.publicKeyString);
  const onChain = chain.accounts.get(l.keeper)!.keys;
  assert.ok(onChain.has(kNew.publicKeyString) && !onChain.has(kOld!.publicKeyString));
  const env = readFileSync(join(out, "keeper.env"), "utf8");
  assert.deepEqual(checkKeeperEnv(env, l, keys), []);
  assert.ok(env.includes(keys.functionCallSecret(l.keeper, l.contracts["h100-fast"]!)));
  // Fund accounts were created and left with FUND_KEEP.
  const funds = [...chain.accounts.keys()].filter((id) => id.startsWith("weir-fund-t1-"));
  assert.ok(funds.length >= 1);
  // (The fake burns no fees; on chain the part of the fee headroom that is not burnt stays too.)
  for (const f of funds) assert.equal(chain.accounts.get(f)!.amount, FUND_KEEP + purchase(0n));
  // Idempotent: a second run sends nothing.
  const again = await topup({ ...ctx, state: readState(out)! });
  assert.equal(again.sent, 0);
  // No secret in the log or the state file.
  const check = new Redactor();
  for (const k of fcKeys(l)) check.add(keys.functionCallSecret(k.account, k.receiver));
  assert.equal(check.leaks(lines.join("\n") + readFileSync(join(out, "state.json"), "utf8")), false);
});
