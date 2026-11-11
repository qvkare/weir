// "One round, as work" (DESIGN section 7.4): sealed bids arrive on the bench, open at once, line
// up by price, go into the rack row for their price, a scanner settles on the one row that
// clears, and the filled bids light. Everything the drawing shows comes from the engine here:
// the rows are the book's prices, the counts at each scanned row are the engine's curves, the
// row the scanner settles on and every fill are clearRound's. The component only poses it.
import { clearRound, curves, type Clearing, type Order } from "@weir/engine";
import { dollarsOfPrice, fmtInt } from "./format.ts";

export interface FloorOrder extends Order {
  /** Short name on the ticket. */
  owner: string;
}

export type FloorState = "full" | "part" | "out";

export interface FloorTicket extends FloorOrder {
  filled: number;
  state: FloorState;
  /** Row in the rack, 0 = highest price. */
  row: number;
  /** Place in its side's queue after lining up, 0 = nearest the rack. */
  rank: number;
  /** Place in its side's queue on arrival (an arbitrary but fixed shuffle of rank). */
  arrival: number;
  /** Offset inside a rack row when two orders of one side share a price. */
  lane: number;
  /** Seconds. */
  arriveAt: number;
  arriveEnd: number;
  revealAt: number;
  rankAt: number;
  rankEnd: number;
  rackAt: number;
  rackEnd: number;
  /** When an unfilled ticket leaves the rack again. */
  returnAt: number;
}

export interface FloorRow {
  price: number;
  /** D(p): GPU-hours of LONG bids at or above this row's price. */
  demand: number;
  /** S(p): GPU-hours of SHORT asks at or below it. */
  supply: number;
}

export interface FloorBeat {
  at: number;
  label: string;
}

export interface FloorPlan {
  tick: number;
  tickets: FloorTicket[];
  rows: FloorRow[];
  clearing: Clearing;
  /** The row the scanner settles on: the clearing price's row. */
  clearRow: number;
  /** Phase starts, seconds. */
  T: typeof FLOOR_T;
  beats: FloorBeat[];
  total: number;
  /** The final frame in words: the text alternative and the reduced-motion caption. */
  summary: string;
}

export const FLOOR_T = {
  arrive: 0.15,
  reveal: 2.9,
  /** One late bid reaches the bench after the commit window closed and is turned away. */
  late: 2.75,
  rank: 3.55,
  rack: 4.55,
  scan: 0, // set per plan: after the last ticket is racked
  lit: 0,
  hold: 0,
} as const;

