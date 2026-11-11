// A deterministic market simulation on the engine, for the site and the CLI. Three reporters
// post an index path, and a swarm of agents (buyers, sellers, makers, noise traders) trades
// through every phase, all through `ModelWeir`: the same swarm code that runs on chain.
// Same seed, same events, byte for byte. Browser-safe.
import { auctionClose, auctionOpen, deliveryEnd, Market, roundCount, roundSecs, sha256Hex, wireEvent, type WeirEvent } from "@weir/engine";
import { ModelWeir, paramsFromWire, type SyncWeir } from "@weir/chain";
import { PRESETS, type PresetName } from "./presets.ts";
import { mulberry32 } from "./random.ts";
import type { Role, Strategy } from "./strategy.ts";
import { buyer, maker, noise, seller } from "./strategies/mod.ts";
import { MemoryStore, newestSeries, tickSync, timeParams, type LogEntry } from "./swarm.ts";

export { PRESETS, type PresetName } from "./presets.ts";

export interface SimConfig {
  seed: number;
  buyers: number;
  sellers: number;
  makers: number;
  noise: number;
  market?: PresetName;
  /** Index prices to replay, in micro-USD per GPU-hour, one per print; the last one repeats.
   * Without it the index is a seeded random walk with occasional jumps. */
  prices?: readonly number[];
}

export interface SimAgent {
  id: string;
  role: Role;
  rule: string;
  /** What the agent was funded with, in micro-USDC. */
  deposit: string;
}

export interface SimEvent {
  at: number;
  kind: string;
  agent?: string;
  text: string;
  data?: unknown;
}

export interface Simulation {
  readonly market: Market;
  readonly agents: SimAgent[];
  /** Every event so far, setup included. */
  readonly log: readonly SimEvent[];
  now(): number;
  /** Advances the clock; reporters and agents act at every step of the preset's cadence. */
  step(seconds: number): SimEvent[];
  /** Advances to the end of the round in progress, when it is cleared. */
  skipToClearing(): SimEvent[];
  /** Runs `n` rounds to their clearing. */
  runRounds(n: number): SimEvent[];
  /** Stops new orders and runs until every opened series is settled and redeemed. */
  settleAll(): SimEvent[];
  /** Free balance per agent, micro-USDC as decimal strings. */
  balances(): Record<string, string>;
}

const KEEPER = "keeper";
/** Index start: $2.00 per H100-hour. */
const START_PRICE = 2_000_000;

/** The random index, scaled to the preset so both see the same delivery period: normal
 * steps adding up to 6% volatility per period, and a jump of 8 to 15% about once every
 * four periods. `printsPerPeriod` is 168 for weekly, 12 for fast. */
function randomWalk(seed: number, printsPerPeriod: number): (k: number) => number {
  const rng = mulberry32(seed ^ 0x5eed1d3c);
  const path = [START_PRICE];
  const sigma = 0.06 / Math.sqrt(printsPerPeriod);
  const jumpChance = 0.25 / printsPerPeriod;
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  return (k) => {
    while (path.length <= k) {
      const jump = rng() < jumpChance ? (rng() < 0.5 ? -1 : 1) * (0.08 + 0.07 * rng()) : 0;
      const next = path.at(-1)! * Math.exp(sigma * gauss() + jump);
      path.push(Math.max(200_000, Math.round(next)));
    }
    return path[k]!;
  };
}

