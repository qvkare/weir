// Contract JSON (engine/src/wire.ts, the single definition) to what the pages show.
import type { WireCommit, WireLiveSeries, WireParams, WirePrint, WireResult, WireRound } from "@weir/engine";
import { toBig } from "./format.ts";
import type { SeriesTimes } from "./timeline.ts";
import type { StepOrder } from "./step.ts";

export interface BookRow {
  seq: number;
  owner: string;
  lock: string;
  state: WireCommit["state"];
  /** The sealed commit hash. */
  hash: string | null;
  side: "Long" | "Short" | null;
  size: number | null;
  price: number | null;
}

export function bookRows(round: WireRound | null): BookRow[] {
  if (!round) return [];
  return [...round.commits]
    .sort((a, b) => a.seq - b.seq)
    .map((c) => ({ seq: c.seq, owner: c.owner, lock: c.lock, state: c.state, hash: c.hash ?? null, side: c.order?.side ?? null, size: c.order?.size ?? null, price: c.order?.price ?? null }));
}

export interface BookTotals {
  commits: number;
  revealed: number;
  void: number;
  sealed: number;
  /** micro-USDC, decimal string. */
  locked: string;
}

export function bookTotals(rows: BookRow[]): BookTotals {
  let locked = 0n;
  for (const r of rows) locked += toBig(r.lock) ?? 0n;
  return {
    commits: rows.length,
    revealed: rows.filter((r) => r.state === "Revealed").length,
    void: rows.filter((r) => r.state === "Void").length,
    sealed: rows.filter((r) => r.state === "Committed").length,
    locked: locked.toString(),
  };
}

export interface FillRow {
  seq: number;
  owner: string;
  side: "Long" | "Short";
  size: number;
  limit: number;
  filled: number;
  part: boolean;
  /** micro-USDC paid for the fill, decimal string: filled * p* for LONG, filled * (band - p*) for SHORT. */
  paid: string;
}

export function fillRows(result: WireResult | null, band: number | null): FillRow[] {
  if (!result) return [];
  return [...result.fills]
    .sort((a, b) => a.seq - b.seq)
    .map((f) => {
      const per = result.price === null || band === null ? 0 : f.side === "Long" ? result.price : band - result.price;
      return {
        seq: f.seq,
        owner: f.owner,
        side: f.side,
        size: f.size,
        limit: f.price,
        filled: f.filled,
        part: f.filled > 0 && f.filled < f.size,
        paid: (BigInt(f.filled) * BigInt(per)).toString(),
      };
    });
}

/** Orders of a round for the step chart: revealed, not void. From a result, with fills. */
export function stepOrdersFromResult(result: WireResult | null): StepOrder[] {
  return (result?.fills ?? []).map((f) => ({ seq: f.seq, owner: f.owner, side: f.side, size: f.size, price: f.price, filled: f.filled }));
}

/** From a round still open: only the revealed, non-void commits are known. */
export function stepOrdersFromRound(round: WireRound | null): StepOrder[] {
  return (round?.commits ?? []).filter((c) => c.state === "Revealed" && c.order).map((c) => ({ seq: c.seq, owner: c.owner, side: c.order!.side, size: c.order!.size, price: c.order!.price }));
}

export interface ResultSummary {
  price: number | null;
  forward: number | null;
  volume: number;
  orders: number;
  commits: number;
  /** Commits that did not take part: void or never revealed. */
  outside: number;
  forfeited: string;
  clearedAt: number;
}

export function summarize(result: WireResult, floor: number | null): ResultSummary {
  return {
    price: result.price,
    forward: result.price !== null && floor !== null ? floor + result.price : null,
    volume: result.volume,
    orders: result.orders,
    commits: result.commits,
    outside: Math.max(0, result.commits - result.orders),
    forfeited: result.forfeited,
    clearedAt: result.cleared_at,
  };
}

