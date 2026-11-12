// Scenario 6: the keeper's `runTick`, with its own `nearChain` and `ChainWeir`, keeps the
// `h100-fast` market running on the sandbox for one whole series: three reporters post the
// index served from the saved source responses, six agents trade through function-call keys,
// a housekeeping account with `KEEPER_KEY_METHODS` clears, settles, finalizes and prunes.
// For the first hour a second market (`h200-weekly`, another chip) runs alongside, with its
// own reporters and agents, to show two markets sharing the request budget. Every transaction
// is also made on the model of its contract.
import { readFileSync } from "node:fs";
import {
  AGENT_KEY_METHODS,
  CALLS,
  CHANGE_METHODS,
  ChainWeir,
  KEEPER_KEY_METHODS,
  REPORTER_KEY_METHODS,
  VIEW_METHODS,
  type PortChange,
  type TxOutcome,
  type WeirPort,
} from "../../chain/src/mod.ts";
import { auctionOpen, deliveryEnd, roundCount, type WireParams } from "../../engine/src/mod.ts";
import { MARKETS } from "../../agents/src/presets.ts";
import { CHIP_IDS, CHIPS, sourcesFor, type ChipId } from "../../index/src/mod.ts";
import { MemoryStore, nearChain, readSecrets, runTick, type AgentSpec, type Chain, type Deployments, type MarketDeployment, type TickReport } from "../../keeper/src/mod.ts";
import { NEAR, type Signer } from "./accounts.ts";
import type { Twin } from "./twin.ts";
import { onGrid, type World } from "./world.ts";

const FIXTURES = new URL("../../index/test/fixtures/", import.meta.url);
const DOLLAR = 1_000_000n;
const FAST = "h100-fast" as const;
const SECOND = "h200-weekly" as const;

export interface TickStat {
  now: number;
  wall_ms: number;
  twin_ms: number;
  requests: number;
  requests_by_market: Record<string, number>;
  rpc_calls: number;
  source_calls: number;
  by_step: TickReport["budget"]["by_step"];
  acting: string[];
  txs: number;
  failed_txs: number;
  undone: string[];
}

export interface SwarmResult {
  contracts: Record<string, string>;
  ticks: TickStat[];
  summary: Record<string, unknown>;
  failures: { at: number; market: string; text: string }[];
  prunes: { contract: string; method: string; args: unknown; ok: boolean; storage_before: number; storage_after: number }[];
  allowance_used: Record<string, string>;
}

const FAST_AGENTS: Omit<AgentSpec, "account_id" | "secret_key">[] = [
  { role: "buyer", need: 40, premium_bps: 400 },
  { role: "buyer", need: 30, premium_bps: 600 },
  { role: "seller", capacity: 150, premium_bps: 300 },
  { role: "seller", capacity: 120, premium_bps: 500 },
  { role: "maker", spread_bps: 500, share_bps: 1000, max_size: 30 },
  { role: "noise" },
];
const SECOND_AGENTS: Omit<AgentSpec, "account_id" | "secret_key">[] = [{ role: "buyer", need: 40 }, { role: "seller", capacity: 120 }, { role: "maker", max_size: 20 }];
const DEPOSITS: Record<string, bigint> = { buyer: 60n * DOLLAR, seller: 200n * DOLLAR, maker: 400n * DOLLAR, noise: 30n * DOLLAR };

/** The bodies saved by the index package, as the keeper's harness serves them. */
const fixtureBody = (sourceId: string, chip: ChipId): string =>
  readFileSync(new URL(sourceId === "verda" ? "verda.json" : sourceId === "vast" ? `v2/vast-${chip}.json` : `v2/${sourceId}.json`, FIXTURES), "utf8");

let storageGrowth: Record<string, number> = {};

