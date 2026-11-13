// The guest path against the fake RPC, which executes the signed transactions on an engine
// `Market`, and a fake faucet. The clock is the market's; sleeping moves it one second at a
// time, and a keeper and a counterparty act on it as the seconds pass. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSignedTransaction } from "@near-js/transactions";
import { commitHash, ERR, Market, type WireParams } from "@weir/engine";
import { depositRefunded, Guest, GuestError, memoryStorage, openingBand, readPlan, setupTransactions, suggestOrder, type GuestEvent, type GuestState } from "../src/guest.ts";
import { AGENT_KEY_METHODS } from "../src/weir.ts";
import { base64Decode, base64Encode, KeyPair, secretKeyFromSeed, utf8Decode, utf8Encode } from "../src/tx.ts";
import { ModelWeir, paramsFromWire } from "../src/weir.ts";
import { NearRpc, type FetchLike } from "../src/near.ts";
import { ChainWeir } from "../src/weir.ts";
import { fakeNear } from "./fake_near.ts";
import { rng, bytes } from "./rng.ts";

const T0 = 1_767_571_200;
const CONTRACT = "weir.testnet";
const USDC = "usdc.testnet";
// The fast preset (agents/src/presets.ts) with test accounts.
const PARAMS: WireParams = {
  usdc: USDC,
  underlying: "H100-USD-HR",
  t0: T0,
  period_secs: 3600,
  lead_secs: 3900,
  cutoff_secs: 300,
  commit_secs: 180,
  reveal_secs: 120,
  band_bps: 1500,
  tick: 1000,
  print_interval_secs: 300,
  report_grace_secs: 60,
  max_spread_bps: 200,
  min_prints: 9,
  void_after_secs: 1800,
  max_anchor_age_secs: 900,
  forfeit_bps: 100,
  min_lock: "1000000",
  commit_fee: "100000",
  max_commits: 64,
  max_order_size: 10_000,
  reporters: ["r0.testnet", "r1.testnet", "r2.testnet"],
  quorum: 2,
};
const SERIES = 10;
const OPEN = T0 + SERIES * 3600 - 3900;
const PRINT = 2_900_000;
const KEY = `weir-guest:${CONTRACT}`;

interface WorldOpts {
  /** Seconds after the auction of SERIES opens. */
  start: number;
  /** The keeper clears every round as soon as it is over. */
  keeper?: boolean;
  /** Bob commits a SHORT 5 at 500000 in the guest's round, and reveals it. */
  counterparty?: boolean;
  /** Faucet answers before success: status and body. */
  faucet?: { status: number; body: string; retryAfter?: string }[];
  /** No index print at all (the series cannot open). */
  noPrint?: boolean;
}

