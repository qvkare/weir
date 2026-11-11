// Geometry of the auction step chart (DESIGN section 5). x is cumulative GPU-hours, y the LONG
// price from 0 to band. Demand (LONG) falls from the highest price, supply (SHORT) rises from the
// lowest. Orders are sorted exactly as the contract fills them, so the filled part of each curve
// is the part left of V*.
import { niceStep } from "./backtest.ts";
import { fmtGpuH, fmtPrice } from "./format.ts";

export interface StepOrder {
  seq: number;
  owner: string;
  side: "Long" | "Short";
  size: number;
  /** LONG price, micro-USD per GPU-hour. */
  price: number;
  /** Units filled, when the round has cleared. */
  filled?: number;
}

export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  filled: boolean;
}

export interface Step {
  seq: number;
  owner: string;
  side: "Long" | "Short";
  size: number;
  price: number;
  filled: number | null;
  /** Hit area and the step's own horizontal, in pixels. */
  x1: number;
  x2: number;
  y: number;
  /** Pixel x where the fill stops inside this step, when it is filled in part. */
  partAt: number | null;
}

export interface StepGeometry {
  width: number;
  height: number;
  plot: { x0: number; x1: number; y0: number; y1: number };
  xMax: number;
  band: number;
  yTicks: { y: number; price: number }[];
  xTicks: { x: number; units: number }[];
  demand: Seg[];
  supply: Seg[];
  steps: Step[];
  clearing: null | {
    y: number;
    x: number;
    price: number;
    volume: number;
    /** What filled LONGs paid: 0..V* x 0..p*. */
    longRect: { x: number; y: number; w: number; h: number };
    /** What filled SHORTs paid: 0..V* x p*..band. */
    shortRect: { x: number; y: number; w: number; h: number };
  };
  /** Why there is no clearing line, when there is none. */
  noClearing: null | "no orders" | "one side only" | "no cross" | "not cleared";
}

export interface StepInput {
  orders: StepOrder[];
  band: number;
  /** Null when nothing traded or the round is not cleared; `cleared` tells which. */
  price: number | null;
  volume: number;
  cleared: boolean;
  width: number;
  height: number;
}

const byDemand = (a: StepOrder, b: StepOrder) => b.price - a.price || a.seq - b.seq;
const bySupply = (a: StepOrder, b: StepOrder) => a.price - b.price || a.seq - b.seq;

