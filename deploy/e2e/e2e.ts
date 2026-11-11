// `pnpm --dir deploy run e2e`: the deployment tool against a local near-sandbox node, through
// its command line exactly as an operator runs it. Nothing here touches testnet.
//
//  1. plan, then apply the two H100 markets; status, every figure it reports asserted.
//  2. One tick by hand through ChainWeir with the generated function-call keys: the reporters
//     report, a buyer and a seller commit and reveal, the keeper's key clears the round after the
//     sandbox clock is moved; allowance charged per call measured; an agent key's refusals.
//  3. apply again: nothing sent.
//  4. seal one market: refused without --confirm; with it, the contract has no keys, and still
//     takes reports and commits.
//  5. The keeper's own runTick, loaded from the generated keeper.env and deployments.json.
//  6. A second, fresh apply killed halfway (SIGKILL), then re-run to completion.
//  7. No secret in anything the tool printed or wrote, except keeper.env and the key files.
// Writes a summary (no secrets) to deploy/out/e2e-sandbox.json and exits non-zero on any failure.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ChainWeir, CallFailed, KeyPair, NearAccount, type NearRpc } from "../../chain/src/mod.ts";
import { commitHash, sha256Hex } from "../../engine/src/mod.ts";
import { Sandbox } from "../../integration/src/sandbox.ts";
import { MemoryStore, readSecrets, runTick, type Deployments } from "../../keeper/src/mod.ts";
import { FakeSources } from "../../keeper/test/harness.ts";
import { Redactor } from "../src/keys.ts";
import { allowanceFor, storageBytes, METHODS_OF } from "../src/budget.ts";
import { fcKeys, layout, sandboxNetwork } from "../src/layout.ts";
import type { StatusReport } from "../src/status.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const OUT = new URL("../out/", import.meta.url).pathname;
const PORT = Number(process.env.WEIR_DEPLOY_E2E_PORT ?? 33_051);
const MARKETS = "h100-fast,h100-weekly";

interface Check {
  step: string;
  name: string;
  ok: boolean;
  detail?: unknown;
}
const checks: Check[] = [];
let step = "setup";
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ step, name, ok, ...(ok || detail === undefined ? {} : { detail }) });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  return ok;
};
const eq = (name: string, a: unknown, b: unknown) => check(name, isDeepStrictEqual(a, b), { actual: a, expected: b });
const section = (s: string) => {
  step = s;
  console.log(`\n== ${s}`);
};

/** Everything the CLI printed, for the secret scan at the end. */
const transcript: string[] = [];

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  err: string;
  ms: number;
}

function cli(args: string[], opts: { killWhen?: (line: string) => boolean; quiet?: boolean } = {}): Promise<Run> {
  const t = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!opts.quiet) console.log(`    | ${line}`);
        if (opts.killWhen?.(line)) child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (!opts.quiet) process.stdout.write(`    ! ${d.toString()}`);
    });
    child.on("close", (code, signal) => {
      transcript.push(out, err);
      resolve({ code, signal, out, err, ms: Date.now() - t });
    });
  });
}

function parseEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)='(.*)'$/.exec(line);
    if (m) vars[m[1]!] = m[2]!;
  }
  return vars;
}

const sandbox = await Sandbox.start({ port: PORT, log: (l) => console.log(l) });
const rpc: NearRpc = sandbox.rpc;
const tmp = mkdtempSync(join(tmpdir(), "weir-deploy-e2e-"));
const rootKey = join(sandbox.home, "validator_key.json");
const net = (out: string, keys: string, suffix: string) => ["--network", "sandbox", "--rpc", sandbox.url, "--root-key", rootKey, "--out", out, "--keys", keys, "--suffix", suffix];
const O1 = join(tmp, "out1");
const K1 = join(tmp, "keys1");
const O2 = join(tmp, "out2");
const K2 = join(tmp, "keys2");
const summary: Record<string, unknown> = { sandbox: { version: sandbox.version, url: sandbox.url }, started: new Date().toISOString() };
let fatal: string | null = null;