function world(o: WorldOpts) {
  const market = new Market(paramsFromWire(PARAMS), OPEN);
  const as = (id: string) => new ModelWeir(market, id).sync;
  if (!o.noPrint) {
    as("r0.testnet").change("report", { bucket: OPEN, price: PRINT, bundle: "11".repeat(32) });
    as("r1.testnet").change("report", { bucket: OPEN, price: PRINT, bundle: "11".repeat(32) });
    as("r2.testnet").change("report", { bucket: OPEN, price: PRINT, bundle: "11".repeat(32) });
  }
  market.setTime(OPEN + o.start);
  const bob = as("bob.testnet");
  bob.change("register", {});
  bob.change("deposit", { amount: "50000000" });
  const storage = memoryStorage();
  const events: GuestEvent[] = [];
  const created = new Set<string>();
  const faucetCalls: unknown[] = [];
  const faucetAnswers = [...(o.faucet ?? [])];
  const fake = fakeNear({ market, contractId: CONTRACT, usdcId: USDC });
  // The test dollar's balances, from the mints and deposits the fake executed, plus what Weir
  // sent back to accounts it did not know.
  const refunded = new Map<string, bigint>();
  const tokenBalance = (id: string) =>
    fake.sent.reduce((sum, s) => {
      if (s.receiver !== USDC) return sum;
      if (s.method === "mint" && s.args.account_id === id) return sum + BigInt(s.args.amount as string);
      if (s.method === "ft_transfer_call" && s.signer === id) return sum - BigInt(s.args.amount as string);
      return sum;
    }, refunded.get(id) ?? 0n);
  const reply = (body: unknown) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, ...(body as object) }) });
  let beforeSend: ((method: string, signer: string) => void) | null = null;
  fake.intercept = (_url, method, params) => {
    if (method === "query" && params.request_type === "view_account") {
      return created.has(params.account_id as string)
        ? reply({ result: { amount: "10000000000000000000000000", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182 } })
        : reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, data: "does not exist" } });
    }
    if (method === "query" && params.request_type === "call_function" && params.account_id === USDC && params.method_name === "ft_balance_of") {
      const { account_id } = JSON.parse(utf8Decode(base64Decode(params.args_base64 as string))) as { account_id: string };
      return reply({ result: { result: [...utf8Encode(JSON.stringify(tokenBalance(account_id).toString()))], logs: [] } });
    }
    if (method === "send_tx") {
      const tx = decodeSignedTransaction(base64Decode(params.signed_tx_base64 as string)).transaction;
      beforeSend?.(tx.actions[0]!.functionCall!.methodName, tx.signerId);
      const ft = tx.actions.find((a) => a.functionCall!.methodName === "ft_transfer_call");
      if (tx.receiverId === USDC && ft && market.getAccount(tx.signerId) === null) {
        const { amount } = JSON.parse(utf8Decode(Uint8Array.from(ft.functionCall!.args))) as { amount: string };
        refunded.set(tx.signerId, (refunded.get(tx.signerId) ?? 0n) + BigInt(amount));
      }
    }
    return undefined;
  };
  const faucetFetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { newAccountId: string; newAccountPublicKey: string };
    faucetCalls.push(body);
    const a = faucetAnswers.shift();
    if (a) return { status: a.status, text: async () => a.body, headers: { get: (h: string) => (h === "retry-after" ? (a.retryAfter ?? null) : null) } };
    created.add(body.newAccountId);
    const outcome = {
      status: { SuccessValue: base64Encode(utf8Encode("true")) },
      transaction: { hash: "FaucetTx1111111111111111111111111111111111111" },
      transaction_outcome: { outcome: { logs: [], gas_burnt: 1 } },
      receipts_outcome: [],
    };
    return { status: 200, text: async () => JSON.stringify(outcome) };
  };

  const state = () => JSON.parse(storage.data.get(KEY) ?? "null") as GuestState | null;
  let bobRound: number | null = null;
  const BOB = { side: "Short" as const, size: 5, price: 500_000, salt: "b0b0".repeat(8) };
  let crashNextSleep = false;
  // Each second: the keeper clears what is over, Bob reveals in the reveal phase.
  const tick = () => {
    const now = market.now;
    if (o.keeper) {
      for (const live of [SERIES, SERIES + 1]) {
        const s = market.getSeries(live);
        for (const r of s?.pendingRounds ?? []) {
          const end = OPEN + (live - SERIES) * 3600 + (r + 1) * 300;
          if (now >= end) as("keeper.testnet").change("clear", { series: live, round: r });
        }
      }
    }
    if (bobRound !== null) {
      const revealAt = OPEN + bobRound * 300 + 180;
      const round = market.getRound(SERIES, bobRound);
      if (now >= revealAt && round && round.commits.some((c) => c.owner === "bob.testnet" && c.order === null)) {
        bob.change("reveal", { series: SERIES, round: bobRound, seq: round.commits.find((c) => c.owner === "bob.testnet")!.seq, ...BOB });
      }
    }
  };
  const deps = {
    fetch: fake.fetch,
    faucetFetch,
    now: () => market.now * 1000,
    sleep: async (ms: number) => {
      if (crashNextSleep) {
        crashNextSleep = false;
        throw new Error("crash");
      }
      for (let s = 0; s < Math.ceil(ms / 1000); s++) {
        market.advance(1);
        tick();
      }
    },
    randomBytes: (() => {
      const r = rng(42);
      return (n: number) => bytes(r, n);
    })(),
    storage,
    onEvent: (e: GuestEvent) => {
      events.push(e);
      if (o.counterparty && e.type === "done" && e.step === "commit" && bobRound === null) {
        const order = state()!.order!;
        bobRound = order.round;
        const hash = commitHash({ series: SERIES, round: order.round, accountId: "bob.testnet", ...BOB });
        bob.change("commit", { series: SERIES, hash, lock: "5000000" });
      }
    },
  };
  const config = { contractId: CONTRACT, rpcUrls: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"], minGapMs: 0 };
  return {
    market,
    fake,
    storage,
    events,
    faucetCalls,
    state,
    deps,
    config,
    load: () => Guest.load(config, deps),
    crashOnNextSleep: () => void (crashNextSleep = true),
    setBeforeSend: (f: (method: string, signer: string) => void) => void (beforeSend = f),
    sentBy: (id: string, method?: string) => fake.sent.filter((s) => s.signer === id && (!method || s.method === method)),
  };
}

