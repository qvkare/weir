// ChainWeir sends what the spec names, with the gas and deposits of the README, and behaves
// exactly like ModelWeir: one scenario runs on both and must produce the same transcript.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commitHash, Market, type WireParams } from "@weir/engine";
import { NearAccount, NearRpc } from "../src/near.ts";
import { base58Encode, KeyPair } from "../src/tx.ts";
import { CallFailed, CHANGE_METHODS, ChainWeir, ModelWeir, paramsFromWire, VIEW_METHODS, type WeirPort } from "../src/weir.ts";
import { fakeNear } from "./fake_near.ts";

const T0 = 1_767_571_200;
const PARAMS: WireParams = {
  usdc: "usdc.testnet",
  underlying: "H100-USD-HR",
  t0: T0,
  period_secs: 3600,
  lead_secs: 3900,
  cutoff_secs: 300,
  commit_secs: 180,
  reveal_secs: 120,
  band_bps: 2000,
  tick: 1000,
  print_interval_secs: 300,
  report_grace_secs: 60,
  max_move_bps: 1500,
  min_prints: 9,
  void_after_secs: 1800,
  max_anchor_age_secs: 900,
  forfeit_bps: 100,
  min_lock: "1000000",
  max_commits: 64,
  max_order_size: 10_000,
  reporters: ["r0.testnet", "r1.testnet", "r2.testnet"],
  quorum: 2,
};

const TGAS = 1_000_000_000_000n;
const FEE = 20_000_000_000_000_000_000_000n;

// Argument names exactly as SPEC sections 5 to 14 write them, and the gas and deposit the README lists.
const SPEC_CHANGES: Record<string, { args: Record<string, unknown>; receiver: "weir" | "usdc"; method: string; gas: bigint; deposit: bigint }> = {
  register: { args: { account_id: "x.testnet" }, receiver: "weir", method: "register", gas: 30n * TGAS, deposit: FEE },
  deposit: { args: { receiver_id: "weir.testnet", amount: "5000000", msg: "x.testnet" }, receiver: "usdc", method: "ft_transfer_call", gas: 100n * TGAS, deposit: 1n },
  withdraw: { args: { amount: "5" }, receiver: "weir", method: "withdraw", gas: 100n * TGAS, deposit: 1n },
  set_guard: { args: { guard: 50_000 }, receiver: "weir", method: "set_guard", gas: 30n * TGAS, deposit: 1n },
  commit: { args: { series: 1, hash: "ab".repeat(32), lock: "2000000" }, receiver: "weir", method: "commit", gas: 50n * TGAS, deposit: 0n },
  reveal: {
    args: { series: 1, round: 2, seq: 3, side: "Short", size: 4, price: 5000, salt: "cd".repeat(16) },
    receiver: "weir",
    method: "reveal",
    gas: 50n * TGAS,
    deposit: 0n,
  },
  clear: { args: { series: 1, round: 2 }, receiver: "weir", method: "clear", gas: 300n * TGAS, deposit: 0n },
  mint: { args: { series: 1, sets: 2 }, receiver: "weir", method: "mint", gas: 50n * TGAS, deposit: 0n },
  merge: { args: { series: 1, sets: 2 }, receiver: "weir", method: "merge", gas: 50n * TGAS, deposit: 0n },
  transfer_position: { args: { series: 1, to: "y.testnet", long: 2, short: 0 }, receiver: "weir", method: "transfer_position", gas: 50n * TGAS, deposit: 1n },
  report: { args: { bucket: 300, price: 2_000_000, bundle: "ef".repeat(32) }, receiver: "weir", method: "report", gas: 50n * TGAS, deposit: 0n },
  settle: { args: { series: 1 }, receiver: "weir", method: "settle", gas: 100n * TGAS, deposit: 0n },
  redeem: { args: { series: 1, account_id: "y.testnet" }, receiver: "weir", method: "redeem", gas: 50n * TGAS, deposit: 0n },
  prune_result: { args: { series: 1, round: 2 }, receiver: "weir", method: "prune_result", gas: 50n * TGAS, deposit: 0n },
};