/** An example book: five buyers and five sellers. Not a market reading. */
export const FLOOR_TICK = 10_000;
export const FLOOR_EXAMPLE: FloorOrder[] = [
  { seq: 0, owner: "lab-a", side: "Long", size: 40, price: 2_810_000 },
  { seq: 1, owner: "dc-1", side: "Short", size: 30, price: 2_700_000 },
  { seq: 2, owner: "agent-7", side: "Long", size: 20, price: 2_760_000 },
  { seq: 3, owner: "dc-2", side: "Short", size: 40, price: 2_740_000 },
  { seq: 4, owner: "lab-b", side: "Long", size: 30, price: 2_730_000 },
  { seq: 5, owner: "spare-3", side: "Short", size: 20, price: 2_790_000 },
  { seq: 6, owner: "agent-2", side: "Long", size: 30, price: 2_680_000 },
  { seq: 7, owner: "dc-4", side: "Short", size: 30, price: 2_660_000 },
  { seq: 8, owner: "lab-c", side: "Long", size: 20, price: 2_790_000 },
  { seq: 9, owner: "spare-5", side: "Short", size: 30, price: 2_830_000 },
];

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "none") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function buildFloor(orders: FloorOrder[] = FLOOR_EXAMPLE, tick = FLOOR_TICK): FloorPlan {
  const c = clearRound(orders, tick);
  if (c.price === null) throw new Error("the floor's example must trade");
  const pts = curves(orders);
  const rows: FloorRow[] = [...pts].reverse().map((p) => ({ price: p.price, demand: p.demand, supply: p.supply }));
  const rowOf = new Map(rows.map((r, i) => [r.price, i]));
  const clearRow = rowOf.get(c.price) ?? rows.findIndex((r) => r.price <= c.price!);

  const longs = orders.map((o, i) => ({ o, i })).filter((x) => x.o.side === "Long").sort((a, b) => b.o.price - a.o.price || a.o.seq - b.o.seq);
  const shorts = orders.map((o, i) => ({ o, i })).filter((x) => x.o.side === "Short").sort((a, b) => a.o.price - b.o.price || a.o.seq - b.o.seq);
  const rankOf = new Map<number, number>();
  longs.forEach((x, r) => rankOf.set(x.i, r));
  shorts.forEach((x, r) => rankOf.set(x.i, r));
  // A fixed shuffle for the arrival order: the bench is not sorted until the bids are open.
  const shuffle = (n: number) => Array.from({ length: n }, (_, k) => (k * 3 + 1) % n);
  const arrL = shuffle(longs.length);
  const arrS = shuffle(shorts.length);
  const lanes = new Map<string, number>();

  // Arrivals interleave the two sides in seq order; racking goes rank by rank, buyer then seller.
  const order = orders.map((o, i) => i);
  const tickets: FloorTicket[] = orders.map((o, i) => {
    const rank = rankOf.get(i)!;
    const filled = c.fills[i]!;
    const key = `${o.side}:${o.price}`;
    const lane = lanes.get(key) ?? 0;
    lanes.set(key, lane + 1);
    const k = order.indexOf(i);
    const arriveAt = FLOOR_T.arrive + k * 0.19;
    const rackAt = FLOOR_T.rack + (rank * 2 + (o.side === "Short" ? 1 : 0)) * 0.2;
    return {
      ...o,
      filled,
      state: filled === 0 ? "out" : filled < o.size ? "part" : "full",
      row: rowOf.get(o.price)!,
      rank,
      arrival: (o.side === "Long" ? arrL : arrS)[rank]!,
      lane,
      arriveAt,
      arriveEnd: arriveAt + 0.9,
      revealAt: FLOOR_T.reveal + k * 0.03,
      rankAt: FLOOR_T.rank + rank * 0.05,
      rankEnd: FLOOR_T.rank + rank * 0.05 + 0.75,
      rackAt,
      rackEnd: rackAt + 0.5,
      returnAt: 0,
    };
  });
  const lastRack = Math.max(...tickets.map((t) => t.rackEnd));
  const scan = +(lastRack + 0.35).toFixed(2);
  const lit = +(scan + 1.6).toFixed(2);
  const hold = +(lit + 1.2).toFixed(2);
  for (const t of tickets) if (t.state === "out") t.returnAt = +(lit + 0.35 + t.rank * 0.06).toFixed(2);
  const total = +(hold + 3.2).toFixed(2);
  const T = { ...FLOOR_T, scan, lit, hold } as typeof FLOOR_T;

  const p = dollarsOfPrice(c.price, tick);
  const nL = tickets.filter((t) => t.side === "Long" && t.filled > 0).length;
  const nS = tickets.filter((t) => t.side === "Short" && t.filled > 0).length;
  // Tickets carry a price, not a name, so the captions name them by side and price.
  const who = (t: FloorTicket) => `the ${dollarsOfPrice(t.price, tick)} ${t.side === "Long" ? "buyer" : "seller"}`;
  const part = tickets.filter((t) => t.state === "part");
  const outL = tickets.filter((t) => t.state === "out" && t.side === "Long").map((t) => dollarsOfPrice(t.price, tick));
  const outS = tickets.filter((t) => t.state === "out" && t.side === "Short").map((t) => dollarsOfPrice(t.price, tick));
  const partText = part.length ? ` ${list(part.map((t) => `${who(t)} is filled ${fmtInt(t.filled)} of ${fmtInt(t.size)} GPU-h`))}.`.replace(/^ t/, " T") : "";
  const outParts = [outL.length ? `buyers at ${list(outL)}` : "", outS.length ? `sellers at ${list(outS)}` : ""].filter(Boolean);
  const outText = outParts.length ? ` Returned unfilled: ${outParts.join("; ")}.` : "";
  const beats: FloorBeat[] = [
    { at: 0, label: `${orders.length} sealed bids arrive. Each shows a lock and nothing else: no side, size or price.` },
    { at: FLOOR_T.reveal, label: "The commit window closes and every bid opens at once. A late bid is turned away: it waits for the next round." },
    { at: FLOOR_T.rank, label: "Lined up by price: the highest buyers and the lowest sellers nearest the rack." },
    { at: FLOOR_T.rack, label: "Racked: each bid goes into the row for its price. Buyers on the left, sellers on the right." },
    { at: scan, label: "The scanner reads each row: GPU-hours bid at or above it, GPU-hours offered at or below it." },
    { at: lit, label: `It stops on ${p}, the row where the most GPU-hours trade: ${fmtInt(c.volume)} GPU-h.` },
    { at: hold, label: `One price for all: ${nL} buyer${nL === 1 ? "" : "s"} and ${nS} seller${nS === 1 ? "" : "s"} filled at ${p} /GPU-h.${partText}${outText}` },
  ];
  const summary = `Example round of ${orders.length} sealed bids, cleared by the Weir engine: one price of ${p} per GPU-hour for ${fmtInt(c.volume)} GPU-hours. ${nL} buyers and ${nS} sellers filled.${partText}${outText}`;
  return { tick, tickets, rows, clearing: c, clearRow, T, beats, total, summary };
}

