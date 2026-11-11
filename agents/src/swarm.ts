// The live runner. `tick` is stateless and idempotent: call it about once a minute and it
// reads the contract, then does what is due now for every agent it runs: reveal in a reveal
// phase, clear rounds that are over, settle and redeem what is due, commit in a commit phase.
//
// The only state is an `OrderStore` (Cloudflare KV in the Worker, memory in tests and the
// simulation). Before an order is committed it is stored under
// `market|series|round|agent|n` with its side, size, price, salt and hash, so a crash
// between storing and committing cannot lose a reveal; the seq is added once the commit
// lands. At reveal time each of the agent's commits in `get_round` is matched to a stored
// order by its hash. The lock is exactly what the order can cost. Salts are
// HMAC(secret, series|round|agent|n), so if an entry is lost the order can still be found by
// hashing the few (side, size, price) that divide the lock exactly (`recover`, on by default).
//
// The logic is one generator that yields the calls it wants made. `tick` runs it on any
// `WeirPort` (async: chain or model); `tickSync` runs the same generator on a `SyncWeir`
// (the model), which is how the simulation drives its market.
import {
  commitHash,
  computeBand,
  deliveryEnd,
  roundCount,
  roundSecs,
  auctionOpen,
  type Side,
  type TimeParams,
  type ViewMethod,
  type ViewMethods,
  type WireLiveSeries,
  type WireParams,
} from "@weir/engine";
import type { PortChange, PortChanges, SyncWeir, WeirPort } from "@weir/chain";
import { derivedRng, hmacHex } from "./random.ts";
import { lockOf, type AgentView, type Intent, type Strategy } from "./strategy.ts";

/** Where orders wait between commit and reveal. A Cloudflare KV namespace fits as is. */
export interface OrderStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** The same store, synchronous, for the simulation. */
export interface SyncOrderStore {
  get(key: string): string | null;
  put(key: string, value: string): void;
}

/** An in-memory store with both faces. */
export class MemoryStore implements SyncOrderStore {
  readonly #map = new Map<string, string>();
  readonly async: OrderStore = {
    get: async (key) => this.get(key),
    put: async (key, value) => this.put(key, value),
  };

  get(key: string): string | null {
    return this.#map.get(key) ?? null;
  }

  put(key: string, value: string): void {
    this.#map.set(key, value);
  }

  /** Forgets everything, as a lost store would. */
  clear(): void {
    this.#map.clear();
  }

  get size(): number {
    return this.#map.size;
  }
}

/** What the store holds for one order. */
export interface StoredOrder extends Intent {
  salt: string;
  hash: string;
  /** Null until the commit has landed. */
  seq: number | null;
}

export const orderKey = (market: string, series: number, round: number, agent: string, n: number): string =>
  `${market}|${series}|${round}|${agent}|${n}`;

export interface SwarmContext<P, S> {
  /** Names the market in store keys, e.g. the contract account id. */
  market: string;
  store: S;
  /** When an order is missing from the store, search for it by hash (cheap). Default true. */
  recover?: boolean;
  /** The agents this swarm runs. Each strategy's `id` is its account id. */
  agents: readonly Strategy[];
  /** A port per agent id that signs as that agent. */
  ports: Readonly<Record<string, P>>;
  /** Secret the salts and random streams come from. */
  secret: string;
  /** Most calls (views and state changes) one tick may make. Default 200. */
  budget?: number;
  /** Port for views and for `clear` and `settle`, which anyone may call. Default: the first agent's. */
  keeper?: P;
  /** When false, no new commits: only reveal, clear, settle and redeem. Default true. */
  trade?: boolean;
  /** How many series before the newest open one to look after. Default 3. */
  lookback?: number;
}

export type Action = "commit" | "reveal" | "clear" | "forfeit" | "settle" | "redeem" | "budget" | "error";

export interface LogEntry {
  action: Action;
  status: "done" | "skipped" | "failed";
  agent?: string;
  series?: number;
  round?: number;
  text: string;
  data?: unknown;
}

export interface TickLog {
  now: number;
  calls: number;
  entries: LogEntry[];
}

/** Orders one agent can place in one round. */
export const MAX_ORDERS_PER_ROUND = 8;

