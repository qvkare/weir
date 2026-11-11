// `runTick(env, now)`: one minute of keeping. Platform-neutral; the Worker and the Node loop
// are thin adapters over it.
//
// Every decision is read from chain state (or from the store, for the swarm's sealed orders),
// so running twice or missing minutes is safe. Work is done in steps, each across every
// market, in the order the request budget is spent:
//
//   plan           get_status per market (and get_params once per contract, then cached)
//   urgent-reveal  reveals whose phase ends before the next tick
//   report         the index fetch, when due, and each reporter's report for the bucket
//   reveal-clear   the other reveals, and clearing rounds that are over
//   commit         new sealed orders
//   settle-redeem  settling series and redeeming the agents' positions
//
// A failure in one market or for one agent is logged and the rest carries on. When the
// budget runs out every remaining step is skipped and named in `undone`.
import { newestSeries, tick, timeParams, type LogEntry, type Strategy } from "@weir/agents";
import type { PortChange, WeirPort } from "@weir/chain";
import { deliveryEnd, type TimeParams, type WireParams, type WireStatus } from "@weir/engine";
import { SOURCES, type Source } from "@weir/index";
import { Budget, BUDGET_MARK, BudgetExhausted, PRIORITY_ORDER, type Priority, type SpentRequest } from "./budget.ts";
import { redactor, strategyOf, type AgentSpec, type Deployments, type MarketDeployment, type MarketId, type Secrets, type Signer } from "./config.ts";
import { indexDue, refreshIndex, type IndexAttempt, type LatestBundle } from "./indexer.ts";
import { DEFERRED, Meter, nearChain, type Chain, type Fetch, type TxRecord } from "./ports.ts";
import { KEYS, orderStore, readJson, renewLease, takeLease, type KeeperStore } from "./store.ts";

export const DEFAULT_BUDGET = 40;
export const LOG_SIZE = 200;
export const OPERATOR_NOTE =
  "Every reporter listed here is run by this one keeper, from the same fetch of the same sources. " +
  "The quorum therefore guards against a failed transaction, not against a wrong price.";

export interface KeeperEnv {
  deployments: Deployments;
  store: KeeperStore;
  secrets: Secrets;
  /** Outbound HTTP for the index sources and, with the default chain, the RPC nodes. */
  fetch: Fetch;
  /** Default: `nearChain(deployments.rpc)`. */
  chain?: Chain;
  /** Outbound requests per tick. Default 40 (Cloudflare's free plan allows 50 subrequests). */
  budget?: number;
  sources?: readonly Source[];
  /** Wall clock in seconds, for the lease. Default `Date.now() / 1000`. */
  wallNow?: () => number;
  /** Set false to run without the lease (tests of what the contract alone prevents). */
  lease?: boolean;
  leaseSecs?: number;
  leaseConfirmMs?: number;
  /** A reveal phase ending within this many seconds is urgent. Default 90. */
  urgentSecs?: number;
  /** Names this run in the lease and the log. */
  runId?: string;
}

export type Step = "keeper" | "index" | "report" | "swarm" | "housekeeping";

export interface KeeperEntry {
  at: number;
  market?: MarketId;
  step: Step;
  action: string;
  status: "done" | "skipped" | "failed";
  agent?: string;
  series?: number;
  round?: number;
  text: string;
  tx?: string | null;
  data?: unknown;
}

export interface MarketSummary {
  contract: string;
  label: string;
  chain_now: number | null;
  live: WireStatus["live"];
  bucket: number | null;
  reported: string[];
  print_final: boolean | null;
  settled_through: number;
  redeemed_through: number;
  errors: number;
}

export interface TickReport {
  now: number;
  run: string;
  /** False when another run held the lease and this one did nothing. */
  ran: boolean;
  budget: { limit: number; used: number; by_step: Partial<Record<Priority, number>> };
  /** Every outbound request, in the order made, with the step it was spent on. */
  requests: SpentRequest[];
  entries: KeeperEntry[];
  txs: (TxRecord & { market: MarketId })[];
  /** What was left for a later tick, in words. */
  undone: string[];
  markets: Partial<Record<MarketId, MarketSummary>>;
}

/** What the keeper has finished per contract. */
interface Marks {
  /** Every series up to this one is settled (or was never opened). */
  settled_through: number;
  /** Every series up to this one is settled and every agent's position in it redeemed. */
  redeemed_through: number;
  /** Agents already redeemed (or holding nothing) per series above `redeemed_through`. */
  redeemed: Record<string, string[]>;
  /** The last bucket whose print this keeper saw final: no need to read it again. */
  final_bucket?: number;
}

