// `verify`: a record written by the real `buildRecord` after `apply` on the fake chain, read back
// through the real `NearRpc` from a fake JSON-RPC endpoint that serves the fake chain. A matching
// record passes; each kind of difference fails with a line naming it; an endpoint that does not
// answer gives the third outcome; sealed and unsealed contracts are both described. No network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FetchLike } from "../../chain/src/mod.ts";
import { rpcFor } from "../src/chain.ts";
import { apply } from "../src/apply.ts";
import { Keystore, Redactor } from "../src/keys.ts";
import { layout, sandboxNetwork, type MarketId } from "../src/layout.ts";
import { buildRecord, type RecordJson } from "../src/outputs.ts";
import { newState } from "../src/state.ts";
import { buildPlan } from "../src/steps.ts";
import { EXIT, VERIFY_MAX_CALL_WAIT_MS, parseRecord, renderVerify, rpcUrlsFor, signerOf, verifyCli, verifyRecord, type VerifyReport } from "../src/verify.ts";
import { FakeChain, fakeWasm } from "./fake.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "weir-verify-test-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const wasm = { weir: fakeWasm("weir", 1), usdc: fakeWasm("mock_usdc", 2) };
const MARKETS: MarketId[] = ["h100-fast", "h100-weekly"];

/** A deployment applied on the fake chain, and the record `apply` would write for it. */
async function deployed(): Promise<{ chain: FakeChain; record: RecordJson }> {
  const chain = new FakeChain(wasm);
  const keys = new Keystore(tmp(), { redactor: new Redactor() });
  const l = layout(sandboxNetwork("http://fake"), "v1", MARKETS);
  keys.loadAll(l.accounts.map((a) => a.id), "v1");
  const plan = buildPlan(l, 3);
  const state = newState("sandbox", "v1", MARKETS, "2026-11-12T00:00:00.000Z");
  await apply({ chain, keys, plan, wasm, out: tmp(), state, log: () => {} });
  const record = JSON.parse(JSON.stringify(await buildRecord(plan, state, chain, keys, wasm))) as RecordJson;
  return { chain, record };
}

const ok = (id: number, result: unknown) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }) });
const err = (id: number, name: string, data: string) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name, info: {} }, data } }) });
const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];

interface World {
  /** Throw on every request, as an unreachable endpoint. */
  down: boolean;
  /** Answer HTTP 429, as fastnear does over its free limit, until this time on the fake clock (ms). */
  limitedUntil: number;
  /** The fake clock (ms): `sleep` advances it, nothing really waits. */
  clock: number;
  /** Transactions that failed on chain. */
  failedTxs: Set<string>;
  /** Transactions signed by someone other than the deploy tool would sign them as. */
  signedBy: Map<string, string>;
  requests: number;
}