type Call =
  | { kind: "view"; method: ViewMethod; args: unknown }
  | { kind: "change"; agent: string | null; method: PortChange; args: unknown }
  | { kind: "get"; key: string }
  | { kind: "put"; key: string; value: string };
type Reply = { ok: true; value: unknown } | { ok: false; error: string };
type Plan<T> = Generator<Call, T, Reply>;

class OutOfBudget extends Error {}

export const saltFor = (secret: string, series: number, round: number, agent: string, n: number): string =>
  hmacHex(secret, `weir-salt|${series}|${round}|${agent}|${n}`);

export const rngFor = (secret: string, series: number, round: number, agent: string): (() => number) =>
  derivedRng(secret, `weir-rng|${series}|${round}|${agent}`);

export const timeParams = (p: WireParams): TimeParams => ({
  t0: p.t0,
  periodSecs: p.period_secs,
  leadSecs: p.lead_secs,
  cutoffSecs: p.cutoff_secs,
  commitSecs: p.commit_secs,
  revealSecs: p.reveal_secs,
});

/** The newest series whose auctions have opened at `now`, or null if none has. */
export function newestSeries(p: TimeParams, now: number): number | null {
  if (auctionOpen(p, 0) > now) return null;
  return Math.max(0, Math.floor((now + p.leadSecs - p.t0) / p.periodSecs));
}

/** Rounds of `series` that are over at `now`. */
function roundsOver(p: TimeParams, series: number, now: number): number {
  const open = auctionOpen(p, series);
  return now < open ? 0 : Math.min(roundCount(p, series), Math.floor((now - open) / roundSecs(p)));
}

/** Finds an order of this swarm from its commit when the store has lost it: the lock is
 * exactly the order's cost, so only sizes dividing it, two sides and a few salts are hashed. */
export function rebuildOrder(
  secret: string,
  params: WireParams,
  band: number,
  commit: { series: number; round: number; owner: string; lock: string; hash: string },
): StoredOrder | null {
  const { tick, max_order_size } = params;
  const lock = BigInt(commit.lock);
  if (lock % BigInt(tick) !== 0n) return null;
  const units = Number(lock / BigInt(tick));
  for (let n = 0; n < MAX_ORDERS_PER_ROUND; n++) {
    const salt = saltFor(secret, commit.series, commit.round, commit.owner, n);
    for (let size = 1; size <= Math.min(max_order_size, units); size++) {
      if (units % size !== 0) continue;
      const k = (units / size) * tick;
      for (const [side, price] of [["Long", k], ["Short", band - k]] as [Side, number][]) {
        if (price <= 0 || price >= band) continue;
        const hash = commitHash({ series: commit.series, round: commit.round, accountId: commit.owner, side, size, price, salt });
        if (hash === commit.hash) return { side, size, price, salt, hash, seq: null };
      }
    }
  }
  return null;
}