const refusals = (events: GuestEvent[]) => events.filter((e) => e.type === "refused").map((e) => (e as { method: string; text: string }).method + ": " + (e as { text: string }).text);

test("the whole path: account, test dollars, commit, reveal, the keeper clears, a filled order", async () => {
  const w = world({ start: 5, keeper: true, counterparty: true });
  const guest = await w.load();
  const result = await guest.run();
  const me = result.accountId;
  assert.match(me, /^weir-try-[0-9a-f]{12}\.testnet$/);
  // The faucet got the account name and the public key of the stored secret key.
  const key = await KeyPair.fromString(w.state()!.secretKey);
  assert.deepEqual(w.faucetCalls, [{ newAccountId: me, newAccountPublicKey: key.publicKeyString }]);
  // Order: reference 2.9 - floor 2.465 = 0.435, plus 15% of the band 0.87, rounded to the tick.
  assert.equal(result.order.price, 565_000);
  assert.equal(result.order.size, 5);
  assert.equal(result.order.lock, "2825000");
  assert.equal(result.round, 0);
  // Bob's SHORT at 500000 against the guest's LONG at 565000: (500000 + 565000) / 2 rounded down to the tick.
  assert.equal(result.clearingPrice, 532_000);
  assert.equal(result.clearingPriceAbs, 2_465_000 + 532_000);
  assert.equal(result.filled, 5);
  assert.equal(result.outcome, "filled in full");
  assert.deepEqual(result.position, { long: 5, short: 0 });
  // 5 USD deposited, 5 x 0.532 paid, 0.10 fee burned.
  assert.equal(result.balance, (5_000_000 - 5 * 532_000 - 100_000).toString());
  // Transactions in order, each with an explorer link; the keeper cleared, so the guest did not.
  assert.deepEqual(result.txs.map((t) => t.method), ["create_account", "register", "storage_deposit+mint+ft_transfer_call", "commit", "reveal"]);
  for (const e of w.events.filter((x) => x.type === "tx")) assert.equal((e as { url: string }).url, `https://testnet.nearblocks.io/txns/${(e as { hash: string }).hash}`);
  assert.deepEqual(w.sentBy(me).map((s) => `${s.receiver} ${s.method}`), [
    `${CONTRACT} register`,
    `${USDC} storage_deposit`,
    `${USDC} mint`,
    `${USDC} ft_transfer_call`,
    `${CONTRACT} commit`,
    `${CONTRACT} reveal`,
  ]);
  assert.equal(w.sentBy(me, "register")[0]!.deposit, 20_000_000_000_000_000_000_000n);
  // commit_hash was read before the commit was sent, and the revealed values match the stored order.
  const methods = w.fake.requests.map((r) => (r.method === "query" ? r.params.method_name ?? r.params.request_type : r.method));
  assert.ok(methods.lastIndexOf("commit_hash") < methods.indexOf("send_tx", methods.lastIndexOf("commit_hash")));
  const reveal = w.sentBy(me, "reveal")[0]!.args;
  assert.deepEqual(reveal, { series: SERIES, round: 0, seq: 0, side: "Long", size: 5, price: 565_000, salt: w.state()!.order!.salt });
  assert.deepEqual(refusals(w.events), []);
  // Run again: nothing more is sent.
  const n = w.fake.sent.length;
  assert.deepEqual(await (await w.load()).run(), result);
  assert.equal(w.fake.sent.length, n);
  // The secret key is in storage and in no event.
  assert.ok(!JSON.stringify(w.events).includes(w.state()!.secretKey));
  assert.equal((guest.state as Record<string, unknown>).secretKey, undefined);
});