/** A JSON-RPC endpoint serving the fake chain: accounts, key lists, views, transactions. */
function endpoint(chain: FakeChain, now: number): { fetch: FetchLike; world: World } {
  const world: World = { down: false, limitedUntil: 0, clock: 1_000_000, failedTxs: new Set(), signedBy: new Map(), requests: 0 };
  const fetch: FetchLike = async (_url, init) => {
    world.requests++;
    if (world.down) throw new Error("connect ECONNREFUSED");
    if (world.clock < world.limitedUntil) {
      const body = { jsonrpc: "2.0", error: { code: -429, message: "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com" }, id: "1" };
      return { status: 429, text: async () => JSON.stringify(body) };
    }
    const req = JSON.parse(init.body) as { id: number; method: string; params: Record<string, string> };
    const p = req.params;
    if (req.method === "tx") {
      if (!p.tx_hash!.startsWith("faketx")) return err(req.id, "UNKNOWN_TRANSACTION", `Transaction ${p.tx_hash} doesn't exist`);
      const status = world.failedTxs.has(p.tx_hash!) ? { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: no" } } } } } : { SuccessValue: "" };
      return ok(req.id, { status, transaction: { hash: p.tx_hash, ...(world.signedBy.has(p.tx_hash!) ? { signer_id: world.signedBy.get(p.tx_hash!) } : {}) }, transaction_outcome: { outcome: { logs: [], gas_burnt: 1 } }, receipts_outcome: [] });
    }
    const exists = await chain.account(p.account_id!);
    if (p.request_type === "view_account") return exists ? ok(req.id, exists) : err(req.id, "UNKNOWN_ACCOUNT", `account ${p.account_id} does not exist while viewing`);
    if (p.request_type === "view_access_key_list") {
      if (!exists) return err(req.id, "UNKNOWN_ACCOUNT", "does not exist");
      return ok(req.id, { keys: (await chain.keys(p.account_id!)).map((k) => ({ public_key: k.public_key, access_key: { nonce: 1, permission: k.permission } })) });
    }
    if (p.request_type === "call_function") {
      const w = chain.weir.get(p.account_id!);
      if (!w) return ok(req.id, { error: `wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "${p.account_id}" })`, logs: [] });
      const views: Record<string, unknown> = {
        get_params: w.params,
        get_status: { now, live: [{ series: 0, delivery_start: 0, delivery_end: 0, auction_open: 0, auction_close: 0, round: 4, phase: "Commit", phase_ends_at: now + 60 }] },
        get_last_print: { bucket: now - 600, price: 2_900_000 },
        get_totals: { free: "117600000", locked: "0", sets_backing: "0", unredeemed: "0", burned: "200000" },
      };
      if (!(p.method_name! in views)) return ok(req.id, { error: `MethodNotFound ${p.method_name}`, logs: [] });
      return ok(req.id, { result: bytes(views[p.method_name!]), logs: [] });
    }
    throw new Error(`fake endpoint: ${req.method} ${p.request_type}`);
  };
  return { fetch, world };
}

/** The fake clock of a world, for `rpcFor`. */
const clockOf = (w: World) => ({ now: () => w.clock, sleep: async (ms: number) => void (w.clock += ms) });
async function run(chain: FakeChain, record: RecordJson, setup: (w: World) => void = () => {}, extra: { txs?: boolean; local?: string | null } = {}): Promise<{ r: VerifyReport; text: string; world: World }> {
  const e = endpoint(chain, chain.clock);
  setup(e.world);
  const c = clockOf(e.world);
  const rpc = rpcFor(["http://a.fake", "http://b.fake"], e.fetch, { ...c, maxCallWaitMs: VERIFY_MAX_CALL_WAIT_MS, minGapMs: 0 });
  const r = await verifyRecord(record, { rpc, txs: extra.txs ?? false, localWeirCodeHash: extra.local === undefined ? null : extra.local, sleep: c.sleep });
  return { r, text: renderVerify(r, "record.json"), world: e.world };
}
const fails = (r: VerifyReport) => r.checks.filter((c) => c.status === "fail").map((c) => c.text);

test("a record that matches the chain passes, with every kind of check present", async () => {
  const { chain, record } = await deployed();
  const { r, text } = await run(chain, record);
  assert.equal(r.outcome, "match", text);
  assert.deepEqual(fails(r), []);
  for (const m of record.markets) {
    assert.match(text, new RegExp(`  ok  ${m.contract}: code hash ${wasm.weir.codeHash} = the record's weir.wasm`));
    assert.match(text, new RegExp(`  ok  ${m.contract}: get_params = the record's 23 fields`));
    assert.match(text, new RegExp(`  ok  ${m.contract}: reporters on chain are the record's 3 reporter accounts`));
    assert.match(text, new RegExp(`  --  ${m.contract}: status at .*series 0 round 4 \\(Commit\\)`));
    assert.match(text, new RegExp(`  --  ${m.contract}: last print bucket .*2.9 USD/GPU-hour, 10 min before chain time`));
    assert.match(text, new RegExp(`  --  ${m.contract}: totals in tUSDC: free 117.6, .*burned 0.2`));
  }
  assert.match(text, /  ok  weir-usdc-v1\.test\.near: code hash .* = the record's mock_usdc\.wasm/);
  // Every operator account with function-call keys gets a line: 3 reporters, 12 agents, the keeper.
  assert.equal(r.checks.filter((c) => c.status === "ok" && /function-call key\(s\) as recorded/.test(c.text)).length, 16);
  assert.match(text, /  ok  reporter-a\.weir-ops-v1\.test\.near: 2 function-call key\(s\) as recorded, .*\[report, finalize_print\]/);
  assert.match(text, /^RESULT match: all \d+ checks against sandbox agree with record\.json$/m);
});

test("unsealed and sealed contracts are both described, and neither is a failure", async () => {
  const { chain, record } = await deployed();
  const [fast, weekly] = record.markets.map((m) => m.contract) as [string, string];
  chain.accounts.get(weekly)!.keys.clear();
  const { r, text } = await run(chain, record);
  assert.equal(r.outcome, "match", text);
  assert.match(text, new RegExp(`  --  ${fast}: not sealed: 1 full-access key\\(s\\) \\(the one the record lists\\); whoever holds a full-access key can replace this account's code`));
  assert.match(text, new RegExp(`  --  ${weekly}: sealed: no access keys, so its code can never change`));
  assert.match(text, /  --  weir-usdc-v1\.test\.near: not sealed: 1 full-access key/);
});

test("a contract the record says was sealed but still has keys fails", async () => {
  const { chain, record } = await deployed();
  record.markets[0]!.sealed = { tx: "faketx999", at: "2026-11-12T00:00:00Z" };
  const { r } = await run(chain, record);
  assert.equal(r.outcome, "differs");
  assert.match(fails(r).join("\n"), /the record says it was sealed \(tx faketx999\), but it has 1 access key/);
});

test("a wrong code hash fails and names both hashes", async () => {
  const { chain, record } = await deployed();
  const c = record.markets[0]!.contract;
  chain.accounts.get(c)!.code = "So11111111111111111111111111111111111111112";
  const { r, text } = await run(chain, record);
  assert.equal(r.outcome, "differs");
  assert.deepEqual(fails(r), [`${c}: code hash on chain So11111111111111111111111111111111111111112, the record says ${wasm.weir.codeHash}`]);
  assert.match(text, /^RESULT DIFFERS: 1 of \d+ checks found sandbox different from record\.json$/m);
});

test("a changed parameter fails and names the field", async () => {
  const { chain, record } = await deployed();
  const c = record.markets[1]!.contract;
  const was = chain.weir.get(c)!.params.tick;
  chain.weir.get(c)!.params.tick = was + 1;
  chain.weir.get(c)!.params.commit_fee = "1";
  const { r } = await run(chain, record);
  assert.equal(r.outcome, "differs");
  assert.deepEqual(fails(r), [`${c}: get_params differs from the record in 2 field(s): tick: chain ${was + 1}, record ${was}; commit_fee: chain "1", record "${record.markets[1]!.params!.commit_fee}"`]);
});

test("reporters on chain that are not the record's reporter accounts fail", async () => {
  const { chain, record } = await deployed();
  const c = record.markets[0]!.contract;
  chain.weir.get(c)!.params.reporters = ["mallory.test.near", ...chain.weir.get(c)!.params.reporters.slice(1)];
  const { r } = await run(chain, record);
  const f = fails(r);
  assert.equal(f.length, 2);
  assert.match(f[0]!, /get_params differs from the record in 1 field\(s\): reporters: chain \["mallory\.test\.near"/);
  assert.match(f[1]!, /reporters on chain \[mallory\.test\.near, .*\], the record's reporter accounts \[reporter-a/);
});

test("a missing key, a key for another receiver and a key with other methods each fail by name", async () => {
  const { chain, record } = await deployed();
  const fcRows = record.keys.filter((k) => k.receiver);
  const [gone, moved, widened] = [fcRows[0]!, fcRows.find((k) => k.account.includes("buyer-1"))!, fcRows.find((k) => k.account.startsWith("keeper."))!];
  chain.accounts.get(gone.account)!.keys.delete(gone.public_key);
  const keysOf = (acc: string) => chain.accounts.get(acc)!.keys;
  const perm = (acc: string, pk: string) => (keysOf(acc).get(pk) as { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } }).FunctionCall;
  perm(moved.account, moved.public_key).receiver_id = "elsewhere.test.near";
  perm(widened.account, widened.public_key).method_names = [...widened.methods!.filter((m) => m !== "prune_result"), "withdraw"];
  const { r } = await run(chain, record);
  assert.equal(r.outcome, "differs");
  const f = fails(r);
  assert.equal(f.length, 3, f.join("\n"));
  assert.match(f[0]!, new RegExp(`^${gone.account}: key ed25519:.* for ${gone.receiver}: not on chain$`));
  assert.match(f[1]!, new RegExp(`^${moved.account}: key .* for ${moved.receiver}: receiver on chain elsewhere\\.test\\.near, the record says ${moved.receiver}$`));
  assert.match(f[2]!, new RegExp(`^${widened.account}: key .* for ${widened.receiver}: methods on chain \\[.*withdraw\\], the record says \\[.*\\]; extra: withdraw; missing: prune_result$`));
});

test("a function-call key that became a full-access key fails", async () => {
  const { chain, record } = await deployed();
  const k = record.keys.find((x) => x.receiver)!;
  chain.accounts.get(k.account)!.keys.set(k.public_key, "FullAccess");
  const { r } = await run(chain, record);
  assert.match(fails(r).join("\n"), /is a full-access key on chain, the record says function call/);
});

test("a market account that does not exist fails", async () => {
  const { chain, record } = await deployed();
  const c = record.markets[0]!.contract;
  chain.accounts.delete(c);
  chain.weir.delete(c);
  const { r } = await run(chain, record);
  assert.deepEqual(fails(r), [`${c} (h100-fast): the account does not exist`]);
});

test("an endpoint that does not answer gives the third outcome and claims nothing", async () => {
  const { chain, record } = await deployed();
  const { r, text, world } = await run(chain, record, (w) => (w.down = true));
  assert.equal(r.outcome, "unreachable");
  assert.deepEqual(r.checks, []);
  assert.equal(world.requests, 2 * 2, "two attempts, each through both endpoints");
  assert.match(text, /  --  the chain could not be reached: every RPC endpoint failed for query: a\.fake: connect ECONNREFUSED; b\.fake: connect ECONNREFUSED$/m);
  assert.match(text, /^RESULT NOT CHECKED: sandbox could not be reached after 0 checks; nothing is claimed either way about record\.json$/m);
});

test("both endpoints rate-limited briefly, then recovering: a full result", async () => {
  const { chain, record } = await deployed();
  const brief = await run(chain, record, (w) => (w.limitedUntil = w.clock + 40_000));
  assert.equal(brief.r.outcome, "match", brief.text);
  assert.ok(brief.world.clock - 1_000_000 >= 40_000, "the 40 s of refusals were waited out");
  assert.equal(brief.r.checks.filter((c) => c.status === "ok").length, 23, "every check ran");
});

test("both endpoints rate-limited beyond the bound: not checked, both endpoints named", async () => {
  const { chain, record } = await deployed();
  const lasting = await run(chain, record, (w) => (w.limitedUntil = Number.MAX_SAFE_INTEGER));
  assert.equal(lasting.r.outcome, "unreachable");
  assert.deepEqual(lasting.r.checks, []);
  assert.match(lasting.text, /  --  the chain could not be reached: every RPC endpoint failed for query \(rate-limited on every endpoint; gave up after \d+ s of waiting, the bound is 60 s\): a\.fake answered HTTP 429: Rate limits exceeded\..*; b\.fake answered HTTP 429: Rate limits exceeded\./);
  assert.match(lasting.text, /^RESULT NOT CHECKED: /m);
  const waited = lasting.world.clock - 1_000_000;
  assert.ok(waited >= VERIFY_MAX_CALL_WAIT_MS && waited <= VERIFY_MAX_CALL_WAIT_MS + 30_000, `gave up after ${waited} ms, once (not retried on top)`);
});

test("--txs: every recorded hash is looked up; a failed and an unknown one fail", async () => {
  const { chain, record } = await deployed();
  const sent = record.transactions.filter((t) => t.tx);
  assert.ok(sent.length > 50);
  const good = await run(chain, record, () => {}, { txs: true });
  assert.equal(good.r.outcome, "match", good.text);
  assert.match(good.text, new RegExp(`  ok  transactions: all ${sent.length} recorded hashes are known to the chain and succeeded`));
  const bad = JSON.parse(JSON.stringify(record)) as RecordJson;
  bad.transactions.find((t) => t.tx)!.tx = "UnknownTx1111";
  const r2 = await run(chain, bad, (w) => w.failedTxs.add(sent[1]!.tx!), { txs: true });
  assert.equal(r2.r.outcome, "differs");
  const f = fails(r2.r);
  assert.equal(f.length, 2);
  assert.match(f[0]!, /^tx UnknownTx1111 \(.*\): unknown to the chain$/);
  assert.match(f[1]!, new RegExp(`^tx ${sent[1]!.tx} \\(.*\\): failed on chain: Smart contract panicked: no$`));
  const reg = sent.find((t) => t.step.startsWith("register:"))!;
  const r3 = await run(chain, record, (w) => w.signedBy.set(reg.tx!, "someone.test.near"), { txs: true });
  assert.match(fails(r3.r).join("\n"), new RegExp(`^tx ${reg.tx} \\(${reg.step}\\): signed by someone\\.test\\.near, the deploy tool signs this step as weir-ops-v1\\.test\\.near$`));
  // Not in the default run.
  assert.equal((await run(chain, bad)).r.outcome, "match");
});

test("signers are derived from the deploy tool's step names", async () => {
  const { record } = await deployed();
  const ops = record.accounts.find((a) => a.role === "ops")!.id;
  assert.equal(signerOf(`account:${ops}`, record), null, "a top-level account: the faucet or the root signed");
  assert.equal(signerOf("account:reporter-a.weir-ops-v1.test.near", record), ops);
  assert.equal(signerOf("deploy:weir-usdc-v1.test.near", record), "weir-usdc-v1.test.near");
  assert.equal(signerOf("register:h100-fast:keeper.weir-ops-v1.test.near", record), ops);
  assert.equal(signerOf("key:keeper.weir-ops-v1.test.near:weir-h100-fast-v1.test.near", record), "keeper.weir-ops-v1.test.near");
  assert.equal(signerOf("guard:h100-fast-buyer-1.weir-ops-v1.test.near", record), "h100-fast-buyer-1.weir-ops-v1.test.near");
});

test("the local wasm is reported as information, never as a failure", async () => {
  const { chain, record } = await deployed();
  const same = await run(chain, record, () => {}, { local: wasm.weir.codeHash });
  assert.match(same.text, /  --  local contracts\/target\/near\/weir\/weir\.wasm has the record.s code hash/);
  const other = await run(chain, record, () => {}, { local: "Other111" });
  assert.equal(other.r.outcome, "match");
  assert.match(other.text, /has code hash Other111, not .*non-reproducible-wasm/);
  const none = await run(chain, record, () => {}, { local: null });
  assert.match(none.text, /  --  no local contracts\/target\/near\/weir\/weir\.wasm: run contracts\/build\.sh/);
});

test("the CLI: exit codes 0, 1, 3 and 2, JSON output, and the endpoints a record names", async () => {
  const { chain, record } = await deployed();
  const dir = tmp();
  const file = join(dir, "record.json");
  writeFileSync(file, JSON.stringify(record));
  const lines: string[] = [];
  const say = (s: string) => void lines.push(s);
  const e = endpoint(chain, chain.clock);
  const base = { rpc: ["http://a.fake"], fetch: e.fetch, ...clockOf(e.world), localWeirCodeHash: null };
  assert.equal(await verifyCli([file], base, say), EXIT.match);
  assert.equal(await verifyCli([file], { ...base, json: true }, say), 0);
  assert.equal((JSON.parse(lines.at(-1)!) as { outcome: string }).outcome, "match");
  chain.weir.get(record.markets[0]!.contract)!.params.quorum = 1;
  assert.equal(await verifyCli([file], base, say), EXIT.differs);
  assert.equal(EXIT.differs, 1);
  e.world.down = true;
  assert.equal(await verifyCli([file], base, say), EXIT.unreachable);
  assert.equal(EXIT.unreachable, 3);
  writeFileSync(join(dir, "not.json"), JSON.stringify({ network: "testnet" }));
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await verifyCli([join(dir, "not.json")], base, say), EXIT.usage);
    assert.equal(await verifyCli([file], { ...base, rpc: undefined as unknown as string[] }, say), EXIT.usage, "a sandbox record needs --rpc");
    assert.equal(await verifyCli([], base, say), EXIT.usage);
  } finally {
    console.error = quiet;
  }
  assert.throws(() => parseRecord(JSON.stringify({ network: "testnet", suffix: "x" })), /missing wasm\.weir\.code_hash, wasm\.mock_usdc\.code_hash, accounts, markets, keys, transactions/);
  assert.deepEqual(rpcUrlsFor({ ...record, network: "testnet" }), ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"]);
});
