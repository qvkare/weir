// The test bid's view state: the storage adapter, the steps the guest's events make, the button's
// rules and the phase clock. No network: events are written out as the guest sends them.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adviceFor,
  bidButton,
  deliveryEnd,
  forfeitOf,
  guestKey,
  guestStorage,
  hasOpenBid,
  initialTry,
  missedReveal,
  phaseNow,
  readStored,
  readWallet,
  revealMissed,
  rowOf,
  settleable,
  STEP_IDS,
  stepLabel,
  storageWorks,
  tryReducer,
  walletAccount,
  walletGuestKey,
  walletKey,
  type ButtonInput,
  type GuestEventLike,
  type KV,
  type PlanView,
  type ResultLike,
  type TryState,
} from "./try-state.ts";

function memoryKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const KEY = guestKey("weir-h100-fast-w1.testnet");
const ACCOUNT = "weir-try-070943795d17.testnet";
const ORDER = { series: 43, round: 5, side: "Long", size: 5, price: 514_000, lock: "2570000", salt: "aa", hash: "bb", floor: 2_386_000, band: 842_000, seqs: [0] };
const RESULT: ResultLike = { accountId: ACCOUNT, series: 43, round: 5, order: ORDER, clearingPrice: 452_000, clearingPriceAbs: 2_838_000, filled: 5, outcome: "filled in full", position: { long: 5, short: 0 }, balance: "2640000", seconds: 341 };
const tx = (step: string, method: string, hash: string) => ({ step, method, hash, ok: true });

// ── Storage ──────────────────────────────────────────────────────

test("storage: the key lives under weir-guest:<contract>, the page reads everything but the secret key", () => {
  assert.equal(KEY, "weir-guest:weir-h100-fast-w1.testnet");
  const kv = memoryKV();
  const s = guestStorage(kv);
  assert.equal(s.get(KEY), null);
  s.set(KEY, JSON.stringify({ version: 1, contractId: "weir-h100-fast-w1.testnet", accountId: ACCOUNT, secretKey: "ed25519:SECRET", external: false, startedAt: 1, order: ORDER, result: null, txs: [tx("account", "create_account", "H1")] }));
  const stored = readStored(s.get(KEY));
  assert.ok(stored);
  assert.equal(stored.accountId, ACCOUNT);
  assert.ok(!JSON.stringify(stored).includes("SECRET"));
  assert.deepEqual(stored.history, []);
  assert.ok(hasOpenBid(stored));
  s.forget(KEY);
  assert.equal(kv.data.size, 0);
  assert.equal(readStored(null), null);
  assert.equal(readStored("{not json"), null);
  assert.equal(readStored(JSON.stringify({ accountId: 7 })), null);
});

test("storage: a browser that refuses to store makes the write throw, so the guest stops before it sends", () => {
  const refusing: KV = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => undefined,
  };
  assert.equal(storageWorks(refusing), false);
  assert.equal(storageWorks(null), false);
  assert.equal(storageWorks(memoryKV()), true);
  assert.throws(() => guestStorage(refusing).set(KEY, "{}"), /refused to store the test account.*QuotaExceededError.*nothing more is sent/);
  const unreadable: KV = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => undefined,
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(guestStorage(unreadable).get(KEY), null);
  assert.doesNotThrow(() => guestStorage(unreadable).forget(KEY));
});

// ── The steps ────────────────────────────────────────────────────

