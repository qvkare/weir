// Every number in results/: computed from the daily index and provider series alone.

import { median } from "@weir/engine";
import { addDays, daysBetween } from "../lib/dates.ts";
import { MICRO } from "../lib/money.ts";
import {
  PARAMS,
  atBand,
  evaluateWeek,
  hedge,
  longPrice,
  mean,
  percentile,
  sd,
  wilson,
} from "./model.ts";
import type { Series, WeekAtBand, WeekCore } from "./model.ts";

export interface Inputs {
  /** All days of the index window, in order, including days without a value. */
  days: string[];
  index: Series;
  /** Provider id → daily series. */
  providers: Map<string, Series>;
  /** Providers kept out of the composite (hyperscalers). */
  outOfComposite: Set<string>;
}

const r6 = (x: number): number => Number(x.toFixed(6));
const r4 = (x: number): number => Number(x.toFixed(4));
const r2 = (x: number): number => Number(x.toFixed(2));
const usd = (micro: number): number => r6(micro / MICRO);
/** Weekly dollars for `hours` GPU-hours at `micro` per GPU-hour. */
const weekly = (micro: number, hours: number): number => (micro * hours) / MICRO;

export function mondaysIn(days: string[]): string[] {
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const out: string[] = [];
  // 2024-11-04 is a Monday; step from the first Monday on or after `first`.
  let d = addDays("2024-11-04", Math.ceil(daysBetween("2024-11-04", first) / 7) * 7);
  for (; addDays(d, 6) <= last; d = addDays(d, 7)) out.push(d);
  return out;
}

export function selectWeeks(inp: Inputs) {
  // Candidate weeks lie inside the span of the index (first to last day with a value):
  // the anchor day can be no earlier than the first value, delivery no later than the last.
  const withValue = inp.days.filter((d) => inp.index.has(d));
  if (!withValue.length) return { mondays: [] as string[], kept: [] as WeekCore[], excluded: [] as Array<{ week: string; reason: string }> };
  const first = withValue[0]!;
  const last = withValue[withValue.length - 1]!;
  const mondays = mondaysIn(inp.days).filter((w) => addDays(w, -PARAMS.leadDays - 1) >= first && addDays(w, 6) <= last);
  const kept: WeekCore[] = [];
  const excluded: Array<{ week: string; reason: string }> = [];
  for (const w of mondays) {
    const v = evaluateWeek(inp.index, w);
    if (v.ok) kept.push(v.core);
    else excluded.push({ week: v.week, reason: v.reason });
  }
  return { mondays, kept, excluded };
}

interface Stat {
  mean: number;
  sd: number;
  min: number;
  max: number;
  total: number;
}

function stat(xs: number[]): Stat {
  return {
    mean: r2(mean(xs)),
    sd: r2(sd(xs)),
    min: r2(Math.min(...xs)),
    max: r2(Math.max(...xs)),
    total: r2(xs.reduce((a, b) => a + b, 0)),
  };
}

/** Largest change between two consecutive calendar weeks that are both in the sample. */
function largestStep(weeks: string[], xs: number[], sign: 1 | -1) {
  let best: { from_week: string; to_week: string; change: number } | null = null;
  for (let i = 1; i < weeks.length; i++) {
    if (addDays(weeks[i - 1]!, 7) !== weeks[i]) continue;
    const ch = (xs[i]! - xs[i - 1]!) * sign;
    if (!best || ch > best.change) best = { from_week: weeks[i - 1]!, to_week: weeks[i]!, change: ch };
  }
  return best ? { ...best, change: r2(best.change * sign) } : null;
}

function varianceRemoved(unhedged: number[], hedged: number[]): number | null {
  const vu = sd(unhedged) ** 2;
  if (vu === 0) return null;
  return r4(1 - sd(hedged) ** 2 / vu);
}

