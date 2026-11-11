// The home page's hero film: one example round, cleared by the engine's clearRound, told in
// under ten seconds. Everything the picture shows (hashes, sides, the price, who is filled)
// comes from the engine here; the score only decides when each part appears.
import { clearRound, commitHash, type Order } from "@weir/engine";
import { dollarsOfPrice, fmtInt } from "./format.ts";
import { DUR, EASE, draw, enter, fadeIn, fadeOut, pop, track, type Score, type Track } from "./motion.ts";

export interface FilmOrder extends Order {
  owner: string;
}

export type FillState = "full" | "part" | "out";

export interface FilmTicket extends FilmOrder {
  account: string;
  hash: string;
  filled: number;
  state: FillState;
}

export interface Film {
  tick: number;
  band: number;
  price: number;
  volume: number;
  tickets: FilmTicket[];
  score: Score;
  /** The final frame in words: the text alternative, and the caption under reduced motion. */
  summary: string;
}

/** An example book: four LONG bids and four SHORT asks, arriving interleaved. Not a market reading. */
export const FILM_TICK = 10_000;
export const FILM_BAND = 90 * FILM_TICK;
export const FILM_ORDERS: FilmOrder[] = [
  { seq: 0, owner: "A", side: "Long", size: 30, price: 52 * FILM_TICK },
  { seq: 1, owner: "E", side: "Short", size: 25, price: 20 * FILM_TICK },
  { seq: 2, owner: "B", side: "Long", size: 30, price: 44 * FILM_TICK },
  { seq: 3, owner: "F", side: "Short", size: 30, price: 30 * FILM_TICK },
  { seq: 4, owner: "C", side: "Long", size: 30, price: 36 * FILM_TICK },
  { seq: 5, owner: "G", side: "Short", size: 25, price: 40 * FILM_TICK },
  { seq: 6, owner: "D", side: "Long", size: 20, price: 24 * FILM_TICK },
  { seq: 7, owner: "H", side: "Short", size: 30, price: 56 * FILM_TICK },
];

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "none") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The beats' start times, in ms. Exported for the tests. */
export const FILM_BEATS = { arrive: 0, reveal: 1700, curves: 3200, cross: 4800, sweep: 5300, fill: 6300, hold: 7500, end: 8800 } as const;

export function buildFilm(orders: FilmOrder[] = FILM_ORDERS, tick = FILM_TICK, band = FILM_BAND): Film {
  const c = clearRound(orders, tick);
  if (c.price === null) throw new Error("the film's example must trade");
  const tickets: FilmTicket[] = orders.map((o, i) => {
    const account = `${o.owner.toLowerCase()}.example.testnet`;
    const salt = (i + 1).toString(16).padStart(2, "0").repeat(16);
    const filled = c.fills[i]!;
    return { ...o, account, hash: commitHash({ series: 0, round: 0, accountId: account, side: o.side, size: o.size, price: o.price, salt }), filled, state: filled === 0 ? "out" : filled < o.size ? "part" : "full" };
  });

  const B = FILM_BEATS;
  const n = tickets.length;
  const tracks: Track[] = [];
  tickets.forEach((t, i) => {
    tracks.push(track(`t-${i}`, enter, B.arrive + i * 170, DUR.base));
    tracks.push(track(`sealed-${i}`, fadeOut, B.reveal + i * 140, DUR.quick));
    tracks.push(track(`open-${i}`, enter, B.reveal + i * 140 + 80, DUR.base));
    tracks.push(track(`fill-${i}`, fadeIn, B.fill + 100 + i * 90, DUR.base));
    if (t.state === "out") tracks.push(track(`dim-${i}`, [{ opacity: 1 }, { opacity: 0.5 }], B.fill + 100 + i * 90, DUR.base));
  });
  tracks.push(
    track("axes", fadeIn, B.arrive, DUR.settle),
    track("demand", draw, B.curves, 1400, EASE.inOut),
    track("supply", draw, B.curves + 100, 1400, EASE.inOut),
    track("demand-label", fadeIn, B.curves + 500, DUR.base),
    track("supply-label", fadeIn, B.curves + 600, DUR.base),
    track("cross", pop, B.cross, 420),
    track("price", draw, B.sweep, DUR.draw, EASE.inOut),
    track("price-label", fadeIn, B.sweep + 600, DUR.base),
    track("lit", fadeIn, B.fill, DUR.base),
    track("soft", fadeIn, B.fill + 100, DUR.settle),
    track("volume", fadeIn, B.fill + 300, DUR.base),
    track("hold", enter, B.hold, DUR.base),
  );

  const filled = tickets.filter((t) => t.state === "full").map((t) => t.owner).sort();
  const part = tickets.filter((t) => t.state === "part");
  const out = tickets.filter((t) => t.state === "out").map((t) => t.owner).sort();
  const p = dollarsOfPrice(c.price, tick);
  const sp = dollarsOfPrice(band - c.price, tick);
  const partText = part.length ? `; ${list(part.map((t) => `${t.owner} in part, ${fmtInt(t.filled)} of ${fmtInt(t.size)}`))}` : "";
  const beats = [
    { at: B.arrive, label: `${n} sealed bids arrive. Each is a hash and a lock: no side, size or price.` },
    { at: B.reveal, label: "Reveal. Each hash opens to a side, a size and a LONG price." },
    { at: B.curves, label: "Demand steps down from the highest bid; supply steps up from the lowest ask." },
    { at: B.cross, label: "They cross where the most GPU-hours can trade." },
    { at: B.sweep, label: `One price for the whole round: ${p} per GPU-hour.` },
    { at: B.fill, label: `Filled: ${list(filled)}${partText}. Out: ${list(out)}.` },
    { at: B.hold, label: `Every filled LONG pays ${p}, every filled SHORT the band minus it, ${sp}. Each pair is backed in full.` },
  ];
  const summary = `Example round of ${n} sealed orders, cleared by the Weir engine: it clears at a LONG price of ${p} per GPU-hour for ${fmtInt(c.volume)} GPU-hours. Filled ${list(filled)}${partText}; out ${list(out)}. Every filled LONG pays ${p} and every filled SHORT ${sp}.`;
  return { tick, band, price: c.price, volume: c.volume, tickets, score: { total: B.end, tracks, beats }, summary };
}