// The events of the testnet run in chain/README.md, in the order the guest sends them.
const RUN: GuestEventLike[] = [
  { type: "done", step: "plan", message: "series 43, round 5: 54 s of the commit phase left" },
  { type: "done", step: "key", message: `new key for ${ACCOUNT}` },
  { type: "step", step: "account", message: `asking the testnet faucet to create ${ACCOUNT}` },
  { type: "tx", step: "account", method: "create_account", hash: "EQG", url: "https://testnet.nearblocks.io/txns/EQG", ok: true },
  { type: "done", step: "account", message: `${ACCOUNT} created by the faucet` },
  { type: "step", step: "register", message: "registering with weir-h100-fast-w1.testnet (0.02 NEAR)" },
  { type: "tx", step: "register", method: "register", hash: "H3u", url: "https://testnet.nearblocks.io/txns/H3u", ok: true },
  { type: "done", step: "register", message: "registered" },
  { type: "step", step: "fund", message: "minting 5 USD of the test dollar weir-usdc-w1.testnet and depositing 5 USD into weir-h100-fast-w1.testnet" },
  { type: "tx", step: "fund", method: "storage_deposit+mint+ft_transfer_call", hash: "Hp8", url: "https://testnet.nearblocks.io/txns/Hp8", ok: true },
  { type: "done", step: "fund", message: "deposited 5 USD" },
  { type: "step", step: "commit", message: "committing series 43 round 5: LONG 5 GPU-hours at most 2.9 USD per GPU-hour, lock 2.57 USD, fee 0.1 USD" },
  { type: "tx", step: "commit", method: "commit", hash: "79u", url: "https://testnet.nearblocks.io/txns/79u", ok: true },
  { type: "done", step: "commit", message: "committed as seq 0; the order stays sealed until the reveal phase" },
  { type: "wait", step: "reveal", seconds: 40, message: "the reveal phase of round 5 opens in 40 s" },
];

const play = (events: GuestEventLike[], from: TryState = tryReducer(initialTry(), { type: "start", at: 0 }), at = 1_000_000) => events.reduce((s, e) => tryReducer(s, { type: "event", e, at }), from);

test("steps: the guest's events fill the rows in order, each with its transaction link", () => {
  // The key is made before the faucet is asked: the account is not done yet.
  assert.equal(play(RUN.slice(0, 3)).rows.account.status, "active");
  const s = play(RUN);
  assert.deepEqual(
    STEP_IDS.map((id) => s.rows[id].status),
    ["done", "done", "done", "done", "active", "todo", "todo", "todo"],
  );
  assert.deepEqual(s.rows.fund.txs, [{ method: "storage_deposit+mint+ft_transfer_call", url: "https://testnet.nearblocks.io/txns/Hp8", ok: true }]);
  assert.equal(s.rows.commit.note, "committed as seq 0; the order stays sealed until the reveal phase");
  // The wait counts down from when it was heard.
  assert.deepEqual(s.wait, { step: "reveal", until: 1_000_000 + 40_000, message: "the reveal phase of round 5 opens in 40 s" });

  const later = play([
    { type: "step", step: "reveal", message: "revealing seq 0: LONG 5 at 2.9 USD" },
    { type: "tx", step: "reveal", method: "reveal", hash: "DJf", url: "https://testnet.nearblocks.io/txns/DJf", ok: true },
    { type: "done", step: "reveal", message: "revealed seq 0" },
    { type: "wait", step: "clear", seconds: 5, message: "waiting for the keeper to clear the round" },
    { type: "refused", step: "clear", method: "clear", text: "round already cleared", hash: "MMf", url: "https://testnet.nearblocks.io/txns/MMf" },
  ], s);
  assert.equal(later.rows.revealWait.status, "done");
  assert.equal(later.rows.reveal.status, "done");
  assert.equal(later.rows.clearWait.status, "active");
  // A refusal the guest went past is kept verbatim on its row.
  assert.deepEqual(later.rows.clear.refusals, ["round already cleared"]);

  const done = tryReducer(later, { type: "result", result: RESULT });
  assert.equal(done.run, "done");
  assert.ok(STEP_IDS.every((id) => done.rows[id].status === "done"));
  assert.equal(done.wait, null);
  assert.equal(done.sealed, null);
});