/** Buyer and seller results for one LONG-price rule over a set of weeks. */
export function hedgeBlock(ws: WeekAtBand[], shift: number) {
  const H = PARAMS.hoursPerWeek;
  const weeks = ws.map((w) => w.week);
  const hs = ws.map((w) => hedge(w, longPrice(w, shift)));
  const anchorCost = ws.map((w) => weekly(w.anchor, H));
  const bu = hs.map((h) => weekly(h.buyerUnhedged, H));
  const bh = hs.map((h) => weekly(h.buyerHedged, H));
  const su = hs.map((h) => weekly(h.sellerUnhedged, H));
  const sh = hs.map((h) => weekly(h.sellerHedged, H));
  const surprise = (xs: number[]) => xs.map((x, i) => x - anchorCost[i]!);
  const clamped = ws.filter((w) => {
    const target = Math.round((w.mid * (1 + shift) - w.floor) / PARAMS.tick) * PARAMS.tick;
    return shift !== 0 && target !== longPrice(w, shift);
  }).length;
  return {
    forward_shift: shift,
    weeks: ws.length,
    long_price_clamped_weeks: clamped,
    mean_forward_usd_per_gpu_hour: usd(mean(hs.map((h) => h.forward))),
    buyer: {
      unhedged_weekly_cost: stat(bu),
      hedged_weekly_cost: stat(bh),
      sd_of_surprise: { unhedged: r2(sd(surprise(bu))), hedged: r2(sd(surprise(bh))) },
      variance_removed: varianceRemoved(bu, bh),
      surprise_variance_removed: varianceRemoved(surprise(bu), surprise(bh)),
      largest_week_on_week_increase: { unhedged: largestStep(weeks, bu, 1), hedged: largestStep(weeks, bh, 1) },
      hedge_cost_total: r2(bh.reduce((a, b) => a + b, 0) - bu.reduce((a, b) => a + b, 0)),
      locked_per_week: stat(hs.map((h) => weekly(h.buyerLock, H))),
    },
    seller: {
      unhedged_weekly_revenue: stat(su),
      hedged_weekly_revenue: stat(sh),
      sd_of_surprise: { unhedged: r2(sd(surprise(su))), hedged: r2(sd(surprise(sh))) },
      variance_removed: varianceRemoved(su, sh),
      surprise_variance_removed: varianceRemoved(surprise(su), surprise(sh)),
      largest_week_on_week_decrease: { unhedged: largestStep(weeks, su, -1), hedged: largestStep(weeks, sh, -1) },
      hedge_gain_total: r2(sh.reduce((a, b) => a + b, 0) - su.reduce((a, b) => a + b, 0)),
      locked_per_week: stat(hs.map((h) => weekly(h.sellerLock, H))),
    },
  };
}

function moveDistribution(cores: WeekCore[]) {
  const moves = cores.map((c) => c.fixing / c.anchor - 1);
  const sorted = [...moves].sort((a, b) => a - b);
  const qs = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];
  const byMove = cores.map((c, i) => ({ week: c.week, move: moves[i]! }));
  const top = (cmp: (a: { move: number }, b: { move: number }) => number) =>
    [...byMove].sort((a, b) => cmp(a, b) || (a.week < b.week ? -1 : 1)).slice(0, 5).map((x) => ({ week: x.week, move: r6(x.move) }));
  return {
    weeks: moves.length,
    mean: r6(mean(moves)),
    sd: r6(sd(moves)),
    min: r6(sorted[0]!),
    max: r6(sorted[sorted.length - 1]!),
    percentiles: Object.fromEntries(qs.map((q) => [`p${Math.round(q * 100)}`, r6(percentile(sorted, q))])),
    abs_percentiles: Object.fromEntries(
      [0.5, 0.9, 0.95, 0.99].map((q) => [`p${Math.round(q * 100)}`, r6(percentile(moves.map(Math.abs).sort((a, b) => a - b), q))]),
    ),
    largest_rises: top((a, b) => b.move - a.move),
    largest_falls: top((a, b) => a.move - b.move),
  };
}