test("a restart between commit and reveal resumes and reveals the same order", async () => {
  const w = world({ start: 5, keeper: true, counterparty: true });
  w.deps.onEvent = ((inner) => (e: GuestEvent) => {
    inner(e);
    if (e.type === "done" && e.step === "commit") w.crashOnNextSleep();
  })(w.deps.onEvent);
  await assert.rejects((await w.load()).run(), /crash/);
  const stored = w.state()!.order!;
  assert.deepEqual(stored.seqs, [0]);
  const result = await (await w.load()).run();
  const me = result.accountId;
  assert.equal(w.sentBy(me, "commit").length, 1);
  assert.equal(w.sentBy(me, "register").length, 1);
  assert.equal(w.sentBy(me, "ft_transfer_call").length, 1);
  assert.deepEqual(w.sentBy(me, "reveal")[0]!.args, { series: SERIES, round: stored.round, seq: 0, side: "Long", size: 5, price: stored.price, salt: stored.salt });
  assert.equal(result.filled, 5);
  assert.equal(w.faucetCalls.length, 1);
  assert.ok(w.events.some((e) => e.type === "step" && e.step === "key" && /resuming/.test(e.message)));
});

test("a restart after the commit landed but before its seq was stored does not commit again", async () => {
  const w = world({ start: 5, keeper: true, counterparty: true });
  const set = w.storage.set;
  let thrown = false;
  w.storage.set = (k, v) => {
    if (!thrown && (JSON.parse(v) as GuestState).order?.seqs) {
      thrown = true;
      throw new Error("crash while saving");
    }
    return set(k, v);
  };
  await assert.rejects((await w.load()).run(), /crash while saving/);
  assert.equal(w.state()!.order!.seqs, null, "the order and salt were stored before the commit was sent");
  const result = await (await w.load()).run();
  assert.equal(w.sentBy(result.accountId, "commit").length, 1);
  assert.ok(w.events.some((e) => e.type === "done" && e.step === "commit" && /found the commit/.test(e.message)));
  assert.equal(result.filled, 5);
});

test("the faucet answering 429 then creating the account; the faucet refusing", async () => {
  const w = world({ start: 5, keeper: true, faucet: [{ status: 429, body: "slow down", retryAfter: "20" }] });
  const result = await (await w.load()).run();
  assert.equal(w.faucetCalls.length, 2);
  const wait = w.events.find((e) => e.type === "wait" && e.step === "account") as { seconds: number; message: string };
  assert.equal(wait.seconds, 20);
  assert.match(wait.message, /HTTP 429, retry-after 20/);
  // No counterparty: the round traded nothing and the lock came back.
  assert.equal(result.clearingPrice, null);
  assert.equal(result.filled, 0);
  assert.match(result.outcome, /did not trade/);

  const r = world({ start: 5, faucet: [{ status: 400, body: "account name is not valid" }] });
  await assert.rejects((await r.load()).run(), (e: unknown) => {
    assert.ok(e instanceof GuestError);
    assert.equal(e.kind, "faucet");
    assert.match(e.message, /the faucet refused weir-try-[0-9a-f]+\.testnet: HTTP 400: account name is not valid/);
    return true;
  });
  assert.equal(r.fake.sent.length, 0);
});

