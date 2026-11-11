// What a trading agent sees and decides. Strategies are pure: the same view and random
// stream always give the same orders, so a sealed order can be rebuilt and replayed.
import type { Side, WireAccumulator, WireLastPrint, WireParams, WirePosition, WireResult } from "@weir/engine";

export type Role = "buyer" | "seller" | "maker" | "noise";

/** An order: `price` is always a LONG price in micro-USD, on the tick, `0 < price < band`. */
export interface Intent {
  side: Side;
  size: number;
  price: number;
}

/** Everything an agent reads from the views before a commit (SPEC section 12). */
export interface AgentView {
  params: WireParams;
  now: number;
  series: number;
  /** The series' band, fixed when it opened (section 6.1). */
  floor: number;
  band: number;
  round: number;
  /** Rounds of this series still to come, this one included. */
  roundsLeft: number;
  lastPrint: WireLastPrint | null;
  /** Recent final prints, oldest first. */
  prints: { bucket: number; price: number }[];
  /** Prints so far inside this series' delivery window. */
  accumulator: WireAccumulator;
  position: WirePosition;
  /** Free balance in micro-USDC. */
  free: bigint;
  /** Recent results of this series, oldest first. */
  results: [number, WireResult][];
}

export interface Strategy {
  id: string;
  role: Role;
  /** The rule in one sentence, for people. */
  rule: string;
  decide(view: AgentView, rng: () => number): Intent[];
}

/** The forecasting rule every strategy shares: the delivery week's average is the prints
 * already in the window plus the last print for every print still to come, so before
 * delivery it is simply the last print. Null when there is no print. */
export function forecast(v: AgentView): number | null {
  if (v.lastPrint === null) return null;
  const total = Math.max(1, Math.floor(v.params.period_secs / v.params.print_interval_secs));
  const { count } = v.accumulator;
  if (count >= total) return Number(BigInt(v.accumulator.sum) / BigInt(count));
  return Number((BigInt(v.accumulator.sum) + BigInt(v.lastPrint.price) * BigInt(total - count)) / BigInt(total));
}

/** The forecast as a LONG price: what one LONG unit is expected to pay, inside the band. */
export function fairLong(v: AgentView): number | null {
  const f = forecast(v);
  return f === null ? null : Math.min(Math.max(f - v.floor, 0), v.band);
}

/** What a commit of `intent` locks: exactly what the order can cost (section 6.3). */
export const lockOf = (intent: Intent, band: number): bigint =>
  BigInt(intent.size) * BigInt(intent.side === "Long" ? intent.price : band - intent.price);

/** Makes intents valid: prices onto the tick (down for LONG, up for SHORT, so never worse
 * than asked) and strictly inside the band; sizes whole, at most `max_order_size`, and small
 * enough that the free balance covers the lock of every intent; anything whose lock is below
 * `min_lock` dropped. In order, so earlier intents get the balance first. */
export function fit(v: AgentView, intents: Intent[]): Intent[] {
  const { tick, max_order_size } = v.params;
  const minLock = BigInt(v.params.min_lock);
  let free = v.free;
  const out: Intent[] = [];
  for (const it of intents) {
    if (!Number.isFinite(it.price) || !Number.isFinite(it.size)) continue;
    const onTick = it.side === "Long" ? Math.floor(it.price / tick) * tick : Math.ceil(it.price / tick) * tick;
    const price = Math.min(Math.max(onTick, tick), v.band - tick);
    const unit = BigInt(it.side === "Long" ? price : v.band - price);
    const size = Math.min(Math.floor(it.size), max_order_size, Number(free / unit));
    if (size < 1 || BigInt(size) * unit < minLock) continue;
    free -= BigInt(size) * unit;
    out.push({ side: it.side, size, price });
  }
  return out;
}

/** The smallest order at `unit` per GPU-hour whose lock reaches `min_lock`. */
export const minSize = (v: AgentView, unit: number): number =>
  Math.max(1, Math.ceil(Number(BigInt(v.params.min_lock)) / Math.max(1, unit)));

export const pct = (bps: number): string => `${+(bps / 100).toFixed(2)}%`;
