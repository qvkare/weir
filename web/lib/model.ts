// Model mode (WEIR_MODEL=1): the engine's Market, driven by a fixed script against the wall
// clock, answers the same views as the chain through callView. Reporters print a made-up H100
// path, scripted agents commit and reveal each round, a keeper clears, settles and redeems.
// Every page that shows these figures carries the "Model data, not the chain" ribbon.
import { auctionClose, auctionOpen, callView, commitHash, computeBand, deliveryEnd, Market, roundCount, roundEnd, roundSecs, roundStart, seriesOf, sha256Hex } from "@weir/engine";
import type { Params, Side, ViewMethod, ViewMethods } from "@weir/engine";
import type { MarketId } from "./config.ts";
import { PRESETS } from "@weir/agents/sim";
import { paramsFromWire } from "@weir/chain";

const HOUR = 3600;
const DAY = 86_400;

/** The same parameters the deployment uses (agents/src/presets.ts), as the engine takes them. */
export const MODEL_PARAMS: Record<MarketId, Params> = {
  weekly: paramsFromWire(PRESETS.weekly),
  fast: paramsFromWire(PRESETS.fast),
};

export interface ModelAgent {
  id: string;
  role: "buyer" | "seller" | "maker";
  rule: string;
  /** True for an account that holds only a function-call key. */
  functionCallOnly: boolean;
}

export const MODEL_AGENTS: ModelAgent[] = [
  { id: "buyer-ana.model", role: "buyer", rule: "Bids LONG at the reference price plus up to 6% of the band", functionCallOnly: false },
  { id: "buyer-ben.model", role: "buyer", rule: "Bids LONG from 8% of the band under the reference to 4% over", functionCallOnly: false },
  { id: "buyer-cy.model", role: "buyer", rule: "Agent key; bids LONG within 4% of the band of the reference, skips a reveal 1 round in 8", functionCallOnly: true },
  { id: "seller-dee.model", role: "seller", rule: "Offers SHORT from 4% of the band under the reference to 8% over", functionCallOnly: false },
  { id: "seller-eli.model", role: "seller", rule: "Offers SHORT at the reference, large sizes", functionCallOnly: false },
  { id: "maker-fay.model", role: "maker", rule: "Agent key; quotes both sides 4% of the band around the reference", functionCallOnly: true },
];

export const MODEL_KEEPER = "keeper.model";
export const modelContract = (id: MarketId) => `${id}.weir.model`;