test("with fewer than 30 s of the commit phase left, it waits for the next round", async () => {
  const w = world({ start: 160, keeper: true, counterparty: true });
  const result = await (await w.load()).run();
  assert.equal(result.round, 1);
  const waits = w.events.filter((e) => e.type === "wait" && e.step === "plan") as { message: string }[];
  assert.ok(waits.length >= 1);
  assert.match(waits[0]!.message, /only 20 s of the commit phase are left/);
  assert.equal(w.sentBy(result.accountId, "commit").length, 1);
  assert.equal(result.filled, 5);
});

test("a round nobody clears is cleared by the guest", async () => {
  const w = world({ start: 5, counterparty: true });
  const result = await (await w.load()).run();
  const clear = w.sentBy(result.accountId, "clear");
  assert.equal(clear.length, 1);
  assert.deepEqual(clear[0]!.args, { series: SERIES, round: 0 });
  assert.equal(clear[0]!.gas, 150_000_000_000_000n);
  assert.deepEqual(result.txs.map((t) => t.method).slice(-3), ["commit", "reveal", "clear"]);
  assert.equal(result.txs.length, 6, "faucet, register, the token transaction, commit, reveal, clear");
  assert.equal(result.filled, 5);
  // It gave the keeper 20 s first, reading the result every 5 s.
  assert.equal(w.events.filter((e) => e.type === "wait" && e.step === "clear" && /keeper/.test(e.message)).length, 4);
});

test("refusals carry the contract's text: a full round, a clear that lost the race, a stale index", async () => {
  // A round already holding 64 commits with larger locks: the commit is refused.
  const full = world({ start: 5 });
  for (let i = 0; i < 64; i++) {
    const p = new ModelWeir(full.market, `filler${i}.testnet`).sync;
    p.change("register", {});
    p.change("deposit", { amount: "20000000" });
    p.change("commit", { series: SERIES, hash: "ab".repeat(32), lock: "10000000" });
  }
  await assert.rejects((await full.load()).run(), (e: unknown) => {
    assert.ok(e instanceof GuestError);
    assert.equal(e.kind, "refused");
    assert.equal(e.refusal, ERR.ROUND_FULL);
    return true;
  });
  assert.deepEqual(refusals(full.events), [`commit: ${ERR.ROUND_FULL}`]);
  const refused = full.events.find((e) => e.type === "refused") as { hash: string; url: string };
  assert.equal(refused.url, `https://testnet.nearblocks.io/txns/${refused.hash}`);
  assert.equal(full.state()!.order, null, "a refused commit leaves no order behind");

  // The keeper clears between the guest's last look and its own clear.
  const race = world({ start: 5, counterparty: true });
  race.setBeforeSend((method, signer) => {
    if (method === "clear" && signer !== "keeper.testnet") new ModelWeir(race.market, "keeper.testnet").sync.change("clear", { series: SERIES, round: 0 });
  });
  const result = await (await race.load()).run();
  assert.deepEqual(refusals(race.events), [`clear: ${ERR.CLEARED}`]);
  assert.equal(result.filled, 5);

  // No print: the series cannot open, so nothing is created.
  const stale = world({ start: 5, noPrint: true });
  await assert.rejects((await stale.load()).run(), (e: unknown) => {
    assert.ok(e instanceof GuestError);
    assert.equal(e.kind, "stale");
    assert.match(e.message, /the index is stale: there is no index print/);
    return true;
  });
  assert.equal(stale.faucetCalls.length, 0);
  assert.equal(stale.state(), null);
});

