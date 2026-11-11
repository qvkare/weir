// Scenario 6: the keeper's `runTick`, with its own `nearChain` and `ChainWeir`, keeps a fast
// market running on the sandbox for one whole series: reporters post the index served from
// the saved source responses, six agents trade through function-call keys, rounds clear, the
// series settles and positions are redeemed. Each transaction is also made on the model.
import { readFileSync } from "node:fs";
import { AGENT_KEY_METHODS, CALLS, ChainWeir, type PortChange, type TxOutcome, type WeirPort, CHANGE_METHODS, VIEW_METHODS } from "../../chain/src/mod.ts";
import { auctionOpen, deliveryEnd, roundCount, type WireParams } from "../../engine/src/mod.ts";
import { MemoryStore, nearChain, readSecrets, runTick, type AgentSpec, type Chain, type Deployments, type TickReport } from "../../keeper/src/mod.ts";
import { SOURCES } from "../../index/src/mod.ts";
import { NEAR, type Signer } from "./accounts.ts";
import type { Twin } from "./twin.ts";
import { onGrid, type World } from "./world.ts";

const FIXTURES = new URL("../../index/test/fixtures/", import.meta.url);
const DOLLAR = 1_000_000n;

export interface TickStat {
  now: number;
  wall_ms: number;
  twin_ms: number;
  requests: number;
  rpc_calls: number;
  source_calls: number;
  by_step: TickReport["budget"]["by_step"];
  txs: number;
  failed_txs: number;
  undone: string[];
}

export interface SwarmResult {
  contract: string;
  ticks: TickStat[];
  summary: Record<string, unknown>;
  failures: { at: number; text: string }[];
  allowance_used: Record<string, string>;
}

const AGENTS: Omit<AgentSpec, "account_id" | "secret_key">[] & { deposit?: bigint }[] = [
  { role: "buyer", need: 40, premium_bps: 400 },
  { role: "buyer", need: 30, premium_bps: 600 },
  { role: "seller", capacity: 150, premium_bps: 300 },
  { role: "seller", capacity: 120, premium_bps: 500 },
  { role: "maker", spread_bps: 500, share_bps: 1000, max_size: 30 },
  { role: "noise" },
];
const DEPOSITS: Record<string, bigint> = { buyer: 60n * DOLLAR, seller: 200n * DOLLAR, maker: 400n * DOLLAR, noise: 30n * DOLLAR };