interface MarketRun {
  dep: MarketDeployment;
  meter: Meter;
  /** Views, and `clear`/`settle` (signed by the first agent when there is one). */
  keeper: WeirPort;
  signs: boolean;
  reporters: { signer: Signer; port: WeirPort }[];
  agents: { spec: AgentSpec; strategy: Strategy; port: WeirPort }[];
  params: WireParams;
  tp: TimeParams;
  status: WireStatus | null;
  newest: number | null;
  marks: Marks;
  marksChanged: boolean;
  summary: MarketSummary;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runTick(env: KeeperEnv, now: number): Promise<TickReport> {
  const budget = new Budget(env.budget ?? DEFAULT_BUDGET);
  const run = env.runId ?? `run-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const redact = redactor(env.secrets);
  const report: TickReport = { now, run, ran: true, budget: { limit: budget.limit, used: 0, by_step: {} }, requests: budget.spent, entries: [], txs: [], undone: [], markets: {} };
  const add = (e: Omit<KeeperEntry, "at">) => report.entries.push({ at: now, ...e });
  const fetchM = budget.meter(env.fetch);
  const chain = env.chain ?? nearChain(env.deployments.rpc);
  const wall = env.wallNow ?? (() => Date.now() / 1000);

  const leaseSecs = env.leaseSecs ?? 55;
  let leaseAt = wall();
  if (env.lease !== false) {
    try {
      const held = await takeLease(env.store, run, leaseAt, leaseSecs, env.leaseConfirmMs ?? 1000);
      if (held) {
        report.ran = false;
        add({ step: "keeper", action: "lease", status: "skipped", text: `another run (${held.owner}) holds the lease until ${Math.floor(held.until)}; this run does nothing` });
        return redact(report);
      }
    } catch (e) {
      add({ step: "keeper", action: "lease", status: "failed", text: `could not take the lease: ${errorText(e)}; running anyway` });
    }
  }

  for (const p of env.secrets.problems) add({ step: "keeper", action: "config", status: "skipped", text: p });

  const runs: MarketRun[] = [];
  const out = { add, report, budget, env, now, undone: (u: string) => report.undone.push(u) };

  try {
    // plan
    budget.priority = "plan";
    for (const dep of env.deployments.markets) {
      try {
        const mr = await openMarket(out, chain, fetchM, dep);
        if (mr) runs.push(mr);
      } catch (e) {
        add({ step: "keeper", market: dep.id, action: "plan", status: e instanceof BudgetExhausted ? "skipped" : "failed", text: `market not run this tick: ${errorText(e)}` });
        if (e instanceof BudgetExhausted) out.undone(`${dep.id}: everything (no budget left to read its status)`);
      }
    }

    const step = async (priority: Priority, name: string, fn: (mr: MarketRun) => Promise<unknown>, list = runs) => {
      // A long run keeps its lease, or stops if another run has taken it.
      if (env.lease !== false && wall() - leaseAt > leaseSecs - 20) {
        if (!(await renewLease(env.store, run, wall(), leaseSecs))) throw new Error(`another run took the lease; stopped before ${name}`);
        leaseAt = wall();
      }
      budget.priority = priority;
      for (const mr of list) {
        if (mr.status === null) continue;
        if (budget.left === 0) {
          out.undone(`${mr.dep.id}: ${name}`);
          add({ step: "keeper", market: mr.dep.id, action: "budget", status: "skipped", text: `${name} not started: ${BUDGET_MARK}` });
          continue;
        }
        try {
          await fn(mr);
        } catch (e) {
          if (e instanceof BudgetExhausted) {
            out.undone(`${mr.dep.id}: the rest of ${name}`);
            add({ step: "keeper", market: mr.dep.id, action: "budget", status: "skipped", text: `${name} stopped: ${errorText(e)}` });
          } else {
            mr.summary.errors++;
            add({ step: "keeper", market: mr.dep.id, action: name, status: "failed", text: errorText(e) });
          }
        } finally {
          mr.meter.allow = null;
        }
      }
    };

    await step("urgent-reveal", "urgent reveals", (mr) => urgentReveals(out, mr));

    budget.priority = "report";
    const latest = await indexStep(out);
    await step("report", "reports", (mr) => reports(out, mr, latest));

    await step("reveal-clear", "reveals and clears", async (mr) => {
      await swarmPass(out, mr, "reveal-clear", ["reveal", "clear"], { lookback: openLookback(mr), trade: false });
    });
    await step("commit", "commits", (mr) => commits(out, mr));
    await step("settle-redeem", "settle and redeem", (mr) => settleAndRedeem(out, mr));
  } catch (e) {
    add({ step: "keeper", action: "error", status: "failed", text: `tick stopped: ${errorText(e)}` });
  }

  for (const mr of runs) {
    report.markets[mr.dep.id] = mr.summary;
    for (const tx of mr.meter.txs) {
      report.txs.push({ ...tx, market: mr.dep.id });
      add({ step: "keeper", market: mr.dep.id, action: "tx", status: tx.ok ? "done" : "failed", agent: tx.signer, text: `${tx.method}${tx.ok ? "" : `: ${tx.error}`}`, tx: tx.tx_hash });
    }
    if (mr.marksChanged) {
      try {
        await env.store.put(KEYS.marks(mr.dep.contract), JSON.stringify(mr.marks));
      } catch (e) {
        add({ step: "keeper", market: mr.dep.id, action: "store", status: "failed", text: `could not save progress marks: ${errorText(e)}` });
      }
    }
  }
  report.budget.used = budget.used;
  for (const p of PRIORITY_ORDER) {
    const n = budget.spent.filter((s) => s.priority === p).length;
    if (n > 0) report.budget.by_step[p] = n;
  }
  const clean = redact(report);
  try {
    await saveStatus(env.store, clean);
  } catch (e) {
    clean.entries.push({ at: now, step: "keeper", action: "store", status: "failed", text: `could not save the log: ${errorText(e)}` });
  }
  return clean;
}

type Out = {
  add: (e: Omit<KeeperEntry, "at">) => void;
  report: TickReport;
  budget: Budget;
  env: KeeperEnv;
  now: number;
  undone: (u: string) => void;
};

const forMarket = (spec: AgentSpec, id: MarketId) => spec.markets === undefined || spec.markets.includes(id);

async function openMarket(out: Out, chain: Chain, fetchM: Fetch, dep: MarketDeployment): Promise<MarketRun | null> {
  const { env, budget } = out;
  const meter = new Meter(budget, chain.perCall);
  const hooks = { fetch: fetchM, onOutcome: meter.onOutcome };
  const connect = async (signer: Signer | null) => meter.wrap(await chain.connect(dep, signer, hooks));

  const cached = await readJson<WireParams>(env.store, KEYS.params(dep.contract));
  if (cached) meter.params = cached;
  const agents: MarketRun["agents"] = [];
  for (const spec of env.secrets.agents.filter((a) => forMarket(a, dep.id))) {
    try {
      agents.push({ spec, strategy: strategyOf(spec), port: await connect(spec) });
    } catch (e) {
      out.add({ step: "swarm", market: dep.id, agent: spec.account_id, action: "config", status: "failed", text: `agent not run: ${errorText(e)}` });
    }
  }
  const keeper = agents[0]?.port ?? (await connect(null));
  const status = await keeper.get_status({});
  const params = await keeper.get_params({});
  if (!cached) await env.store.put(KEYS.params(dep.contract), JSON.stringify(params));

  const reporters: MarketRun["reporters"] = [];
  for (const signer of env.secrets.reporters) {
    if (!params.reporters.includes(signer.account_id)) continue;
    try {
      reporters.push({ signer, port: await connect(signer) });
    } catch (e) {
      out.add({ step: "report", market: dep.id, agent: signer.account_id, action: "config", status: "failed", text: `reporter not run: ${errorText(e)}` });
    }
  }
  const tp = timeParams(params);
  const marks = (await readJson<Marks>(env.store, KEYS.marks(dep.contract))) ?? { settled_through: -1, redeemed_through: -1, redeemed: {} };
  const mr: MarketRun = {
    dep, meter, keeper, signs: agents.length > 0, reporters, agents, params, tp, status,
    newest: newestSeries(tp, status.now), marks, marksChanged: false,
    summary: {
      contract: dep.contract, label: dep.label, chain_now: status.now, live: status.live, bucket: null, reported: [],
      print_final: null, settled_through: marks.settled_through, redeemed_through: marks.redeemed_through, errors: 0,
    },
  };
  // Before anything else: the swarm's passes skip series at or below the mark, so a series
  // settled since the last tick must not be looked at again by every pass.
  await advanceSettled(mr, new Set());
  return mr;
}

/** Moves the settled mark over series that are settled (known from `settled`, else read)
 * or can no longer open. Reads a series only once its delivery and report window are over. */
async function advanceSettled(mr: MarketRun, settled: ReadonlySet<number>): Promise<void> {
  if (mr.newest === null || mr.status === null) return;
  for (let s = mr.marks.settled_through + 1; s <= mr.newest; s++) {
    if (!settled.has(s)) {
      if (mr.status.now < deliveryEnd(mr.tp, s) + mr.params.report_grace_secs) break;
      const rec = await mr.keeper.get_series({ series: s });
      if (rec !== null && rec.settlement === null) break;
    }
    mr.marks.settled_through = s;
    mr.marksChanged = true;
  }
  mr.summary.settled_through = mr.marks.settled_through;
}

/** Series above the settled mark, as the swarm's `lookback` from the newest. */
const openLookback = (mr: MarketRun): number => Math.max(0, (mr.newest ?? 0) - (mr.marks.settled_through + 1));

/** One pass of the agents package's `tick`, allowed only the state changes in `allow`. */
async function swarmPass(
  out: Out,
  mr: MarketRun,
  priority: Priority,
  allow: PortChange[],
  opts: { lookback: number; trade: boolean; housekeeping?: boolean },
): Promise<LogEntry[]> {
  if (mr.newest === null) return [];
  const secret = out.env.secrets.swarmSecret;
  if (!opts.housekeeping && (secret === null || mr.agents.length === 0)) return [];
  mr.meter.allow = new Set(allow);
  const agents = opts.housekeeping ? [] : mr.agents;
  const log = await tick({
    market: mr.dep.contract,
    store: orderStore(out.env.store),
    agents: agents.map((a) => a.strategy),
    ports: Object.fromEntries(agents.map((a) => [a.spec.account_id, a.port])),
    secret: secret ?? "",
    keeper: mr.keeper,
    budget: Number.MAX_SAFE_INTEGER,
    trade: opts.trade,
    lookback: opts.lookback,
  });
  mr.meter.allow = null;
  absorb(out, mr, log.entries, opts.housekeeping ? "housekeeping" : "swarm", priority);
  return log.entries;
}

const ALREADY = /commit is already revealed|round is already cleared|series is already settled/;

/** Moves the swarm's log into the keeper's: deferred calls vanish (a later step makes them),
 * and calls the budget refused become "left for the next tick". */
function absorb(out: Out, mr: MarketRun, entries: LogEntry[], step: Step, priority: Priority): void {
  const deferredClears = new Set(entries.filter((e) => e.action === "clear" && e.text.includes(DEFERRED)).map((e) => `${e.series}/${e.round}`));
  for (const e of entries) {
    if (e.text.includes(DEFERRED)) continue;
    if (e.action === "forfeit" && deferredClears.has(`${e.series}/${e.round}`)) continue;
    const base = { market: mr.dep.id, step, ...(e.agent ? { agent: e.agent } : {}), ...(e.series !== undefined ? { series: e.series } : {}), ...(e.round !== undefined ? { round: e.round } : {}) };
    if (e.text.includes(BUDGET_MARK)) {
      const what = e.action === "error" ? `${priority}: the rest of the pass` : `${e.text.replace(/ failed: .*$/, "").replace(/: .*$/, "")}`;
      out.undone(`${mr.dep.id}: ${what}${e.agent ? ` (${e.agent})` : ""}${e.series !== undefined ? ` series ${e.series}` : ""}${e.round !== undefined ? ` round ${e.round}` : ""}`);
      out.add({ ...base, action: e.action === "error" ? "budget" : e.action, status: "skipped", text: e.action === "error" ? `stopped: ${BUDGET_MARK}` : `${e.text.replace(/ failed: .*$/, "")}: left for the next tick (${BUDGET_MARK})` });
      continue;
    }
    // Someone else (another run, or anyone: clear and settle are open) got there first.
    if (e.status === "failed" && ALREADY.test(e.text)) {
      out.add({ ...base, action: e.action, status: "skipped", text: `${e.text} (done by another caller first)` });
      continue;
    }
    if (e.status === "failed" || e.action === "error") mr.summary.errors++;
    out.add({ ...base, action: e.action, status: e.status, text: e.text, ...(e.data !== undefined ? { data: e.data } : {}) });
  }
}

async function urgentReveals(out: Out, mr: MarketRun): Promise<unknown> {
  const urgent = (mr.status?.live ?? []).filter(
    (l) => l.phase === "Reveal" && l.phase_ends_at !== null && l.phase_ends_at - mr.status!.now <= (out.env.urgentSecs ?? 90),
  );
  if (urgent.length === 0 || mr.newest === null) return;
  const lookback = mr.newest - Math.min(...urgent.map((l) => l.series));
  await swarmPass(out, mr, "urgent-reveal", ["reveal"], { lookback, trade: false });
}

async function indexStep(out: Out): Promise<LatestBundle | null> {
  const { env, budget, now } = out;
  let latest = await readJson<LatestBundle>(env.store, KEYS.latest);
  try {
    if (!(await indexDue(env.store, now))) return latest;
    const sources = env.sources;
    const count = (sources ?? SOURCES).length;
    if (budget.left < count) {
      out.undone(`index: fetch of ${count} sources (${budget.left} requests left)`);
      out.add({ step: "index", action: "fetch", status: "skipped", text: `index fetch needs ${count} requests, ${budget.left} left: tried again next tick` });
      return latest;
    }
    const { attempt, latest: fresh } = await refreshIndex(env.store, budget.meter(env.fetch), now, ...(sources ? [sources] : []));
    const failed = attempt.sources.filter((s) => !s.ok).map((s) => `${s.id} (${s.error})`);
    const sourcesText = failed.length > 0 ? `; failed: ${failed.join(", ")}` : "";
    if (fresh) {
      latest = fresh;
      out.add({ step: "index", action: "fetch", status: "done", text: `index ${fresh.index} micro-USD, bundle ${fresh.hash}${sourcesText}`, data: { hash: fresh.hash, index: fresh.index } });
    } else {
      out.add({ step: "index", action: "fetch", status: "failed", text: `no index: ${attempt.reason}${sourcesText}; nothing stored, no price reported from this fetch` });
    }
  } catch (e) {
    out.add({ step: "index", action: "fetch", status: "failed", text: `index step failed: ${errorText(e)}` });
  }
  return latest;
}

async function reports(out: Out, mr: MarketRun, latest: LatestBundle | null): Promise<void> {
  const interval = mr.params.print_interval_secs;
  const bucket = Math.floor(out.now / interval) * interval;
  mr.summary.bucket = bucket;
  const base = { step: "report" as const, market: mr.dep.id };
  if (mr.reporters.length === 0) return;
  if (mr.marks.final_bucket === bucket) {
    mr.summary.print_final = true;
    return;
  }
  const final = () => {
    mr.summary.print_final = true;
    mr.marks.final_bucket = bucket;
    mr.marksChanged = true;
  };
  if (latest === null || latest.fetched_at < bucket || latest.fetched_at >= bucket + interval) {
    const attempt = await readJson<IndexAttempt>(out.env.store, KEYS.indexAttempt);
    const why = attempt && !attempt.ok && attempt.at >= bucket ? `the fetch at ${attempt.at} formed no index (${attempt.reason})` : latest ? `the latest bundle was fetched at ${latest.fetched_at}` : "there is no bundle yet";
    out.add({ ...base, action: "report", status: "skipped", text: `no report for bucket ${bucket}: no bundle fetched within it; ${why}` });
    return;
  }
  const print = await mr.keeper.get_print({ bucket });
  const done = new Set(print?.reports.map((r) => r.reporter) ?? []);
  mr.summary.reported = [...done];
  mr.summary.print_final = print?.final ?? false;
  if (print?.final) return final();
  for (const { signer, port } of mr.reporters) {
    if (done.has(signer.account_id)) continue;
    const at = { ...base, agent: signer.account_id, data: { bucket, price: latest.index, bundle: latest.hash } };
    try {
      const madeFinal = await port.report({ bucket, price: latest.index, bundle: latest.hash });
      mr.summary.reported.push(signer.account_id);
      out.add({ ...at, action: "report", status: "done", text: `reported ${latest.index} for bucket ${bucket}${madeFinal ? "; the print is final" : ""}` });
      if (madeFinal) return final();
    } catch (e) {
      if (e instanceof BudgetExhausted) throw e;
      const msg = errorText(e);
      if (/already reported/.test(msg)) out.add({ ...at, action: "report", status: "skipped", text: `another run reported for bucket ${bucket} first` });
      else {
        mr.summary.errors++;
        out.add({ ...at, action: "report", status: "failed", text: `report for bucket ${bucket} failed: ${msg}` });
      }
    }
  }
}

/** The fewest requests that can place one commit: the swarm's five shared reads (round,
 * last print, accumulator, prints, results), the agent's account and position, and the
 * transaction. With less left the pass could only read, so it is not started. */
export const MIN_COMMIT_REQUESTS = 9;

async function commits(out: Out, mr: MarketRun): Promise<unknown> {
  const open = (mr.status?.live ?? []).filter((l) => l.phase === "Commit");
  if (open.length === 0 || mr.newest === null || out.env.secrets.swarmSecret === null || mr.agents.length === 0) return;
  if (out.budget.left < MIN_COMMIT_REQUESTS) {
    out.undone(`${mr.dep.id}: commits`);
    out.add({ step: "swarm", market: mr.dep.id, action: "budget", status: "skipped", text: `commits not started: one needs ${MIN_COMMIT_REQUESTS} requests, ${out.budget.left} left` });
    return;
  }
  const lookback = mr.newest - Math.min(...open.map((l) => l.series));
  await swarmPass(out, mr, "commit", ["commit"], { lookback, trade: true });
}

async function settleAndRedeem(out: Out, mr: MarketRun): Promise<void> {
  if (mr.newest === null) return;
  const now = mr.status!.now;
  const first = mr.marks.settled_through + 1;
  const due = first <= mr.newest && now >= deliveryEnd(mr.tp, first) + mr.params.report_grace_secs;
  const settled = new Set<number>();
  if (due && mr.signs) {
    const log = await swarmPass(out, mr, "settle-redeem", ["settle"], { lookback: openLookback(mr), trade: false, housekeeping: true });
    for (const e of log) if (e.action === "settle" && e.status === "done" && e.series !== undefined) settled.add(e.series);
  } else if (due) {
    out.add({ step: "housekeeping", market: mr.dep.id, action: "settle", status: "skipped", text: "no agent account configured to sign settle" });
  }
  await advanceSettled(mr, settled);
  // Redeem every agent's position on settled series, remembering who is done.
  for (let s = mr.marks.redeemed_through + 1; s <= mr.marks.settled_through; s++) {
    const done = new Set(mr.marks.redeemed[s] ?? []);
    for (const a of mr.agents) {
      const id = a.spec.account_id;
      if (done.has(id)) continue;
      const pos = await mr.keeper.get_position({ series: s, account_id: id });
      if (pos.long + pos.short > 0) {
        try {
          await a.port.redeem({ series: s });
          out.add({ step: "housekeeping", market: mr.dep.id, agent: id, series: s, action: "redeem", status: "done", text: `redeemed ${pos.long} LONG and ${pos.short} SHORT` });
        } catch (e) {
          if (e instanceof BudgetExhausted) throw e;
          if (!/nothing to redeem/.test(errorText(e))) {
            mr.summary.errors++;
            out.add({ step: "housekeeping", market: mr.dep.id, agent: id, series: s, action: "redeem", status: "failed", text: `redeem failed: ${errorText(e)}` });
            continue;
          }
        }
      }
      done.add(id);
      mr.marks.redeemed[s] = [...done];
      mr.marksChanged = true;
    }
    if (mr.agents.some((a) => !done.has(a.spec.account_id))) break;
    mr.marks.redeemed_through = s;
    delete mr.marks.redeemed[s];
  }
  mr.summary.settled_through = mr.marks.settled_through;
  mr.summary.redeemed_through = mr.marks.redeemed_through;
}

export interface StoredStatus {
  last_tick: number;
  run: string;
  operator_note: string;
  budget: TickReport["budget"];
  undone: string[];
  markets: TickReport["markets"];
  log: KeeperEntry[];
}

async function saveStatus(store: KeeperStore, report: TickReport): Promise<void> {
  const prev = await readJson<StoredStatus>(store, KEYS.status);
  const log = [...(prev?.log ?? []), ...report.entries].slice(-LOG_SIZE);
  const status: StoredStatus = {
    last_tick: report.now,
    run: report.run,
    operator_note: OPERATOR_NOTE,
    budget: report.budget,
    undone: report.undone,
    markets: report.markets,
    log,
  };
  await store.put(KEYS.status, JSON.stringify(status));
}