const usd = (micro: bigint | string | number): string => {
  const v = BigInt(micro);
  const a = v < 0n ? -v : v;
  return `${v < 0n ? "-" : ""}$${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
};

const price = (micro: number): string => `$${(micro / 1e6).toFixed(3)}`;

class Planner<P, S> {
  readonly log: TickLog = { now: 0, calls: 0, entries: [] };
  readonly #ctx: SwarmContext<P, S>;
  readonly #budget: number;
  readonly #mine: Set<string>;

  constructor(ctx: SwarmContext<P, S>) {
    this.#ctx = ctx;
    this.#budget = ctx.budget ?? 200;
    this.#mine = new Set(ctx.agents.map((a) => a.id));
  }

  *run(): Plan<void> {
    try {
      const status = yield* this.#view("get_status", {});
      this.log.now = status.now;
      const params = yield* this.#view("get_params", {});
      const tp = timeParams(params);
      const newest = newestSeries(tp, status.now);
      if (newest === null) return;
      const first = Math.max(0, newest - (this.#ctx.lookback ?? 3));
      const live = (s: number) => status.live.find((l) => l.series === s && l.round !== null);
      // Most urgent first: a commit not revealed in time loses part of its lock.
      for (let s = first; s <= newest; s++) {
        const l = live(s);
        if (l?.phase === "Reveal") yield* this.#reveal(params, l);
      }
      for (let s = first; s <= newest; s++) yield* this.#clearSettleRedeem(params, tp, s, status.now);
      if (this.#ctx.trade === false) return;
      for (let s = first; s <= newest; s++) {
        const l = live(s);
        if (l?.phase === "Commit") yield* this.#commit(params, tp, l, status.now);
      }
    } catch (e) {
      if (e instanceof OutOfBudget) {
        this.#entry({ action: "budget", status: "skipped", text: `budget of ${this.#budget} calls used up; the rest waits for the next tick` });
      } else {
        this.#entry({ action: "error", status: "failed", text: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  *#reveal(params: WireParams, live: WireLiveSeries): Plan<void> {
    const series = live.series;
    const round = live.round!;
    const book = yield* this.#view("get_round", { series, round });
    const waiting = book?.commits.filter((c) => c.state === "Committed" && this.#mine.has(c.owner)) ?? [];
    if (waiting.length === 0) return;
    let band: number | null = null;
    for (const agent of new Set(waiting.map((c) => c.owner))) {
      const commits = waiting.filter((c) => c.owner === agent);
      // Stored orders are numbered from 0 with no gaps: read until all commits are matched.
      const stored: StoredOrder[] = [];
      for (let n = 0; n < MAX_ORDERS_PER_ROUND && commits.some((c) => !stored.some((o) => o.hash === c.hash)); n++) {
        const value = yield* this.#get(orderKey(this.#ctx.market, series, round, agent, n));
        if (value === null) break;
        stored.push(JSON.parse(value) as StoredOrder);
      }
      for (const c of commits) {
        const at = { agent, series, round };
        let o = stored.find((x) => x.hash === c.hash) ?? null;
        let how = "";
        if (!o && this.#ctx.recover !== false) {
          band ??= (yield* this.#view("get_series", { series }))!.band;
          o = rebuildOrder(this.#ctx.secret, params, band, { series, round, owner: agent, lock: c.lock, hash: c.hash });
          how = " (rebuilt: not in store)";
        }
        if (!o) {
          this.#entry({ action: "reveal", status: "failed", ...at, text: `cannot reveal: order not in store (commit ${c.seq})`, data: { seq: c.seq } });
          continue;
        }
        const r = yield* this.#change(agent, "reveal", { series, round, seq: c.seq, side: o.side, size: o.size, price: o.price, salt: o.salt });
        const text = r.ok ? `revealed ${o.side.toUpperCase()} ${o.size} @ ${price(o.price)}${how}` : `reveal of commit ${c.seq} failed: ${r.error}`;
        this.#entry({ action: "reveal", status: r.ok ? "done" : "failed", ...at, text, data: { seq: c.seq, side: o.side, size: o.size, price: o.price } });
      }
    }
  }

  *#clearSettleRedeem(params: WireParams, tp: TimeParams, series: number, now: number): Plan<void> {
    const rec = yield* this.#view("get_series", { series });
    if (!rec) return;
    let settled = rec.settlement !== null;
    if (!settled) {
      // `pending_rounds` lists, oldest first, the rounds holding commits not yet cleared. Clear
      // every one that is over; the round in progress stays pending.
      const over = roundsOver(tp, series, now);
      let pending = rec.pending_rounds.length;
      for (const round of rec.pending_rounds) {
        if (round >= over) continue;
        const book = yield* this.#view("get_round", { series, round });
        if (!book) {
          pending--; // cleared by someone else since get_series
          continue;
        }
        for (const c of book.commits.filter((x) => x.state === "Committed")) {
          const forfeit = (BigInt(c.lock) * BigInt(params.forfeit_bps)) / 10_000n;
          const whose = this.#mine.has(c.owner) ? "" : " (not ours)";
          this.#entry({ action: "forfeit", status: "done", agent: c.owner, series, round, text: `commit ${c.seq} was never revealed${whose}: forfeits ${usd(forfeit)} to the bonus pool`, data: { seq: c.seq, forfeit: forfeit.toString() } });
        }
        const r = yield* this.#change(null, "clear", { series, round });
        if (r.ok) pending--;
        this.#entry({ action: "clear", status: r.ok ? "done" : "failed", series, round, text: r.ok ? `cleared round ${round} (${book.commits.length} commits)` : `clear failed: ${r.error}` });
      }
      const end = deliveryEnd(tp, series);
      if (pending > 0 || now < end + params.report_grace_secs) return;
      const acc = yield* this.#view("get_accumulator", { series });
      if (acc.count < params.min_prints && now < end + params.void_after_secs) {
        this.#entry({ action: "settle", status: "skipped", series, text: `${acc.count} of ${params.min_prints} prints; waiting for more or for the void rule at ${end + params.void_after_secs}` });
        return;
      }
      const r = yield* this.#change(null, "settle", { series });
      this.#entry({ action: "settle", status: r.ok ? "done" : "failed", series, text: r.ok ? `settled series ${series} on ${acc.count} prints` : `settle failed: ${r.error}` });
      settled = r.ok;
    }
    if (!settled) return;
    for (const agent of this.#ctx.agents) {
      const pos = yield* this.#view("get_position", { series, account_id: agent.id });
      if (pos.long + pos.short === 0) continue;
      const r = yield* this.#change(agent.id, "redeem", { series });
      this.#entry({ action: "redeem", status: r.ok ? "done" : "failed", agent: agent.id, series, text: r.ok ? `redeemed ${pos.long} LONG and ${pos.short} SHORT` : `redeem failed: ${r.error}` });
    }
  }

  *#commit(params: WireParams, tp: TimeParams, live: WireLiveSeries, now: number): Plan<void> {
    const series = live.series;
    const round = live.round!;
    const book = yield* this.#view("get_round", { series, round });
    const done = new Set(book?.commits.map((c) => c.owner) ?? []);
    const todo = this.#ctx.agents.filter((a) => !done.has(a.id));
    if (todo.length === 0) return;

    let rec = yield* this.#view("get_series", { series });
    const last = yield* this.#view("get_last_print", {});
    let band: { floor: number; band: number };
    if (rec) band = rec;
    else if (last && now - last.bucket <= params.max_anchor_age_secs) band = computeBand(last.price, params.tick, params.band_bps);
    else {
      this.#entry({ action: "commit", status: "skipped", series, round, text: "index is stale: the series cannot open yet" });
      return;
    }
    const accumulator = yield* this.#view("get_accumulator", { series });
    const window = 24 * params.print_interval_secs;
    const prints = (yield* this.#view("get_prints", { from_bucket: Math.max(0, now - window), limit: 24 })).map((p) => ({ bucket: p.bucket, price: p.price! }));
    const results = yield* this.#view("get_results", { series, from_round: Math.max(0, round - 6), limit: 6 });
    const roundsLeft = roundCount(tp, series) - round;

    for (const agent of todo) {
      const at = { agent: agent.id, series, round };
      const account = yield* this.#view("get_account", { account_id: agent.id });
      if (!account) {
        this.#entry({ action: "commit", status: "skipped", ...at, text: "not registered" });
        continue;
      }
      const position = yield* this.#view("get_position", { series, account_id: agent.id });
      const view: AgentView = {
        params, now, series, floor: band.floor, band: band.band, round, roundsLeft,
        lastPrint: last, prints, accumulator, position, free: BigInt(account.balance), results,
      };
      const intents = agent.decide(view, rngFor(this.#ctx.secret, series, round, agent.id)).slice(0, MAX_ORDERS_PER_ROUND);
      if (intents.length === 0) continue;
      // Store, commit, store the seq: three calls per order, all or none for this agent.
      if (this.log.calls + 3 * intents.length > this.#budget) throw new OutOfBudget();
      for (const [n, o] of intents.entries()) {
        const salt = saltFor(this.#ctx.secret, series, round, agent.id, n);
        const hash = commitHash({ series, round, accountId: agent.id, side: o.side, size: o.size, price: o.price, salt });
        const lock = lockOf(o, band.band);
        const key = orderKey(this.#ctx.market, series, round, agent.id, n);
        const order: StoredOrder = { ...o, salt, hash, seq: null };
        if (!(yield* this.#put(key, JSON.stringify(order)))) {
          this.#entry({ action: "commit", status: "failed", ...at, text: "could not store the order; not committed" });
          break;
        }
        const r = yield* this.#change(agent.id, "commit", { series, hash, lock: lock.toString() });
        const text = r.ok ? `sealed an order, locking ${usd(lock)}` : `commit failed: ${r.error}`;
        this.#entry({ action: "commit", status: r.ok ? "done" : "failed", ...at, text, data: { n, hash, lock: lock.toString(), seq: r.ok ? r.value : null } });
        if (!r.ok) break;
        yield* this.#put(key, JSON.stringify({ ...order, seq: r.value }));
        // The first commit opens the series; read the band it was really opened with.
        if (!rec) {
          rec = yield* this.#view("get_series", { series });
          if (rec) band = rec;
        }
      }
    }
  }

  *#view<M extends ViewMethod>(method: M, args: ViewMethods[M]["args"]): Plan<ViewMethods[M]["result"]> {
    if (this.log.calls >= this.#budget) throw new OutOfBudget();
    this.log.calls++;
    const r = yield { kind: "view", method, args };
    if (!r.ok) throw new Error(`view ${method} failed: ${r.error}`);
    return r.value as ViewMethods[M]["result"];
  }

  *#change<M extends PortChange>(agent: string | null, method: M, args: PortChanges[M]["args"]): Plan<Reply> {
    if (this.log.calls >= this.#budget) throw new OutOfBudget();
    this.log.calls++;
    return yield { kind: "change", agent, method, args };
  }

  *#get(key: string): Plan<string | null> {
    if (this.log.calls >= this.#budget) throw new OutOfBudget();
    this.log.calls++;
    const r = yield { kind: "get", key };
    if (!r.ok) throw new Error(`store read failed: ${r.error}`);
    return r.value as string | null;
  }

  /** True when stored. */
  *#put(key: string, value: string): Plan<boolean> {
    if (this.log.calls >= this.#budget) throw new OutOfBudget();
    this.log.calls++;
    return (yield { kind: "put", key, value }).ok;
  }

  #entry(e: LogEntry): void {
    this.log.entries.push(e);
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function portFor<P, S>(ctx: SwarmContext<P, S>, call: Call & { kind: "view" | "change" }): P {
  const agent = call.kind === "change" ? call.agent : null;
  const port = agent !== null ? ctx.ports[agent] : (ctx.keeper ?? ctx.ports[ctx.agents[0]?.id ?? ""]);
  if (!port) throw new Error(`no port for ${agent ?? "the keeper"}`);
  return port;
}

/** One tick on any `WeirPort`. Resolves with what it did; never rejects for a failed call. */
export async function tick(ctx: SwarmContext<WeirPort, OrderStore>): Promise<TickLog> {
  const planner = new Planner(ctx);
  const plan = planner.run();
  let step = plan.next();
  while (!step.done) {
    const call = step.value;
    let reply: Reply;
    try {
      let value: unknown;
      if (call.kind === "get") value = await ctx.store.get(call.key);
      else if (call.kind === "put") value = await ctx.store.put(call.key, call.value);
      else if (call.kind === "view") value = await portFor(ctx, call).view(call.method, call.args as never);
      else value = await portFor(ctx, call).change(call.method, call.args as never);
      reply = { ok: true, value };
    } catch (e) {
      reply = { ok: false, error: errorText(e) };
    }
    step = plan.next(reply);
  }
  return planner.log;
}

/** The same tick, synchronously, on the model. */
export function tickSync(ctx: SwarmContext<SyncWeir, SyncOrderStore>): TickLog {
  const planner = new Planner(ctx);
  const plan = planner.run();
  let step = plan.next();
  while (!step.done) {
    const call = step.value;
    let reply: Reply;
    try {
      let value: unknown;
      if (call.kind === "get") value = ctx.store.get(call.key);
      else if (call.kind === "put") value = ctx.store.put(call.key, call.value);
      else if (call.kind === "view") value = portFor(ctx, call).view(call.method, call.args as never);
      else value = portFor(ctx, call).change(call.method, call.args as never);
      reply = { ok: true, value };
    } catch (e) {
      reply = { ok: false, error: errorText(e) };
    }
    step = plan.next(reply);
  }
  return planner.log;
}