export async function swarm(w: World, reporters: Signer[]): Promise<SwarmResult> {
  w.scenario = "swarm";
  const rpc = w.sandbox.rpc;
  const now0 = await w.sandbox.now();
  const t0 = onGrid(now0 + 3900 + 120, 300);
  const params: WireParams = w.fastParams(reporters.map((r) => r.accountId), t0);
  const { id: weir } = await w.deployWeir("weir-swarm", params);
  const { twin, tp } = await w.twin(weir);
  twin.scenario = "swarm";
  const view = new ChainWeir({ rpc, contractId: weir });

  // Six agents whose only key is a function-call key for Weir; root registers and funds them.
  const agents: AgentSpec[] = [];
  const rootPort = twin.port(w.root.near());
  await w.mint(w.root.near(), w.root.accountId, 10_000n * DOLLAR);
  for (const [i, a] of AGENTS.entries()) {
    const id = `${a.role}-${i}.${w.root.accountId}`;
    const s = await w.root.createAccount(id, { balance: 5n * NEAR, permission: { receiverId: weir, methodNames: [...AGENT_KEY_METHODS], allowance: NEAR } });
    await rootPort.call("register", { account_id: id });
    await rootPort.call("deposit", { amount: DEPOSITS[a.role]!.toString(), msg: id });
    agents.push({ ...a, account_id: id, secret_key: s.secret } as AgentSpec);
  }
  const totalDeposit = AGENTS.reduce((s, a) => s + DEPOSITS[a.role]!, 0n);
  const secrets = readSecrets({
    REPORTERS: JSON.stringify(reporters.map((r) => ({ account_id: r.accountId, secret_key: r.secret }))),
    AGENTS: JSON.stringify(agents),
    SWARM_SECRET: "integration-swarm-secret-0123456789abcdef",
  });
  w.eq("keeper secrets parse without problems", secrets.problems, []);
  const deployments: Deployments = {
    network: "sandbox",
    rpc: [w.sandbox.url],
    explorer: "",
    bundles_base: null,
    markets: [{ id: "fast", label: "Fast (sandbox)", contract: weir, usdc: w.usdc.accountId }],
  };

  // The fetch the keeper gets: RPC goes to the sandbox, the six index sources are served from
  // index/test/fixtures, and anything else is refused (and counted, and fails the run).
  const bodies = new Map(SOURCES.map((s) => [s.url, readFileSync(new URL(`${s.id}.json`, FIXTURES), "utf8")]));
  const counters = { rpc: 0, source: 0, other: [] as string[] };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith(w.sandbox.url)) {
      counters.rpc++;
      return fetch(url, init);
    }
    const body = bodies.get(url);
    if (body !== undefined) {
      counters.source++;
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    counters.other.push(url);
    return new Response("blocked by the integration test", { status: 599 });
  };

  // The keeper's own nearChain, with each port's state changes also made on the model.
  let twinMs = 0;
  const base = nearChain(deployments.rpc);
  const chain: Chain = {
    perCall: false,
    async connect(market, signer, hooks) {
      const box: { last: TxOutcome | null } = { last: null };
      const port = await base.connect(market, signer, { fetch: hooks.fetch, onOutcome: (o) => ((box.last = o as TxOutcome), hooks.onOutcome(o)) });
      return mirrored(port, twin, box, (ms) => (twinMs += ms));
    },
  };
  const store = new MemoryStore();
  let tickChainNow = 0;
  let tickWallStart = 0;
  const env = {
    deployments,
    store,
    secrets,
    fetch: fetchFn as never,
    chain,
    wallNow: () => tickChainNow + (Date.now() - tickWallStart) / 1000,
    leaseConfirmMs: 200,
  };

  // Ticks: three per five-minute round (20 s, 110 s and 200 s in), from series 0's auction
  // opening until its delivery and report window are over, and a few more to redeem.
  const open = auctionOpen(tp, 0);
  const end = deliveryEnd(tp, 0) + params.report_grace_secs;
  const targets: number[] = [];
  for (let slot = open; slot <= end + 300; slot += 300) for (const off of [20, 110, 200]) targets.push(slot + off);
  const ticks: TickStat[] = [];
  const failures: { at: number; text: string }[] = [];
  const reports: TickReport[] = [];
  for (const target of targets) {
    const warpStart = Date.now();
    const now = await w.sandbox.warpTo(target);
    const warpMs = Date.now() - warpStart;
    counters.rpc = 0;
    counters.source = 0;
    twinMs = 0;
    tickChainNow = now;
    tickWallStart = Date.now();
    const report = await runTick(env as never, now);
    const wallMs = Date.now() - tickWallStart;
    reports.push(report);
    ticks.push({
      now,
      wall_ms: wallMs,
      twin_ms: twinMs,
      requests: report.budget.used,
      rpc_calls: counters.rpc,
      source_calls: counters.source,
      by_step: report.budget.by_step,
      txs: report.txs.length,
      failed_txs: report.txs.filter((t) => !t.ok).length,
      undone: report.undone,
    });
    if (process.env.WEIR_E2E_VERBOSE) console.log(`   tick ${now - open}: ${wallMs} ms (twin ${twinMs} ms, warp ${warpMs} ms), ${report.budget.used} requests, ${report.txs.length} txs ${JSON.stringify(report.txs.map((t) => t.method))}, undone ${report.undone.length}`);
    for (const e of report.entries) if (e.status === "failed") failures.push({ at: now, text: `${e.step}/${e.action}${e.agent ? ` ${e.agent}` : ""}: ${e.text}` });
    const settled = (await view.get_series({ series: 0 }))?.settlement;
    if (settled && now > end + 120) {
      const positions = await Promise.all(agents.map((a) => view.get_position({ series: 0, account_id: a.account_id })));
      if (positions.every((p) => p.long + p.short === 0)) break;
    }
  }
  console.log(`   ${ticks.length} ticks, ${ticks.reduce((s, t) => s + t.txs, 0)} transactions, ${failures.length} failed entries`);

  // What must be true after one whole series.
  const prints = await view.get_prints({ from_bucket: open, limit: 200 });
  const buckets: number[] = [];
  for (let b = open; b < deliveryEnd(tp, 0); b += params.print_interval_secs) buckets.push(b);
  const finalBuckets = new Set(prints.map((p) => p.bucket));
  w.eq("a final print in every bucket from the auction's opening to delivery end", buckets.filter((b) => !finalBuckets.has(b)), []);
  const rounds = roundCount(tp, 0);
  const results = await view.get_results({ series: 0, from_round: 0, limit: 100 });
  const series = await view.get_series({ series: 0 });
  w.eq("no round of series 0 is left uncleared", series?.pending_rounds, []);
  const traded = results.filter(([, r]) => r.volume > 0).length;
  w.check("rounds with commits were cleared", results.length > 0, { cleared: results.length, rounds, traded });
  const forfeited = results.reduce((s, [, r]) => s + BigInt(r.forfeited), 0n);
  w.eq("zero forfeits", forfeited, 0n);
  w.eq("every commit was revealed", results.reduce((s, [, r]) => s + r.commits - r.orders, 0), 0);
  w.check("series 0 settled normally", series?.settlement?.void === false, series?.settlement);
  const positions = await Promise.all(agents.map((a) => view.get_position({ series: 0, account_id: a.account_id })));
  w.eq("every agent's position in series 0 was redeemed", positions.filter((p) => p.long + p.short > 0).length, 0);
  await w.booksBalance("swarm", weir);
  const totals = await view.get_totals({});
  w.eq("the swarm's deposits are all accounted for", [totals.free, totals.locked, totals.sets_backing, totals.pools, totals.unredeemed].reduce((s, x) => s + BigInt(x), 0n), totalDeposit);
  w.eq("the keeper made no request outside the sandbox and the fixtures", counters.other, []);
  w.eq("no tick went over the request budget", ticks.filter((t) => t.requests > 40), []);
  w.check("no keeper entry failed", failures.length === 0, failures.slice(0, 20));
  await twin.checkpoint("swarm end", { tp, series: [0, 1], accounts: agents.map((a) => a.account_id) });

  const allowance: Record<string, string> = {};
  for (const a of agents) {
    const keys = await rpc.call<{ keys: { access_key: { permission: { FunctionCall?: { allowance: string | null } } } }[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: a.account_id });
    const left = BigInt(keys.keys[0]?.access_key.permission.FunctionCall?.allowance ?? "0");
    allowance[a.account_id] = (NEAR - left).toString();
  }
  return {
    contract: weir,
    ticks,
    failures,
    allowance_used: allowance,
    summary: {
      rounds_cleared: results.length,
      rounds_traded: traded,
      volume: results.reduce((s, [, r]) => s + r.volume, 0),
      settlement: series?.settlement,
      buckets: buckets.length,
      store_writes: store.writes,
      txs_by_method: countBy(reports.flatMap((r) => r.txs.map((t) => t.method))),
    },
  };
}

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