/** The common spacing of every timed thing in a preset: the simulation acts this often. */
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const usd = (micro: bigint | string | number, digits = 2): string => {
  const v = Number(micro) / 1e6;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(digits)}`;
};

function makeAgents(config: SimConfig): { strategy: Strategy; deposit: bigint }[] {
  const rng = mulberry32(config.seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const id = (role: string, i: number) => `${role}-${String(i + 1).padStart(2, "0")}`;
  const out: { strategy: Strategy; deposit: bigint }[] = [];
  for (let i = 0; i < config.buyers; i++) {
    out.push({ strategy: buyer(id("buyer", i), { need: int(20, 60), premiumBps: int(2, 8) * 100 }), deposit: 60_000_000n });
  }
  for (let i = 0; i < config.sellers; i++) {
    out.push({ strategy: seller(id("seller", i), { capacity: int(120, 240), premiumBps: int(2, 8) * 100 }), deposit: 200_000_000n });
  }
  for (let i = 0; i < config.makers; i++) {
    out.push({ strategy: maker(id("maker", i), { spreadBps: int(4, 8) * 100, shareBps: 1000, maxSize: 40 }), deposit: 400_000_000n });
  }
  for (let i = 0; i < config.noise; i++) {
    out.push({ strategy: noise(id("noise", i), { viewBps: 1000, minSize: 3, maxSize: 10 }), deposit: 30_000_000n });
  }
  return out;
}

/** One line for an engine event. */
function describe(e: WeirEvent, band: (series: number) => { floor: number; band: number } | null): { agent?: string; text: string } {
  const d = e.data as Record<string, unknown>;
  const agent = (d.accountId ?? d.reporter ?? d.from) as string | undefined;
  const per = (p: number) => `${usd(p, 3)}/h`;
  switch (e.event) {
    case "register":
      return { agent, text: `${agent} registered` };
    case "deposit":
      return { agent, text: `${agent} deposited ${usd(e.data.amount)}` };
    case "withdraw":
    case "withdraw_failed":
      return { agent, text: `${agent} ${e.event.replace("_", " ")} ${usd(e.data.amount)}` };
    case "series_opened":
      return { text: `series ${e.data.series} opened on ${per(e.data.anchor)}: LONG pays the week's average above ${per(e.data.floor)}, up to ${usd(e.data.band, 3)}` };
    case "commit":
      return { agent, text: `${agent} sealed an order in round ${e.data.round}, locking ${usd(e.data.lock)}` };
    case "evict":
      return { agent, text: `${agent}'s commit ${e.data.seq} was evicted from a full round` };
    case "reveal":
      return { agent, text: `${agent} revealed ${e.data.side.toUpperCase()} ${e.data.size} @ ${usd(e.data.price, 3)}${e.data.void ? " (void by guard)" : ""}` };
    case "clear": {
      const b = band(e.data.series);
      const { price, volume, round, series } = e.data;
      const forfeit = e.data.forfeited > 0n ? `, ${usd(e.data.forfeited)} forfeited` : "";
      if (price === null) return { text: `round ${round} of series ${series}: no trade${forfeit}` };
      return { text: `round ${round} of series ${series} cleared at ${usd(price, 3)} (forward ${per(b!.floor + price)}), ${volume} GPU-hours${forfeit}` };
    }
    case "mint":
    case "merge":
      return { agent, text: `${agent} ${e.event === "mint" ? "minted" : "merged"} ${e.data.sets} sets` };
    case "transfer_position":
      return { agent, text: `${e.data.from} moved ${e.data.long} LONG and ${e.data.short} SHORT to ${e.data.to}` };
    case "report":
      return { agent, text: `${agent} reported ${per(e.data.price)}` };
    case "print":
      return { text: `index print ${per(e.data.price)} (${e.data.reports} reports)` };
    case "settle":
      return { text: `series ${e.data.series} settled at ${per(e.data.fixing)}: LONG pays ${usd(e.data.longPayout, 3)}, SHORT ${usd(e.data.shortPayout, 3)}${e.data.void ? " (void)" : ""}` };
    case "redeem":
      return { agent, text: `${agent} redeemed ${usd(e.data.amount)}` };
    case "guard":
      return { agent, text: `${agent} set guard ${e.data.guard ?? "none"}` };
  }
}