test("the plan reads the chain only and suggests the order; the opening band follows SPEC 6.1", async () => {
  assert.deepEqual(openingBand(PARAMS, 2_900_000), { floor: 2_465_000, band: 870_000 });
  assert.deepEqual(openingBand(PARAMS, 2_900_999), { floor: 2_465_000, band: 870_000 });
  // Capped at band - tick, at least min_lock locked.
  assert.equal(suggestOrder(PARAMS, 870_000, 860_000, 5, 1500).price, 869_000);
  assert.equal(suggestOrder(PARAMS, 870_000, 0, 1, 1500).lock, "1000000");
  const w = world({ start: 5 });
  const rpc = new NearRpc({ urls: ["x"], fetch: w.fake.fetch });
  const plan = await readPlan(new ChainWeir({ rpc, contractId: CONTRACT }));
  assert.equal(plan.status, "ready");
  assert.equal(plan.series, SERIES);
  assert.equal(plan.round, 0);
  assert.equal(plan.seriesOpen, false);
  assert.deepEqual(plan.order, { side: "Long", size: 5, price: 565_000, lock: "2825000", fee: "100000", maxNeed: "4450000" });
  assert.equal(w.fake.requests.filter((r) => r.method === "send_tx").length, 0);
});

test("setup as data a wallet signs: register to Weir, then storage_deposit, mint and ft_transfer_call to the token", () => {
  const txs = setupTransactions({ contractId: CONTRACT, usdcId: USDC, accountId: "x.testnet", deposit: "5000000" });
  assert.deepEqual(
    txs.map((t) => ({ to: t.receiverId, calls: t.calls.map((c) => [c.methodName, c.args, c.gas, c.deposit]) })),
    [
      { to: CONTRACT, calls: [["register", {}, 10_000_000_000_000n, 20_000_000_000_000_000_000_000n]] },
      {
        to: USDC,
        calls: [
          ["storage_deposit", { account_id: "x.testnet", registration_only: true }, 10_000_000_000_000n, 1_250_000_000_000_000_000_000n],
          ["mint", { account_id: "x.testnet", amount: "5000000" }, 10_000_000_000_000n, 0n],
          ["ft_transfer_call", { receiver_id: CONTRACT, amount: "5000000", msg: "" }, 100_000_000_000_000n, 1n],
        ],
      },
    ],
  );
  const again = setupTransactions({ contractId: CONTRACT, usdcId: USDC, accountId: "x.testnet", deposit: "5000000", mint: "0", register: false });
  assert.deepEqual(again.map((t) => t.calls.map((c) => c.methodName)), [["storage_deposit", "ft_transfer_call"]]);
  // ft_transfer_call's result is what Weir kept: "0" means it sent the deposit back.
  assert.equal(depositRefunded("0", "5000000"), true);
  assert.equal(depositRefunded("5000000", "5000000"), false);
  assert.equal(depositRefunded(null, "5000000"), true);
});

test("a deposit that arrives before the registration is detected and deposited again on the next run", async () => {
  const w = world({ start: 5, keeper: true, counterparty: true });
  // The first `register` is answered as a success but never executed: the deposit then meets
  // an account Weir does not know, and the token gets it back (SPEC section 5).
  let lost = false;
  const inner = w.fake.intercept!;
  w.fake.intercept = (url, method, params) => {
    if (method === "send_tx" && !lost) {
      const tx = decodeSignedTransaction(base64Decode(params.signed_tx_base64 as string)).transaction;
      if (tx.actions[0]!.functionCall!.methodName === "register") {
        lost = true;
        const outcome = { logs: [], gas_burnt: 1, status: { SuccessValue: "" } };
        const result = { final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash: "LostRegister111111111111111111111111111111111" }, transaction_outcome: { id: "t", outcome }, receipts_outcome: [] };
        return { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }) };
      }
    }
    return inner(url, method, params);
  };
  await assert.rejects((await w.load()).run(), (e: unknown) => {
    assert.ok(e instanceof GuestError);
    assert.match(e.message, /sent the deposit of 5\.00 USD back: weir-try-[0-9a-f]+\.testnet was not registered with it when the deposit arrived\. The dollars are in the token account; run again to deposit again\./);
    return true;
  });
  const result = await (await w.load()).run();
  const me = result.accountId;
  // The second run registers and deposits the 5 USD already held, without minting again.
  assert.deepEqual(w.sentBy(me).map((s) => s.method), ["storage_deposit", "mint", "ft_transfer_call", "register", "storage_deposit", "ft_transfer_call", "commit", "reveal"]);
  assert.equal(result.filled, 5);
});