function coverage(cores: WeekCore[]) {
  return PARAMS.bandBpsGrid.map((bps) => {
    const ws = cores.map((c) => atBand(c, bps));
    const inside = ws.filter((w) => w.inside).length;
    const [lo, hi] = wilson(inside, ws.length);
    return {
      band_bps: bps,
      weeks: ws.length,
      inside,
      above_cap: ws.filter((w) => w.fixing > w.cap).length,
      below_floor: ws.filter((w) => w.fixing < w.floor).length,
      share_inside: r4(inside / ws.length),
      share_inside_wilson95: [r4(lo), r4(hi)] as [number, number],
    };
  });
}

export function recommend(cov: ReturnType<typeof coverage>) {
  const pick = cov.find((c) => c.share_inside >= PARAMS.coverageTarget);
  return {
    rule: `smallest band_bps in ${JSON.stringify(PARAMS.bandBpsGrid)} whose fixing stayed inside the band in at least ${PARAMS.coverageTarget * 100}% of weeks`,
    band_bps: pick ? pick.band_bps : PARAMS.bandBpsGrid[PARAMS.bandBpsGrid.length - 1]!,
    met: Boolean(pick),
    /** For context: the smallest band with no breach at all in the sample. */
    no_breach_band_bps: cov.find((c) => c.inside === c.weeks)?.band_bps ?? null,
    /** For context: the smallest band whose 95% Wilson lower bound reaches the target. */
    lower_bound_band_bps: cov.find((c) => c.share_inside_wilson95[0] >= PARAMS.coverageTarget)?.band_bps ?? null,
  };
}

/**
 * Split the sample at the trough: the week with the lowest centred 5-week mean of the
 * fixing. Weeks up to and including it are the falling market, later weeks the rising
 * market. Returns null if the trough is within 4 weeks of either end.
 */
export function regimeSplit(cores: WeekCore[]): string | null {
  if (cores.length < 10) return null;
  let best: { week: string; v: number } | null = null;
  for (let i = 2; i < cores.length - 2; i++) {
    const v = mean(cores.slice(i - 2, i + 3).map((c) => c.fixing));
    if (!best || v < best.v) best = { week: cores[i]!.week, v };
  }
  if (!best) return null;
  const idx = cores.findIndex((c) => c.week === best!.week);
  if (idx < 4 || idx > cores.length - 5) return null;
  return best.week;
}

function capped(ws: WeekAtBand[]) {
  const H = PARAMS.hoursPerWeek;
  return ws
    .filter((w) => !w.inside)
    .map((w) => {
      const above = w.fixing > w.cap;
      const excess = above ? w.fixing - w.cap : w.floor - w.fixing;
      return {
        week: w.week,
        side: above ? "above_cap" : "below_floor",
        anchor: usd(w.anchor),
        fixing: usd(w.fixing),
        move: r6(w.fixing / w.anchor - 1),
        floor: usd(w.floor),
        cap: usd(w.cap),
        unhedged_excess_usd_per_gpu_hour: usd(excess),
        unhedged_excess_usd_per_week: r2(weekly(excess, H)),
        who_bears_it: above ? "buyer pays spot above the cap" : "seller earns spot below the floor",
      };
    });
}

export interface BasisRow {
  provider: string;
  in_composite: boolean;
  weeks: number;
  enough_history: boolean;
  first_week?: string;
  last_week?: string;
  mean_price?: number;
  sd_weekly_cost_surprise?: { unhedged: number; hedged: number };
  surprise_variance_removed?: number | null;
  correlation_of_moves_with_index?: number | null;
  verdict?: string;
}

