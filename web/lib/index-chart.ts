import { fmtPrice, fmtUtc } from "./format.ts";

// Geometry of the index chart (DESIGN section 5). The index is a step-after line over final
// prints; a missing print is a gap, never interpolated. Each reporter's own reports are thin
// lines, so the index reads as the middle of them. The current series' band and running
// average are drawn across its delivery window.

export interface IndexPrint {
  bucket: number;
  price: number;
  reports: { reporter: string; price: number }[];
}

export interface IndexChartInput {
  prints: IndexPrint[];
  interval: number;
  from: number;
  to: number;
  band: null | { floor: number; band: number; start: number; end: number; average: number | null };
  /** Buckets decided without a print (SPEC 9): marked on the axis, never drawn as a price. */
  noPrint?: number[];
  width: number;
  height: number;
}

export interface IndexChartGeometry {
  width: number;
  height: number;
  plot: { x0: number; x1: number; y0: number; y1: number };
  /** SVG path data; "M" starts a new run after a gap. */
  index: string;
  reporters: { reporter: string; path: string; labelY: number | null }[];
  /** False on narrow charts: reporter names go under the chart instead of at the right end. */
  endLabels: boolean;
  band: null | { x: number; w: number; y: number; h: number; avgY: number | null; average: number | null };
  yTicks: { y: number; price: number }[];
  xTicks: { x: number; t: number }[];
  last: null | { x: number; y: number; price: number };
  gaps: number;
  /** x of each bucket that ended with no print. */
  noPrint: number[];
}

export function indexChartGeometry(o: IndexChartInput): IndexChartGeometry {
  const narrow = o.width < 560;
  const plot = { x0: narrow ? 44 : 56, x1: o.width - (narrow ? 12 : 112), y0: 12, y1: o.height - 28 };
  const prints = o.prints.filter((p) => p.bucket >= o.from - o.interval && p.bucket <= o.to).sort((a, b) => a.bucket - b.bucket);
  const values: number[] = [];
  for (const p of prints) {
    values.push(p.price);
    for (const r of p.reports) values.push(r.price);
  }
  if (o.band) values.push(o.band.floor, o.band.floor + o.band.band);
  let lo = values.length ? Math.min(...values) : 0;
  let hi = values.length ? Math.max(...values) : 1_000_000;
  const pad = (hi - lo || hi || 1) * 0.1;
  lo = Math.max(0, lo - pad);
  hi = hi + pad;
  const X = (t: number) => plot.x0 + ((t - o.from) / (o.to - o.from || 1)) * (plot.x1 - plot.x0);
  const Y = (v: number) => plot.y1 - ((v - lo) / (hi - lo || 1)) * (plot.y1 - plot.y0);
  const clampX = (x: number) => Math.min(Math.max(x, plot.x0), plot.x1);

  // Step-after runs: each print holds until the next bucket; a missing bucket breaks the run.
  let gaps = 0;
  const runs = (get: (p: IndexPrint) => number | null) => {
    let d = "";
    let prev: IndexPrint | null = null;
    for (const p of prints) {
      const v = get(p);
      if (v === null) {
        prev = null;
        continue;
      }
      const x = clampX(X(p.bucket));
      const xe = clampX(X(p.bucket + o.interval));
      const y = Y(v).toFixed(1);
      if (prev && p.bucket - prev.bucket === o.interval) d += `V${y}H${xe.toFixed(1)}`;
      else {
        if (prev) gaps++;
        d += `M${x.toFixed(1)},${y}H${xe.toFixed(1)}`;
      }
      prev = p;
    }
    return d;
  };
  const index = runs((p) => p.price);
  const indexGaps = gaps;
  const names = [...new Set(prints.flatMap((p) => p.reports.map((r) => r.reporter)))].sort();
  const reporters = names.map((reporter) => {
    const path = runs((p) => p.reports.find((r) => r.reporter === reporter)?.price ?? null);
    const lastWith = [...prints].reverse().find((p) => p.reports.some((r) => r.reporter === reporter));
    const v = lastWith?.reports.find((r) => r.reporter === reporter)?.price;
    return { reporter, path, labelY: v === undefined ? null : Y(v) };
  });
  // Labels at the right end must not overlap: push them apart by 12 px.
  const order = reporters.filter((r) => r.labelY !== null).sort((a, b) => a.labelY! - b.labelY!);
  for (let i = 1; i < order.length; i++) if (order[i]!.labelY! - order[i - 1]!.labelY! < 12) order[i]!.labelY = order[i - 1]!.labelY! + 12;

  let band: IndexChartGeometry["band"] = null;
  if (o.band) {
    const xa = clampX(X(o.band.start));
    const xb = clampX(X(o.band.end));
    if (xb > xa) {
      band = {
        x: xa,
        w: xb - xa,
        y: Y(o.band.floor + o.band.band),
        h: Y(o.band.floor) - Y(o.band.floor + o.band.band),
        avgY: o.band.average === null ? null : Y(o.band.average),
        average: o.band.average,
      };
    }
  }

  const span = hi - lo;
  const raw = span / (narrow ? 4 : 5);
  const pw = 10 ** Math.floor(Math.log10(raw || 1));
  const step = Math.max(10_000, [1, 2, 5, 10].map((m) => m * pw).find((s) => s >= raw) ?? 10 * pw);
  const yTicks: { y: number; price: number }[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yTicks.push({ y: Y(v), price: v });

  const spanT = o.to - o.from;
  const tStep = [300, 900, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86_400, 2 * 86_400, 7 * 86_400].find((s) => spanT / s <= (narrow ? 4 : 7)) ?? 14 * 86_400;
  const xTicks: { x: number; t: number }[] = [];
  for (let t = Math.ceil(o.from / tStep) * tStep; t <= o.to; t += tStep) xTicks.push({ x: X(t), t });

  const lp = prints[prints.length - 1];
  return {
    width: o.width,
    height: o.height,
    plot,
    index,
    reporters,
    endLabels: !narrow,
    band,
    yTicks,
    xTicks,
    last: lp ? { x: clampX(X(lp.bucket + o.interval)), y: Y(lp.price), price: lp.price } : null,
    gaps: indexGaps,
    noPrint: (o.noPrint ?? []).filter((b) => b >= o.from && b <= o.to).map((b) => X(b + o.interval / 2)),
  };
}

/** The chart's text alternative. */
export function indexSummary(prints: { bucket: number; price: number }[], tick: number, from: number, to: number): string {
  if (prints.length === 0) return `No final prints between ${fmtUtc(from)} and ${fmtUtc(to)}.`;
  const vals = prints.map((p) => p.price);
  const last = prints[prints.length - 1]!;
  return `${prints.length} final prints from ${fmtUtc(from)} to ${fmtUtc(to)}. Low ${fmtPrice(Math.min(...vals), tick)}, high ${fmtPrice(Math.max(...vals), tick)}, last ${fmtPrice(last.price, tick)} at ${fmtUtc(last.bucket)}.`;
}
