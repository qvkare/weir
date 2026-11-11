// Sections 7.1 and 7.2: one uniform price for a round, and who is filled at it.
import type { Side } from "./hash.ts";

export interface Order {
  seq: number;
  side: Side;
  size: number;
  /** Always a LONG price, a positive multiple of the tick. */
  price: number;
}

export interface CurvePoint {
  price: number;
  /** D(p): total size of LONG orders with price >= p. */
  demand: number;
  /** S(p): total size of SHORT orders with price <= p. */
  supply: number;
}

export interface Clearing {
  price: number | null;
  volume: number;
  /** `fills[i]` is the fill of `orders[i]`. */
  fills: number[];
}

/** Demand and supply at every distinct order price, ascending. Between two points the
 * curves are steps: demand takes the value of the point above, supply of the point below. */
export function curves(orders: readonly Order[]): CurvePoint[] {
  const prices = [...new Set(orders.map((o) => o.price))].sort((a, b) => a - b);
  return prices.map((price) => {
    let demand = 0;
    let supply = 0;
    for (const o of orders) {
      if (o.side === "Long" && o.price >= price) demand += o.size;
      if (o.side === "Short" && o.price <= price) supply += o.size;
    }
    return { price, demand, supply };
  });
}

export function clearRound(orders: readonly Order[], tick: number): Clearing {
  for (const o of orders) {
    if (!Number.isSafeInteger(o.size) || o.size < 1) throw new Error("order size must be a positive integer");
    if (!Number.isSafeInteger(o.price) || o.price <= 0 || o.price % tick !== 0) {
      throw new Error("order price must be a positive multiple of tick");
    }
  }
  const fills = orders.map(() => 0);
  const points = curves(orders);
  const volumeAt = (c: CurvePoint) => Math.min(c.demand, c.supply);
  const imbalance = (c: CurvePoint) => Math.abs(c.demand - c.supply);

  const volume = Math.max(0, ...points.map(volumeAt));
  if (volume === 0) return { price: null, volume: 0, fills };

  const best = points.filter((c) => volumeAt(c) === volume);
  const least = Math.min(...best.map(imbalance));
  const kept = best.filter((c) => imbalance(c) === least);
  const lo = kept[0]!.price;
  const hi = kept[kept.length - 1]!.price;

  let price: number;
  if (kept.every((c) => c.demand > c.supply)) price = hi;
  else if (kept.every((c) => c.demand < c.supply)) price = lo;
  else {
    const mid = Math.floor((lo + hi) / 2);
    price = mid - (mid % tick);
  }

  allocate(orders, fills, volume, (o) => o.side === "Long" && o.price >= price, (a, b) => b.price - a.price);
  allocate(orders, fills, volume, (o) => o.side === "Short" && o.price <= price, (a, b) => a.price - b.price);
  return { price, volume, fills };
}

/** Fills `volume` units across the eligible orders by price priority, then lowest seq. */
function allocate(
  orders: readonly Order[],
  fills: number[],
  volume: number,
  eligible: (o: Order) => boolean,
  byPrice: (a: Order, b: Order) => number,
): void {
  const queue = orders
    .map((order, index) => ({ order, index }))
    .filter(({ order }) => eligible(order))
    // Index breaks ties only for callers that repeat a seq, to keep the result deterministic.
    .sort((a, b) => byPrice(a.order, b.order) || a.order.seq - b.order.seq || a.index - b.index);
  let left = volume;
  for (const { order, index } of queue) {
    if (left === 0) break;
    const fill = Math.min(order.size, left);
    fills[index] = fill;
    left -= fill;
  }
}