test("steps: already-done setup reads as done (an account set up earlier, a balance that covers)", () => {
  const s = play([
    { type: "step", step: "key", message: `resuming ${ACCOUNT}` },
    { type: "step", step: "account", message: `${ACCOUNT} exists` },
    { type: "step", step: "register", message: `${ACCOUNT} is registered with weir-h100-fast-w1.testnet` },
    { type: "step", step: "fund", message: "free balance 4.31 USD covers 4.31 USD" },
  ]);
  assert.deepEqual([s.rows.account.status, s.rows.register.status, s.rows.fund.status, s.rows.commit.status], ["done", "done", "done", "todo"]);
});

test("steps: who signed the setup changes the first label only, never the rows", () => {
  assert.equal(stepLabel("account", "guest"), "Account created");
  assert.equal(stepLabel("account", "wallet"), "Wallet connected");
  for (const id of STEP_IDS.slice(1)) assert.equal(stepLabel(id, "guest"), stepLabel(id, "wallet"));
  const wallet = play(RUN, tryReducer(initialTry("wallet"), { type: "start", at: 0 }));
  const guest = play(RUN);
  assert.deepEqual(wallet.rows, guest.rows);
  assert.equal(rowOf("reveal", "wait"), "revealWait");
  assert.equal(rowOf("reveal", "step"), "reveal");
  assert.equal(rowOf("result", "done"), "clear");
  assert.equal(rowOf("plan", "wait"), null);
});

test("steps: a failure marks the step in progress and keeps the contract's text and one sentence of advice", () => {
  const s = play(RUN.slice(0, 12));
  const failed = tryReducer(s, { type: "error", error: { kind: "refused", message: "the contract refused the commit: round is full", refusal: "round is full", advice: adviceFor("refused", "commit") } });
  assert.equal(failed.run, "failed");
  assert.equal(failed.rows.commit.status, "failed");
  assert.equal(failed.error?.refusal, "round is full");
  assert.equal(failed.error?.advice, "Nothing was committed and no fee was paid. Try again in the next round.");
  // Pressing the button again starts from the failed step, not from the top.
  const again = tryReducer(failed, { type: "start", at: 0 });
  assert.equal(again.rows.commit.status, "todo");
  assert.equal(again.rows.fund.status, "done");
  assert.equal(again.error, null);
  for (const kind of ["closed", "stale", "timeout", "faucet", "unfunded", "allowance", "refused", "rpc", "unknown"]) assert.match(adviceFor(kind, null), /^[A-Z][^.]*\.( [A-Z][^.]*\.)?( [a-z;][^.]*\.)?/);
});

test("restore: a stored guest rebuilds its rows; a sealed order is open (resumed on load), a result is done", () => {
  const sealed = readStored(JSON.stringify({ accountId: ACCOUNT, secretKey: "x", order: ORDER, result: null, txs: [tx("account", "create_account", "EQG"), tx("register", "register", "H3u"), tx("fund", "storage_deposit+mint+ft_transfer_call", "Hp8"), tx("commit", "commit", "79u")] }));
  const s = tryReducer(initialTry(), { type: "restore", stored: sealed });
  assert.equal(s.accountId, ACCOUNT);
  assert.equal(s.run, "idle");
  assert.deepEqual(s.sealed, ORDER);
  assert.deepEqual(STEP_IDS.map((id) => s.rows[id].status), ["done", "done", "done", "done", "todo", "todo", "todo", "todo"]);
  assert.equal(s.rows.commit.txs[0]!.url, "https://testnet.nearblocks.io/txns/79u");

  const done = tryReducer(initialTry(), { type: "restore", stored: readStored(JSON.stringify({ accountId: ACCOUNT, order: ORDER, result: RESULT, txs: [], history: [{ ...RESULT, round: 2 }] })) });
  assert.equal(done.run, "done");
  assert.equal(done.sealed, null);
  assert.equal(done.result?.filled, 5);
  assert.equal(done.history.length, 1);

  // Bid again: the next stored state has no order and no result, and keeps the account.
  const next = tryReducer(done, { type: "next", stored: readStored(JSON.stringify({ accountId: ACCOUNT, order: null, result: null, txs: [], history: [RESULT] })) });
  assert.equal(next.accountId, ACCOUNT);
  assert.equal(next.result, null);
  assert.ok(STEP_IDS.every((id) => next.rows[id].status === "todo"));
  assert.deepEqual(tryReducer(next, { type: "forget" }), initialTry());
  assert.deepEqual(tryReducer(initialTry(), { type: "restore", stored: null }), initialTry());
});