const SPEC_VIEWS: Record<string, Record<string, unknown>> = {
  get_params: {},
  get_status: {},
  get_series: { series: 1 },
  get_account: { account_id: "x.testnet" },
  get_position: { series: 1, account_id: "x.testnet" },
  get_round: { series: 1, round: 2 },
  get_result: { series: 1, round: 2 },
  get_results: { series: 1, from_round: 0, limit: 10 },
  get_print: { bucket: 300 },
  get_last_print: {},
  get_prints: { from_bucket: 0, limit: 10 },
  get_accumulator: { series: 1 },
  get_totals: {},
  commit_hash: { series: 1, round: 2, account_id: "x.testnet", side: "Long", size: 3, price: 4000, salt: "ab".repeat(16) },
};

const keyFor = (name: string) => KeyPair.fromString(`ed25519:${base58Encode(new TextEncoder().encode(name.padEnd(32, "#").slice(0, 32)))}`);

async function chainPort(rpc: NearRpc, accountId: string): Promise<ChainWeir> {
  return new ChainWeir({ rpc, account: new NearAccount(rpc, accountId, await keyFor(accountId)), contractId: "weir.testnet", usdcId: "usdc.testnet" });
}

test("the port covers every view and state change of the spec", () => {
  assert.deepEqual([...VIEW_METHODS].sort(), Object.keys(SPEC_VIEWS).sort());
  assert.deepEqual([...CHANGE_METHODS].sort(), Object.keys(SPEC_CHANGES).sort());
});

test("ChainWeir sends each state change with the spec's argument names, the README's gas and deposit", async () => {
  const fake = fakeNear();
  const rpc = new NearRpc({ urls: ["x"], fetch: fake.fetch });
  const port = await chainPort(rpc, "x.testnet");
  for (const [name, spec] of Object.entries(SPEC_CHANGES)) {
    const args = name === "deposit" ? { amount: "5000000", msg: "x.testnet" } : spec.args;
    await port.change(name as never, args as never);
    const sent = fake.sent.at(-1)!;
    assert.equal(sent.method, spec.method, name);
    assert.equal(sent.receiver, spec.receiver === "weir" ? "weir.testnet" : "usdc.testnet", name);
    assert.deepEqual(sent.args, spec.args, name);
    assert.equal(sent.gas, spec.gas, `${name} gas`);
    assert.equal(sent.deposit, spec.deposit, `${name} deposit`);
  }
  // Optional arguments left out are left out of the JSON, as the contract's Option<_> expects.
  await port.register({});
  await port.redeem({ series: 4 });
  await port.set_guard({});
  assert.deepEqual(fake.sent.slice(-3).map((s) => s.args), [{}, { series: 4 }, {}]);
  await port.deposit({ amount: "7" });
  assert.deepEqual(fake.sent.at(-1)!.args, { receiver_id: "weir.testnet", amount: "7", msg: "" });
});

test("ChainWeir sends each view with the spec's argument names", async () => {
  const fake = fakeNear();
  const port = await chainPort(new NearRpc({ urls: ["x"], fetch: fake.fetch }), "x.testnet");
  for (const [name, args] of Object.entries(SPEC_VIEWS)) {
    await port.view(name as never, args as never);
    const { params } = fake.requests.at(-1)!;
    assert.equal(params.method_name, name);
    assert.equal(params.account_id, "weir.testnet");
    assert.deepEqual(JSON.parse(atob(params.args_base64 as string)), args, name);
  }
});

