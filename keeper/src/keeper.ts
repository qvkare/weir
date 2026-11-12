// `runTick(env, now)`: one minute of keeping. Platform-neutral; the Worker and the Node loop
// are thin adapters over it.
//
// Every decision is read from chain state (or from the store, for the swarm's sealed orders),
// so running twice or missing minutes is safe. Work is done in steps, each across every
// market, in the order the request budget is spent:
//
//   plan           get_status per market (and get_params once per contract, then cached)
//   urgent-reveal  reveals whose phase ends before the next tick
//   report         the index fetch (every chip at once) when due, each reporter's report for
//                  the bucket from its market's chip, finalize_print for buckets left open
//   reveal-clear   the other reveals, and clearing rounds that are over
//   commit         new sealed orders
//   settle-redeem  settling series and redeeming the agents' positions
//   prune          prune_print and prune_result, a few per market, and the burned total
//
// Fairness. Urgent reveals, the index, reports and finalize run for every market every tick.
// The rest (other reveals and clears, commits, settle and redeem, pruning) runs for a market on
// its turn: every `cadence` minutes, the largest whole number of minutes that still gives the
// market at least 6 turns in a commit phase and 3 in a reveal phase (1 for the fast preset,
// 5 for the weekly one), with markets of the same cadence on different minutes. Within every
// step the markets taking part take turns being first: the order rotates by one each tick.
// So a market with work is first in line at least once every k of its turns, k being the
// number of markets acting in the same minute (at most 2 with the four markets of `MARKETS`):
// every 2 minutes for the fast market, every 10 for a weekly one.
//
// A failure in one market or for one agent is logged and the rest carries on. When the
// budget runs out every remaining step is skipped and named in `undone`.
import { newestSeries, tick, timeParams, type LogEntry, type Strategy } from "@weir/agents";
import type { PortChange, WeirPort } from "@weir/chain";
import { deliveryEnd, ERR, type TimeParams, type WireParams, type WireStatus } from "@weir/engine";
import { CHIP_IDS, type ChipId } from "@weir/index";
import { Budget, BUDGET_MARK, BudgetExhausted, PRIORITY_ORDER, type Priority, type SpentRequest } from "./budget.ts";
import { keyFor, redactor, strategyOf, type AgentSpec, type Deployments, type MarketDeployment, type MarketId, type Secrets, type Signer } from "./config.ts";
import { KeyGuard, KeyUnusable, NO_KEY_MARK, type KeyFault, type Role } from "./keys.ts";
import { indexDue, readLatest, refreshIndex, requestsFor, type IndexAttempt, type LatestBundle } from "./indexer.ts";
import { DEFERRED, Meter, nearChain, type Chain, type Fetch, type RpcCooling, type TxRecord } from "./ports.ts";
import { KEYS, orderStore, readJson, renewLease, takeLease, type KeeperStore } from "./store.ts";

export const DEFAULT_BUDGET = 40;
export const LOG_SIZE = 200;
/** State-changing prune calls per market per tick, at the lowest priority. */
export const PRUNE_PER_TICK = 3;
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
  /** Chips fetched each window. Default: the chips of the deployed markets, or every chip of
   * the index package when there is no market yet. */
  chips?: readonly ChipId[];
  /** Wall clock in seconds, for the lease. Default `Date.now() / 1000`. */
  wallNow?: () => number;
  /** Set false to run without the lease (tests of what the contract alone prevents). */
  lease?: boolean;
  leaseSecs?: number;
  leaseConfirmMs?: number;
  /** A reveal phase ending within this many seconds is urgent. Default 90. */
  urgentSecs?: number;
  /** Set false to serve markets in a fixed order and every market every tick (the unfair
   * baseline the fairness test compares with). */
  rotate?: boolean;
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

/** What running the swarm has cost on one market, read from the chain. */
export interface Costs {
  /** First tick that counted. */
  since: number;
  /** Commit fees of this keeper's agents in rounds this keeper cleared, micro-USDC. */
  fees: string;
  /** Forfeits of this keeper's agents in rounds this keeper cleared. */
  forfeits: string;
  rounds: number;
  by_agent: Record<string, { fees: string; forfeits: string }>;
  /** `get_totals().burned` at `since` and when last read: everything the market burned, anyone's. */
  burned_at_start: string | null;
  burned: string | null;
}

export interface MarketSummary {
  contract: string;
  label: string;
  chip: ChipId;
  chain_now: number | null;
  live: WireStatus["live"];
  bucket: number | null;
  reported: string[];
  print: "Open" | "Final" | "NoPrint" | null;
  pending_buckets: number[];
  settled_through: number;
  redeemed_through: number;
  pruning: string;
  costs: Costs | null;
  errors: number;
}

