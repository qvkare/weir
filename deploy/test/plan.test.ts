import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKETS } from "../../agents/src/presets.ts";
import { AGENT_KEY_METHODS, KEEPER_KEY_METHODS, REPORTER_KEY_METHODS } from "../../chain/src/weir.ts";
import {
  allowanceFor,
  ASSUMED_GRANT,
  BURNT_GGAS,
  DEFAULT_DAYS,
  fmtNear,
  NEAR,
  operatorBudgets,
  opsBudget,
  storageBytes,
  storageStake,
  purchase,
  yocto,
} from "../src/budget.ts";
import { fcKeys, isAccountId, layout, MARKET_IDS, parseMarkets, sandboxNetwork, TESTNET, type MarketId } from "../src/layout.ts";
import { renderPlan } from "../src/plan.ts";
import { buildPlan } from "../src/steps.ts";

const subsets = (): MarketId[][] => {
  const out: MarketId[][] = [];
  for (let mask = 1; mask < 1 << MARKET_IDS.length; mask++) out.push(MARKET_IDS.filter((_, i) => mask & (1 << i)));
  return out;
};

test("the plan for every combination of markets, on both networks", () => {
  const sizes = { weir: 303_281, usdc: 146_689 };
  let checked = 0;
  for (const net of [TESTNET, sandboxNetwork("http://127.0.0.1:1")]) {
    for (const ms of subsets()) {
      const l = layout(net, "t1", ms);
      const p = buildPlan(l, DEFAULT_DAYS);
      const n = ms.length;
      // usdc + n markets + ops + 3 reporters + 6 agents per market + keeper
      assert.equal(l.accounts.length, 6 + 7 * n);
      const ids = l.accounts.map((a) => a.id);
      assert.equal(new Set(ids).size, ids.length, "names are unique");
      for (const id of ids) assert.ok(isAccountId(id) && id.endsWith(`.${net.root}`), id);
      for (const a of l.accounts.filter((x) => x.createdBy === "top-level")) assert.equal(a.id.split(".").length, net.root.split(".").length + 1, `${a.id} is top-level`);
      for (const a of l.accounts.filter((x) => x.createdBy === "ops")) assert.ok(a.id.endsWith(`.${l.ops}`), `${a.id} is under ops`);
      // Every transaction is signed by an account an earlier step created (or the creator), and
      // touches only accounts that exist by then; contracts are deployed before they are called.
      const exists = new Set<string>();
      const deployed = new Set<string>();
      for (const s of p.steps) {
        if (s.kind === "create-top") {
          exists.add(s.account!);
          continue;
        }
        assert.ok(exists.has(s.signer), `${s.id}: signer ${s.signer} exists`);
        if (s.kind === "create-sub") {
          exists.add(s.account!);
          continue;
        }
        if (s.kind === "deploy-usdc" || s.kind === "deploy-market") deployed.add(s.receiver);
        else if (s.kind !== "add-key") assert.ok(deployed.has(s.receiver), `${s.id}: ${s.receiver} deployed first`);
        if (s.kind === "deposit") assert.ok(p.steps.findIndex((x) => x.id === `register:${s.market}:${s.account}`) < p.steps.indexOf(s), "registered before deposit");
      }
      const steps = p.steps.length;
      // creates (6 + 7n) + usdc deploy + n deploys + storage (n contracts + 3 + 6n + 1) + mints 6n
      // + registers 7n + deposits 6n + guards 6n + keys (3n reporters + 6n agents + n keeper)
      assert.equal(steps, 6 + 7 * n + 1 + n + (n + 3 + 6 * n + 1) + 6 * n + 7 * n + 6 * n + 6 * n + 10 * n);
      assert.equal(new Set(p.steps.map((s) => s.id)).size, steps, "step ids are unique");
      // Function-call keys: each names one market contract, with the right list; a reporter and the
      // keeper hold one per market, an agent one for its market.
      for (const id of [...l.reporters[ms[0]!]!, l.keeper]) assert.deepEqual(fcKeys(l).filter((k) => k.account === id).map((k) => k.receiver), ms.map((m) => l.contracts[m]));
      for (const a of l.agents) assert.deepEqual(fcKeys(l).filter((k) => k.account === a.account).map((k) => k.receiver), [l.contracts[a.market]]);
      for (const k of fcKeys(l)) {
        assert.equal(k.receiver, l.contracts[k.market]);
        const st = p.steps.find((s) => s.id === `key:${k.account}:${k.receiver}`)!;
        const want = { reporter: REPORTER_KEY_METHODS, agent: AGENT_KEY_METHODS, keeper: KEEPER_KEY_METHODS }[k.methods];
        assert.deepEqual(st.key!.methodNames, want);
      }
      // The ops account pays for everything it signs out of one faucet grant at the default days.
      const ob = opsBudget(l, p.budgets);
      assert.ok(ob.total <= ASSUMED_GRANT, `${ms.join(",")}: ${fmtNear(ob.total)} fits in the grant`);
      assert.equal(ob.transfers, p.budgets.reduce((s, b) => s + b.funding, 0n));
      assert.equal(ob.transfers, p.steps.filter((s) => s.kind === "create-sub").reduce((s, x) => s + x.attached, 0n));
      const text = renderPlan(p, sizes, 1_794_470_400);
      assert.match(text, /can never be\s+upgraded or recovered/);
      assert.match(text, /Real USDC is out of scope/);
      for (const m of ms) assert.match(text, new RegExp(`${m}: t0 = `));
      checked++;
    }
  }
  assert.equal(checked, 30);
});