export function createSimulation(config: SimConfig): Simulation {
  const preset = config.market ?? "weekly";
  const params = PRESETS[preset];
  const tp = timeParams(params);
  const cadence = [params.commit_secs, params.reveal_secs, params.print_interval_secs, params.report_grace_secs].reduce(gcd);
  const start = auctionOpen(tp, 0) - params.print_interval_secs;
  const market = new Market(paramsFromWire(params), start);
  const keeper = new ModelWeir(market, KEEPER);
  const secret = `weir-sim-${config.seed}`;
  const store = new MemoryStore();

  const funded = makeAgents(config);
  const strategies = funded.map((f) => f.strategy);
  const ports: Record<string, SyncWeir> = {};
  for (const { strategy, deposit } of funded) {
    const port = keeper.as(strategy.id).sync;
    ports[strategy.id] = port;
    port.change("register", {});
    port.change("deposit", { amount: deposit.toString() });
  }
  const agents: SimAgent[] = funded.map(({ strategy: s, deposit }) => ({ id: s.id, role: s.role, rule: s.rule, deposit: deposit.toString() }));

  const indexAt = config.prices
    ? (k: number) => config.prices![Math.min(k, config.prices!.length - 1)]!
    : randomWalk(config.seed, params.period_secs / params.print_interval_secs);
  // Reporters see the same index a little differently: -0.1%, exact, +0.1%.
  const reporters = params.reporters.map((name, i) => ({ port: keeper.as(name).sync, skew: 1 + (i - 1) * 0.001 }));

  const log: SimEvent[] = [];
  let seen = 0;
  let trading = true;
  let lastTick = start - cadence;

  const band = (series: number) => market.getSeries(series);
  const collect = (entries: LogEntry[]): SimEvent[] => {
    const out: SimEvent[] = [];
    for (const e of market.events.slice(seen)) {
      out.push({ at: market.now, kind: e.event, ...describe(e, band), data: wireEvent(e).data });
    }
    seen = market.events.length;
    for (const x of entries) {
      if (x.action === "forfeit" || x.status === "failed" || x.action === "budget") {
        out.push({ at: market.now, kind: x.action === "forfeit" ? "forfeit" : "error", agent: x.agent, text: x.agent ? `${x.agent}: ${x.text}` : x.text, data: x.data });
      }
    }
    log.push(...out);
    return out;
  };

  const actAt = (t: number): SimEvent[] => {
    market.setTime(t);
    lastTick = t;
    if (t % params.print_interval_secs === 0) {
      const price = indexAt((t - start) / params.print_interval_secs);
      for (const r of reporters) {
        const p = Math.round(price * r.skew);
        r.port.change("report", { bucket: t, price: p, bundle: sha256Hex(`sim|${t}|${r.port.accountId}|${p}`) });
      }
    }
    const result = tickSync({ market: "sim", store, agents: strategies, ports, secret, keeper: keeper.sync, budget: Infinity, trade: trading });
    return collect(result.entries);
  };

  const step = (seconds: number): SimEvent[] => {
    const target = market.now + seconds;
    const out: SimEvent[] = [];
    for (let t = lastTick + cadence; t <= target; t += cadence) out.push(...actAt(t));
    market.setTime(Math.max(market.now, target));
    return out;
  };

  /** The end of the round in progress (or of the next round to start). */
  const nextRoundEnd = (): number => {
    const now = market.now;
    const rs = roundSecs(tp);
    const s0 = newestSeries(tp, now) ?? 0;
    let best = Infinity;
    for (const s of [s0, s0 + 1]) {
      const open = auctionOpen(tp, s);
      if (roundCount(tp, s) === 0) continue;
      const end = now < open ? open + rs : open + (Math.floor((now - open) / rs) + 1) * rs;
      if (end <= auctionClose(tp, s) && end > now) best = Math.min(best, end);
    }
    return best === Infinity ? now + rs : best;
  };

  const settled = (): boolean => {
    const t = market.getTotals();
    if (t.locked > 0n || t.setsBacking > 0n || t.unredeemed > 0n) return false;
    const newest = newestSeries(tp, market.now) ?? 0;
    for (let s = 0; s <= newest; s++) {
      const rec = market.getSeries(s);
      if (rec && !rec.settlement) return false;
    }
    return true;
  };

  collect([]);
  actAt(start);

  return {
    market,
    agents,
    log,
    now: () => market.now,
    step,
    skipToClearing: () => step(nextRoundEnd() - market.now),
    runRounds(n) {
      const out: SimEvent[] = [];
      for (let i = 0; i < n; i++) out.push(...step(nextRoundEnd() - market.now));
      return out;
    },
    settleAll() {
      trading = false;
      const out: SimEvent[] = [];
      const newest = newestSeries(tp, market.now) ?? 0;
      const deadline = deliveryEnd(tp, newest) + params.void_after_secs + params.period_secs;
      while (!settled() && market.now < deadline) out.push(...step(cadence));
      return out;
    },
    balances() {
      return Object.fromEntries(agents.map((a) => [a.id, (market.getAccount(a.id)?.balance ?? 0n).toString()]));
    },
  };
}

export interface AgentReport {
  id: string;
  role: Role;
  /** GPU-hours bought. */
  long: number;
  short: number;
  /** Paid in auctions, micro-USDC. */
  paid: bigint;
  /** Received at redemption. */
  received: bigint;
  /** Lost to forfeits. */
  forfeited: bigint;
  /** Free balance now minus the deposit. */
  result: bigint;
}

/** Per agent: what it traded, paid and received, from the market's results and events. */
export function agentReports(sim: Simulation): AgentReport[] {
  const m = sim.market;
  const rows = new Map<string, AgentReport>(
    sim.agents.map((a) => [a.id, { id: a.id, role: a.role, long: 0, short: 0, paid: 0n, received: 0n, forfeited: 0n, result: 0n }]),
  );
  const forfeitBps = BigInt(m.params.forfeitBps);
  const locks = new Map<string, { owner: string; lock: bigint }>();
  for (const e of m.events) {
    const key = (s: number, r: number, q: number) => `${s}/${r}/${q}`;
    if (e.event === "commit") locks.set(key(e.data.series, e.data.round, e.data.seq), { owner: e.data.accountId, lock: e.data.lock });
    if (e.event === "reveal") locks.delete(key(e.data.series, e.data.round, e.data.seq));
    if (e.event === "evict") locks.delete(key(e.data.series, e.data.round, e.data.seq));
    if (e.event === "redeem") {
      const row = rows.get(e.data.accountId);
      if (row) row.received += e.data.amount;
    }
    if (e.event === "clear") {
      const { series, round } = e.data;
      const result = m.getResult(series, round);
      const bandOf = m.getSeries(series)!.band;
      for (const f of result?.fills ?? []) {
        const row = rows.get(f.owner);
        if (!row || f.filled === 0 || result!.price === null) continue;
        if (f.side === "Long") row.long += f.filled;
        else row.short += f.filled;
        row.paid += BigInt(f.filled) * BigInt(f.side === "Long" ? result!.price : bandOf - result!.price);
      }
      for (const [k, c] of locks) {
        if (!k.startsWith(`${series}/${round}/`)) continue;
        const row = rows.get(c.owner);
        if (row) row.forfeited += (c.lock * forfeitBps) / 10_000n;
        locks.delete(k);
      }
    }
  }
  for (const a of sim.agents) {
    const row = rows.get(a.id)!;
    row.result = (m.getAccount(a.id)?.balance ?? 0n) - BigInt(a.deposit);
  }
  return [...rows.values()];
}