export interface TickReport {
  now: number;
  run: string;
  /** False when another run held the lease and this one did nothing. */
  ran: boolean;
  /** The order markets were served in this tick (all of them in the plan, urgent and report steps). */
  order: MarketId[];
  /** The markets whose turn it was for the other steps, in the order served. */
  acting: MarketId[];
  budget: { limit: number; used: number; by_step: Partial<Record<Priority, number>> };
  /** Every outbound request, in the order made, with its step and market. */
  requests: SpentRequest[];
  entries: KeeperEntry[];
  txs: (TxRecord & { market: MarketId })[];
  /** What was left for a later tick, in words, each starting with the market id (or "index"). */
  undone: string[];
  markets: Partial<Record<MarketId, MarketSummary>>;
  /** Keys the node refused, set aside (not retried) until `until`, each with what to fix. */
  key_faults: KeyFault[];
  /** Configuration problems that held this tick: unreadable secrets, keys that do not parse,
   * signers without a key for a market. Shown in /status for as long as they hold. */
  config: ConfigProblem[];
  /** RPC endpoints passed over after a refusal or a fault, when the tick ended. */
  rpc_cooling: RpcCooling[];
}

/** One configuration problem, in words that never contain a secret. */
export interface ConfigProblem {
  /** Absent for a problem with the secrets as a whole. */
  market?: MarketId;
  text: string;
}

/** What the keeper has finished per contract. */
interface Marks {
  /** Every series up to this one is settled (or was never opened). */
  settled_through: number;
  /** Every series up to this one is settled and every agent's position in it redeemed. */
  redeemed_through: number;
  /** Agents already redeemed (or holding nothing) per series above `redeemed_through`. */
  redeemed: Record<string, string[]>;
  /** The last bucket seen decided: no need to read it again. */
  final_bucket?: number;
  /** Buckets left undecided after this keeper's reports: finalize once their window closes. */
  pending?: number[];
  /** The bucket in which `get_pending_prints` was last read (a sweep for anyone's buckets). */
  swept_bucket?: number;
  /** Buckets with stored reports, to prune two periods after the bucket. */
  prunable?: number[];
  /** Next result to look at for `prune_result`. */
  results_from?: { series: number; round: number };
}