test("settle: the steps of settle and redeem go to their own block, with the contract's text when refused", () => {
  let s = tryReducer(initialTry(), { type: "settle-start" });
  s = play([{ type: "refused", step: "settle", method: "settle", text: "delivery not over", hash: null, url: null }], s);
  assert.equal(s.settle?.refusal, "delivery not over");
  assert.ok(STEP_IDS.every((id) => s.rows[id].status === "todo"));
  s = tryReducer(s, { type: "settle-done", settled: false, reason: "delivery not over", balance: "2640000", txs: [] });
  assert.equal(s.settle?.status, "failed");
  s = tryReducer(s, { type: "settle-done", settled: true, reason: null, balance: "5000000", txs: [{ method: "redeem", hash: "R1", ok: true }] });
  assert.deepEqual(s.settle, { status: "done", note: null, refusal: null, balance: "5000000", txs: [{ method: "redeem", url: "https://testnet.nearblocks.io/txns/R1", ok: true }] });
});

// ── The button and the clock ─────────────────────────────────────

const PLAN: PlanView = {
  now: 1_000_000,
  readAt: 0,
  status: "ready",
  reason: "series 43, round 5: 100 s of the commit phase left",
  series: 43,
  round: 5,
  phase: "Commit",
  phaseEndsAt: 1_000_100,
  floor: 2_386_000,
  band: 842_000,
  tick: 1000,
  lastClearing: { round: 4, price: 452_000 },
  order: { side: "Long", size: 5, price: 514_000, lock: "2570000", fee: "100000", maxNeed: "4310000" },
  commitSecs: 180,
  revealSecs: 120,
  t0: 1_000_000 - 43 * 3600,
  periodSecs: 3600,
  forfeitBps: 100,
};
const ready: ButtonInput = { mode: "chain", storage: true, busy: false, open: false, plan: PLAN, planError: null, now: PLAN.now };

test("button: enabled in a commit phase with 30 s or more left", () => {
  assert.deepEqual(bidButton(ready), { enabled: true, reason: null, until: null });
  assert.equal(bidButton({ ...ready, now: PLAN.now + 70 }).enabled, true);
});

test("button: disabled with less than 30 s of commit left, counting down to the next commit phase", () => {
  const b = bidButton({ ...ready, now: PLAN.now + 71 });
  assert.equal(b.enabled, false);
  assert.equal(b.reason, "Less than 30 s of the commit phase is left.");
  assert.equal(b.until, PLAN.phaseEndsAt! + 120);
  // In the reveal phase: the same next commit.
  const r = bidButton({ ...ready, now: PLAN.now + 150 });
  assert.equal(r.reason, "The round is in its reveal phase.");
  assert.equal(r.until, PLAN.phaseEndsAt! + 120);
  // Once that commit phase opens, the old plan carries forward and the button is on again.
  assert.equal(bidButton({ ...ready, now: PLAN.phaseEndsAt! + 121 }).enabled, true);
  // A plan read in a reveal phase.
  assert.equal(bidButton({ ...ready, plan: { ...PLAN, status: "wait", phase: "Reveal" }, now: PLAN.now }).until, PLAN.phaseEndsAt);
});