test("an account set up elsewhere trades with a key for the agent methods only: no deposit, no token call", async () => {
  const w = world({ start: 5, keeper: true, counterparty: true });
  const id = "wallet-user.testnet";
  const owner = new ModelWeir(w.market, id).sync;
  owner.change("register", {});
  owner.change("deposit", { amount: "5000000" });
  const guest = await Guest.forAccount(w.config, w.deps, { accountId: id, secretKey: secretKeyFromSeed(new Uint8Array(32).fill(3)) });
  const result = await guest.run();
  assert.equal(result.filled, 5);
  const sent = w.sentBy(id);
  assert.deepEqual(sent.map((s) => s.method), ["commit", "reveal"]);
  for (const s of sent) {
    assert.equal(s.receiver, CONTRACT);
    assert.equal(s.deposit, 0n);
    assert.ok((AGENT_KEY_METHODS as readonly string[]).includes(s.method));
  }
  assert.equal(w.faucetCalls.length, 0);

  // Too little free balance: a plain stop, nothing sent.
  const poor = world({ start: 5 });
  new ModelWeir(poor.market, id).sync.change("register", {});
  const g = await Guest.forAccount(poor.config, poor.deps, { accountId: id, secretKey: secretKeyFromSeed(new Uint8Array(32).fill(3)) });
  await assert.rejects(g.run(), (e: unknown) => {
    assert.ok(e instanceof GuestError);
    assert.equal(e.kind, "unfunded");
    assert.match(e.message, /free balance of wallet-user\.testnet in weir\.testnet is 0\.00 USD, below the 4\.45 USD/);
    return true;
  });
  assert.equal(poor.fake.sent.length, 0);
});

test("a function-call key without allowance for clear leaves it to the keeper, then stops in plain words", async () => {
  const w = world({ start: 5, counterparty: true });
  const id = "wallet-user.testnet";
  const owner = new ModelWeir(w.market, id).sync;
  owner.change("register", {});
  owner.change("deposit", { amount: "5000000" });
  const inner = w.fake.intercept!;
  w.fake.intercept = (url, method, params) => {
    if (method === "query" && params.request_type === "view_access_key" && params.account_id === id) {
      const perm = { FunctionCall: { allowance: "100000000000000000000000", receiver_id: CONTRACT, method_names: [...AGENT_KEY_METHODS] } };
      const nonce = w.fake.sent.filter((s) => s.signer === id).length;
      return { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { nonce, permission: perm, block_hash: "8".repeat(43), block_height: 1 } }) };
    }
    return inner(url, method, params);
  };
  const guest = await Guest.forAccount(w.config, w.deps, { accountId: id, secretKey: secretKeyFromSeed(new Uint8Array(32).fill(3)) });
  await assert.rejects(guest.run(), (e: unknown) => {
    assert.ok(e instanceof GuestError);
    assert.equal(e.kind, "allowance");
    assert.match(e.message, /below the 0\.155 NEAR a clear needs/);
    return true;
  });
  assert.deepEqual(w.sentBy(id).map((s) => s.method), ["commit", "reveal"]);
  // Once someone clears it, the next run reads the fill without sending anything.
  new ModelWeir(w.market, "keeper.testnet").sync.change("clear", { series: SERIES, round: 0 });
  const result = await (await Guest.load(w.config, w.deps)).run();
  assert.equal(result.filled, 5);
  assert.deepEqual(w.sentBy(id).map((s) => s.method), ["commit", "reveal"]);
});