test("market selection: order, duplicates and unknown ids", () => {
  assert.deepEqual(parseMarkets("h200-weekly,h100-fast,h100-fast"), ["h100-fast", "h200-weekly"]);
  assert.deepEqual(parseMarkets(undefined), MARKET_IDS);
  assert.throws(() => parseMarkets("h100"), /unknown market/);
  assert.throws(() => layout(TESTNET, "Bad_Suffix", ["h100-fast"]), /--suffix/);
  assert.throws(() => layout(TESTNET, "ok", []), /no markets/);
});

test("agents: guard, round lock limit and deposits", () => {
  const l = layout(TESTNET, "t1", MARKET_IDS);
  for (const a of l.agents) {
    const m = MARKETS[a.market];
    const band = (2 * m.startPrice * m.params.band_bps) / 10_000;
    assert.equal(a.guard % m.params.tick, 0);
    assert.ok(a.guard <= band * 0.2 && a.guard > band * 0.2 - m.params.tick);
    assert.ok(a.maxRoundLock >= 10_000_000n && a.maxRoundLock >= a.working / 4n);
    // An order locks at least 50 commit fees (agents/src/strategy.ts FEE_MULTIPLE): the limit allows one.
    assert.ok(a.maxRoundLock >= BigInt(m.params.commit_fee) * 51n);
    // Deposit = working balance + the default days of fees at the preset's commit fee, read at run time.
    const rounds = BigInt(86_400 / (m.params.commit_secs + m.params.reveal_secs));
    assert.equal(a.feesPerDay, rounds * (a.spec.role === "maker" ? 2n : 1n) * BigInt(m.params.commit_fee));
    assert.equal(a.deposit, a.working + a.feesPerDay * 2n);
  }
  const fast = l.agents.filter((a) => a.market === "h100-fast");
  assert.equal(fast[0]!.guard, 174_000); // 20% of a band of $0.87 at $2.90
  assert.equal(fast.map((a) => a.spec.role).join(), "buyer,buyer,seller,seller,maker,noise");
  // The agents package's rule: weekly needs, capacities and the maker's size x8.4; working
  // balance x8.4 and x the chip's price over the H100's (H200 $4.25: x1.4655).
  const of = (m: string, name: string) => l.agents.find((a) => a.account.startsWith(`${m}-${name}.`))!;
  assert.equal(of("h100-fast", "buyer-1").working, 60_000_000n);
  assert.equal(of("h100-weekly", "buyer-1").spec.need, 336);
  assert.equal(of("h100-weekly", "seller-1").spec.capacity, 1260);
  assert.equal(of("h100-weekly", "maker-1").spec.max_size, 252);
  assert.equal(of("h100-weekly", "noise-1").spec.max_size, 10);
  assert.equal(of("h100-weekly", "buyer-1").working, 504_000_000n);
  assert.equal(of("h200-weekly", "buyer-1").working, BigInt(Math.ceil(60 * 8.4 * (4_250_000 / 2_900_000))) * 1_000_000n);
  assert.equal(of("a100-80-weekly", "buyer-1").working, 504_000_000n, "a cheaper chip is not scaled down");
  // At $0.10 a commit the fast market's six agents (seven orders a round) burn $201.60 a day.
  assert.equal(fast.reduce((s, a) => s + a.feesPerDay, 0n), 201_600_000n);
  // --days 7 carries seven days of fees.
  const l7 = layout(TESTNET, "t1", ["h100-fast"], 7);
  assert.equal(l7.agents[0]!.deposit, 60_000_000n + 7n * 28_800_000n);
});