// Deterministic randomness: FNV-1a of a key, then mulberry32.
function seedOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(key: string): () => number {
  let a = seedOf(key);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The made-up H100 path in micro-USD per GPU-hour. */
export function modelIndex(id: MarketId, t: number): number {
  const base = 2_700_000;
  const w = id === "weekly" ? [23 * DAY, 3.1 * DAY, 0.06, 0.025] : [5 * HOUR, 47 * 60, 0.04, 0.015];
  const noise = rng(`${id}|path|${t}`)() - 0.5;
  const v = base * (1 + w[2]! * Math.sin((2 * Math.PI * t) / w[0]!) + w[3]! * Math.sin((2 * Math.PI * t) / w[1]!) + noise * 0.008);
  return Math.round(v / 1000) * 1000;
}

interface Pending {
  seq: number;
  side: Side;
  size: number;
  price: number;
  salt: string;
  reveal: boolean;
}

interface ModelState {
  id: MarketId;
  market: Market;
  until: number;
  pending: Map<string, Pending>;
  deposited: bigint;
}

type Ev = { at: number; run: (s: ModelState) => void };

function reference(st: ModelState, series: number): { floor: number; band: number; ref: number } | null {
  const last = st.market.getLastPrint();
  if (!last) return null;
  const opened = st.market.getSeries(series);
  const p = st.market.params;
  let floor: number;
  let band: number;
  if (opened) ({ floor, band } = opened);
  else {
    try {
      ({ floor, band } = computeBand(last.price, p.tick, p.bandBps));
    } catch {
      return null;
    }
  }
  return { floor, band, ref: Math.min(Math.max(last.price - floor, 0), band) };
}

function agentOrders(st: ModelState, agent: ModelAgent, k: number, series: number, round: number): Omit<Pending, "seq">[] {
  const r = rng(`${st.id}|${series}|${round}|${agent.id}`);
  if (r() > (agent.role === "maker" ? 0.85 : 0.7)) return [];
  const info = reference(st, series);
  if (!info) return [];
  const { tick } = st.market.params;
  const scale = st.id === "weekly" ? 8 : 1;
  const clampPrice = (p: number) => Math.min(Math.max(Math.round(p / tick) * tick, tick), info.band - tick);
  // One price step is 2% of the band, so orders spread visibly across it.
  const unit = Math.max(tick, Math.round((info.band * 0.02) / tick) * tick);
  const ticks = (lo: number, hi: number) => (lo + Math.floor(r() * (hi - lo + 1))) * unit;
  const size = (lo: number, hi: number) => scale * (lo + Math.floor(r() * (hi - lo + 1)));
  const salt = (n: number) => sha256Hex(`${st.id}|salt|${series}|${round}|${agent.id}|${n}`).slice(0, 32);
  const skip = agent.id === "buyer-cy.model" && r() < 0.125;
  const out: Omit<Pending, "seq">[] = [];
  switch (agent.id) {
    case "buyer-ana.model":
      out.push({ side: "Long", size: size(8, 60), price: clampPrice(info.ref + ticks(0, 3)), salt: salt(0), reveal: true });
      break;
    case "buyer-ben.model":
      out.push({ side: "Long", size: size(4, 40), price: clampPrice(info.ref + ticks(-4, 2)), salt: salt(0), reveal: true });
      break;
    case "buyer-cy.model":
      out.push({ side: "Long", size: size(2, 24), price: clampPrice(info.ref + ticks(-2, 2)), salt: salt(0), reveal: !skip });
      break;
    case "seller-dee.model":
      out.push({ side: "Short", size: size(8, 50), price: clampPrice(info.ref + ticks(-2, 4)), salt: salt(0), reveal: true });
      break;
    case "seller-eli.model":
      out.push({ side: "Short", size: size(20, 90), price: clampPrice(info.ref + ticks(-1, 1)), salt: salt(0), reveal: true });
      break;
    case "maker-fay.model":
      out.push({ side: "Long", size: size(4, 20), price: clampPrice(info.ref - 2 * unit), salt: salt(0), reveal: true });
      out.push({ side: "Short", size: size(4, 20), price: clampPrice(info.ref + 2 * unit), salt: salt(1), reveal: true });
      break;
  }
  void k;
  return out;
}

const attempt = (f: () => void) => {
  try {
    f();
  } catch {
    // A call that panics on chain changes nothing; the script moves on, as a real agent would.
  }
};

/** Every scripted call with a time in [a, b). */
function schedule(st: ModelState, a: number, b: number): Ev[] {
  const p = st.market.params;
  const evs: Ev[] = [];
  const I = p.printIntervalSecs;
  const offsets = st.id === "weekly" ? { report: 40, commit: 300, reveal: 90 } : { report: 15, commit: 25, reveal: 15 };

  // Reports: reporter i reports each bucket at bucket + offset * (i + 1); reporter 3 sometimes misses one.
  for (let bucket = Math.ceil((a - 3 * offsets.report - I) / I) * I; bucket < b; bucket += I) {
    p.reporters.forEach((rep, i) => {
      const at = bucket + offsets.report * (i + 1);
      if (at < a || at >= b) return;
      if (i === 2 && rng(`${st.id}|miss|${bucket}`)() < 0.2) return;
      const base = modelIndex(st.id, bucket);
      const jitter = (rng(`${st.id}|rep|${bucket}|${i}`)() - 0.5) * 0.012;
      const price = Math.round((base * (1 + jitter)) / 1000) * 1000;
      evs.push({ at, run: (s) => attempt(() => s.market.report(rep, bucket, price, sha256Hex(`weir-model-bundle|${bucket}|${rep}`))) });
    });
  }

  // Rounds of every series whose auction window meets [a, b), and settlement after delivery.
  const first = Math.max(0, Math.floor((a - p.periodSecs - p.voidAfterSecs - p.t0) / p.periodSecs));
  for (let series = first; auctionOpen(p, series) < b; series++) {
    if (auctionClose(p, series) + 10 >= a) {
      const rounds = roundCount(p, series);
      const from = Math.max(0, Math.floor((a - auctionOpen(p, series)) / roundSecs(p)) - 1);
      for (let round = from; round < rounds && roundStart(p, series, round) < b; round++) {
        const start = roundStart(p, series, round);
        const commitEnd = start + p.commitSecs;
        MODEL_AGENTS.forEach((agent, k) => {
          const cAt = start + 5 + offsets.commit * k;
          if (cAt >= a && cAt < b) {
            evs.push({
              at: cAt,
              run: (s) => {
                agentOrders(s, agent, k, series, round).forEach((o, n) => {
                  const lock = BigInt(o.size) * BigInt(reference(s, series)!.band);
                  attempt(() => {
                    const hash = commitHash({ series, round, accountId: agent.id, side: o.side, size: o.size, price: o.price, salt: o.salt });
                    const seq = s.market.commit(agent.id, series, hash, lock);
                    s.pending.set(`${series}|${round}|${agent.id}|${n}`, { ...o, seq });
                  });
                });
              },
            });
          }
          const rAt = commitEnd + 5 + offsets.reveal * k;
          if (rAt >= a && rAt < b) {
            evs.push({
              at: rAt,
              run: (s) => {
                for (let n = 0; n < 2; n++) {
                  const key = `${series}|${round}|${agent.id}|${n}`;
                  const o = s.pending.get(key);
                  if (!o) continue;
                  s.pending.delete(key);
                  if (o.reveal) attempt(() => s.market.reveal(agent.id, series, round, o.seq, o.side, o.size, o.price, o.salt));
                }
              },
            });
          }
        });
        const clearAt = roundEnd(p, series, round) + 2;
        if (clearAt >= a && clearAt < b) evs.push({ at: clearAt, run: (s) => attempt(() => s.market.clear(series, round)) });
      }
    }
    const settleAt = deliveryEnd(p, series) + p.reportGraceSecs + 5;
    if (settleAt >= a && settleAt < b) {
      evs.push({
        at: settleAt,
        run: (s) =>
          attempt(() => {
            s.market.settle(series);
            for (const agent of MODEL_AGENTS) attempt(() => s.market.redeem(series, agent.id));
          }),
      });
    }
  }
  return evs.sort((x, y) => x.at - y.at);
}

const states = new Map<MarketId, ModelState>();

function start(id: MarketId, now: number): ModelState {
  const p = MODEL_PARAMS[id];
  const current = seriesOf(p, now) ?? 0;
  // Enough history for a settled series, the one delivering now and the one in auction.
  const back = id === "weekly" ? 2 : 8;
  const begin = Math.max(p.t0, auctionOpen(p, Math.max(0, current - back)) - 2 * p.printIntervalSecs);
  const market = new Market(p, begin);
  let deposited = 0n;
  for (const agent of MODEL_AGENTS) {
    market.register(agent.id);
    market.deposit(agent.id, 2_000_000_000_000n);
    deposited += 2_000_000_000_000n;
  }
  market.register(MODEL_KEEPER);
  return { id, market, until: begin, pending: new Map(), deposited };
}

/** The model market of `id`, advanced to `now` (Unix seconds). */
export function modelMarket(id: MarketId, now = Math.floor(Date.now() / 1000)): ModelState {
  let st = states.get(id);
  if (!st || now < st.market.now) {
    st = start(id, now);
    states.set(id, st);
  }
  if (now >= st.until) {
    for (const ev of schedule(st, st.until, now + 1)) {
      if (ev.at < st.market.now) continue;
      st.market.setTime(ev.at);
      ev.run(st);
    }
    st.market.setTime(now);
    st.until = now + 1;
  }
  return st;
}

export function modelView<M extends ViewMethod>(id: MarketId, method: M, args: ViewMethods[M]["args"], now?: number): ViewMethods[M]["result"] {
  return callView(modelMarket(id, now).market, method, args);
}

/** The model's own count of USDC deposited, standing in for the token balance. */
export const modelTokenBalance = (id: MarketId): bigint => {
  const st = modelMarket(id);
  let paidOut = 0n;
  for (const e of st.market.events) if (e.event === "withdraw") paidOut += e.data.amount;
  return st.deposited - paidOut;
};