test("button: disabled when the market is closed or stale, while a call is in flight, with a bid open, without storage or a plan", () => {
  const off = (i: Partial<ButtonInput>) => bidButton({ ...ready, ...i });
  assert.deepEqual(off({ plan: { ...PLAN, status: "closed" } }), { enabled: false, reason: "No series is in its auction window now.", until: null });
  assert.match(off({ plan: { ...PLAN, status: "stale" } }).reason!, /index is stale/);
  assert.equal(off({ busy: true }).reason, "A call is in flight.");
  assert.match(off({ open: true }).reason!, /sealed bid is still open/);
  assert.match(off({ storage: false }).reason!, /does not let the page keep data/);
  assert.equal(off({ plan: null }).reason, "Reading the market.");
  assert.match(off({ plan: null, planError: "near-testnet.drpc.org answered HTTP 429" }).reason!, /could not be read: .*429/);
  assert.match(off({ mode: "model" }).reason!, /model/);
  assert.match(off({ mode: "none" }).reason!, /not deployed/);
  // Closed or stale outrank the clock; in-flight outranks the plan.
  assert.equal(off({ busy: true, plan: { ...PLAN, status: "closed" } }).reason, "A call is in flight.");
});

test("clock: phases repeat every commit + reveal seconds from what the plan read", () => {
  assert.deepEqual(phaseNow(PLAN, PLAN.now), { phase: "Commit", endsAt: 1_000_100, nextCommitAt: 1_000_220 });
  assert.deepEqual(phaseNow(PLAN, 1_000_100), { phase: "Reveal", endsAt: 1_000_220, nextCommitAt: 1_000_220 });
  assert.deepEqual(phaseNow(PLAN, 1_000_220 + 300), { phase: "Commit", endsAt: 1_000_220 + 300 + 180, nextCommitAt: 1_000_220 + 600 });
  assert.equal(phaseNow({ ...PLAN, phase: "Closed", phaseEndsAt: null }, PLAN.now), null);
});

test("settle and redeem: offered for each series of this account once its delivery hour is over", () => {
  assert.equal(deliveryEnd(PLAN, 43), PLAN.t0 + 44 * 3600);
  const s = { result: RESULT, history: [{ ...RESULT, round: 2 }, { ...RESULT, series: 42 }] };
  assert.deepEqual(settleable(s, PLAN, deliveryEnd(PLAN, 43) - 1), [42]);
  assert.deepEqual(settleable(s, PLAN, deliveryEnd(PLAN, 43)), [42, 43]);
  assert.deepEqual(settleable(s, null, deliveryEnd(PLAN, 43)), []);
  assert.deepEqual(settleable({ result: null, history: [] }, PLAN, 9e9), []);
});

test("a missed reveal: the bid ends with a result, the reveal row fails, nothing is left open, and a new bid can start", () => {
  const missed: ResultLike = { ...RESULT, order: { ...ORDER, reveal: "missed" }, clearingPrice: 452_000, filled: 0, outcome: "not revealed in time", position: { long: 0, short: 0 }, balance: "4871000" };
  assert.ok(missedReveal(missed));
  assert.ok(!missedReveal(RESULT));
  // Live: the guest says the phase ended, then returns the result.
  const s = tryReducer(
    play(
      [...RUN, { type: "step", step: "reveal", message: "the reveal phase of round 5 ended before the order was revealed: 1% of its lock is forfeited when the round clears, and the rest returns" }],
      tryReducer(initialTry(), { type: "restore", stored: readStored(JSON.stringify({ accountId: ACCOUNT, order: ORDER, result: null, txs: [] })) }),
    ),
    { type: "result", result: missed },
  );
  assert.equal(s.run, "done");
  assert.equal(s.sealed, null);
  assert.equal(s.rows.reveal.status, "failed");
  assert.deepEqual(STEP_IDS.filter((id) => s.rows[id].status !== "done"), ["reveal"]);
  // Stored: terminal, not open, so the page does not resume it; restored the same way.
  const stored = readStored(JSON.stringify({ accountId: ACCOUNT, order: missed.order, result: missed, txs: [tx("commit", "commit", "79u")] }));
  assert.equal(hasOpenBid(stored), false);
  const back = tryReducer(initialTry(), { type: "restore", stored });
  assert.equal(back.run, "done");
  assert.equal(back.rows.reveal.status, "failed");
  // The button for the next bid follows the usual rules.
  assert.equal(bidButton({ ...ready, open: hasOpenBid(stored) }).enabled, true);
  const next = tryReducer(back, { type: "next", stored: readStored(JSON.stringify({ accountId: ACCOUNT, order: null, result: null, txs: [], history: [missed] })) });
  assert.equal(next.accountId, ACCOUNT);
  assert.ok(STEP_IDS.every((id) => next.rows[id].status === "todo"));
  // 1% of a 2.90 USD lock is 0.029 USD.
  assert.equal(forfeitOf("2900000", 100), 29_000n);
});