/** The last round with a result, from get_results' [[round, result], ...]. */
export function lastResult(results: [number, WireResult][] | null): { round: number; result: WireResult } | null {
  if (!results || results.length === 0) return null;
  const [round, result] = results.reduce((a, b) => (b[0] > a[0] ? b : a));
  return { round, result };
}

/** The last round that traded, if any, and the last cleared round. */
export function lastTraded(results: [number, WireResult][] | null): { round: number; result: WireResult } | null {
  const traded = (results ?? []).filter(([, r]) => r.price !== null);
  return lastResult(traded);
}

export function seriesTimes(live: Pick<WireLiveSeries, "series" | "auction_open" | "auction_close" | "delivery_start" | "delivery_end">, params: WireParams): SeriesTimes {
  return {
    series: live.series,
    auctionOpen: live.auction_open,
    auctionClose: live.auction_close,
    deliveryStart: live.delivery_start,
    deliveryEnd: live.delivery_end,
    settleAt: live.delivery_end + params.report_grace_secs,
    commitSecs: params.commit_secs,
    revealSecs: params.reveal_secs,
  };
}

/** Section 4 timing from parameters, for a series that is not in get_status. */
export function timesOf(series: number, p: WireParams): SeriesTimes {
  const deliveryStart = p.t0 + series * p.period_secs;
  const deliveryEnd = deliveryStart + p.period_secs;
  return {
    series,
    auctionOpen: Math.max(0, deliveryStart - p.lead_secs),
    auctionClose: Math.max(0, deliveryStart - p.cutoff_secs),
    deliveryStart,
    deliveryEnd,
    settleAt: deliveryEnd + p.report_grace_secs,
    commitSecs: p.commit_secs,
    revealSecs: p.reveal_secs,
  };
}

/** The series whose delivery window contains `now`, or null before t0. */
export const deliveringSeries = (p: WireParams, now: number): number | null => (now < p.t0 ? null : Math.floor((now - p.t0) / p.period_secs));

/** The next series whose auctions have not opened, and when its round 0 starts. */
export function nextOpening(p: WireParams, now: number): { series: number; at: number } {
  let s = Math.max(0, Math.floor((now + p.lead_secs - p.t0) / p.period_secs));
  while (Math.max(0, p.t0 + s * p.period_secs - p.lead_secs) <= now) s++;
  return { series: s, at: Math.max(0, p.t0 + s * p.period_secs - p.lead_secs) };
}

export interface ReporterRow {
  reporter: string;
  price: number;
  bundle: string;
}

export interface PrintView {
  bucket: number;
  price: number | null;
  final: boolean;
  reporters: ReporterRow[];
  /** The reporter whose report is the median, or both middle ones for an even count. */
  middle: string[];
}

export function printView(p: WirePrint | null): PrintView | null {
  if (!p) return null;
  const sorted = [...p.reports].sort((a, b) => a.price - b.price || (a.reporter < b.reporter ? -1 : 1));
  const n = sorted.length;
  const middle = n === 0 ? [] : n % 2 ? [sorted[(n - 1) / 2]!.reporter] : [sorted[n / 2 - 1]!.reporter, sorted[n / 2]!.reporter];
  return { bucket: p.bucket, price: p.price, final: p.final, reporters: sorted, middle };
}

/** Median of prices as the contract takes it: mean of the two middle values rounded down. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : Math.floor((s[n / 2 - 1]! + s[n / 2]!) / 2);
}

/** Running average of a series' prints, from get_accumulator. */
export function average(acc: { sum: string; count: number } | null): number | null {
  if (!acc || acc.count === 0) return null;
  const sum = toBig(acc.sum);
  return sum === null ? null : Number(sum / BigInt(acc.count));
}

/** Sum of get_totals' five terms, micro-USDC. */
export function totalsSum(t: { free: string; locked: string; sets_backing: string; pools: string; unredeemed: string } | null): bigint | null {
  if (!t) return null;
  let s = 0n;
  for (const v of [t.free, t.locked, t.sets_backing, t.pools, t.unredeemed]) {
    const b = toBig(v);
    if (b === null) return null;
    s += b;
  }
  return s;
}