/** One scenario through the port: everything it sees and every error, in order. */
async function scenario(port: (account: string) => WeirPort, setTime: (t: number) => void): Promise<unknown[]> {
  const out: unknown[] = [];
  const attempt = async (label: string, f: () => Promise<unknown>) => {
    try {
      out.push([label, await f()]);
    } catch (e) {
      out.push([label, "threw", (e as Error).message]);
    }
  };
  const [alice, bob, r0, r1] = ["alice.testnet", "bob.testnet", "r0.testnet", "r1.testnet"].map(port) as [WeirPort, WeirPort, WeirPort, WeirPort];
  const open = T0 - 3900;
  setTime(open - 300);
  await attempt("commit unregistered", () => alice.commit({ series: 0, hash: "00".repeat(32), lock: "1000000" }));
  const bundle = "11".repeat(32);
  await attempt("report r0", () => r0.report({ bucket: open - 300, price: 2_000_000, bundle }));
  await attempt("report r1", () => r1.report({ bucket: open - 300, price: 2_010_000, bundle }));
  await attempt("report r1 again", () => r1.report({ bucket: open - 300, price: 2_010_000, bundle }));
  await attempt("last print", () => alice.get_last_print({}));
  await attempt("register alice", () => alice.register({}));
  await attempt("register bob for himself via alice", () => alice.register({ account_id: "bob.testnet" }));
  await attempt("register alice twice", () => alice.register({}));
  await attempt("deposit alice", () => alice.deposit({ amount: "50000000" }));
  await attempt("deposit to unregistered", () => bob.deposit({ amount: "3000000", msg: "carol.testnet" }));
  await attempt("deposit bob", () => bob.deposit({ amount: "50000000" }));
  setTime(open + 10);
  await attempt("status", () => alice.get_status({}));
  const salt = "5a17".repeat(8);
  const orders = [
    [alice, "alice.testnet", "Long", 10, 405_000],
    [bob, "bob.testnet", "Short", 8, 395_000],
  ] as const;
  for (const [p, id, side, size, price] of orders) {
    const hash = commitHash({ series: 0, round: 0, accountId: id, side, size, price, salt });
    await attempt(`commit_hash ${id}`, () => p.commit_hash({ series: 0, round: 0, account_id: id, side, size, price, salt }));
    await attempt(`commit ${id}`, () => p.commit({ series: 0, hash, lock: "5000000" }));
  }
  await attempt("series", () => alice.get_series({ series: 0 }));
  await attempt("round", () => alice.get_round({ series: 0, round: 0 }));
  setTime(open + 200);
  for (const [p, , side, size, price] of orders) {
    await attempt("reveal", () => p.reveal({ series: 0, round: 0, seq: p === alice ? 0 : 1, side, size, price, salt }));
  }
  await attempt("reveal twice", () => alice.reveal({ series: 0, round: 0, seq: 0, side: "Long", size: 10, price: 405_000, salt }));
  await attempt("clear early", () => bob.clear({ series: 0, round: 0 }));
  setTime(open + 300);
  await attempt("clear", () => bob.clear({ series: 0, round: 0 }));
  await attempt("result", () => alice.get_result({ series: 0, round: 0 }));
  await attempt("results", () => alice.get_results({ series: 0, from_round: 0, limit: 5 }));
  await attempt("positions", async () => [await alice.get_position({ series: 0, account_id: "alice.testnet" }), await bob.get_position({ series: 0, account_id: "bob.testnet" })]);
  await attempt("mint", () => alice.mint({ series: 0, sets: 2 }));
  await attempt("merge", () => alice.merge({ series: 0, sets: 1 }));
  await attempt("transfer", () => alice.transfer_position({ series: 0, to: "bob.testnet", long: 1, short: 0 }));
  await attempt("guard", () => bob.set_guard({ guard: 20_000 }));
  await attempt("withdraw too much", () => bob.withdraw({ amount: "999000000" }));
  await attempt("withdraw", () => bob.withdraw({ amount: "1000000" }));
  await attempt("settle early", () => bob.settle({ series: 0 }));
  await attempt("accounts", async () => [await alice.get_account({ account_id: "alice.testnet" }), await alice.get_account({ account_id: "nobody" })]);
  await attempt("accumulator", () => alice.get_accumulator({ series: 0 }));
  await attempt("prints", () => alice.get_prints({ from_bucket: 0, limit: 10 }));
  await attempt("print", () => alice.get_print({ bucket: open - 300 }));
  await attempt("totals", () => alice.get_totals({}));
  await attempt("params", () => alice.get_params({}));
  // Settle on the void rule: no prints in the delivery window, and the void wait has passed.
  setTime(T0 + 3600 + 1800);
  await attempt("settle", () => bob.settle({ series: 0 }));
  await attempt("redeem alice by bob", () => bob.redeem({ series: 0, account_id: "alice.testnet" }));
  await attempt("redeem bob", () => bob.redeem({ series: 0 }));
  await attempt("redeem bob again", () => bob.redeem({ series: 0 }));
  await attempt("prune", () => bob.prune_result({ series: 0, round: 0 }));
  await attempt("totals after", () => alice.get_totals({}));
  return out;
}

