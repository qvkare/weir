// Random action sequences against Market. After every step, success or failure, the test
// checks invariants 1, 2 and 5 of section 11 against its own count of dollars, and that a
// call that threw changed nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeBand, deliveryEnd, Market, phaseAt, roundEnd, type Params, type Side, type Totals } from "../src/mod.ts";
import { BUNDLE, PARAMS as BASE, revealSecret, sealedCommit, type Secret } from "./fixtures.ts";
import { Rng } from "./prng.ts";

// A compressed calendar so a few hundred steps cover auctions, delivery and settlement:
// series 0 auctions over [98_800, 101_000) in 90 s rounds and delivers over [100_000, 101_200).
const PARAMS: Params = {
  ...BASE,
  periodSecs: 1200,
  leadSecs: 1200,
  cutoffSecs: 200,
  commitSecs: 60,
  revealSecs: 30,
  printIntervalSecs: 60,
  reportGraceSecs: 60,
  voidAfterSecs: 600,
  maxAnchorAgeSecs: 1200,
};
const START = 98_700;
const RUNS = 300;
const STEPS = 450;
const TRADERS = ["t0", "t1", "t2", "t3", "t4"];
const SERIES = [0, 1];
// Past this time every series in play can settle, void or not.
const END = deliveryEnd(PARAMS, 1) + PARAMS.voidAfterSecs;

interface Ledger {
  /** USDC the contract holds: deposits taken minus withdrawals paid. */
  held: bigint;
  netDeposit: Map<string, bigint>;
  /** Everything each account ever locked in a commit or paid to mint. */
  outlay: Map<string, bigint>;
}

const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
const total = (t: Totals) => t.free + t.locked + t.setsBacking + t.pools + t.unredeemed;

