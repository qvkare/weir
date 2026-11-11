// The payoff diagram and the hedge sizer (DESIGN sections 4 and 5), from SPEC sections 1 and 10.
// A LONG unit pays clamp(fixing - floor, 0, band) and costs p; a SHORT unit pays band minus that
// and costs band - p. A buyer who holds LONG and buys compute at the fixing pays
// fixing - payout + p per GPU-hour; a seller who holds SHORT and sells at the fixing receives
// fixing + (band - payout) - (band - p). Both come to floor + p everywhere inside the band.

export type HedgeSide = "Long" | "Short";

export const longPayout = (fixing: number, floor: number, band: number): number => Math.min(Math.max(fixing - floor, 0), band);

export interface PayoffPoint {
  fixing: number;
  unhedged: number;
  /** The payout of one unit of the side held. */
  payout: number;
  hedged: number;
  /** hedged - unhedged: for a buyer, positive means the hedge cost money; for a seller, it earned. */
  difference: number;
}

/** Per GPU-hour, at one fixing, for one unit of `side` bought at LONG price `p`. */
export function payoffAt(side: HedgeSide, fixing: number, floor: number, band: number, p: number): PayoffPoint {
  const lp = longPayout(fixing, floor, band);
  if (side === "Long") {
    const hedged = fixing - lp + p;
    return { fixing, unhedged: fixing, payout: lp, hedged, difference: hedged - fixing };
  }
  const sp = band - lp;
  const hedged = fixing + sp - (band - p);
  return { fixing, unhedged: fixing, payout: sp, hedged, difference: hedged - fixing };
}

export interface PayoffGeometry {
  width: number;
  height: number;
  plot: { x0: number; x1: number; y0: number; y1: number };
  domain: { lo: number; hi: number };
  range: { lo: number; hi: number };
  unhedged: string;
  hedged: string;
  band: { x1: number; x2: number };
  /** Corners of the hedged line, where it changes slope. */
  kinks: { x: number; y: number }[];
  xTicks: { x: number; value: number }[];
  yTicks: { y: number; value: number }[];
  handle: { x: number; yUnhedged: number; yHedged: number };
  X: (v: number) => number;
  Y: (v: number) => number;
}

export function payoffDomain(floor: number, band: number): { lo: number; hi: number } {
  return { lo: Math.max(0, floor - band / 2), hi: floor + 1.5 * band };
}

export function payoffGeometry(o: { side: HedgeSide; floor: number; band: number; p: number; fixing: number; width: number; height: number }): PayoffGeometry {
  const narrow = o.width < 560;
  const plot = { x0: narrow ? 48 : 60, x1: o.width - 14, y0: 14, y1: o.height - 34 };
  const domain = payoffDomain(o.floor, o.band);
  const at = (f: number) => payoffAt(o.side, f, o.floor, o.band, o.p);
  const corners = [domain.lo, o.floor, o.floor + o.band, domain.hi];
  const values = corners.flatMap((f) => [at(f).unhedged, at(f).hedged]);
  const span = Math.max(...values) - Math.min(...values) || 1;
  const range = { lo: Math.min(...values) - span * 0.06, hi: Math.max(...values) + span * 0.06 };
  const X = (v: number) => plot.x0 + ((v - domain.lo) / (domain.hi - domain.lo || 1)) * (plot.x1 - plot.x0);
  const Y = (v: number) => plot.y1 - ((v - range.lo) / (range.hi - range.lo)) * (plot.y1 - plot.y0);
  const line = (pick: (p: PayoffPoint) => number) => corners.map((f) => `${X(f).toFixed(1)},${Y(pick(at(f))).toFixed(1)}`).join(" ");
  const fixing = clampFixing(o.fixing, o.floor, o.band);
  const h = at(fixing);
  const ticks = (lo: number, hi: number, n: number) => {
    const step = Math.max(10_000, niceMicro((hi - lo) / n));
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
    return out;
  };
  return {
    width: o.width,
    height: o.height,
    plot,
    domain,
    range,
    unhedged: line((p) => p.unhedged),
    hedged: line((p) => p.hedged),
    band: { x1: X(o.floor), x2: X(o.floor + o.band) },
    kinks: [o.floor, o.floor + o.band].map((f) => ({ x: X(f), y: Y(at(f).hedged) })),
    xTicks: ticks(domain.lo, domain.hi, narrow ? 3 : 6).map((value) => ({ x: X(value), value })),
    yTicks: ticks(range.lo, range.hi, 4).map((value) => ({ y: Y(value), value })),
    handle: { x: X(fixing), yUnhedged: Y(h.unhedged), yHedged: Y(h.hedged) },
    X,
    Y,
  };
}

function niceMicro(raw: number): number {
  if (!(raw > 0)) return 10_000;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export function clampFixing(f: number, floor: number, band: number): number {
  const d = payoffDomain(floor, band);
  return Math.min(Math.max(f, d.lo), d.hi);
}

/** The keyboard step of the handle: one tick, ten with Shift, snapped to the tick grid. */
export function stepFixing(f: number, dir: -1 | 1, big: boolean, tick: number, floor: number, band: number): number {
  const t = tick > 0 ? tick : 10_000;
  const snapped = Math.round(f / t) * t;
  return clampFixing(snapped + dir * (big ? 10 : 1) * t, floor, band);
}

/** Pixel x to a fixing snapped to the tick, for pointer drags. */
export function fixingFromX(x: number, g: Pick<PayoffGeometry, "plot" | "domain">, tick: number): number {
  const frac = (x - g.plot.x0) / (g.plot.x1 - g.plot.x0 || 1);
  const raw = g.domain.lo + Math.min(Math.max(frac, 0), 1) * (g.domain.hi - g.domain.lo);
  const t = tick > 0 ? tick : 10_000;
  return Math.min(Math.max(Math.round(raw / t) * t, g.domain.lo), g.domain.hi);
}

export interface HedgeSize {
  units: number;
  /** micro-USDC. */
  locked: bigint;
  /** The most the position can lose: everything locked, at the far edge of the band. */
  maxLoss: bigint;
  /** micro-USD per GPU-hour: the price the hedge fixes inside the band. */
  effective: number;
  /** The fixings outside which the hedge stops. */
  low: number;
  high: number;
}

/** One unit hedges one GPU-hour. Locks `units * p` for LONG and `units * (band - p)` for SHORT. */
export function hedgeSize(gpuHours: number, side: HedgeSide, floor: number, band: number, p: number): HedgeSize | null {
  if (!Number.isSafeInteger(gpuHours) || gpuHours < 1 || !(band > 0) || !(p > 0) || p >= band) return null;
  const per = side === "Long" ? p : band - p;
  const locked = BigInt(gpuHours) * BigInt(per);
  return { units: gpuHours, locked, maxLoss: locked, effective: floor + p, low: floor, high: floor + band };
}

/** Parses the GPU-hours field: a whole number from 1 to `max`, commas allowed. */
export function parseGpuHours(text: string, max: number): number | null {
  const t = text.replace(/[,\s_]/g, "");
  if (!/^\d{1,12}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= max ? n : null;
}