/** The keeper's port, with every state change also made on the model at the chain's time. */
function mirrored(port: WeirPort, twin: Twin, box: { last: TxOutcome | null }, spent: (ms: number) => void): WeirPort {
  const change = async (method: string, args: unknown): Promise<unknown> => {
    box.last = null;
    let result: unknown;
    let error: unknown = null;
    try {
      result = await port.change(method as never, args as never);
    } catch (e) {
      error = e;
    }
    const o = box.last as TxOutcome | null;
    const t = Date.now();
    if (o) {
      const x = await twin.execTime(o.tx_hash, port.accountId);
      const msg = error instanceof Error ? error.message : String(error);
      twin.replay({
        account: port.accountId,
        method,
        args,
        chain: {
          ok: error === null,
          ...(error === null ? { result: result ?? null } : { error: msg, kind: "panic" as const }),
          tx_hash: o.tx_hash,
          gas_burnt: o.gas_burnt,
          events: o.logs.filter((l) => l.startsWith("EVENT_JSON:") && l.includes('"standard":"weir"')),
          exec_time: x.time,
          exec_height: x.height,
          receipts: x.receipts,
          wall_ms: 0,
          gas_attached: Number(CALLS[method as PortChange].gas),
        },
      });
    }
    spent(Date.now() - t);
    if (error !== null) throw error;
    return result;
  };
  const out: Record<string, unknown> = { accountId: port.accountId, view: port.view.bind(port), change };
  for (const m of VIEW_METHODS) out[m] = (a: unknown) => port.view(m, a as never);
  for (const m of CHANGE_METHODS) out[m] = (a: unknown) => change(m, a);
  return out as unknown as WeirPort;
}