function lockedBy(m: Market, secrets: readonly Secret[]): Map<string, bigint> {
  const locked = new Map<string, bigint>();
  const seen = new Set<string>();
  for (const s of secrets) {
    const key = `${s.series}/${s.round}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const c of m.getRound(s.series, s.round)?.commits ?? []) {
      if (c.state !== "Void") add(locked, c.owner, c.lock);
    }
  }
  return locked;
}

function checkInvariants(m: Market, ledger: Ledger, secrets: readonly Secret[], where: string): void {
  const totals = m.getTotals();
  // Invariant 1. Every rounding in the spec goes to a pool, so it holds with equality.
  assert.equal(total(totals), ledger.held, `${where}: solvency ${JSON.stringify(totals, big)}`);

  // Invariant 2.
  for (const s of SERIES) {
    const series = m.getSeries(s);
    if (!series || series.settlement) continue;
    let long = 0;
    let short = 0;
    for (const t of TRADERS) {
      const p = m.getPosition(s, t);
      long += p.long;
      short += p.short;
    }
    assert.equal(long, series.openSets, `${where}: series ${s} long`);
    assert.equal(short, series.openSets, `${where}: series ${s} short`);
  }

  // Invariant 5: what an account no longer has never exceeds what it locked or paid.
  const locked = lockedBy(m, secrets);
  for (const t of TRADERS) {
    const balance = m.getAccount(t)!.balance;
    assert.ok(balance >= 0n, `${where}: ${t} balance ${balance}`);
    const kept = balance + (locked.get(t) ?? 0n);
    const floor = (ledger.netDeposit.get(t) ?? 0n) - (ledger.outlay.get(t) ?? 0n);
    assert.ok(kept >= floor, `${where}: ${t} kept ${kept} < ${floor}`);
  }
}

function big(_key: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

/** A plausible order price: inside the band the series has or would open with. */
function orderPrice(m: Market, rng: Rng, series: number): number {
  const band = m.getSeries(series)?.band ?? anchorBand(m);
  return rng.int(1, Math.max(1, band / PARAMS.tick - 1)) * PARAMS.tick * (rng.chance(0.03) ? 3 : 1);
}

function anchorBand(m: Market): number {
  const last = m.getLastPrint();
  return last ? computeBand(last.price, PARAMS.tick, PARAMS.bandBps).band : 400_000;
}

function runSequence(seed: number, stats: { settled: number; voided: number; cleared: number; traded: number }): void {
  const rng = new Rng(seed);
  const m = new Market(PARAMS, START);
  const ledger: Ledger = { held: 0n, netDeposit: new Map(), outlay: new Map() };
  const secrets: Secret[] = [];
  let level = 2_000_000;

  for (const t of TRADERS) {
    m.register(t);
    m.deposit(t, 50_000_000n);
    ledger.held += 50_000_000n;
    add(ledger.netDeposit, t, 50_000_000n);
  }

  const clear = (series: number, round: number) => {
    const result = m.clear(series, round);
    stats.cleared++;
    if (result.volume > 0) stats.traded++;
  };
  const waiting = (s: Secret) => {
    const now = phaseAt(PARAMS, s.series, m.now);
    const commit = m.getRound(s.series, s.round)?.commits.find((c) => c.seq === s.seq);
    return now.round === s.round && now.phase === "Reveal" && commit?.state === "Committed";
  };

  const actions: [number, () => void][] = [
    [10, () => m.setTime(m.now + rng.int(0, 100))],
    [
      2,
      () => {
        const t = rng.pick(TRADERS);
        const amount = BigInt(rng.int(1, 20_000_000));
        const refund = m.deposit(rng.chance(0.05) ? "stranger" : t, amount);
        ledger.held += amount - refund;
        if (refund === 0n) add(ledger.netDeposit, t, amount);
      },
    ],
    [
      1,
      () => {
        const t = rng.pick(TRADERS);
        const amount = BigInt(rng.int(1, 8_000_000));
        m.withdraw(t, amount, { transferFails: rng.chance(0.1) });
        if (m.events.at(-1)!.event === "withdraw") {
          ledger.held -= amount;
          add(ledger.netDeposit, t, -amount);
        }
      },
    ],
    [1, () => m.setGuard(rng.pick(TRADERS), rng.chance(0.5) ? null : rng.int(0, 150_000))],
    [
      12,
      () => {
        // Reporters mostly agree around a slowly moving level, sometimes jump.
        if (rng.chance(0.1)) level = Math.max(1_000_000, level + rng.int(-300_000, 300_000));
        const bucket = m.now - (m.now % PARAMS.printIntervalSecs) - (rng.chance(0.2) ? PARAMS.printIntervalSecs : 0);
        const reporter = rng.pick(PARAMS.reporters);
        m.report(reporter, bucket, level + rng.int(-5000, 5000), BUNDLE);
      },
    ],
    [
      30,
      () => {
        const t = rng.pick(TRADERS);
        const series = rng.pick(SERIES);
        const round = phaseAt(PARAMS, series, m.now).round ?? 0;
        const side: Side = rng.chance(0.5) ? "Long" : "Short";
        const size = rng.int(1, rng.chance(0.05) ? 120 : 20);
        const price = orderPrice(m, rng, series);
        const band = m.getSeries(series)?.band ?? anchorBand(m);
        const cost = BigInt(size) * BigInt(side === "Long" ? price : Math.max(0, band - price));
        const lock = rng.chance(0.1) ? BigInt(rng.int(1000, 50_000)) : cost + BigInt(rng.int(0, 200_000));
        const salt = rng.hex(rng.int(32, 64));
        secrets.push(sealedCommit(m, t, series, round, side, size, price, lock, salt));
        add(ledger.outlay, t, lock);
      },
    ],
    [
      4,
      () => {
        if (secrets.length === 0) return;
        const s = rng.pick(secrets);
        revealSecret(m, rng.chance(0.2) ? { ...s, salt: rng.hex(32) } : s);
      },
    ],
    [
      2,
      () => {
        if (secrets.length === 0) return;
        const s = rng.pick(secrets);
        clear(s.series, s.round);
      },
    ],
    [
      2,
      () => {
        const t = rng.pick(TRADERS);
        const series = rng.pick(SERIES);
        const sets = rng.int(1, 5);
        const band = m.getSeries(series)?.band ?? anchorBand(m);
        m.mint(t, series, sets);
        add(ledger.outlay, t, BigInt(sets) * BigInt(band));
      },
    ],
    [2, () => m.merge(rng.pick(TRADERS), rng.pick(SERIES), rng.int(1, 5))],
    [
      1,
      () => m.transferPosition(rng.pick(TRADERS), rng.pick(SERIES), rng.pick(TRADERS), rng.int(0, 3), rng.int(0, 3)),
    ],
    [1, () => m.settle(rng.pick(SERIES))],
    [2, () => m.redeem(rng.pick(SERIES), rng.pick(TRADERS))],
  ];
  const weights = actions.reduce((w, [n]) => w + n, 0);

  const step = (where: string, action: () => void) => {
    const before = { totals: m.getTotals(), events: m.events.length, held: ledger.held };
    try {
      action();
    } catch (e) {
      if (!(e instanceof Error) || /must be (a non-negative integer|above zero)/.test(e.message)) throw e;
      assert.equal(m.events.length, before.events, `${where}: a failed call logged an event (${e.message})`);
      assert.deepEqual(m.getTotals(), before.totals, `${where}: a failed call moved dollars (${e.message})`);
      assert.equal(ledger.held, before.held, where);
    }
    checkInvariants(m, ledger, secrets, where);
  };

  for (let i = 0; i < STEPS; i++) {
    let r = rng.next() * weights;
    const index = actions.findIndex(([n]) => (r -= n) < 0);
    step(`seed ${seed} step ${i}`, actions[index]![1]);
    if (index !== 0) continue;
    // After the clock moves, diligent traders reveal what is due and clear what is over,
    // though not all of them, so forfeits and late clears still happen.
    for (const s of secrets.filter(waiting)) {
      if (rng.chance(0.8)) step(`seed ${seed} step ${i} reveal`, () => revealSecret(m, s));
    }
    for (const s of secrets) {
      const over = m.now >= roundEnd(PARAMS, s.series, s.round);
      if (over && m.getRound(s.series, s.round) && rng.chance(0.6)) step(`seed ${seed} step ${i} clear`, () => clear(s.series, s.round));
    }
  }

  // Wind down: clear what is left, settle, redeem everything.
  step(`seed ${seed} end`, () => m.setTime(Math.max(m.now, END)));
  for (const s of secrets) step(`seed ${seed} final clear`, () => m.getRound(s.series, s.round) && clear(s.series, s.round));
  for (const series of SERIES) {
    if (!m.getSeries(series)) continue;
    step(`seed ${seed} final settle`, () => {
      if (!m.getSeries(series)!.settlement) m.settle(series);
      const s = m.getSeries(series)!.settlement!;
      stats.settled++;
      if (s.void) stats.voided++;
    });
    for (const t of TRADERS) {
      const p = m.getPosition(series, t);
      if (p.long + p.short > 0) step(`seed ${seed} final redeem`, () => m.redeem(series, t));
    }
  }
  const totals = m.getTotals();
  assert.deepEqual([totals.locked, totals.setsBacking, totals.unredeemed], [0n, 0n, 0n], `seed ${seed}`);
  assert.equal(totals.free + totals.pools, ledger.held, `seed ${seed}`);
}

test(`invariants 1, 2 and 5 hold over ${RUNS} random action sequences`, (t) => {
  const stats = { settled: 0, voided: 0, cleared: 0, traded: 0 };
  for (let seed = 1; seed <= RUNS; seed++) runSequence(seed, stats);
  t.diagnostic(JSON.stringify(stats));
  // The sequences must actually reach the interesting states.
  assert.ok(stats.cleared > RUNS, `cleared ${stats.cleared}`);
  assert.ok(stats.traded > RUNS, `traded ${stats.traded}`);
  assert.ok(stats.settled > RUNS, `settled ${stats.settled}`);
  assert.ok(stats.voided > 0 && stats.voided < stats.settled, `voided ${stats.voided} of ${stats.settled}`);
});