export async function swarm(w: World, reporters: Signer[], opts: { second?: boolean } = {}): Promise<SwarmResult> {
  w.scenario = "swarm";
  const rpc = w.sandbox.rpc;
  const second = opts.second !== false;
  const now0 = await w.sandbox.now();
  const t0 = onGrid(now0 + 3900 + 150, 300);
  const params: WireParams = { ...MARKETS[FAST].params, usdc: w.usdc.accountId, reporters: reporters.map((r) => r.accountId), t0 };
  w.eq("the h100-fast market is the fast preset", { ...params, usdc: "", reporters: [], t0: 0, underlying: "H100-USD-HR" }, { ...MARKETS[FAST].params, usdc: "", reporters: [], t0: 0 });
  const { id: weir } = await w.deployWeir("weir-h100-fast", params);
  const fast = await w.twin(weir);
  fast.twin.scenario = "swarm";
  const view = new ChainWeir({ rpc, contractId: weir });
  const open = auctionOpen(fast.tp, 0);

  // The second market: weekly, another chip, the same three reporters; its series 0 auction
  // opens up to an hour before the fast one's.
  let second2: { id: string; twin: Twin; params: WireParams } | null = null;
  if (second) {
    const lead = MARKETS[SECOND].params.lead_secs;
    const t0w = Math.floor((open + lead) / 3600) * 3600;
    const p2: WireParams = { ...MARKETS[SECOND].params, usdc: w.usdc.accountId, reporters: reporters.map((r) => r.accountId), t0: t0w };
    const { id } = await w.deployWeir("weir-h200-weekly", p2);
    const t = await w.twin(id);
    t.twin.scenario = "swarm-h200";
    second2 = { id, twin: t.twin, params: p2 };
  }
  const contracts = [weir, ...(second2 ? [second2.id] : [])];

  // Keys, as a testnet deployment will hold them: one function-call key per contract for every
  // signer. Reporters: REPORTER_KEY_METHODS on each contract. Agents: one market each, one key
  // holding AGENT_KEY_METHODS. Housekeeping: KEEPER_KEY_METHODS on each contract.
  const keysFor = async (signer: Signer, methods: readonly string[]) => {
    const keys: Record<string, string> = {};
    for (const c of contracts) keys[c] = (await signer.addKey({ receiverId: c, methodNames: [...methods], allowance: NEAR })).secret;
    return keys;
  };
  const reporterKeys = await Promise.all(reporters.map(async (r) => ({ account_id: r.accountId, keys: await keysFor(r, REPORTER_KEY_METHODS) })));
  const housekeeper = await w.root.createAccount("housekeeper", { balance: 5n * NEAR });
  const housekeeperKeys = await keysFor(housekeeper, KEEPER_KEY_METHODS);
  await w.mint(w.root.near(), w.root.accountId, 10_000n * DOLLAR);
  const agents: AgentSpec[] = [];
  const fund = async (twin: Twin, contract: string, specs: typeof FAST_AGENTS, market: string, prefix: string, keyReceiver = contract) => {
    const rootPort = twin.port(w.root.near());
    for (const [i, a] of specs.entries()) {
      const id = `${prefix}${a.role}-${i}.${w.root.accountId}`;
      const s = await w.root.createAccount(id, { balance: 5n * NEAR, permission: { receiverId: keyReceiver, methodNames: [...AGENT_KEY_METHODS], allowance: NEAR } });
      await rootPort.call("register", { account_id: id });
      await rootPort.call("deposit", { amount: DEPOSITS[a.role]!.toString(), msg: id });
      agents.push({ ...a, account_id: id, keys: { [contract]: s.secret }, markets: [market] } as AgentSpec);
    }
  };
  await fund(fast.twin, weir, FAST_AGENTS, FAST, "");
  // A deliberately wrong configuration: an agent of the second market whose key names the fast
  // contract. Its first call must be refused, logged once with the fix, and not retried.
  let misfit: string | null = null;
  if (second2) {
    await fund(second2.twin, second2.id, SECOND_AGENTS, SECOND, "h200-");
    await fund(second2.twin, second2.id, [{ role: "noise" }], SECOND, "misfit-", weir);
    misfit = agents.at(-1)!.account_id;
  }
  const fastAgents = agents.filter((a) => a.markets?.includes(FAST));
  const totalDeposit = FAST_AGENTS.reduce((s, a) => s + DEPOSITS[a.role]!, 0n);

  const secretsWith = (reps: typeof reporterKeys) =>
    readSecrets({
      REPORTERS: JSON.stringify(reps),
      AGENTS: JSON.stringify(agents),
      SWARM_SECRET: "integration-swarm-secret-0123456789abcdef",
      KEEPER: JSON.stringify({ account_id: housekeeper.accountId, keys: housekeeperKeys }),
    });
  const secrets = secretsWith(reporterKeys);
  // For one bucket the third reporter is missing: its bucket must be decided by finalize_print.
  const secretsMissing = secretsWith(reporterKeys.slice(0, 2));
  w.eq("keeper secrets parse without problems", secrets.problems, []);
  const market = (id: typeof FAST | typeof SECOND, contract: string): MarketDeployment => ({ id, label: MARKETS[id].label, chip: MARKETS[id].chip, contract, usdc: w.usdc.accountId });
  const both: Deployments = { network: "sandbox", rpc: [w.sandbox.url], explorer: "", bundles_base: null, markets: [market(FAST, weir), ...(second2 ? [market(SECOND, second2.id)] : [])] };
  const fastOnly: Deployments = { ...both, markets: [market(FAST, weir)] };

  // The keeper's fetch: RPC to the sandbox, the index sources from the saved bodies, nothing else.
  const bodies = new Map<string, string>();
  for (const chip of CHIP_IDS) for (const s of sourcesFor(CHIPS[chip])) bodies.set(`${s.url}\n${s.body ?? ""}`, fixtureBody(s.id, chip));
  const counters = { rpc: 0, source: 0, other: [] as string[] };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith(w.sandbox.url)) {
      counters.rpc++;
      return fetch(url, init);
    }
    const body = bodies.get(`${url}\n${typeof init?.body === "string" ? init.body : ""}`);
    if (body !== undefined) {
      counters.source++;
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    counters.other.push(url);
    return new Response("blocked by the integration test", { status: 599 });
  };

  // The keeper's own nearChain; each state change is also made on its contract's model, and a
  // prune reads the contract's storage before and after.
  let twinMs = 0;
  const prunes: SwarmResult["prunes"] = [];
  const twins: Record<string, Twin> = { [weir]: fast.twin, ...(second2 ? { [second2.id]: second2.twin } : {}) };
  const base = nearChain([w.sandbox.url]);
  const chain: Chain = {
    perCall: false,
    async connect(m, signer, hooks) {
      const box: { last: TxOutcome | null } = { last: null };
      const port = await base.connect(m, signer, { fetch: hooks.fetch, onOutcome: (o) => ((box.last = o as TxOutcome), hooks.onOutcome(o)) });
      return mirrored(port, twins[m.contract]!, box, (ms) => (twinMs += ms), async (method, args, run) => {
        if (!method.startsWith("prune_")) return run();
        const before = (await rpc.viewAccount(m.contract)).storage_usage;
        let ok = false;
        try {
          const r = await run();
          ok = true;
          return r;
        } finally {
          prunes.push({ contract: m.contract, method, args, ok, storage_before: before, storage_after: (await rpc.viewAccount(m.contract)).storage_usage });
        }
      });
    },
  };
  const store = new MemoryStore();
  let tickChainNow = 0;
  let tickWallStart = 0;
  const env = (deployments: Deployments, s: typeof secrets) => ({
    deployments,
    store,
    secrets: s,
    fetch: fetchFn as never,
    chain,
    wallNow: () => tickChainNow + (Date.now() - tickWallStart) / 1000,
    leaseConfirmMs: 200,
  });

  // Three ticks per five-minute round (20, 110 and 200 s in) from the fast series 0's auction
  // opening until after its settlement, redemption and the first prunes two periods on.
  const missingBucket = open + 6 * 300;
  const secondUntil = Number.MAX_SAFE_INTEGER;
  const targets: number[] = [];
  // Three periods: the last hour is the first in which pruning keeps pace (prints are prunable
  // two periods after their bucket, results once their series is settled).
  for (let slot = open; slot < open + 3 * params.period_secs; slot += 300) for (const off of [20, 110, 200]) targets.push(slot + off);
  const ticks: TickStat[] = [];
  const storageSeries: Record<string, [number, number][]> = {};
  const failures: SwarmResult["failures"] = [];
  const reports: TickReport[] = [];
  const verbose = Boolean(process.env.WEIR_E2E_VERBOSE);
  for (const target of targets) {
    const warpStart = Date.now();
    const now = await w.sandbox.warpTo(target);
    const warpMs = Date.now() - warpStart;
    counters.rpc = 0;
    counters.source = 0;
    twinMs = 0;
    tickChainNow = now;
    tickWallStart = Date.now();
    const deployments = second2 && now < secondUntil ? both : fastOnly;
    const s = now >= missingBucket && now < missingBucket + 300 ? secretsMissing : secrets;
    const report = await runTick(env(deployments, s) as never, now);
    for (const c of contracts) (storageSeries[c] ??= []).push([now, (await rpc.viewAccount(c)).storage_usage]);
    const wallMs = Date.now() - tickWallStart;
    reports.push(report);
    const byMarket: Record<string, number> = {};
    for (const r of report.requests) {
      const m = (r as { market?: string }).market ?? "index";
      byMarket[m] = (byMarket[m] ?? 0) + 1;
    }
    ticks.push({
      now, wall_ms: wallMs, twin_ms: twinMs, requests: report.budget.used, requests_by_market: byMarket, rpc_calls: counters.rpc, source_calls: counters.source,
      by_step: report.budget.by_step, acting: report.acting, txs: report.txs.length, failed_txs: report.txs.filter((t) => !t.ok).length, undone: report.undone,
    });
    if (verbose) console.log(`   tick ${now - open}: ${wallMs} ms (twin ${twinMs}, warp ${warpMs}), ${report.budget.used} req ${JSON.stringify(byMarket)}, acting ${report.acting}, txs ${JSON.stringify(report.txs.map((t) => `${t.market}:${t.method}${t.ok ? "" : "!"}`))}`);
    for (const e of report.entries) if (e.status === "failed") failures.push({ at: now, market: e.market ?? "", text: `${e.step}/${e.action}${e.agent ? ` ${e.agent}` : ""}: ${e.text}` });
  }
  console.log(`   ${ticks.length} ticks, ${ticks.reduce((s, t) => s + t.txs, 0)} transactions, ${failures.length} failed entries`);

  // The fast market after one whole series.
  const prints = await view.get_prints({ from_bucket: open, limit: 200 });
  const buckets: number[] = [];
  for (let b = open; b < deliveryEnd(fast.tp, 0); b += params.print_interval_secs) buckets.push(b);
  const finalBuckets = new Set(prints.map((p) => p.bucket));
  const pruned = new Set(prunes.filter((p) => p.contract === weir && p.ok && p.method === "prune_print").map((p) => (p.args as { bucket: number }).bucket));
  w.eq("a final print in every bucket from the auction's opening to delivery end (or pruned after being final)", buckets.filter((b) => !finalBuckets.has(b) && !pruned.has(b)), []);
  const accumulator = await view.get_accumulator({ series: 0 });
  w.eq("all 12 delivery buckets counted", accumulator.count, 12);
  const missing = await view.get_print({ bucket: missingBucket });
  const finalizeTxs = reports.flatMap((r) => r.txs.filter((t) => t.method === "finalize_print" && t.market === FAST));
  w.check("the bucket with a missing reporter was decided by finalize_print, from two reports", (missing === null && pruned.has(missingBucket)) || (missing?.state === "Final" && missing.reports.length === 2), missing);
  w.check("the housekeeping account sent finalize_print", finalizeTxs.length >= 1 && finalizeTxs.every((t) => t.ok && t.signer === housekeeper.accountId), finalizeTxs);
  const rounds = roundCount(fast.tp, 0);
  const allResults = await view.get_results({ series: 0, from_round: 0, limit: 100 });
  const series = await view.get_series({ series: 0 });
  w.eq("no round of series 0 is left uncleared", series?.pending_rounds, []);
  const clears = fast.twin.log.calls.filter((c) => c.scenario === "swarm" && c.method === "clear" && c.chain.ok && (c.args as { series: number }).series === 0);
  w.eq("every round of series 0 that had commits was cleared", clears.length, rounds);
  const forfeits = clears.reduce((s, c) => s + BigInt(JSON.parse(c.chain.events.find((e) => e.includes('"event":"clear"'))!.slice(11)).data.forfeited), 0n);
  w.eq("zero forfeits", forfeits, 0n);
  w.check("series 0 settled normally", series?.settlement?.void === false, series?.settlement);
  const positions = await Promise.all(fastAgents.map((a) => view.get_position({ series: 0, account_id: a.account_id })));
  w.eq("every agent's position in series 0 was redeemed", positions.filter((p) => p.long + p.short > 0).length, 0);
  await w.booksBalance("swarm", weir);
  const totals = await view.get_totals({});
  w.eq("the swarm's deposits are all accounted for", [totals.free, totals.locked, totals.sets_backing, totals.unredeemed, totals.burned].reduce((s, x) => s + BigInt(x), 0n), totalDeposit);
  const agentCommits = fast.twin.log.calls.filter((c) => c.scenario === "swarm" && c.method === "commit" && c.chain.ok).length;
  const settledRounds = fast.twin.log.calls.filter((c) => c.scenario === "swarm" && c.method === "clear" && c.chain.ok).reduce((s, c) => s + BigInt(JSON.parse(c.chain.events.find((e) => e.includes('"event":"clear"'))!.slice(11)).data.fees), 0n);
  w.eq("the agents' fees (cleared rounds) equal the market's burned", BigInt(totals.burned), settledRounds);
  w.eq("burned plus fees still held in open rounds equal the fee of every agent commit", BigInt(totals.burned) + (await heldFees()), BigInt(agentCommits) * BigInt(params.commit_fee));
  const fastPrunes = prunes.filter((p) => p.contract === weir);
  const printPrunes = fastPrunes.filter((p) => p.method === "prune_print");
  const resultPrunes = fastPrunes.filter((p) => p.method === "prune_result");
  w.check("the keeper pruned results of the settled series", resultPrunes.length >= 1, resultPrunes.length);
  w.check("the keeper pruned prints two periods on", printPrunes.length >= 1, printPrunes.length);
  w.check("every prune released contract storage", fastPrunes.length > 0 && fastPrunes.every((p) => p.ok && p.storage_after < p.storage_before), fastPrunes.map((p) => p.storage_before - p.storage_after));
  const costs = reports.at(-1)?.markets[FAST]?.costs as { fees: string; forfeits: string; rounds: number } | null | undefined;
  w.eq("the keeper's cost report: its agents' fees and forfeits equal the market's burned", costs && BigInt(costs.fees) + BigInt(costs.forfeits), BigInt(totals.burned));
  w.eq("the keeper made no request outside the sandbox and the fixtures", counters.other, []);
  w.eq("no tick went over the request budget", ticks.filter((t) => t.requests > 40), []);
  const fastFailures = failures.filter((f) => f.market === FAST || f.market === "");
  w.check("no keeper entry failed on the fast market", fastFailures.length === 0, fastFailures.slice(0, 20));
  await fast.twin.checkpoint("swarm end", { tp: fast.tp, series: [0, 1], accounts: fastAgents.map((a) => a.account_id), buckets: [missingBucket] });

  // Storage: the fast contract's, sampled after every tick. Results are pruned once a series is
  // settled and prints two periods after their bucket.
  const fastStorage = storageSeries[weir]!;
  const at = (t: number) => fastStorage.find(([n]) => n >= t)?.[1] ?? fastStorage.at(-1)![1];
  const lastHour = fastStorage.at(-1)![1] - at(fastStorage.at(-1)![0] - params.period_secs);
  const firstHour = at(open + params.period_secs) - fastStorage[0]![1];
  storageGrowth = { first_hour: firstHour, last_hour: lastHour, start: fastStorage[0]![1], end: fastStorage.at(-1)![1] };
  w.check("fast: with pruning keeping pace, storage grows by less than 1% over the last hour", lastHour < fastStorage.at(-1)![1] / 100, storageGrowth);

  // The second market, for the whole run.
  let secondSummary: Record<string, unknown> | null = null;
  if (second2) {
    const v2 = new ChainWeir({ rpc, contractId: second2.id });
    const secondFailures = failures.filter((f) => f.market === SECOND && !(misfit && f.text.includes(misfit)));
    const shared = ticks.filter((t) => (t.requests_by_market[SECOND] ?? 0) > 0 && (t.requests_by_market[FAST] ?? 0) > 0).length;
    w.check("both markets spent from one tick's budget", shared > 0, shared);
    const p2 = await v2.get_prints({ from_bucket: 0, limit: 200 });
    w.check("the second market got final prints of its own chip", p2.length >= 2, p2.map((x) => [x.bucket, x.price]));
    const commits2 = second2.twin.log.calls.filter((c) => c.scenario === "swarm-h200" && c.method === "commit" && c.chain.ok);
    w.check("the second market's agents committed", commits2.length > 0, commits2.length);
    const clears2 = reports.flatMap((r) => r.txs.filter((t) => t.market === SECOND && t.method === "clear"));
    w.check("the second market's rounds were cleared, every time by the housekeeping account's own key", clears2.length >= 1 && clears2.every((t) => t.ok && t.signer === housekeeper.accountId), clears2);
    const status2 = await v2.get_status({});
    const s2 = await v2.get_series({ series: 0 });
    const current = status2.live.find((l) => l.series === 0)?.round ?? Infinity;
    w.eq("no round of the second market that is over waits to be cleared", (s2?.pending_rounds ?? []).filter((r) => r < current), []);
    w.check("no keeper entry failed on the second market, besides the misconfigured agent", secondFailures.length === 0, secondFailures.slice(0, 5));
    const totals2 = await v2.get_totals({});
    const costs2 = reports.at(-1)?.markets[SECOND]?.costs as { fees: string; forfeits: string } | null | undefined;
    w.eq("second market: the keeper's cost report equals burned", costs2 && BigInt(costs2.fees) + BigInt(costs2.forfeits), BigInt(totals2.burned));
    w.check("second market: something was burned", BigInt(totals2.burned) > 0n, totals2);
    await w.booksBalance("swarm, second market", second2.id);
    // The misconfigured agent: what it sent and what the keeper said.
    // The node refuses such a transaction before it exists, so it is not in `txs`; the keeper's
    // fault entry is the record of each attempt, and the misfit's access key never moves.
    const misLogs = reports.flatMap((r) => r.entries.filter((e) => e.text.includes(misfit!) && /refused its key/.test(e.text)).map((e) => ({ at: r.now, text: e.text })));
    const misKeys = await rpc.call<{ keys: { access_key: { nonce: number } }[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: misfit! });
    const spanHours = (ticks.at(-1)!.now - ticks[0]!.now) / 3600;
    w.check("the wrong-receiver key was refused with ReceiverMismatch, and the fault says what to fix", misLogs.length >= 1 && misLogs.every((l) => /ReceiverMismatch/.test(l.text) && /Fix: /.test(l.text)), misLogs[0]);
    const gaps = misLogs.slice(1).map((l, i) => l.at - misLogs[i]!.at);
    w.check("one attempt and one logged fault, then nothing until the hour it is set aside has passed", gaps.every((g) => g >= 3600) && misLogs.length <= Math.ceil(spanHours), { attempts: misLogs.map((l) => l.at - open), gaps });
    w.check("the misconfigured agent never got a transaction through", [...Object.values(twins)].every((t) => t.log.calls.every((c) => c.account !== misfit)), misKeys.keys.map((k) => k.access_key.nonce));
    secondSummary = { prints: p2.length, commits: commits2.length, clears: clears2.length, shared_ticks: shared, totals: totals2, costs: costs2, misfit: { attempts: misLogs.map((l) => l.at - open), logs: misLogs.slice(0, 1) }, storage: storageSeries[second2.id]!.filter((_, i) => i % 12 === 0) };
  }

  const allowance: Record<string, string> = {};
  for (const id of [...fastAgents.map((a) => a.account_id), housekeeper.accountId]) {
    const keys = await rpc.call<{ keys: { access_key: { permission: { FunctionCall?: { allowance: string | null } } } }[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: id });
    allowance[id] = (NEAR - BigInt(keys.keys[0]?.access_key.permission.FunctionCall?.allowance ?? "0")).toString();
  }
  return {
    contracts: { [FAST]: weir, ...(second2 ? { [SECOND]: second2.id } : {}) },
    ticks,
    failures,
    prunes,
    allowance_used: allowance,
    summary: {
      rounds_cleared: allResults.length,
      volume: allResults.reduce((s, [, r]) => s + r.volume, 0),
      settlement: series?.settlement,
      buckets: buckets.length,
      missing_reporter_bucket: missingBucket - open,
      totals,
      agent_commits: agentCommits,
      store_writes: store.writes,
      txs_by_method: countBy(reports.flatMap((r) => r.txs.map((t) => `${t.market}:${t.method}`))),
      second: secondSummary,
      fast_storage: storageSeries[weir]!.filter((_, i) => i % 6 === 0),
      storage_growth: storageGrowth,
    },
  };

  async function heldFees(): Promise<bigint> {
    let held = 0n;
    for (const s of [0, 1, 2]) {
      const rec = await view.get_series({ series: s });
      for (const r of rec?.pending_rounds ?? []) for (const c of (await view.get_round({ series: s, round: r }))?.commits ?? []) held += BigInt(c.fee);
    }
    return held;
  }
}

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

type Around = (method: string, args: unknown, run: () => Promise<unknown>) => Promise<unknown>;

/** The keeper's port, with every state change also made on the model at the chain's time. */
function mirrored(port: WeirPort, twin: Twin, box: { last: TxOutcome | null }, spent: (ms: number) => void, around: Around): WeirPort {
  const change = async (method: string, args: unknown): Promise<unknown> => {
    box.last = null;
    let result: unknown;
    let error: unknown = null;
    try {
      result = await around(method, args, () => port.change(method as never, args as never));
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