export function stepGeometry(input: StepInput): StepGeometry {
  const { orders, band, width, height } = input;
  const narrow = width < 560;
  const plot = { x0: narrow ? 46 : 64, x1: width - (narrow ? 46 : 64), y0: 28, y1: height - 34 };
  const longs = orders.filter((o) => o.side === "Long").sort(byDemand);
  const shorts = orders.filter((o) => o.side === "Short").sort(bySupply);
  const dTotal = longs.reduce((s, o) => s + o.size, 0);
  const sTotal = shorts.reduce((s, o) => s + o.size, 0);
  const xMax = Math.max(dTotal, sTotal, 1);
  const safeBand = band > 0 ? band : 1;

  const X = (u: number) => plot.x0 + (u / xMax) * (plot.x1 - plot.x0);
  const Y = (p: number) => plot.y1 - (Math.min(Math.max(p, 0), safeBand) / safeBand) * (plot.y1 - plot.y0);
  const V = input.cleared && input.price !== null ? input.volume : 0;

  const steps: Step[] = [];
  const curve = (list: StepOrder[], endPrice: number): Seg[] => {
    const segs: Seg[] = [];
    let cum = 0;
    let prevY: number | null = null;
    for (const o of list) {
      const y = Y(o.price);
      const a = cum;
      const b = cum + o.size;
      const xa = X(a);
      const xb = X(b);
      if (prevY !== null && prevY !== y) segs.push({ x1: xa, y1: prevY, x2: xa, y2: y, filled: a < V });
      let partAt: number | null = null;
      if (V > a && V < b) {
        partAt = X(V);
        segs.push({ x1: xa, y1: y, x2: partAt, y2: y, filled: true });
        segs.push({ x1: partAt, y1: y, x2: xb, y2: y, filled: false });
      } else {
        segs.push({ x1: xa, y1: y, x2: xb, y2: y, filled: b <= V });
      }
      steps.push({ seq: o.seq, owner: o.owner, side: o.side, size: o.size, price: o.price, filled: input.cleared ? (o.filled ?? 0) : null, x1: xa, x2: xb, y, partAt });
      prevY = y;
      cum = b;
    }
    if (prevY !== null) segs.push({ x1: X(cum), y1: prevY, x2: X(cum), y2: Y(endPrice), filled: false });
    return segs;
  };
  const demand = curve(longs, 0);
  const supply = curve(shorts, safeBand);

  const yStep = niceTick(safeBand / (narrow ? 4 : 5));
  const yTicks: { y: number; price: number }[] = [];
  for (let p = 0; p <= safeBand + 1e-9; p += yStep) yTicks.push({ y: Y(p), price: p });
  const xStep = niceStep(xMax / (narrow ? 3 : 6));
  const xTicks: { x: number; units: number }[] = [];
  for (let u = 0; u <= xMax + 1e-9; u += xStep) xTicks.push({ x: X(u), units: Math.round(u) });

  let clearing: StepGeometry["clearing"] = null;
  let noClearing: StepGeometry["noClearing"] = null;
  if (orders.length === 0) noClearing = "no orders";
  else if (longs.length === 0 || shorts.length === 0) noClearing = "one side only";
  else if (!input.cleared) noClearing = "not cleared";
  else if (input.price === null || input.volume <= 0) noClearing = "no cross";
  else {
    const y = Y(input.price);
    const x = X(input.volume);
    clearing = {
      y,
      x,
      price: input.price,
      volume: input.volume,
      longRect: { x: plot.x0, y, w: x - plot.x0, h: plot.y1 - y },
      shortRect: { x: plot.x0, y: plot.y0, w: x - plot.x0, h: y - plot.y0 },
    };
  }
  return { width, height, plot, xMax, band: safeBand, yTicks, xTicks, demand, supply, steps, clearing, noClearing };
}

/** A tick step for prices in micro-USD: a nice step of at least one cent. */
function niceTick(raw: number): number {
  return Math.max(10_000, niceStep(raw));
}

/** Demand and supply at a price, for checks and the summary sentence. */
export function sizesAt(orders: StepOrder[], price: number): { demand: number; supply: number } {
  let demand = 0;
  let supply = 0;
  for (const o of orders) {
    if (o.side === "Long" && o.price >= price) demand += o.size;
    if (o.side === "Short" && o.price <= price) supply += o.size;
  }
  return { demand, supply };
}

/** The chart's text alternative. */
export function stepSummary(p: { orders: StepOrder[]; price: number | null; volume: number; cleared: boolean; floor: number | null; tick: number }): string {
  const longs = p.orders.filter((o) => o.side === "Long");
  const shorts = p.orders.filter((o) => o.side === "Short");
  const sum = (l: StepOrder[]) => l.reduce((s, o) => s + o.size, 0);
  const head = `${longs.length} LONG orders for ${fmtGpuH(sum(longs))} and ${shorts.length} SHORT orders for ${fmtGpuH(sum(shorts))}.`;
  if (!p.cleared) return `${head} The round has not cleared.`;
  if (p.price === null) return longs.length === 0 || shorts.length === 0 ? `${head} Orders on one side only, so nothing traded.` : `${head} The curves do not cross, so nothing traded.`;
  const fwd = p.floor === null ? "" : `, a forward price of ${fmtPrice(p.floor + p.price, p.tick)}`;
  return `${head} It clears at a LONG price of ${fmtPrice(p.price, p.tick)}${fwd}, for ${fmtGpuH(p.volume)}.`;
}