test("allowance arithmetic, by hand", () => {
  const l = layout(TESTNET, "t1", ["h100-fast"]);
  const keys = fcKeys(l);
  // A fast reporter: 2,592,000 s / 300 = 8640 reports, plus 864 finalizes, at 2.73 Tgas,
  // 0.0001 NEAR per Tgas, x 1.25, plus 10 Tgas of headroom, rounded up to 0.01 NEAR.
  const rep = allowanceFor(l, keys.find((k) => k.methods === "reporter")!);
  assert.equal(rep.monthGgas, (8640n + 864n) * 2730n);
  // Headroom: the 10 Tgas a report attaches plus 5 Tgas of transaction fees, bought at 1e9 yocto/gas = 0.015 NEAR.
  const raw = (rep.monthGgas * 10n ** 17n * 125n) / 100n + 15_000n * 10n ** 18n;
  assert.equal(raw, 3_258_240_000_000_000_000_000_000n);
  assert.equal(rep.allowance, 326n * 10n ** 22n);
  // The keeper: 8640 rounds cleared at a full book, 720 settles, 864 finalizes, 8640 prune_print, 8640 prune_result.
  const kp = allowanceFor(l, keys.find((k) => k.methods === "keeper")!);
  assert.equal(kp.monthGgas, 8640n * 25_500n + 720n * 3_200n + 864n * 2_730n + 8640n * 2_240n + 8640n * 2_240n);
  assert.match(kp.arithmetic, /8640 clear_full x 25\.50 Tgas/);
  assert.ok(kp.allowance >= (yocto(kp.monthGgas) * 5n) / 4n);
  // Agents only trade: the housekeeping account clears.
  const agents = keys.filter((k) => k.methods === "agent").map((k) => allowanceFor(l, k));
  assert.ok(agents.every((a) => !a.lines.some((x) => x.method === "clear_full" || x.method === "clear")));
  // The maker commits on both sides: twice the commits of a buyer.
  const maker = agents.find((a) => a.key.account.includes("maker"))!;
  assert.equal(maker.lines.find((x) => x.method === "commit")!.calls, 2n * 8640n);
  // Weekly: 720 one-hour rounds and 720 prints a month.
  const w = allowanceFor(layout(TESTNET, "t1", ["h200-weekly"]), fcKeys(layout(TESTNET, "t1", ["h200-weekly"]))[0]!);
  assert.equal(w.lines[0]!.calls, 720n);
});

test("NEAR budgeting: storage, funding and formatting", () => {
  // The keeper's account crosses NEP-448's 770 free bytes only with several market keys.
  const one = storageBytes("keeper.weir-ops-t1.testnet", [{ receiver: "weir-h100-fast-t1.testnet", methods: KEEPER_KEY_METHODS }]);
  const four = storageBytes("keeper.weir-ops-t1.testnet", MARKET_IDS.map((m) => ({ receiver: `weir-${m}-t1.testnet`, methods: KEEPER_KEY_METHODS })));
  assert.ok(one <= 770 && four > 770);
  assert.equal(storageStake(one), 0n);
  assert.equal(storageStake(four), BigInt(four) * 10n ** 19n);
  const l = layout(TESTNET, "t1", MARKET_IDS);
  const b3 = operatorBudgets(l, 3);
  const b6 = operatorBudgets(l, 6);
  for (const [i, b] of b3.entries()) {
    assert.ok(b6[i]!.funding >= b.funding);
    // Setup gas, then the larger of: the days of gas plus what it keeps, or the headroom its setup needs.
    const float = yocto(b.dailyGgas) * 3n + b.keepYocto;
    const stake = b.keepYocto - purchase(b.role === "reporter" ? 10_000n : 150_000n);
    const need = yocto(b.setupGgas) + (float > b.setupHeadroom + stake ? float : b.setupHeadroom + stake);
    assert.ok(b.funding >= need && b.funding - need < 10n ** 21n, `${b.account}: rounded up by under 0.001 NEAR`);
    if (b.role === "agent") assert.ok(b.funding >= purchase(100_000n), "an agent can attach the deposit's 100 Tgas");
  }
  // The housekeeping account is funded for every market's clears, settles and prunes; a reporter
  // for every market's reports; agents only for their own trading.
  const keeper = b3.find((b) => b.role === "keeper")!;
  assert.ok(keeper.funding >= purchase(150_000n) && purchase(150_000n) > 150_919n * 10n ** 18n, "it can send a clear (150.919 Tgas bought on the sandbox)");
  const single = operatorBudgets(layout(TESTNET, "t1", ["h100-fast"]), 3);
  assert.ok(keeper.dailyGgas > single.find((b) => b.role === "keeper")!.dailyGgas);
  assert.ok(b3.find((b) => b.role === "reporter")!.dailyGgas > single.find((b) => b.role === "reporter")!.dailyGgas);
  assert.equal(single.find((b) => b.account.includes("buyer-1"))!.dailyGgas, b3.find((b) => b.account.startsWith("h100-fast-buyer-1"))!.dailyGgas);
  assert.ok(opsBudget(l, b6).total > ASSUMED_GRANT, "six days of four markets do not fit one grant");
  assert.throws(() => operatorBudgets(l, 0), /--days/);
  assert.equal(fmtNear(NEAR), "1.000 NEAR");
  assert.equal(fmtNear(1n), "0.001 NEAR");
  assert.equal(fmtNear(10n * NEAR, 0), "10 NEAR");
  assert.equal(fmtNear(1_234_500_000_000_000_000_000n, 2), "0.01 NEAR");
  assert.equal(BURNT_GGAS.clear_full, 25_500n);
});