test("a missed reveal before the round is read: the reveal row is failed, never done, while the clear waits", () => {
  const missedOrder = { ...ORDER, reveal: "missed" as const };
  const storedOpen = (order: typeof ORDER & { reveal?: "done" | "missed" | "evicted" }) => readStored(JSON.stringify({ accountId: ACCOUNT, order, result: null, txs: [tx("commit", "commit", "79u")] }));
  // The page comes back after the reveal phase: resumed, the guest finds the reveal missed and stores it.
  let s = tryReducer(initialTry(), { type: "restore", stored: storedOpen(ORDER) });
  s = tryReducer(s, { type: "start", at: 0 });
  s = tryReducer(s, { type: "event", e: { type: "step", step: "reveal", message: "the reveal phase of round 5 ended before the order was revealed: 1% of its lock is forfeited when the round clears, and the rest returns" }, at: 0 });
  s = tryReducer(s, { type: "stored", stored: storedOpen(missedOrder) });
  assert.equal(s.rows.reveal.status, "failed");
  assert.ok(revealMissed(s));
  // The keeper's 20 s: the clear's waits settle the rows before it, but not the failed reveal.
  for (let i = 0; i < 4; i++) {
    s = tryReducer(s, { type: "event", e: { type: "wait", step: "clear", seconds: 5, message: "waiting for the keeper to clear the round" }, at: i * 5000 });
    s = tryReducer(s, { type: "stored", stored: storedOpen(missedOrder) });
    assert.equal(s.rows.reveal.status, "failed");
    assert.equal(s.rows.clearWait.status, "active");
  }
  s = tryReducer(s, { type: "event", e: { type: "step", step: "clear", message: "nobody cleared round 5; clearing it" }, at: 20_000 });
  assert.equal(s.rows.reveal.status, "failed");
  // A reload in those seconds restores it failed as well.
  assert.equal(tryReducer(initialTry(), { type: "restore", stored: storedOpen(missedOrder) }).rows.reveal.status, "failed");
  // A reveal that landed is not touched.
  const done = tryReducer(initialTry(), { type: "restore", stored: storedOpen({ ...ORDER, reveal: "done" }) });
  assert.notEqual(done.rows.reveal.status, "failed");
  assert.ok(!revealMissed(done));
});

test("wallet storage: the wallet's record and its guest state have their own keys beside the throwaway guest's", () => {
  const kv = memoryKV();
  assert.equal(walletKey("w.testnet"), "weir-wallet:w.testnet");
  assert.equal(walletGuestKey("w.testnet"), "weir-wallet-guest:w.testnet");
  assert.notEqual(walletGuestKey("w.testnet"), guestKey("w.testnet"));
  assert.equal(readWallet(kv, "w.testnet"), null);
  kv.setItem(walletKey("w.testnet"), JSON.stringify({ version: 1, contractId: "w.testnet", secretKey: "ed25519:S", publicKey: "ed25519:P", walletId: "meteor-wallet", accountId: "alice.testnet", phase: "connecting", since: 1 }));
  assert.equal(walletAccount(readWallet(kv, "w.testnet")), null);
  kv.setItem(walletKey("w.testnet"), JSON.stringify({ version: 1, contractId: "w.testnet", secretKey: "ed25519:S", publicKey: "ed25519:P", walletId: "meteor-wallet", accountId: "alice.testnet", phase: "connected", since: 1 }));
  assert.equal(walletAccount(readWallet(kv, "w.testnet")), "alice.testnet");
});