test("bidding again with the same account: the result moves to history, no second account", async () => {
  const w = world({ start: 5, keeper: true, counterparty: true });
  const guest = await w.load();
  const first = await guest.run();
  await guest.nextBid();
  assert.equal(w.state()!.result, null);
  assert.equal(w.state()!.order, null);
  assert.deepEqual(w.state()!.txs, []);
  assert.deepEqual(w.state()!.history!.map((r) => r.round), [first.round]);
  const second = await (await w.load()).run();
  assert.equal(second.accountId, first.accountId);
  assert.ok(second.round > first.round);
  assert.equal(w.faucetCalls.length, 1);
  assert.equal(w.sentBy(first.accountId, "register").length, 1);
  assert.equal(w.sentBy(first.accountId, "commit").length, 2);
  assert.ok(!second.txs.some((t) => t.method === "create_account" || t.method === "register"));
  // An open order cannot be put aside.
  const third = await w.load();
  await third.nextBid();
  const s = w.state()!;
  s.order = { ...first.order };
  w.storage.data.set(KEY, JSON.stringify(s));
  await assert.rejects((await w.load()).nextBid(), /still open/);
});

test("a page back after the reveal phase: the missed reveal ends the bid with a result, no throw, and the account bids again", async () => {
  const w = world({ start: 5, keeper: true, counterparty: true });
  const inner = w.deps.onEvent;
  w.deps.onEvent = (e: GuestEvent) => {
    inner(e);
    if (e.type === "done" && e.step === "commit") w.crashOnNextSleep();
  };
  await assert.rejects((await w.load()).run(), /crash/);
  w.deps.onEvent = inner;
  const order = w.state()!.order!;
  // The page was closed through the reveal phase: the round is over, nobody has cleared it yet.
  w.market.setTime(OPEN + order.round * 300 + 300 + 5);
  const result = await (await w.load()).run();
  const me = result.accountId;
  assert.equal(w.sentBy(me, "reveal").length, 0);
  assert.equal(result.order.reveal, "missed");
  assert.equal(result.filled, 0);
  assert.match(result.outcome, /^not revealed in time: 1% of the lock \(0\.02825 USD\) is forfeited at clearing and the rest is back in the free balance$/);
  const deposited = BigInt(w.sentBy(me, "ft_transfer_call")[0]!.args.amount as string);
  assert.equal(result.balance, (deposited - 100_000n - BigInt(order.lock) / 100n).toString());
  assert.ok(w.events.some((e) => e.type === "step" && e.step === "reveal" && /ended before the order was revealed/.test(e.message)));
  // Terminal: loading again sends nothing and returns the same result.
  const n = w.fake.sent.length;
  assert.deepEqual(await (await w.load()).run(), result);
  assert.equal(w.fake.sent.length, n);
  // A new bid with the same account.
  const g = await w.load();
  await g.nextBid();
  const second = await g.run();
  assert.equal(second.accountId, me);
  assert.ok(second.round > order.round);
  assert.equal(w.sentBy(me, "reveal").length, 1);
  assert.equal(w.faucetCalls.length, 1);
});

test("a page back after the round was cleared without its reveal: the stored order ends as missed", async () => {
  const w = world({ start: 5, keeper: true });
  w.deps.onEvent = ((inner) => (e: GuestEvent) => {
    inner(e);
    if (e.type === "done" && e.step === "commit") w.crashOnNextSleep();
  })(w.deps.onEvent);
  await assert.rejects((await w.load()).run(), /crash/);
  const order = w.state()!.order!;
  w.market.setTime(OPEN + order.round * 300 + 300 + 30);
  new ModelWeir(w.market, "keeper.testnet").sync.change("clear", { series: SERIES, round: order.round });
  const result = await (await w.load()).run();
  assert.equal(result.order.reveal, "missed");
  assert.match(result.outcome, /^not revealed in time/);
  assert.equal(w.state()!.result!.round, order.round);
  await (await w.load()).nextBid();
  assert.equal(w.state()!.order, null);
});