try {
  // ---------------------------------------------------------------- 1
  section("plan and apply two H100 markets");
  const plan = await cli(["plan", ...net(O1, K1, "e2e1"), "--markets", MARKETS], { quiet: true });
  check("plan exits 0", plan.code === 0, plan.err);
  const planSteps = Number(/(\d+) transactions\./.exec(plan.out)?.[1]);
  check("plan says sealed accounts can never be upgraded or recovered", /can never be\s+upgraded or recovered/.test(plan.out));
  const apply1 = await cli(["apply", ...net(O1, K1, "e2e1"), "--markets", MARKETS], { quiet: true });
  check("apply exits 0", apply1.code === 0, apply1.err.slice(-2000));
  const sentLines = apply1.out.split("\n").filter((l) => / sent  /.test(l));
  eq("apply sent every planned transaction once", sentLines.length, planSteps);
  check("every sent step logs a transaction hash", sentLines.every((l) => /: tx [1-9A-HJ-NP-Za-km-z]{43,44}( |$)/.test(l)), sentLines.find((l) => !/: tx [1-9A-HJ-NP-Za-km-z]{43,44}/.test(l)));
  summary.apply = { transactions: sentLines.length, seconds: apply1.ms / 1000 };
  console.log(`    apply: ${sentLines.length} transactions in ${(apply1.ms / 1000).toFixed(1)} s`);
  for (const f of ["deployments.json", "keeper.env", "record.json", "state.json"]) {
    const mode = statSync(join(O1, f)).mode & 0o777;
    check(`${f} written${f === "keeper.env" ? " with mode 600" : ""}`, f === "keeper.env" ? mode === 0o600 : true, mode.toString(8));
  }
  const deployments = JSON.parse(readFileSync(join(O1, "deployments.json"), "utf8")) as Deployments;
  const l = layout(sandboxNetwork(sandbox.url), "e2e1", ["h100-fast", "h100-weekly"]);
  eq("deployments.json has the repository's shape", Object.keys(deployments), ["network", "rpc", "explorer", "bundles_base", "markets"]);
  eq("deployments.json markets", deployments.markets, [
    { id: "h100-fast", label: "H100, hourly (demo)", chip: "h100", contract: l.contracts["h100-fast"], usdc: l.usdc },
    { id: "h100-weekly", label: "H100, weekly", chip: "h100", contract: l.contracts["h100-weekly"], usdc: l.usdc },
  ]);
  const record = JSON.parse(readFileSync(join(O1, "record.json"), "utf8")) as { transactions: { tx: string | null }[]; wasm: { weir: { code_hash: string } } };
  eq("record.json lists every transaction with its hash", record.transactions.filter((t) => t.tx).length, planSteps);

  section("status");
  const st1 = await cli(["status", ...net(O1, K1, "e2e1"), "--json"], { quiet: true });
  check("status exits 0 (no problems)", st1.code === 0, st1.err);
  const r = JSON.parse(st1.out) as StatusReport;
  eq("status: no problems", r.problems, []);
  for (const c of r.contracts) {
    check(`${c.account}: code hash equals the local wasm's sha256`, c.code_ok && c.code_hash === c.expected_code_hash);
    check(`${c.account}: one full-access key, ours, not sealed`, c.keys.length === 1 && c.keys[0]!.kind === "full access" && c.keys[0]!.ours && !c.sealed, c.keys);
    check(`${c.account}: balance covers its storage`, BigInt(c.balance) > BigInt(c.storage_cost), { balance: c.balance, storage: c.storage_cost });
    if (c.role === "market") {
      eq(`${c.account}: parameters equal MARKETS with usdc, reporters and t0 replaced`, c.params_diff, []);
      check(`${c.account}: storage is the wasm and a little state`, c.storage_usage > 303_000 && c.storage_usage < 306_000, c.storage_usage);
    }
  }
  const fast = r.contracts.find((c) => c.market === "h100-fast")!;
  const weekly = r.contracts.find((c) => c.market === "h100-weekly")!;
  check("h100-fast t0 is on the hour and series 0's auction was open at deployment", fast.params!.t0 % 3600 === 0 && fast.params!.t0 - 3900 <= r.chain_now);
  check("h100-weekly t0 is a Monday 00:00 UTC", new Date(weekly.params!.t0 * 1000).getUTCDay() === 1 && weekly.params!.t0 % 86_400 === 0);
  const planned = fcKeys(l);
  for (const k of planned) {
    const op = r.operators.find((o) => o.account === k.account)!;
    const key = op.keys.find((x) => x.kind === "function call" && x.receiver === k.receiver);
    const want = allowanceFor(l, k).allowance.toString();
    check(`${k.account.split(".")[0]}: function-call key for ${k.receiver.split(".")[0]} with [${METHODS_OF[k.methods].join(",")}] and allowance ${want}`, !!key && key.ours && isDeepStrictEqual(key.methods, [...METHODS_OF[k.methods]]) && key.allowance === want, key);
  }
  for (const a of l.agents) {
    const op = r.operators.find((o) => o.account === a.account)!;
    const m = op.markets[a.market];
    check(`${a.account.split(".")[0]}: registered, $${a.deposit / 1_000_000n} deposited, guard ${a.guard}, max_round_lock ${a.maxRoundLock}, 2 keys, wallet empty`,
      !!m && m.balance === a.deposit.toString() && m.guard === a.guard && m.max_round_lock === a.maxRoundLock.toString() && op.keys.length === 2 && op.token_balance === "0", { m, keys: op.keys.length, wallet: op.token_balance });
  }
  const keeperRow = r.operators.find((o) => o.role === "keeper")!;
  check("keeper registered on both markets, 1 full-access + 2 function-call keys", Object.values(keeperRow.markets).every((x) => x !== null) && keeperRow.keys.length === 3);
  const est = storageBytes(l.keeper, planned.filter((k) => k.account === l.keeper).map((k) => ({ receiver: k.receiver, methods: METHODS_OF[k.methods] })));
  summary.storage_estimate = { keeper_estimated_bytes: est, keeper_actual_bytes: keeperRow.storage_usage };
  eq("the keeper account's storage, as budget.ts computes it, equals the bytes on chain", est, keeperRow.storage_usage);
  for (const o of r.operators.filter((x) => x.role === "agent" || x.role === "reporter")) {
    const mine = planned.filter((k) => k.account === o.account).map((k) => ({ receiver: k.receiver, methods: METHODS_OF[k.methods] }));
    if (storageBytes(o.account, mine) !== o.storage_usage) eq(`${o.account}: storage as computed`, storageBytes(o.account, mine), o.storage_usage);
  }
  check("every operator has some days of gas", r.operators.filter((o) => o.role !== "ops").every((o) => (o.days_left ?? 99) >= 1.9), r.operators.map((o) => [o.account, o.days_left]));
  summary.status = { problems: r.problems.length, contracts: r.contracts.length, operators: r.operators.length };

  // ---------------------------------------------------------------- 2
  section("one tick by hand with the generated keys");
  // keeper.env's shape: every signer has `keys`, one per contract, named by the contract.
  let vars = parseEnv(readFileSync(join(O1, "keeper.env"), "utf8"));
  type Keyed = { account_id: string; keys: Record<string, string> };
  const envReporters = () => JSON.parse(vars.REPORTERS!) as Keyed[];
  const envAgents = () => JSON.parse(vars.AGENTS!) as (Keyed & { market: string; role: string })[];
  const envKeeper = () => JSON.parse(vars.KEEPER!) as Keyed;
  eq("keeper.env: REPORTERS, AGENTS, SWARM_SECRET and KEEPER, nothing else", Object.keys(vars), ["REPORTERS", "AGENTS", "SWARM_SECRET", "KEEPER"]);
  check("every reporter and the keeper hold one key per market contract, every agent one for its market", envReporters().every((r) => Object.keys(r.keys).length === 2) && Object.keys(envKeeper().keys).length === 2 && envAgents().every((a) => isDeepStrictEqual(Object.keys(a.keys), [l.contracts[a.market]])));
  const fastSecret = (e: Keyed) => e.keys[l.contracts["h100-fast"]!]!;
  const fastId = l.contracts["h100-fast"]!;
  const portFor = async (account: string, secret: string, contract = fastId) => new ChainWeir({ rpc, account: new NearAccount(rpc, account, await KeyPair.fromString(secret)), contractId: contract, usdcId: l.usdc });
  const viewer = new ChainWeir({ rpc, contractId: fastId });
  const allowanceOf = async (account: string, secret: string) => {
    const k = await KeyPair.fromString(secret);
    const ak = await rpc.viewAccessKey(account, k.publicKeyString);
    return typeof ak.permission === "object" ? BigInt(ak.permission.FunctionCall.allowance ?? "0") : null;
  };
  const measured: { method: string; gas_burnt_tgas: number; allowance_charged_near: number }[] = [];
  const measure = async <T>(method: string, account: string, secret: string, fn: () => Promise<T>, gasOf: () => number): Promise<T> => {
    const before = (await allowanceOf(account, secret))!;
    const v = await fn();
    const after = (await allowanceOf(account, secret))!;
    measured.push({ method, gas_burnt_tgas: gasOf() / 1e12, allowance_charged_near: Number(before - after) / 1e24 });
    return v;
  };
  let lastGas = 0;
  const onOutcome = (_m: string, o: { gas_burnt: number }) => (lastGas = o.gas_burnt);
  const fastReporters = envReporters().map((r) => ({ account_id: r.account_id, secret_key: fastSecret(r) }));
  eq("three reporters for h100-fast in REPORTERS", fastReporters.length, 3);
  const params = await viewer.get_params({});
  const reportAll = async (price: number) => {
    const now = await sandbox.now();
    const bucket = Math.floor(now / params.print_interval_secs) * params.print_interval_secs;
    const bundle = sha256Hex(`weir deploy e2e ${bucket}`);
    for (const rep of fastReporters) {
      const port = new ChainWeir({ rpc, account: new NearAccount(rpc, rep.account_id, await KeyPair.fromString(rep.secret_key)), contractId: fastId, onOutcome });
      await measure("report", rep.account_id, rep.secret_key, () => port.report({ bucket, price, bundle }), () => lastGas);
    }
    return bucket;
  };
  // Wait for the start of a commit phase with enough of it left for the reports and commits.
  const toCommitPhase = async () => {
    for (;;) {
      const s = await viewer.get_status({});
      const live = s.live[0]!;
      if (live.phase === "Commit" && live.phase_ends_at! - s.now >= 60) return live;
      await sandbox.warpTo((live.phase_ends_at ?? s.now + 2) + 1);
    }
  };
  let live = await toCommitPhase();
  const storageBefore = (await rpc.viewAccount(fastId)).storage_usage;
  const bucket = await reportAll(2_900_000);
  const printBytes = (await rpc.viewAccount(fastId)).storage_usage - storageBefore;
  summary.print_storage = { bytes_per_final_print_with_3_reports: printBytes, fast_market_bytes_per_day_unpruned: printBytes * 288, near_per_day: (printBytes * 288) / 100_000 };
  console.log(`    one final print with three reports adds ${printBytes} bytes to the contract's storage`);
  const print = await viewer.get_print({ bucket });
  eq("three reports make a final print at once", [print?.state, print?.price], ["Final", 2_900_000]);
  live = await toCommitPhase();
  const agentOf = (id: string) => {
    const a = envAgents().find((x) => x.account_id === id)!;
    return { account_id: a.account_id, secret_key: fastSecret(a) };
  };
  const buyer = agentOf(`h100-fast-buyer-1.${l.ops}`);
  const seller = agentOf(`h100-fast-seller-1.${l.ops}`);
  const bPort = await portFor(buyer.account_id, buyer.secret_key);
  const salt = (who: string) => sha256Hex(`salt ${who}`).slice(0, 32);
  const order = { series: live.series, round: live.round!, size: 3, price: 435_000 };
  const bHash = commitHash({ ...order, accountId: buyer.account_id, side: "Long", salt: salt("b") });
  const sHash = commitHash({ ...order, accountId: seller.account_id, side: "Short", salt: salt("s") });
  const bp = new ChainWeir({ rpc, account: new NearAccount(rpc, buyer.account_id, await KeyPair.fromString(buyer.secret_key)), contractId: fastId, onOutcome });
  const sp = new ChainWeir({ rpc, account: new NearAccount(rpc, seller.account_id, await KeyPair.fromString(seller.secret_key)), contractId: fastId, onOutcome });
  const bSeq = await measure("commit", buyer.account_id, buyer.secret_key, () => bp.commit({ series: order.series, hash: bHash, lock: "1305000" }), () => lastGas);
  const sSeq = await measure("commit", seller.account_id, seller.secret_key, () => sp.commit({ series: order.series, hash: sHash, lock: "1305000" }), () => lastGas);
  check("buyer and seller commit with their function-call keys", typeof bSeq === "number" && typeof sSeq === "number");
  // What a function-call key cannot do (SPEC section 15): anything that attaches a deposit.
  for (const [m, fn] of [
    ["set_guard", () => bPort.set_guard({ guard: null, max_round_lock: null })],
    ["withdraw", () => bPort.withdraw({ amount: "1" })],
    ["register", () => bPort.register({})],
  ] as const) {
    try {
      await fn();
      check(`the agent key cannot call ${m}`, false);
    } catch (e) {
      check(`the agent key cannot call ${m}`, !(e instanceof CallFailed) || /deposit|not allowed|MethodName/i.test(e.message), (e as Error).message.slice(0, 200));
    }
  }
  const revealAt = live.phase_ends_at!;
  await sandbox.warpTo(revealAt + 1);
  await measure("reveal", buyer.account_id, buyer.secret_key, () => bp.reveal({ ...order, seq: bSeq, side: "Long", salt: salt("b") }), () => lastGas);
  await measure("reveal", seller.account_id, seller.secret_key, () => sp.reveal({ ...order, seq: sSeq, side: "Short", salt: salt("s") }), () => lastGas);
  await sandbox.warpTo(revealAt + params.reveal_secs + 1);
  const kk = { account_id: envKeeper().account_id, secret_key: fastSecret(envKeeper()) };
  const kp = new ChainWeir({ rpc, account: new NearAccount(rpc, kk.account_id, await KeyPair.fromString(kk.secret_key)), contractId: fastId, onOutcome });
  await measure("clear", kk.account_id, kk.secret_key, () => kp.clear({ series: order.series, round: order.round }), () => lastGas);
  const result = await viewer.get_result({ series: order.series, round: order.round });
  eq("the keeper's key cleared the round: 3 GPU-hours at $0.435", [result?.price, result?.volume], [435_000, 3]);
  const wrong = { account_id: envKeeper().account_id, secret_key: envKeeper().keys[l.contracts["h100-weekly"]!]! };
  try {
    const kw = await portFor(wrong.account_id, wrong.secret_key, fastId);
    await kw.clear({ series: order.series, round: order.round + 100 });
    check("the keeper's h100-weekly key is refused on h100-fast", false);
  } catch (e) {
    check("the keeper's h100-weekly key is refused on h100-fast", !(e instanceof CallFailed), (e as Error).message.slice(0, 200));
  }
  summary.allowance_vs_gas = measured;
  for (const x of measured) console.log(`    ${x.method}: ${x.gas_burnt_tgas.toFixed(2)} Tgas burnt, ${x.allowance_charged_near.toFixed(6)} NEAR of allowance`);
  // The key is charged at most the gas burnt at the gas price (1e8), not the 1e9 purchase price of
  // the gas attached: the unburnt part comes back to the allowance.
  check("allowance is charged at most the gas burnt at 1e8 yocto/gas, and at least 85% of it", measured.every((x) => x.allowance_charged_near <= x.gas_burnt_tgas * 1e-4 && x.allowance_charged_near >= x.gas_burnt_tgas * 1e-4 * 0.85), measured);

  // ---------------------------------------------------------------- 3
  section("apply again");
  const apply2 = await cli(["apply", ...net(O1, K1, "e2e1"), "--markets", MARKETS], { quiet: true });
  check("second apply exits 0", apply2.code === 0, apply2.err);
  check("second apply sends nothing", /done: 0 transactions sent, (\d+) steps already on chain/.test(apply2.out) && !/ sent  /.test(apply2.out), apply2.out.slice(-300));

  // ---------------------------------------------------------------- 4
  section("seal h100-fast");
  const noConfirm = await cli(["seal", ...net(O1, K1, "e2e1"), "--markets", "h100-fast"], { quiet: true });
  check("seal without --confirm refuses", noConfirm.code !== 0 && /pass --confirm/.test(noConfirm.err), noConfirm.err);
  const weeklyConfirm = await cli(["seal", ...net(O1, K1, "e2e1"), "--markets", "h100-fast", "--confirm", l.contracts["h100-weekly"]!], { quiet: true });
  check("seal with the wrong name refuses", weeklyConfirm.code !== 0, weeklyConfirm.err);
  eq("still one key after the refusals", (await rpc.call<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: fastId })).keys.length, 1);
  const sealRun = await cli(["seal", ...net(O1, K1, "e2e1"), "--markets", "h100-fast", "--confirm", fastId], { quiet: true });
  check("seal exits 0", sealRun.code === 0, sealRun.err);
  const st2 = JSON.parse((await cli(["status", ...net(O1, K1, "e2e1"), "--json"], { quiet: true })).out) as StatusReport;
  const sealed = st2.contracts.find((c) => c.account === fastId)!;
  check("the sealed market has no access keys", sealed.keys.length === 0 && sealed.sealed);
  check("the other market and the token keep their key", st2.contracts.filter((c) => c.account !== fastId).every((c) => c.keys.length === 1));
  eq("status after sealing: no problems", st2.problems, []);
  live = await toCommitPhase();
  const bucket2 = await reportAll(2_910_000);
  eq("the sealed market still takes reports", (await viewer.get_print({ bucket: bucket2 }))?.state, "Final");
  live = await toCommitPhase();
  const h2 = commitHash({ series: live.series, round: live.round!, size: 3, price: 435_000, accountId: buyer.account_id, side: "Long", salt: salt("b2") });
  check("the sealed market still takes commits", typeof (await bp.commit({ series: live.series, hash: h2, lock: "1305000" })) === "number");
  const apply3 = await cli(["apply", ...net(O1, K1, "e2e1"), "--markets", MARKETS], { quiet: true });
  check("apply after sealing still sends nothing", apply3.code === 0 && /done: 0 transactions sent/.test(apply3.out), apply3.err);
  summary.seal = { contract: fastId, keys_after: sealed.keys.length };

  // ---------------------------------------------------------------- 5
  section("the keeper, loaded from keeper.env and deployments.json");
  const sources = new FakeSources();
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => (url.startsWith(sandbox.url) ? fetch(url, init) : sources.fetch(url, init));
  const store = new MemoryStore();
  /** Loads keeper.env with the keeper's own reader and runs `n` ticks a minute apart. Returns
   * null, and says why, if the keeper cannot take the file. */
  const keeperTicks = async (label: string, n: number) => {
    vars = parseEnv(readFileSync(join(O1, "keeper.env"), "utf8"));
    const secrets = readSecrets(vars);
    if (!check(`${label}: the keeper's own readSecrets takes keeper.env without a problem`, secrets.problems.length === 0, secrets.problems)) return null;
    let wall = 0;
    const env = { deployments, store, secrets, fetch: fetchFn, wallNow: () => wall, leaseConfirmMs: 0 };
    const ticks: { now: number; txs: number; failed: number; requests: number; undone: number }[] = [];
    const failedTexts: string[] = [];
    let handMadeSeen = 0;
    const txMethods: Record<string, number> = {};
    const signers: Record<string, number> = {};
    let t = await sandbox.now();
    for (let i = 0; i < n; i++) {
      t = await sandbox.warpTo(t + 60);
      wall = t;
      const rep = await runTick(env as never, t);
      // The commit made by hand on the sealed market (step 4) has a salt the keeper cannot know, so
      // the keeper rightly reports it cannot reveal it; anything else failing is a failure.
      const handMade = (e: { agent?: string; text: string }) => e.agent === buyer.account_id && /cannot reveal: order not in store/.test(e.text);
      handMadeSeen += rep.entries.filter((e) => e.status === "failed" && handMade(e)).length;
      const failed = rep.entries.filter((e) => e.status === "failed" && !handMade(e));
      for (const x of rep.txs) {
        txMethods[x.method] = (txMethods[x.method] ?? 0) + 1;
        if (x.ok) signers[x.signer] = (signers[x.signer] ?? 0) + 1;
      }
      failedTexts.push(...failed.map((e) => `${e.market ?? "-"} ${e.action}: ${e.text}`));
      ticks.push({ now: t, txs: rep.txs.length, failed: failed.length, requests: rep.budget.used, undone: rep.undone.length });
      console.log(`    tick ${i + 1} at ${new Date(t * 1000).toISOString()}: ${rep.txs.length} transactions (${rep.txs.filter((x) => x.ok).length} ok), ${failed.length} failed, ${rep.budget.used} requests`);
    }
    console.log(`    keeper transactions by method: ${JSON.stringify(txMethods)}`);
    eq(`${label}: no keeper entry failed (other than the hand-made commit it cannot reveal)`, failedTexts, []);
    return { ticks, txMethods, signers, handMadeSeen, transactions: ticks.reduce((s, x) => s + x.txs, 0) };
  };
  const k1 = await keeperTicks("first run", 12);
  if (k1) {
    check("the keeper ran 12 ticks and sent transactions with the generated keys", k1.transactions > 0, k1.ticks);
    check("the keeper said it cannot reveal the hand-made commit", k1.handMadeSeen > 0);
    check("the keeper reported, committed, revealed and cleared with the generated keys", ["report", "commit", "reveal", "clear"].every((m) => (k1.txMethods[m] ?? 0) > 0), k1.txMethods);
    check("the housekeeping account signed with its per-market keys", (k1.signers[l.keeper] ?? 0) > 0, k1.signers);
    const fastPrint = await viewer.get_last_print({});
    check("the keeper's reporters made prints on the sealed market", (fastPrint?.bucket ?? 0) > bucket2, fastPrint);
    const weeklyPrint = await new ChainWeir({ rpc, contractId: l.contracts["h100-weekly"]! }).get_last_print({});
    check("and on the weekly market", weeklyPrint !== null, weeklyPrint);
  }
  summary.keeper = k1 ? { ticks: k1.ticks, transactions: k1.transactions, by_method: k1.txMethods, signers: k1.signers } : "the keeper could not load keeper.env";

  // ---------------------------------------------------------------- 5b
  section("topup: a drained agent, an exhausted key, contracts short of storage money");
  const fullKey = async (id: string) => KeyPair.fromString((JSON.parse(readFileSync(join(K1, `${id}.json`), "utf8")) as { private_key: string }).private_key);
  // Drain an agent: it sends nearly all its NEAR back to the ops account with its full-access key.
  const drained = `h100-fast-maker-1.${l.ops}`;
  const dAcct = new NearAccount(rpc, drained, await fullKey(drained));
  const dBal = BigInt((await rpc.viewAccount(drained)).amount);
  const { RpcChain } = await import("../src/chain.ts");
  const raw = new RpcChain(rpc, () => Promise.reject(new Error("not used here")));
  await raw.send({ accountId: drained, key: dAcct.key }, l.ops, [{ type: "Transfer", deposit: dBal - 3n * 10n ** 21n }]);
  // Exhaust a key: reporter-a's key for the fast market is replaced on chain by the same public key
  // with an allowance of 0.0005 NEAR, as if it had been used up.
  const repA = `reporter-a.${l.ops}`;
  const repAKey = await KeyPair.fromString(fastSecret(envReporters().find((r) => r.account_id === repA)!));
  const repAFull = await fullKey(repA);
  await raw.send({ accountId: repA, key: repAFull }, repA, [
    { type: "DeleteKey", publicKey: repAKey.publicKey },
    { type: "AddKey", publicKey: repAKey.publicKey, permission: { receiverId: fastId, methodNames: ["report", "finalize_print"], allowance: 5n * 10n ** 20n } },
  ]);
  // Spend an agent's test dollars: it withdraws all but $2 with its full-access key.
  const spender = `h100-weekly-seller-2.${l.ops}`;
  const spenderPort = new ChainWeir({ rpc, account: new NearAccount(rpc, spender, await fullKey(spender)), contractId: l.contracts["h100-weekly"]! });
  const spenderFree = BigInt((await spenderPort.get_account({ account_id: spender }))!.balance);
  await spenderPort.withdraw({ amount: (spenderFree - 2_000_000n).toString() });
  const st4 = JSON.parse((await cli(["status", ...net(O1, K1, "e2e1"), "--json"], { quiet: true })).out) as StatusReport;
  check("status flags the drained agent and the exhausted key", st4.problems.some((p) => p.includes(drained)) && st4.problems.some((p) => p.includes(repA) && p.includes("allowance")), st4.problems);
  check("status gives days left for every operator and market contract", st4.operators.filter((o) => o.role !== "ops").every((o) => o.days_left !== null) && st4.contracts.filter((c) => c.role === "market").every((c) => c.days_left !== null));
  const keyFiles = () => readdirSync(join(K1, repA)).length;
  const filesBefore = keyFiles();
  const dry = await cli(["topup", ...net(O1, K1, "e2e1"), "--days", "14", "--dry-run"], { quiet: true });
  check("topup --dry-run names the drained agent, the agent out of test dollars, the key to replace and the contracts, and sends nothing", dry.code === 0 && dry.out.includes(drained) && dry.out.includes(`test dollars for ${spender}`) && dry.out.includes(`replace ${repA}'s key for ${fastId}`) && dry.out.includes(`to ${fastId}`) && !/sent  /.test(dry.out), dry.out.slice(-1500));
  eq("--dry-run created no key", keyFiles(), filesBefore);
  const up = await cli(["topup", ...net(O1, K1, "e2e1"), "--days", "14"], { quiet: true });
  check("topup exits 0", up.code === 0, up.err.slice(-1500));
  const upSent = up.out.split("\n").filter((x) => /^sent  /.test(x));
  check("every topup transaction logs its hash", upSent.length > 0 && upSent.every((x) => /: tx [1-9A-HJ-NP-Za-km-z]{43,44}$/.test(x)), upSent);
  const funds = upSent.filter((x) => x.startsWith("sent  fund:")).length;
  check(`topup created fund accounts (${funds}) and swept them into ops`, funds > 0 && upSent.some((x) => x.startsWith("sent  sweep:")));
  const st5 = JSON.parse((await cli(["status", ...net(O1, K1, "e2e1"), "--json"], { quiet: true })).out) as StatusReport;
  eq("status after topup: no problems", st5.problems, []);
  check("every operator and market contract now has at least 14 days", st5.operators.filter((o) => o.days_left !== null).every((o) => o.days_left! >= 14) && st5.contracts.filter((c) => c.days_left !== null).every((c) => c.days_left! >= 14), [st5.operators.map((o) => [o.account, o.days_left]), st5.contracts.map((c) => [c.account, c.days_left])]);
  const spPlan = l.agents.find((a) => a.account === spender)!;
  check("the agent out of test dollars was minted and deposited back to its working balance plus 14 days of fees", upSent.some((x) => x.startsWith(`sent  mint:${spender}`)) && upSent.some((x) => x.startsWith(`sent  deposit:${spender}`)) && BigInt((await spenderPort.get_account({ account_id: spender }))!.balance) >= spPlan.working + spPlan.feesPerDay * 14n);
  check("status shows days of test dollars for every agent", st5.operators.filter((o) => o.role === "agent").every((o) => (o.dollar_days_left ?? 0) >= 14), st5.operators.map((o) => [o.account, o.dollar_days_left]));
  vars = parseEnv(readFileSync(join(O1, "keeper.env"), "utf8"));
  const repANew = await KeyPair.fromString(fastSecret(envReporters().find((r) => r.account_id === repA)!));
  check("keeper.env holds reporter-a's new key for the fast market", repANew.publicKeyString !== repAKey.publicKeyString);
  const repAKeys = (await rpc.call<{ keys: { public_key: string; access_key: { permission: { FunctionCall?: { allowance: string; receiver_id: string } } } }[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: repA })).keys;
  check("the new key is on chain with a fresh allowance, the exhausted one is deleted", repAKeys.some((k) => k.public_key === repANew.publicKeyString && BigInt(k.access_key.permission.FunctionCall!.allowance) > 10n ** 24n) && !repAKeys.some((k) => k.public_key === repAKey.publicKeyString), repAKeys);
  const again = await cli(["topup", ...net(O1, K1, "e2e1"), "--days", "14"], { quiet: true });
  check("a second topup sends nothing", again.code === 0 && /done: 0 transactions sent/.test(again.out), again.out.slice(-800));
  const before = BigInt((await rpc.viewAccessKey(repA, repANew.publicKeyString)).permission === "FullAccess" ? 0 : ((await rpc.viewAccessKey(repA, repANew.publicKeyString)).permission as { FunctionCall: { allowance: string } }).FunctionCall.allowance);
  const k2 = await keeperTicks("after topup (keeper restarted on the new keeper.env)", 6);
  const afterAllowance = (await rpc.viewAccessKey(repA, repANew.publicKeyString)).permission as { FunctionCall: { allowance: string } };
  if (k2) check("the keeper reported with reporter-a's rotated key", BigInt(afterAllowance.FunctionCall.allowance) < before && (k2.signers[repA] ?? 0) > 0, { before: String(before), after: afterAllowance.FunctionCall.allowance, signers: k2.signers });
  summary.topup = { fund_accounts: funds, transactions: upSent.length, rotated: repA, keeper_after: k2 ? k2.txMethods : null };

  // ---------------------------------------------------------------- 6
  section("a fresh apply killed halfway, then resumed");
  const half = Math.floor(planSteps / 2);
  let seen = 0;
  const killed = await cli(["apply", ...net(O2, K2, "e2e2"), "--markets", MARKETS], { quiet: true, killWhen: (line) => / sent  /.test(line) && ++seen === half });
  check(`apply killed with SIGKILL after ${half} logged transactions`, killed.signal === "SIGKILL", { code: killed.code, signal: killed.signal });
  const loggedBefore = killed.out.split("\n").filter((x) => / sent  /.test(x)).length;
  const stateAfterKill = JSON.parse(readFileSync(join(O2, "state.json"), "utf8")) as { steps: Record<string, unknown> };
  check("the state file was left behind, partial", Object.keys(stateAfterKill.steps).length >= half && Object.keys(stateAfterKill.steps).length < planSteps, Object.keys(stateAfterKill.steps).length);
  const resumed = await cli(["apply", ...net(O2, K2, "e2e2"), "--markets", MARKETS], { quiet: true });
  check("the re-run exits 0", resumed.code === 0, resumed.err.slice(-1000));
  const m = /done: (\d+) transactions sent, (\d+) steps already on chain/.exec(resumed.out);
  const sent2 = Number(m?.[1]);
  const skipped2 = Number(m?.[2]);
  eq("the re-run covers every step exactly once", sent2 + skipped2, planSteps);
  check(`it skipped at least the ${loggedBefore} transactions the killed run logged`, skipped2 >= loggedBefore, { skipped2, loggedBefore });
  check("no transaction was sent twice", loggedBefore + sent2 <= planSteps, { loggedBefore, sent2, planSteps });
  const st3 = await cli(["status", ...net(O2, K2, "e2e2"), "--json"], { quiet: true });
  check("status of the resumed deployment: no problems", st3.code === 0 && (JSON.parse(st3.out) as StatusReport).problems.length === 0, st3.code === 0 ? undefined : (JSON.parse(st3.out) as StatusReport).problems);
  summary.kill = { killed_after_logged: loggedBefore, resumed_sent: sent2, resumed_skipped: skipped2, plan_steps: planSteps };

  // ---------------------------------------------------------------- 7
  section("secrets");
  const leak = new Redactor();
  let nSecrets = 0;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else {
        check(`${p.slice(tmp.length)} is mode 600`, (statSync(p).mode & 0o777) === 0o600);
        const text = readFileSync(p, "utf8");
        leak.add(n.endsWith(".swarm-secret") ? text.trim() : (JSON.parse(text) as { private_key: string }).private_key);
        nSecrets++;
      }
    }
  };
  walk(K1);
  walk(K2);
  leak.add((JSON.parse(readFileSync(rootKey, "utf8")) as { secret_key: string }).secret_key);
  const outputs: [string, string][] = transcript.map((x, i) => [`cli output ${i}`, x]);
  for (const o of [O1, O2]) for (const f of ["state.json", "record.json", "deployments.json"]) outputs.push([join(o, f).slice(tmp.length), readFileSync(join(o, f), "utf8")]);
  const leaking = outputs.filter(([, text]) => leak.leaks(text)).map(([n]) => n);
  eq(`none of ${nSecrets} generated secrets (plus the root key) in ${outputs.length} outputs`, leaking, []);
  check("keeper.env does hold the function-call keys", leak.leaks(readFileSync(join(O1, "keeper.env"), "utf8")));
  summary.secrets = { generated: nSecrets, outputs_scanned: outputs.length, leaking };
} catch (e) {
  fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(fatal);
  check("the run reached its end", false, fatal);
} finally {
  sandbox.stop();
}

const failed = checks.filter((c) => !c.ok);
summary.finished = new Date().toISOString();
summary.checks = { total: checks.length, failed: failed.length };
summary.failures = failed;
mkdirSync(OUT, { recursive: true });
const leakGuard = new Redactor();
writeFileSync(join(OUT, "e2e-sandbox.json"), leakGuard.redact(JSON.stringify(summary, null, 2)) + "\n");
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed${fatal ? " (stopped early)" : ""}. Summary: ${join(OUT, "e2e-sandbox.json")}`);
if (failed.length === 0 && !fatal) rmSync(tmp, { recursive: true, force: true });
else console.log(`kept ${tmp} for inspection`);
process.exitCode = failed.length === 0 && !fatal ? 0 : 1;