/** The scanner's row (fractional) at time t: it starts above the top row and settles, with a damped swing, on the clearing row. */
export function scanRow(plan: FloorPlan, t: number): number {
  const start = -0.9;
  const u = t - plan.T.scan;
  if (u <= 0) return start;
  return plan.clearRow + (start - plan.clearRow) * Math.exp(-3.2 * u) * Math.cos(4.6 * u);
}

/** Timeline seconds after `ms` of clock time: wall time, clamped to the end. */
export const floorTime = (plan: Pick<FloorPlan, "total">, ms: number): number => Math.min(plan.total, Math.max(0, ms / 1000));

/** The beat showing at t. */
export function floorBeat(plan: FloorPlan, t: number): number {
  let i = 0;
  plan.beats.forEach((b, j) => {
    if (b.at <= t) i = j;
  });
  return i;
}

/** Problems with a plan, empty when sound: beats in order, every ticket's moves in sequence and inside the score. */
export function checkFloor(plan: FloorPlan): string[] {
  const out: string[] = [];
  plan.beats.forEach((b, i) => {
    if (i && b.at <= plan.beats[i - 1]!.at) out.push(`beat ${i} does not follow beat ${i - 1}`);
  });
  for (const t of plan.tickets) {
    const seq = [t.arriveAt, t.arriveEnd, t.revealAt, t.rankAt, t.rankEnd, t.rackAt, t.rackEnd];
    for (let i = 1; i < seq.length; i++) if (seq[i]! < seq[i - 1]!) out.push(`ticket ${t.seq}: step ${i} starts before step ${i - 1} ends`);
    if (t.rackEnd > plan.T.scan) out.push(`ticket ${t.seq} is racked after the scan starts`);
    if (t.state === "out" && !(t.returnAt > plan.T.lit && t.returnAt < plan.total)) out.push(`ticket ${t.seq} returns outside the score`);
  }
  if (plan.T.hold >= plan.total) out.push("the hold starts after the end");
  return out;
}
