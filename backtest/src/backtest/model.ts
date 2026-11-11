// The backtest's arithmetic, as pure functions on integer micro-USD prices.
// Band and payoff come from the engine (spec sections 6.1 and 10).

import { computeBand, fixingOf, payouts } from "@weir/engine";
import { addDays } from "../lib/dates.ts";

export const PARAMS = {
  /** Price increment, micro-USD per GPU-hour ($0.001), as in the engine's fixtures. */
  tick: 1000,
  bandBpsGrid: [1000, 1500, 2000, 2500, 3000, 4000],
  /** Smallest band_bps whose fixing stayed inside the band in at least this share of weeks. */
  coverageTarget: 0.95,
  /** Auctions for a week open this many days before delivery starts. */
  leadDays: 7,
  /** Oldest daily print (by its day's start) a series may be opened on, in days. */
  maxAnchorAgeDays: 3,
  /** Daily index values a delivery week needs for a fixing. */
  minDeliveryPrints: 4,
  /** 8 GPUs for a 168-hour week. */
  hoursPerWeek: 1344,
  forwardShifts: [-0.05, -0.02, 0, 0.02, 0.05],
  /** Weeks a provider needs in the basis-risk table. */
  minProviderWeeks: 20,
} as const;

export type Series = Map<string, number>;

export interface WeekCore {
  /** Monday the delivery week starts (00:00 UTC). */
  week: string;
  /** Day of the daily print used as the anchor. */
  anchorDay: string;
  anchor: number;
  prints: number;
  fixing: number;
}

export type WeekVerdict = { ok: true; core: WeekCore } | { ok: false; week: string; reason: "stale_anchor" | "few_prints" };

/**
 * A daily print for day X is treated as the print of the bucket starting X 00:00 UTC;
 * it is final when that day ends. At the auction opening (`week - leadDays`, 00:00)
 * the latest final print is X = opening - 1 day, and the anchor must satisfy
 * opening - X <= maxAnchorAgeDays. Delivery prints are the days week .. week+6.
 */
export function evaluateWeek(index: Series, week: string, p = PARAMS): WeekVerdict {
  const opening = addDays(week, -p.leadDays);
  let anchorDay: string | null = null;
  for (let age = 1; age <= p.maxAnchorAgeDays; age++) {
    const d = addDays(opening, -age);
    if (index.has(d)) {
      anchorDay = d;
      break;
    }
  }
  if (!anchorDay) return { ok: false, week, reason: "stale_anchor" };
  let sum = 0n;
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const v = index.get(addDays(week, i));
    if (v !== undefined) {
      sum += BigInt(v);
      count++;
    }
  }
  if (count < p.minDeliveryPrints) return { ok: false, week, reason: "few_prints" };
  const { fixing } = fixingOf({ sum, count, minPrints: p.minDeliveryPrints, voidAllowed: false, floor: 0, band: 0, openSets: 0, pool: 0n });
  return { ok: true, core: { week, anchorDay, anchor: index.get(anchorDay)!, prints: count, fixing } };
}

export interface WeekAtBand extends WeekCore {
  mid: number;
  half: number;
  floor: number;
  band: number;
  cap: number;
  inside: boolean;
  longPayout: number;
  shortPayout: number;
}

export function atBand(c: WeekCore, bandBps: number, tick: number = PARAMS.tick): WeekAtBand {
  const b = computeBand(c.anchor, tick, bandBps);
  const pay = payouts(c.fixing, b.floor, b.band);
  const cap = b.floor + b.band;
  return { ...c, ...b, cap, inside: c.fixing >= b.floor && c.fixing <= cap, ...pay };
}

/** LONG price for a forward of mid * (1 + shift), on the tick grid, strictly inside (0, band). */
export function longPrice(w: WeekAtBand, shift: number, tick: number = PARAMS.tick): number {
  if (shift === 0) return w.half;
  const raw = Math.round((w.mid * (1 + shift) - w.floor) / tick) * tick;
  return Math.min(Math.max(raw, tick), w.band - tick);
}

export interface Hedge {
  /** LONG price paid per unit. */
  p: number;
  forward: number;
  /** Buyer's cost per GPU-hour: spot, and spot - LONG payout + p. */
  buyerUnhedged: number;
  buyerHedged: number;
  /** Seller's revenue per GPU-hour: spot, and spot + SHORT payout - (band - p). */
  sellerUnhedged: number;
  sellerHedged: number;
  /** Dollars locked per GPU-hour hedged: buyer pays p, seller pays band - p. */
  buyerLock: number;
  sellerLock: number;
}

/** `spot` is the price paid or earned per GPU-hour; the hedge settles on the index. */
export function hedge(w: WeekAtBand, p: number, spot: number = w.fixing): Hedge {
  return {
    p,
    forward: w.floor + p,
    buyerUnhedged: spot,
    buyerHedged: spot - w.longPayout + p,
    sellerUnhedged: spot,
    sellerHedged: spot + w.shortPayout - (w.band - p),
    buyerLock: p,
    sellerLock: w.band - p,
  };
}

// ---- statistics (floats, for reporting) ----

export function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n - 1). */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** Linear-interpolation percentile on sorted data (numpy's default). */
export function percentile(sorted: number[], q: number): number {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (h - lo);
}

/** Wilson score interval for k successes in n trials, 95%. */
export function wilson(k: number, n: number): [number, number] {
  const z = 1.959963984540054;
  const ph = k / n;
  const den = 1 + (z * z) / n;
  const centre = (ph + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / den;
  return [centre - half, centre + half];
}
