// The first screen's wafer (DESIGN section 7.3). Every die is one order in a simulated sealed
// round. The book is drawn from a seeded generator, cleared by the engine's clearRound, and laid
// out so the keenest orders of each side sit nearest the centre; the timeline says what each die
// shows at any moment. Pure: components/wafer.tsx only paints what these functions return.
import { clearRound, type Clearing, type Order } from "@weir/engine";

/** A small, fast, seeded generator (mulberry32). Same seed, same book. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Die {
  x: number;
  y: number;
  /** Distance of the die's centre from the wafer's centre. */
  d: number;
}

export interface WaferGeom {
  cx: number;
  cy: number;
  r: number;
  pitch: number;
}

/** The whole dies that fit inside the wafer's edge exclusion, row by row. */
export function layoutDies(g: WaferGeom, clip?: { w: number; h: number }): Die[] {
  const dies: Die[] = [];
  const p = g.pitch;
  const n = Math.ceil(g.r / p) + 1;
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const x = g.cx + i * p - p / 2;
      const y = g.cy + j * p - p / 2;
      const far = Math.max(Math.hypot(x - g.cx, y - g.cy), Math.hypot(x + p - g.cx, y - g.cy), Math.hypot(x - g.cx, y + p - g.cy), Math.hypot(x + p - g.cx, y + p - g.cy));
      if (far > g.r - p * 0.35) continue;
      if (clip && (x + p < 0 || x > clip.w || y + p < 0 || y > clip.h)) continue;
      dies.push({ x, y, d: Math.hypot(x + p / 2 - g.cx, y + p / 2 - g.cy) });
    }
  }
  return dies;
}

export const WAFER_TICK = 10_000; // $0.01 in micro-USD
/** Where the simulated book is centred when no live index is passed in (micro-USD). */
export const WAFER_ANCHOR = 2_760_000;

export interface WaferBook {
  /** `orders[k]` is the order on die k. */
  orders: Order[];
  clearing: Clearing;
  /** `fill[k]` is the fill of the order on die k. */
  fill: number[];
  filledCount: number;
}

/**
 * A simulated book of one order per die, cleared by the engine. Buyers bid a little above the
 * anchor and sellers ask a little above it too, so the round always trades near the anchor.
 * The keenest orders of each side are placed nearest the centre, interleaved, with jitter, so
 * the filled dies form a ragged disc: the clearing reads from the middle out.
 */
export function waferBook(dies: Die[], seed: number, anchor = WAFER_ANCHOR, tick = WAFER_TICK): WaferBook {
  const r = rng(seed);
  const gauss = () => (r() + r() + r() - 1.5) / 1.5;
  const spread = Math.max(tick * 4, Math.round(anchor * 0.07));
  const lo = Math.max(tick, anchor - spread * 2);
  const hi = anchor + spread * 2;
  const snap = (v: number) => Math.min(hi, Math.max(lo, Math.round(v / tick) * tick));
  const raw: Order[] = dies.map((_, i) => {
    const long = r() < 0.5;
    const price = snap(anchor + (long ? -0.004 : 0.018) * anchor + gauss() * spread);
    return { seq: i, side: long ? "Long" : "Short", size: 4 + Math.floor(r() * 37) * 2, price };
  });
  const c = clearRound(raw, tick);
  const fills = new Map(raw.map((o, i) => [o.seq, c.fills[i]!]));
  const longs = raw.filter((o) => o.side === "Long").sort((a, b) => b.price - a.price || a.seq - b.seq);
  const shorts = raw.filter((o) => o.side === "Short").sort((a, b) => a.price - b.price || a.seq - b.seq);
  const pitch = spreadOf(dies);
  const key = dies.map((d) => d.d + r() * 3.2 * pitch);
  const byDistance = dies.map((_, i) => i).sort((a, b) => key[a]! - key[b]!);
  const orders: Order[] = new Array(dies.length);
  let li = 0;
  let si = 0;
  for (const k of byDistance) {
    const takeLong = si >= shorts.length || (li < longs.length && li / longs.length <= si / shorts.length);
    orders[k] = takeLong ? longs[li++]! : shorts[si++]!;
  }
  const fill = orders.map((o) => fills.get(o.seq) ?? 0);
  return { orders, clearing: c, fill, filledCount: fill.filter((f) => f > 0).length };
}

/** The die pitch, read back from the layout (used to scale the placement jitter). */
function spreadOf(dies: Die[]): number {
  if (dies.length < 2) return 1;
  let best = Infinity;
  for (let i = 1; i < Math.min(dies.length, 60); i++) {
    const dx = Math.abs(dies[i]!.x - dies[0]!.x);
    if (dx > 0 && dx < best) best = dx;
  }
  return Number.isFinite(best) ? best : 1;
}

/** One round of the wafer, in seconds. */
export const WAFER_T = {
  /** A ripple from the centre seals every die again. */
  reseal: 1.0,
  /** A probe sweeps top to bottom, revealing each die in its side's colour. */
  probeStart: 1.0,
  probeEnd: 4.4,
  /** The clearing ring grows from the centre; filled dies light, the rest go dark. */
  clearStart: 4.6,
  clearEnd: 6.0,
  /** Hold the cleared wafer, then fade it before the next book. */
  fadeStart: 11,
  total: 12,
  /** The composed still frame for reduced motion and for the server's first paint. */
  still: 8,
} as const;

export type DieLook = "sealed" | "open" | "filled" | "part" | "out";

/**
 * What die k shows at time t (seconds into the round). `probeY` is where the probe line is,
 * `ring` how far the clearing ring has grown; both come from waferProgress.
 */
export function dieLook(t: number, die: Die, pitch: number, fill: number, size: number, prog: WaferProgress): DieLook {
  if (t < WAFER_T.probeStart) return "sealed";
  if (die.y + pitch / 2 >= prog.probeY) return "sealed";
  if (t < WAFER_T.clearStart || die.d >= prog.ring) return "open";
  if (fill === 0) return "out";
  return fill < size ? "part" : "filled";
}

export interface WaferProgress {
  probeY: number;
  ring: number;
  /** 0..1, how far the end-of-round fade has gone. */
  fade: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** The house ease for travelling things (matches --ease-in-out). */
const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

export function waferProgress(t: number, g: WaferGeom): WaferProgress {
  const pu = inOut(clamp01((t - WAFER_T.probeStart) / (WAFER_T.probeEnd - WAFER_T.probeStart)));
  const probeY = g.cy - g.r - 20 + pu * (2 * g.r + 40);
  const ru = 1 - (1 - clamp01((t - WAFER_T.clearStart) / (WAFER_T.clearEnd - WAFER_T.clearStart))) ** 3;
  return { probeY: t < WAFER_T.probeStart ? -Infinity : probeY, ring: t < WAFER_T.clearStart ? 0 : ru * (g.r + 40), fade: clamp01((t - WAFER_T.fadeStart) / (WAFER_T.total - WAFER_T.fadeStart)) };
}

/** Counts of each look at time t: the tests use it to check the round reads in order. */
export function lookCounts(t: number, dies: Die[], g: WaferGeom, book: WaferBook): Record<DieLook, number> {
  const prog = waferProgress(t, g);
  const out: Record<DieLook, number> = { sealed: 0, open: 0, filled: 0, part: 0, out: 0 };
  dies.forEach((d, k) => out[dieLook(t, d, g.pitch, book.fill[k]!, book.orders[k]!.size, prog)]++);
  return out;
}