test("one scenario gives the same transcript on ModelWeir and on ChainWeir over RPC", async () => {
  const modelMarket = new Market(paramsFromWire(PARAMS), 0);
  const model = new ModelWeir(modelMarket, "alice.testnet");
  const modelOut = await scenario((a) => model.as(a), (t) => model.setTime(t));

  const chainMarket = new Market(paramsFromWire(PARAMS), 0);
  const fake = fakeNear({ market: chainMarket, contractId: "weir.testnet", usdcId: "usdc.testnet" });
  const rpc = new NearRpc({ urls: ["x"], fetch: fake.fetch });
  const ports = new Map<string, ChainWeir>();
  for (const a of ["alice.testnet", "bob.testnet", "r0.testnet", "r1.testnet"]) ports.set(a, await chainPort(rpc, a));
  const chainOut = await scenario((a) => ports.get(a)!, (t) => chainMarket.setTime(t));

  assert.deepEqual(chainOut, modelOut);
  const threw = modelOut.filter((x) => (x as unknown[])[1] === "threw").map((x) => (x as unknown[])[0]);
  assert.deepEqual(threw, [
    "commit unregistered",
    "register alice twice",
    "reveal twice",
    "clear early",
    "withdraw too much",
    "settle early",
    "redeem bob again",
  ]);
  assert.deepEqual(modelOut.find((x) => (x as unknown[])[0] === "deposit to unregistered"), ["deposit to unregistered", "0"]);
  // A report for a bucket already final is ignored, not refused (section 9).
  assert.deepEqual(modelOut.find((x) => (x as unknown[])[0] === "report r1 again"), ["report r1 again", false]);
  assert.deepEqual(modelOut.find((x) => (x as unknown[])[0] === "commit unregistered"), ["commit unregistered", "threw", "account is not registered"]);
});

test("a failed chain call throws CallFailed carrying the outcome and the bare panic message", async () => {
  const market = new Market(paramsFromWire(PARAMS), T0);
  const fake = fakeNear({ market, contractId: "weir.testnet", usdcId: "usdc.testnet" });
  const outcomes: string[] = [];
  const rpc = new NearRpc({ urls: ["x"], fetch: fake.fetch });
  const port = new ChainWeir({
    rpc,
    account: new NearAccount(rpc, "z.testnet", await keyFor("z")),
    contractId: "weir.testnet",
    onOutcome: (m, o) => outcomes.push(`${m}:${o.ok}`),
  });
  await assert.rejects(port.withdraw({ amount: "1" }), (e: unknown) => {
    assert.ok(e instanceof CallFailed);
    assert.equal(e.message, "account is not registered");
    assert.equal(e.outcome.ok, false);
    return true;
  });
  // usdcId was not given, so deposit reads it from get_params first.
  await port.register({});
  assert.equal(await port.deposit({ amount: "10" }), "10");
  assert.deepEqual(outcomes, ["withdraw:false", "register:true", "deposit:true"]);
  const readOnly = new ChainWeir({ rpc, contractId: "weir.testnet" });
  await assert.rejects(readOnly.clear({ series: 0, round: 0 }), /no signer/);
});

test("ModelWeir hands out JSON copies and shares one market and clock between accounts", async () => {
  const model = new ModelWeir(new Market(paramsFromWire(PARAMS), T0), "a");
  const b = model.as("b");
  await model.register({});
  b.advance(5);
  assert.equal(model.now(), T0 + 5);
  const params = await b.get_params({});
  params.reporters.push("mutated");
  assert.deepEqual((await model.get_params({})).reporters, PARAMS.reporters);
  assert.equal(model.sync.view("get_account", { account_id: "a" })!.balance, "0");
  assert.throws(() => model.sync.change("register", {}), /already registered/);
});