interface MarketRun {
  dep: MarketDeployment;
  meter: Meter;
  /** Views; and `clear`/`settle`, sent by the first signer with a usable key for this
   * market: the housekeeping account, then each agent of the market. */
  keeper: WeirPort;
  signs: boolean;
  /** Signs `finalize_print`: the housekeeping account, then each reporter. */
  finalizer: WeirPort | null;
  /** Signs the prunes: the housekeeping account only (agent and reporter keys do not allow them). */
  pruner: WeirPort | null;
  reporters: { signer: Signer; port: WeirPort }[];
  agents: { spec: AgentSpec; strategy: Strategy; port: WeirPort }[];
  params: WireParams;
  tp: TimeParams;
  status: WireStatus | null;
  newest: number | null;
  marks: Marks;
  marksChanged: boolean;
  costs: Costs;
  costsChanged: boolean;
  clearedNow: number;
  summary: MarketSummary;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The contract's refusal text, exactly (SPEC section 16). */
const refused = (e: unknown, ...texts: string[]): boolean => texts.includes(errorText(e));
const usd = (micro: bigint): string => `$${(Number(micro) / 1e6).toFixed(2)}`;

export async function runTick(env: KeeperEnv, now: number): Promise<TickReport> {
  const budget = new Budget(env.budget ?? DEFAULT_BUDGET);
  const run = env.runId ?? `run-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const redact = redactor(env.secrets);
  const report: TickReport = {
    now, run, ran: true, order: [], acting: [], budget: { limit: budget.limit, used: 0, by_step: {} }, requests: budget.spent, entries: [], txs: [], undone: [], markets: {}, key_faults: [], config: [], rpc_cooling: [],
  };
  const configProblem = (text: string, market?: MarketId) => {
    if (!report.config.some((c) => c.text === text && c.market === market)) report.config.push({ ...(market ? { market } : {}), text });
  };
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

  for (const p of env.secrets.problems) {
    add({ step: "keeper", action: "config", status: "skipped", text: p });
    configProblem(p);
  }
  // Endpoints still cooling down from a refusal in an earlier tick (same process or isolate):
  // calls pass them over, or fail at once without a request when every one refused for rate.
  const coolingAtStart = chain.cooling?.() ?? [];
  if (coolingAtStart.length > 0) {
    const list = coolingAtStart.map((c) => `${c.endpoint} until ${c.until} (${c.rate ? "rate limit" : "fault"})`).join(", ");
    add({ step: "keeper", action: "rpc", status: "skipped", text: `RPC endpoints passed over after earlier refusals: ${list}` });
  }

  const minute = Math.floor(now / 60);
  const rotate = <T>(xs: T[]): T[] => {
    const k = env.rotate === false || xs.length === 0 ? 0 : minute % xs.length;
    return [...xs.slice(k), ...xs.slice(0, k)];
  };
  const ordered = rotate([...env.deployments.markets]);
  report.order = ordered.map((d) => d.id);

  const runs: MarketRun[] = [];
  let stored: Record<string, KeyFault> | null = null;
  try {
    stored = await readJson<Record<string, KeyFault>>(env.store, KEYS.keyFaults);
  } catch {
    stored = null;
  }
  const keys = new KeyGuard(stored, now, (text, market, account) =>
    add({ step: "keeper", ...(market ? { market: market as MarketId } : {}), ...(account ? { agent: account } : {}), action: "key", status: "skipped", text }),
  );
  const out: Out = { keys, add, report, budget, env, now, undone: (u: string) => report.undone.push(u), configProblem };

  try {
    budget.priority = "plan";
    for (const dep of ordered) {
      budget.market = dep.id;
      try {
        runs.push(await openMarket(out, chain, fetchM, dep));
      } catch (e) {
        add({ step: "keeper", market: dep.id, action: "plan", status: e instanceof BudgetExhausted ? "skipped" : "failed", text: `market not run this tick: ${errorText(e)}` });
        if (e instanceof BudgetExhausted) out.undone(`${dep.id}: everything (no budget left to read its status)`);
      }
    }

    // Whose turn it is for the steps after the reports (see the fairness rule above).
    const index = (mr: MarketRun) => env.deployments.markets.indexOf(mr.dep);
    const acting = rotate(
      runs
        .filter((mr) => env.rotate === false || minute % cadence(mr.params) === index(mr) % cadence(mr.params))
        .sort((a, b) => index(a) - index(b)),
    );
    report.acting = acting.map((mr) => mr.dep.id);

    const step = async (priority: Priority, name: string, fn: (mr: MarketRun) => Promise<unknown>, list: MarketRun[] = runs) => {
      // A long run keeps its lease, or stops if another run has taken it.
      if (env.lease !== false && wall() - leaseAt > leaseSecs - 20) {
        if (!(await renewLease(env.store, run, wall(), leaseSecs))) throw new Error(`another run took the lease; stopped before ${name}`);
        leaseAt = wall();
      }
      budget.priority = priority;
      for (const mr of list) {
        budget.market = mr.dep.id;
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
      budget.market = undefined;
    };

    await step("urgent-reveal", "urgent reveals", (mr) => urgentReveals(out, mr));

    budget.priority = "report";
    budget.market = undefined;
    const latest = await indexStep(out);
    await step("report", "reports", async (mr) => {
      await reports(out, mr, latest[mr.dep.chip] ?? null);
      await finalize(out, mr);
    });
    await step("reveal-clear", "reveals and clears", async (mr) => {
      await swarmPass(out, mr, "reveal-clear", ["reveal", "clear"], { lookback: openLookback(mr), trade: false });
    }, acting);
    await step("commit", "commits", (mr) => commits(out, mr), acting);
    await step("settle-redeem", "settle and redeem", (mr) => settleAndRedeem(out, mr), acting);
    await step("prune", "pruning", async (mr) => {
      try {
        await prune(out, mr);
      } catch (e) {
        if (!(e instanceof KeyUnusable)) throw e; // said once by the key guard
      }
    }, acting);
  } catch (e) {
    add({ step: "keeper", action: "error", status: "failed", text: `tick stopped: ${errorText(e)}` });
  }
  budget.market = undefined;

  for (const mr of runs) {
    mr.summary.costs = mr.costs;
    mr.summary.pending_buckets = mr.marks.pending ?? [];
    report.markets[mr.dep.id] = mr.summary;
    for (const tx of mr.meter.txs) {
      report.txs.push({ ...tx, market: mr.dep.id });
      add({ step: "keeper", market: mr.dep.id, action: "tx", status: tx.ok ? "done" : "failed", agent: tx.signer, text: `${tx.method}${tx.ok ? "" : `: ${tx.error}`}`, tx: tx.tx_hash });
    }
    if (mr.clearedNow > 0) {
      const c = mr.costs;
      const market = c.burned !== null && c.burned_at_start !== null ? `; the market burned ${usd(BigInt(c.burned) - BigInt(c.burned_at_start))} in all` : "";
      add({ step: "housekeeping", market: mr.dep.id, action: "costs", status: "done", text: `since ${c.since} the agents paid ${usd(BigInt(c.fees))} in commit fees and lost ${usd(BigInt(c.forfeits))} in forfeits over ${c.rounds} rounds${market}`, data: c });
    }
    try {
      if (mr.marksChanged) await env.store.put(KEYS.marks(mr.dep.contract), JSON.stringify(mr.marks));
      if (mr.costsChanged) await env.store.put(KEYS.costs(mr.dep.contract), JSON.stringify(mr.costs));
    } catch (e) {
      add({ step: "keeper", market: mr.dep.id, action: "store", status: "failed", text: `could not save progress: ${errorText(e)}` });
    }
  }
  report.key_faults = Object.values(keys.faults);
  report.rpc_cooling = chain.cooling?.() ?? [];
  if (keys.changed) {
    try {
      await env.store.put(KEYS.keyFaults, JSON.stringify(keys.faults));
    } catch (e) {
      add({ step: "keeper", action: "store", status: "failed", text: `could not save key faults: ${errorText(e)}` });
    }
  }
  report.budget.used = budget.used;
  for (const p of PRIORITY_ORDER) {
    const n = budget.spent.filter((s) => s.priority === p).length;
    if (n > 0) report.budget.by_step[p] = n;
  }
  const clean = redact(report);
  try {
    await saveStatus(env.store, clean, new Set(env.deployments.markets.map((d) => d.id)));
  } catch (e) {
    clean.entries.push({ at: now, step: "keeper", action: "store", status: "failed", text: `could not save the log: ${errorText(e)}` });
  }
  return clean;
}

type Out = {
  keys: KeyGuard;
  add: (e: Omit<KeeperEntry, "at">) => void;
  report: TickReport;
  budget: Budget;
  env: KeeperEnv;
  now: number;
  undone: (u: string) => void;
  configProblem: (text: string, market?: MarketId) => void;
};

/** Minutes between a market's turns: at least 6 turns per commit phase and 3 per reveal phase. */
export const cadence = (p: Pick<WireParams, "commit_secs" | "reveal_secs">): number =>
  Math.max(1, Math.floor(Math.min(p.commit_secs / 6, p.reveal_secs / 3) / 60));

const forMarket = (spec: AgentSpec, id: MarketId) =>
  spec.market !== undefined ? spec.market === id : spec.markets === undefined || spec.markets.includes(id);

async function openMarket(out: Out, chain: Chain, fetchM: Fetch, dep: MarketDeployment): Promise<MarketRun> {
  const { env, budget, keys } = out;
  const meter = new Meter(budget, chain.perCall);
  const hooks = { fetch: fetchM, onOutcome: meter.onOutcome };
  const contract = dep.contract;
  const viewPort = meter.wrap(await chain.connect(dep, null, hooks));
  /** A signer's port on this market, guarded by its role, or null when it has no key here. */
  const signerPort = async (signer: Signer, role: Role, step: Step): Promise<WeirPort | null> => {
    const key = keyFor(signer, contract);
    if (key === null) {
      const text = `${signer.account_id} (${role}) cannot act on ${dep.id}: it has no key for ${contract} (add one under "keys")`;
      keys.once(`nokey|${signer.account_id}|${contract}`, text, dep.id, signer.account_id);
      out.configProblem(text, dep.id);
      return null;
    }
    try {
      return keys.guard(meter.wrap(await chain.connect(dep, { account_id: signer.account_id, secret_key: key }, hooks)), role, signer.account_id, contract, dep.id, out.now);
    } catch (e) {
      out.add({ step, market: dep.id, agent: signer.account_id, action: "config", status: "failed", text: `${role} not used on ${dep.id}: ${errorText(e)}` });
      out.configProblem(`${signer.account_id} (${role}) not used on ${dep.id}: ${errorText(e)}`, dep.id);
      return null;
    }
  };

  const cached = await readJson<WireParams>(env.store, KEYS.params(contract));
  if (cached) meter.params = cached;
  const agents: MarketRun["agents"] = [];
  for (const spec of env.secrets.agents.filter((a) => forMarket(a, dep.id))) {
    const port = await signerPort(spec, "agent", "swarm");
    if (port) agents.push({ spec, strategy: strategyOf(spec), port });
  }
  const housekeeper = env.secrets.keeper ? await signerPort(env.secrets.keeper, "keeper", "housekeeping") : null;
  const status = await viewPort.get_status({});
  const params = await viewPort.get_params({});
  if (!cached) await env.store.put(KEYS.params(contract), JSON.stringify(params));

  const reporters: MarketRun["reporters"] = [];
  for (const signer of env.secrets.reporters) {
    if (!params.reporters.includes(signer.account_id)) continue;
    const port = await signerPort(signer, "reporter", "report");
    if (port) reporters.push({ signer, port });
  }
  const named = <T extends { port: WeirPort }>(xs: T[], id: (x: T) => string) => xs.map((x) => ({ port: x.port, account: id(x) }));
  const hk = housekeeper && env.secrets.keeper ? [{ port: housekeeper, account: env.secrets.keeper.account_id }] : [];
  const settlers = [...hk, ...named(agents, (a) => a.spec.account_id)];
  const finalizers = [...hk, ...named(reporters, (r) => r.signer.account_id)];
  const keeper = keys.fallback(viewPort, settlers, contract, dep.id);
  const tp = timeParams(params);
  const marks = (await readJson<Marks>(env.store, KEYS.marks(contract))) ?? { settled_through: -1, redeemed_through: -1, redeemed: {} };
  const storedCosts = await readJson<Costs>(env.store, KEYS.costs(contract));
  const costs: Costs = storedCosts ?? { since: out.now, fees: "0", forfeits: "0", rounds: 0, by_agent: {}, burned_at_start: null, burned: null };
  const pruning = !env.secrets.keeper
    ? "off: no KEEPER account (agent and reporter keys may not prune)"
    : housekeeper
      ? "on"
      : `off: the KEEPER account has no key for ${contract}`;
  const mr: MarketRun = {
    dep, meter, keeper, signs: settlers.length > 0,
    finalizer: finalizers.length > 0 ? keys.fallback(viewPort, finalizers, contract, dep.id) : null,
    pruner: housekeeper,
    reporters, agents, params, tp, status, newest: newestSeries(tp, status.now), marks, marksChanged: false,
    costs, costsChanged: storedCosts === null, clearedNow: 0,
    summary: {
      contract, label: dep.label, chip: dep.chip, chain_now: status.now, live: status.live, bucket: null, reported: [],
      print: null, pending_buckets: [], settled_through: marks.settled_through, redeemed_through: marks.redeemed_through,
      pruning, costs: null, errors: 0,
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

/** Refusals that mean someone else (another run, or anyone: clear and settle are open) got there first. */
const ALREADY_DONE: readonly string[] = [ERR.ALREADY_REVEALED, ERR.CLEARED, ERR.SETTLED];

/** Moves the swarm's log into the keeper's: deferred calls vanish (a later step makes them),
 * and calls the budget refused become "left for the next tick". Counts the agents' fees and
 * forfeits of every round this keeper cleared, from the round's book as last read. */
function absorb(out: Out, mr: MarketRun, entries: LogEntry[], step: Step, priority: Priority): void {
  const deferredClears = new Set(entries.filter((e) => e.action === "clear" && e.text.includes(DEFERRED)).map((e) => `${e.series}/${e.round}`));
  for (const e of entries) {
    // Deferred to a later step, or not sent for want of a usable key (said once already).
    if (e.text.includes(DEFERRED) || e.text.includes(NO_KEY_MARK)) continue;
    if (e.action === "forfeit" && deferredClears.has(`${e.series}/${e.round}`)) continue;
    const base = { market: mr.dep.id, step, ...(e.agent ? { agent: e.agent } : {}), ...(e.series !== undefined ? { series: e.series } : {}), ...(e.round !== undefined ? { round: e.round } : {}) };
    if (e.text.includes(BUDGET_MARK)) {
      const what = e.action === "error" ? `${priority}: the rest of the pass` : `${e.text.replace(/ failed: .*$/, "").replace(/: .*$/, "")}`;
      out.undone(`${mr.dep.id}: ${what}${e.agent ? ` (${e.agent})` : ""}${e.series !== undefined ? ` series ${e.series}` : ""}${e.round !== undefined ? ` round ${e.round}` : ""}`);
      out.add({ ...base, action: e.action === "error" ? "budget" : e.action, status: "skipped", text: e.action === "error" ? `stopped: ${BUDGET_MARK}` : `${e.text.replace(/ failed: .*$/, "")}: left for the next tick (${BUDGET_MARK})` });
      continue;
    }
    if (e.status === "failed" && ALREADY_DONE.some((t) => e.text.endsWith(t))) {
      out.add({ ...base, action: e.action, status: "skipped", text: `${e.text} (done by another caller first)` });
      continue;
    }
    if (e.action === "clear" && e.status === "done" && e.series !== undefined && e.round !== undefined) countCosts(mr, e.series, e.round);
    if (e.status === "failed" || e.action === "error") mr.summary.errors++;
    out.add({ ...base, action: e.action, status: e.status, text: e.text, ...(e.data !== undefined ? { data: e.data } : {}) });
  }
}

/** Adds the fees and forfeits of this keeper's agents in a round it just cleared. */
function countCosts(mr: MarketRun, series: number, round: number): void {
  mr.clearedNow++;
  const book = mr.meter.books.get(`${series}/${round}`);
  if (!book) return;
  const mine = new Set(mr.agents.map((a) => a.spec.account_id));
  const c = mr.costs;
  for (const commit of book.commits) {
    if (!mine.has(commit.owner)) continue;
    const fee = BigInt(commit.fee);
    const forfeit = commit.state === "Committed" ? (BigInt(commit.lock) * BigInt(mr.params.forfeit_bps)) / 10_000n : 0n;
    const a = (c.by_agent[commit.owner] ??= { fees: "0", forfeits: "0" });
    a.fees = (BigInt(a.fees) + fee).toString();
    a.forfeits = (BigInt(a.forfeits) + forfeit).toString();
    c.fees = (BigInt(c.fees) + fee).toString();
    c.forfeits = (BigInt(c.forfeits) + forfeit).toString();
  }
  c.rounds++;
  mr.costsChanged = true;
}

async function urgentReveals(out: Out, mr: MarketRun): Promise<void> {
  const urgent = (mr.status?.live ?? []).filter(
    (l) => l.phase === "Reveal" && l.phase_ends_at !== null && l.phase_ends_at - mr.status!.now <= (out.env.urgentSecs ?? 90),
  );
  if (urgent.length === 0 || mr.newest === null) return;
  const lookback = mr.newest - Math.min(...urgent.map((l) => l.series));
  await swarmPass(out, mr, "urgent-reveal", ["reveal"], { lookback, trade: false });
}

async function indexStep(out: Out): Promise<Partial<Record<ChipId, LatestBundle>>> {
  const { env, budget, now } = out;
  let latest = await readLatest(env.store);
  try {
    if (!(await indexDue(env.store, now))) return latest;
    const marketChips = [...new Set(env.deployments.markets.map((m) => m.chip))];
    const chips = env.chips ?? (marketChips.length > 0 ? marketChips : CHIP_IDS);
    const count = requestsFor(chips);
    if (budget.left < count) {
      out.undone(`index: fetch of ${chips.length} chips (${count} requests, ${budget.left} left)`);
      out.add({ step: "index", action: "fetch", status: "skipped", text: `index fetch needs ${count} requests, ${budget.left} left: tried again next tick` });
      return latest;
    }
    const { attempt, latest: fresh } = await refreshIndex(env.store, budget.meter(env.fetch), now, chips);
    latest = { ...latest, ...fresh };
    const failed = [...new Map(attempt.sources.filter((s) => !s.ok).map((s) => [s.id, `${s.id} (${s.error})`])).values()];
    const sourcesText = failed.length > 0 ? `; failed sources: ${failed.join(", ")}` : "";
    for (const chip of chips) {
      const c = attempt.chips[chip]!;
      if (c.ok) out.add({ step: "index", action: "fetch", status: "done", text: `${chip}: index ${c.index} micro-USD, bundle ${c.hash}${sourcesText}`, data: { chip, hash: c.hash, index: c.index } });
      else out.add({ step: "index", action: "fetch", status: "failed", text: `${chip}: no index: ${c.reason}${sourcesText}; nothing stored, no price reported from this fetch`, data: { chip } });
    }
  } catch (e) {
    out.add({ step: "index", action: "fetch", status: "failed", text: `index step failed: ${errorText(e)}` });
  }
  return latest;
}

function markDecided(mr: MarketRun, bucket: number, state: "Final" | "NoPrint"): void {
  mr.summary.print = state;
  mr.marks.final_bucket = bucket;
  mr.marks.pending = (mr.marks.pending ?? []).filter((b) => b !== bucket);
  mr.marksChanged = true;
}

function addPrunable(mr: MarketRun, bucket: number): void {
  const list = (mr.marks.prunable ??= []);
  if (!list.includes(bucket)) {
    list.push(bucket);
    mr.marksChanged = true;
  }
}

async function reports(out: Out, mr: MarketRun, latest: LatestBundle | null): Promise<void> {
  const interval = mr.params.print_interval_secs;
  const bucket = Math.floor(out.now / interval) * interval;
  mr.summary.bucket = bucket;
  const base = { step: "report" as const, market: mr.dep.id };
  if (mr.reporters.length === 0) return;
  if (mr.marks.final_bucket === bucket) {
    mr.summary.print = "Final";
    return;
  }
  const chip = mr.dep.chip;
  if (latest === null || latest.fetched_at < bucket || latest.fetched_at >= bucket + interval) {
    const attempt = await readJson<IndexAttempt>(out.env.store, KEYS.indexAttempt);
    const failedHere = attempt && attempt.at >= bucket && attempt.chips[chip] && !attempt.chips[chip]!.ok;
    const why = failedHere
      ? `the fetch at ${attempt!.at} formed no ${chip} index (${attempt!.chips[chip]!.reason})`
      : latest
        ? `the latest ${chip} bundle was fetched at ${latest.fetched_at}`
        : `there is no ${chip} bundle yet`;
    out.add({ ...base, action: "report", status: "skipped", text: `no report for bucket ${bucket}: no ${chip} bundle fetched within it; ${why}` });
    return;
  }
  const print = await mr.keeper.get_print({ bucket });
  const done = new Set(print?.reports.map((r) => r.reporter) ?? []);
  mr.summary.reported = [...done];
  mr.summary.print = print?.state ?? null;
  if (print && print.state !== "Open") return markDecided(mr, bucket, print.state);
  for (const { signer, port } of mr.reporters) {
    if (done.has(signer.account_id)) continue;
    const at = { ...base, agent: signer.account_id, data: { bucket, chip, price: latest.index, bundle: latest.hash } };
    try {
      const madeFinal = await port.report({ bucket, price: latest.index, bundle: latest.hash });
      done.add(signer.account_id);
      mr.summary.reported.push(signer.account_id);
      addPrunable(mr, bucket);
      out.add({ ...at, action: "report", status: "done", text: `reported ${latest.index} (${chip}) for bucket ${bucket}${madeFinal ? "; the print is final" : ""}` });
      if (madeFinal) return markDecided(mr, bucket, "Final");
    } catch (e) {
      if (e instanceof BudgetExhausted) throw e;
      if (e instanceof KeyUnusable) continue;
      if (refused(e, ERR.DUPLICATE_REPORT)) {
        done.add(signer.account_id);
        out.add({ ...at, action: "report", status: "skipped", text: `another run reported for bucket ${bucket} first` });
      } else {
        mr.summary.errors++;
        out.add({ ...at, action: "report", status: "failed", text: `report for bucket ${bucket} failed: ${errorText(e)}` });
      }
    }
  }
  // Every reporter in: the bucket is decided (with or without a print). Otherwise it waits
  // for the missing ones, or for its window to close and `finalize_print`.
  if (mr.params.reporters.every((r) => done.has(r))) {
    if (mr.summary.print !== "Final") markDecided(mr, bucket, "NoPrint");
  } else if (done.size > 0 && !(mr.marks.pending ?? []).includes(bucket)) {
    (mr.marks.pending ??= []).push(bucket);
    mr.marksChanged = true;
    const missing = mr.params.reporters.filter((r) => !done.has(r));
    out.add({ ...base, action: "report", status: "skipped", text: `bucket ${bucket} waits: ${missing.join(", ")} not reported; it is decided when they do, or by finalize_print after ${bucket + interval + mr.params.report_grace_secs}` });
  }
}

/** Decides buckets whose report window has closed without every reporter: `finalize_print`.
 * Once per print bucket it also reads `get_pending_prints`, to catch buckets reported by others. */
async function finalize(out: Out, mr: MarketRun): Promise<void> {
  if (!mr.finalizer) return;
  const interval = mr.params.print_interval_secs;
  const bucket = Math.floor(out.now / interval) * interval;
  const closes = (b: number) => b + interval + mr.params.report_grace_secs;
  const now = mr.status!.now;
  if (mr.marks.swept_bucket !== bucket) {
    const pending = await mr.keeper.get_pending_prints({});
    for (const b of pending) {
      if (!(mr.marks.pending ?? []).includes(b)) (mr.marks.pending ??= []).push(b);
      addPrunable(mr, b);
    }
    mr.marks.swept_bucket = bucket;
    mr.marksChanged = true;
  }
  for (const b of [...(mr.marks.pending ?? [])].sort((x, y) => x - y)) {
    if (now < closes(b)) continue;
    const base = { step: "report" as const, market: mr.dep.id, action: "finalize", data: { bucket: b } };
    try {
      const final = await mr.finalizer.finalize_print({ bucket: b });
      if (final) out.add({ ...base, status: "done", text: `finalized bucket ${b}: its print is final` });
      else out.add({ ...base, status: "done", text: `finalized bucket ${b} with no print: ${await noPrintReason(mr, b)}` });
    } catch (e) {
      if (e instanceof BudgetExhausted) throw e;
      if (e instanceof KeyUnusable) return;
      if (refused(e, ERR.DECIDED, ERR.NO_REPORTS)) out.add({ ...base, status: "skipped", text: `bucket ${b}: ${errorText(e)} (a later report or a settle decided it)` });
      else {
        mr.summary.errors++;
        out.add({ ...base, status: "failed", text: `finalize_print(${b}) failed: ${errorText(e)}` });
        continue;
      }
    }
    mr.marks.pending = (mr.marks.pending ?? []).filter((x) => x !== b);
    mr.marksChanged = true;
  }
}

/** Why a decided bucket has no print, from its reports (SPEC section 9). */
async function noPrintReason(mr: MarketRun, bucket: number): Promise<string> {
  const p = await mr.keeper.get_print({ bucket });
  const prices = (p?.reports ?? []).map((r) => r.price).sort((a, b) => a - b);
  const { quorum, max_spread_bps } = mr.params;
  if (prices.length < quorum) return `${prices.length} report(s), quorum is ${quorum}`;
  if (prices.length % 2 === 0) {
    const lo = prices[prices.length / 2 - 1]!;
    const hi = prices[prices.length / 2]!;
    return `the two middle reports ${lo} and ${hi} are ${(((hi - lo) * 10_000) / lo).toFixed(0)} bps apart, more than max_spread_bps ${max_spread_bps}`;
  }
  return `reports ${prices.join(", ")}`;
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
    for (const e of log) if (e.action === "settle" && (e.status === "done" || e.text.endsWith(ERR.SETTLED)) && e.series !== undefined) settled.add(e.series);
  } else if (due) {
    out.keys.once(`nosettle|${mr.dep.contract}`, `nobody can settle on ${mr.dep.id}: no housekeeping account or agent has a key for ${mr.dep.contract}`, mr.dep.id);
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
          if (e instanceof KeyUnusable) continue;
          if (!refused(e, ERR.NO_POSITION)) {
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
  mr.summary.redeemed_through = mr.marks.redeemed_through;
}

/** Lowest priority: release the contract's storage, and read the market's burned total. */
async function prune(out: Out, mr: MarketRun): Promise<void> {
  const now = mr.status!.now;
  // The burned total changes only at clearing: read it after a clear, and once at the start.
  if (mr.clearedNow > 0 || mr.costs.burned === null) {
    const burned = (await mr.keeper.get_totals({})).burned;
    mr.costs.burned_at_start ??= burned;
    mr.costs.burned = burned;
    mr.costsChanged = true;
  }
  if (!mr.pruner) return;
  let left = PRUNE_PER_TICK;
  const base = { step: "housekeeping" as const, market: mr.dep.id };
  // Prints: decided buckets two periods old.
  for (const b of [...(mr.marks.prunable ?? [])].sort((x, y) => x - y)) {
    if (left === 0 || now < b + 2 * mr.params.period_secs) break;
    if ((mr.marks.pending ?? []).includes(b)) continue;
    left--;
    try {
      await mr.pruner.prune_print({ bucket: b });
      out.add({ ...base, action: "prune", status: "done", text: `pruned the print of bucket ${b}` });
    } catch (e) {
      if (e instanceof BudgetExhausted || e instanceof KeyUnusable) throw e;
      if (refused(e, ERR.NOT_DECIDED)) {
        (mr.marks.pending ??= []).push(b);
        mr.marksChanged = true;
        continue;
      }
      out.add({ ...base, action: "prune", status: "skipped", text: `bucket ${b} not pruned: ${errorText(e)}` });
    }
    mr.marks.prunable = (mr.marks.prunable ?? []).filter((x) => x !== b);
    mr.marksChanged = true;
  }
  // Results of settled series, oldest first.
  while (left > 0) {
    const at = mr.marks.results_from ?? { series: 0, round: 0 };
    if (at.series > mr.marks.settled_through) break;
    const rows = await mr.keeper.get_results({ series: at.series, from_round: at.round, limit: 100 });
    if (rows.length === 0) {
      const last = at.round + 100 >= roundsOf(mr, at.series);
      mr.marks.results_from = last ? { series: at.series + 1, round: 0 } : { series: at.series, round: at.round + 100 };
      mr.marksChanged = true;
      continue;
    }
    for (const [round] of rows.slice(0, left)) {
      left--;
      try {
        await mr.pruner.prune_result({ series: at.series, round });
        out.add({ ...base, action: "prune", status: "done", series: at.series, round, text: `pruned the result of series ${at.series} round ${round}` });
      } catch (e) {
        if (e instanceof BudgetExhausted || e instanceof KeyUnusable) throw e;
        out.add({ ...base, action: "prune", status: "skipped", series: at.series, round, text: `result not pruned: ${errorText(e)}` });
      }
      mr.marks.results_from = { series: at.series, round: round + 1 };
      mr.marksChanged = true;
    }
  }
}

const roundsOf = (mr: MarketRun, _series: number): number =>
  Math.floor((mr.params.lead_secs - mr.params.cutoff_secs) / (mr.params.commit_secs + mr.params.reveal_secs));

export interface StoredStatus {
  last_tick: number;
  run: string;
  operator_note: string;
  budget: TickReport["budget"];
  order: MarketId[];
  acting: MarketId[];
  undone: string[];
  markets: TickReport["markets"];
  key_faults: KeyFault[];
  config: ConfigProblem[];
  rpc_cooling: RpcCooling[];
  log: KeeperEntry[];
}

async function saveStatus(store: KeeperStore, report: TickReport, deployed: ReadonlySet<MarketId>): Promise<void> {
  const prev = await readJson<StoredStatus>(store, KEYS.status);
  const log = [...(prev?.log ?? []), ...report.entries].slice(-LOG_SIZE);
  // A market this tick could not open (its status unreadable, or no budget left) was not
  // checked again: its problems from the last tick that checked it still stand.
  const config = [...report.config];
  for (const c of prev?.config ?? []) {
    if (c.market !== undefined && deployed.has(c.market) && report.markets[c.market] === undefined && !config.some((x) => x.market === c.market && x.text === c.text)) config.push(c);
  }
  const status: StoredStatus = {
    last_tick: report.now,
    run: report.run,
    operator_note: OPERATOR_NOTE,
    budget: report.budget,
    order: report.order,
    acting: report.acting,
    undone: report.undone,
    markets: report.markets,
    key_faults: report.key_faults,
    config,
    rpc_cooling: report.rpc_cooling,
    log,
  };
  await store.put(KEYS.status, JSON.stringify(status));
}