function basis(inp: Inputs, ws: WeekAtBand[]): BasisRow[] {
  const H = PARAMS.hoursPerWeek;
  const rows: BasisRow[] = [];
  for (const [provider, series] of [...inp.providers.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const pts: Array<{ week: string; anchor: number; spot: number; hedged: number; index: number; indexAnchor: number }> = [];
    for (const w of ws) {
      let anchor: number | undefined;
      for (let age = 0; age < PARAMS.maxAnchorAgeDays && anchor === undefined; age++) {
        anchor = series.get(addDays(w.anchorDay, -age));
      }
      const vals: number[] = [];
      for (let i = 0; i < 7; i++) {
        const v = series.get(addDays(w.week, i));
        if (v !== undefined) vals.push(v);
      }
      if (anchor === undefined || vals.length < PARAMS.minDeliveryPrints) continue;
      const spot = Math.floor(vals.reduce((a, b) => a + b, 0) / vals.length);
      const h = hedge(w, w.half, spot);
      pts.push({ week: w.week, anchor, spot, hedged: h.buyerHedged, index: w.fixing, indexAnchor: w.anchor });
    }
    if (pts.length < PARAMS.minProviderWeeks) {
      rows.push({ provider, in_composite: !inp.outOfComposite.has(provider), weeks: pts.length, enough_history: false });
      continue;
    }
    const su = pts.map((p) => weekly(p.spot - p.anchor, H));
    const sh = pts.map((p) => weekly(p.hedged - p.anchor, H));
    const dp = pts.map((p) => p.spot / p.anchor - 1);
    const di = pts.map((p) => p.index / p.indexAnchor - 1);
    const md = mean(dp);
    const mi = mean(di);
    let cov = 0;
    for (let i = 0; i < dp.length; i++) cov += (dp[i]! - md) * (di[i]! - mi);
    const denom = sd(dp) * sd(di) * (dp.length - 1);
    const removed = varianceRemoved(su, sh);
    const verdict =
      removed === null
        ? "provider price never moved; the hedge only adds index risk"
        : removed < 0
          ? "hedge makes it worse"
          : removed < 0.25
            ? "hedge does little"
            : removed < 0.6
              ? "hedge helps partly"
              : "hedge removes most of it";
    rows.push({
      provider,
      in_composite: !inp.outOfComposite.has(provider),
      weeks: pts.length,
      enough_history: true,
      first_week: pts[0]!.week,
      last_week: pts[pts.length - 1]!.week,
      mean_price: usd(mean(pts.map((p) => p.spot))),
      sd_weekly_cost_surprise: { unhedged: r2(sd(su)), hedged: r2(sd(sh)) },
      surprise_variance_removed: removed,
      correlation_of_moves_with_index: denom === 0 ? null : r4(cov / denom),
      verdict,
    });
  }
  return rows;
}

function periodReport(cores: WeekCore[], bps: number) {
  if (!cores.length) return null;
  const ws = cores.map((c) => atBand(c, bps));
  return {
    first_week: cores[0]!.week,
    last_week: cores[cores.length - 1]!.week,
    weeks: cores.length,
    mean_fixing: usd(mean(cores.map((c) => c.fixing))),
    move: moveDistribution(cores),
    coverage: coverage(cores),
    hedge_neutral: hedgeBlock(ws, 0),
    capped_weeks: capped(ws).map((c) => c.week),
  };
}

export function analyse(inp: Inputs) {
  const sel = selectWeeks(inp);
  const cores = sel.kept;
  const cov = coverage(cores);
  const rec = recommend(cov);
  const ws = cores.map((c) => atBand(c, rec.band_bps));
  const split = regimeSplit(cores);
  const idxDays = inp.days.filter((d) => inp.index.has(d));
  return {
    parameters: {
      ...PARAMS,
      band_rule: "anchor = last daily index print; mid = anchor rounded down to tick; half = anchor * band_bps / 10000 rounded down to tick; floor = mid - half; band = 2 * half; cap = floor + band (engine computeBand)",
      payoff_rule: "LONG pays clamp(fixing - floor, 0, band); SHORT pays band - LONG payout (engine payouts); fixing = floor(sum / count) of the daily prints in the delivery week (engine fixingOf)",
      week_rule: "delivery week = Monday 00:00 UTC to the next Monday; auction opens leadDays before; anchor = latest daily print whose day started 1..maxAnchorAgeDays days before the opening; at least minDeliveryPrints daily prints in the delivery week",
      neutral_price: "LONG price p = half, so the forward floor + p equals mid (the anchor on the tick grid)",
      cost_rule: "unhedged weekly cost = fixing * hoursPerWeek (the buyer pays the index every hour, so the week's average price is the fixing); hedged = (fixing - LONG payout + p) * hoursPerWeek",
      surprise_rule: "surprise = weekly cost minus hoursPerWeek * anchor, i.e. the part of the week's cost not known when the auction opened",
      prices: "integer micro-USD per GPU-hour internally; dollars in outputs",
    },
    data: {
      first_day: inp.days[0],
      last_day: inp.days[inp.days.length - 1],
      days: inp.days.length,
      days_with_index: idxDays.length,
      days_without_index: inp.days.length - idxDays.length,
      first_index_day: idxDays[0] ?? null,
      last_index_day: idxDays[idxDays.length - 1] ?? null,
    },
    weeks: {
      candidate_mondays: sel.mondays.length,
      kept: cores.length,
      excluded: sel.excluded,
      first: cores[0]?.week ?? null,
      last: cores[cores.length - 1]?.week ?? null,
    },
    move: moveDistribution(cores),
    coverage: cov,
    recommendation: rec,
    hedge_neutral: hedgeBlock(ws, 0),
    capped_weeks: capped(ws),
    sensitivity: PARAMS.forwardShifts.map((s) => hedgeBlock(ws, s)),
    basis_risk: basis(inp, ws),
    regimes: {
      rule: "split at the week with the lowest centred 5-week mean fixing; falling = up to and including that week, rising = after it",
      trough_week: split,
      falling: split ? periodReport(cores.filter((c) => c.week <= split), rec.band_bps) : null,
      rising: split ? periodReport(cores.filter((c) => c.week > split), rec.band_bps) : null,
    },
    robustness_fixed_panel: fixedPanel(inp, idxDays),
  };
}

/**
 * The composite's provider set changes from day to day (Wayback captures and
 * marketplace snapshots come and go), and the median can step when it does. As a
 * check, rebuild the index from a fixed panel: in-composite providers with a value on
 * at least 95% of index days, on days when all of them have one.
 */
function fixedPanel(inp: Inputs, idxDays: string[]) {
  const panel = [...inp.providers.entries()]
    .filter(([p, s]) => !inp.outOfComposite.has(p) && idxDays.filter((d) => s.has(d)).length >= 0.95 * idxDays.length)
    .map(([p]) => p)
    .sort();
  if (panel.length < 3) return { providers: panel, note: "fewer than 3 providers qualify; not computed" };
  const index: Series = new Map();
  for (const d of inp.days) {
    const vals = panel.map((p) => inp.providers.get(p)!.get(d));
    if (vals.every((v) => v !== undefined)) index.set(d, median(vals as number[]));
  }
  const cores = selectWeeks({ ...inp, index }).kept;
  return {
    rule: "providers with a value on >= 95% of composite index days; median on days when all are present",
    providers: panel,
    days_with_value: index.size,
    weeks: cores.length,
    move: moveDistribution(cores),
    coverage: coverage(cores),
    composition_changes: idxDays.filter((d, i) => i > 0 && compositionOf(inp, d) !== compositionOf(inp, idxDays[i - 1]!)).length,
  };
}

function compositionOf(inp: Inputs, day: string): string {
  return [...inp.providers.entries()]
    .filter(([p, s]) => !inp.outOfComposite.has(p) && s.has(day))
    .map(([p]) => p)
    .sort()
    .join(";");
}

export type Summary = ReturnType<typeof analyse>;

export function weekRows(inp: Inputs, bps: number, split: string | null) {
  const { kept } = selectWeeks(inp);
  return kept.map((c) => {
    const w = atBand(c, bps);
    const h = hedge(w, w.half);
    return { w, h, regime: split === null ? "all" : c.week <= split ? "falling" : "rising" };
  });
}
