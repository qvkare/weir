// The homepage's reads, for its application window: the round in progress and its book, the
// latest rounds as grid rows (the series before fills in when the live one is new), the last
// clearing, the last index print, and the last print of every other market for the sidebar.
// About fourteen views. Browser-safe; the build runs it for the static page, the browser again.
import type { WireLastPrint, WireLiveSeries, WireParams, WirePrint, WireResult } from "@weir/engine";
import type { Bundle } from "@weir/index";
import { valueOf } from "../cache.ts";
import type { MarketId } from "../config.ts";
import { latestRound, loadBundle, loadCore, loadResults } from "../load.ts";
import type { Source, SourceKind } from "../source-types.ts";
import { bookRows, bookTotals, type BookTotals } from "../views.ts";

export interface FrontChip {
  market: MarketId;
  kind: SourceKind;
  last: WireLastPrint | null;
  tick: number | null;
}

/** One row of the window's grid: a round, open or cleared. */
export interface FrontRow {
  series: number;
  round: number;
  state: "Committing" | "Revealing" | "Cleared" | "No trade";
  /** Micro-USD per GPU-hour; null when nothing traded or not cleared. */
  price: number | null;
  forward: number | null;
  volume: number | null;
  commits: number;
  /** Orders revealed (for a cleared round, those that took part). */
  revealed: number;
  /** Commit fees, micro-USDC: held while open, burned at clearing. */
  fees: string;
  /** Dollars locked, micro-USDC: known for the round in progress only. */
  locked: string | null;
  clearedAt: number | null;
}

export const WINDOW_ROWS = 12;

export interface FrontData {
  market: MarketId;
  kind: SourceKind;
  /** Why the market could not be read, when it could not. */
  error: string | null;
  params: WireParams | null;
  now: number;
  last: WireLastPrint | null;
  live: WireLiveSeries | null;
  book: BookTotals | null;
  clearing: { series: number; round: number; result: WireResult; floor: number | null; band: number | null } | null;
  /** The newest commits of the round in progress (at most 5): hash, lock, state. */
  sealed: { seq: number; hash: string | null; lock: string; state: string }[];
  /** Newest first: the round in progress, then cleared rounds, at most WINDOW_ROWS. */
  rows: FrontRow[];
  /** The last print with its reports, and the first report's bundle from the bundle host. */
  print: WirePrint | null;
  bundle: { hash: string; text: string; data: Bundle; url: string } | null;
  bundleError: string | null;
  /** Each account's latest action seen in the rows read: a commit or reveal in the open round, or a fill. */
  actions: Record<string, { what: string; series: number; round: number; at: number | null }>;
  chips: FrontChip[];
  at: number;
}

export async function loadFront(src: Source, chipSources: Source[], bundlesBase: string | null = null): Promise<FrontData> {
  const c = await loadCore(src);
  const params = valueOf(c.params);
  const status = valueOf(c.status);
  const base: FrontData = { market: src.market, kind: src.kind, error: null, params, now: c.now, last: valueOf(c.last), live: null, book: null, clearing: null, rows: [], print: null, bundle: null, bundleError: null, actions: {}, sealed: [], chips: [], at: Date.now() };
  const chipsP = Promise.all(
    chipSources.map(async (s): Promise<FrontChip> => {
      if (s === src) return { market: s.market, kind: s.kind, last: valueOf(c.last), tick: params?.tick ?? null };
      const [l, p] = await Promise.all([s.view("get_last_print", {}), s.view("get_params", {})]);
      return { market: s.market, kind: s.kind, last: valueOf(l), tick: valueOf(p)?.tick ?? null };
    }),
  );
  if (!params || !status) {
    const e = !c.status.ok ? c.status.error : !c.params.ok ? c.params.error : null;
    return { ...base, error: e, chips: await chipsP };
  }
  const live = status.live.find((l) => l.round !== null) ?? status.live[0] ?? null;
  const prev = live && live.series > 0 ? live.series - 1 : null;
  const lastPrint = valueOf(c.last);
  const [roundR, resultsR, seriesR, prevR, prevSeriesR, chips, printR] = await Promise.all([
    live && live.round !== null ? src.view("get_round", { series: live.series, round: live.round }) : Promise.resolve(null),
    live ? loadResults(src, live.series, latestRound(params, live.series, c.now), 100) : Promise.resolve(null),
    live ? src.view("get_series", { series: live.series }) : Promise.resolve(null),
    prev !== null ? loadResults(src, prev, latestRound(params, prev, c.now), 100) : Promise.resolve(null),
    prev !== null ? src.view("get_series", { series: prev }) : Promise.resolve(null),
    chipsP,
    lastPrint ? src.view("get_print", { bucket: lastPrint.bucket }) : Promise.resolve(null),
  ]);
  const print = printR ? valueOf(printR) : null;
  const hash = print?.reports[0]?.bundle ?? null;
  const hosted = hash ? await loadBundle(bundlesBase, hash) : null;
  const bundle = hosted && hosted.ok ? { hash: hash!, text: hosted.value.text, data: hosted.value.bundle, url: hosted.value.origin.kind === "host" ? hosted.value.origin.url : "" } : null;
  const bundleError = hosted && !hosted.ok ? hosted.error : !bundlesBase && hash ? "no bundle host is configured" : null;
  const round = roundR ? valueOf(roundR) : null;
  const book = round ? bookTotals(bookRows(round)) : live && live.round !== null && roundR?.ok ? bookTotals([]) : null;
  const floors = new Map<number, number | null>();
  const bands = new Map<number, number | null>();
  if (live) floors.set(live.series, seriesR ? valueOf(seriesR)?.floor ?? null : null);
  if (prev !== null) floors.set(prev, prevSeriesR ? valueOf(prevSeriesR)?.floor ?? null : null);
  if (live) bands.set(live.series, seriesR ? valueOf(seriesR)?.band ?? null : null);
  if (prev !== null) bands.set(prev, prevSeriesR ? valueOf(prevSeriesR)?.band ?? null : null);
  const cleared = (series: number, list: [number, WireResult][] | null): FrontRow[] =>
    [...(list ?? [])].reverse().map(([r, res]) => {
      const floor = floors.get(series) ?? null;
      return { series, round: r, state: res.price === null ? "No trade" : "Cleared", price: res.price, forward: res.price !== null && floor !== null ? floor + res.price : null, volume: res.price === null ? null : res.volume, commits: res.commits, revealed: res.orders, fees: res.fees, locked: null, clearedAt: res.cleared_at };
    });
  const rows: FrontRow[] = [];
  if (live && live.round !== null && book) rows.push({ series: live.series, round: live.round, state: live.phase === "Commit" ? "Committing" : "Revealing", price: null, forward: null, volume: null, commits: book.commits, revealed: book.revealed, fees: book.fees, locked: book.locked, clearedAt: null });
  if (live) rows.push(...cleared(live.series, resultsR ? valueOf(resultsR) : null));
  // A new series (on the hourly market, each hour from :55 until its first round clears) has few
  // rounds or none: the series before fills the grid, and the last clearing comes from it.
  if (prev !== null) rows.push(...cleared(prev, prevR ? valueOf(prevR) : null));
  const traded = rows.find((r) => r.state === "Cleared");
  const results = new Map<string, WireResult>();
  for (const [r, res] of (resultsR ? valueOf(resultsR) : null) ?? []) results.set(`${live!.series}-${r}`, res);
  for (const [r, res] of (prevR ? valueOf(prevR) : null) ?? []) results.set(`${prev}-${r}`, res);
  const clearing = traded ? { series: traded.series, round: traded.round, result: results.get(`${traded.series}-${traded.round}`)!, floor: floors.get(traded.series) ?? null, band: bands.get(traded.series) ?? null } : null;
  const sealed = [...(round?.commits ?? [])].sort((a, b) => b.seq - a.seq).slice(0, 5).map((x) => ({ seq: x.seq, hash: x.hash ?? null, lock: x.lock, state: x.state }));
  // Each account's latest action among the rounds read (newest first, so the first seen wins).
  const actions: FrontData["actions"] = {};
  for (const x of round?.commits ?? []) actions[x.owner] ??= { what: x.state === "Revealed" ? "revealed" : x.state === "Void" ? "void" : "committed, sealed", series: live!.series, round: live!.round!, at: null };
  const ordered: [number, [number, WireResult][] | null][] = [[live?.series ?? -1, resultsR ? valueOf(resultsR) : null], [prev ?? -1, prevR ? valueOf(prevR) : null]];
  for (const [s, list] of ordered)
    for (const [r, res] of [...(list ?? [])].reverse())
      for (const f of res.fills) actions[f.owner] ??= { what: `filled ${f.filled} GPU-h ${f.side === "Long" ? "LONG" : "SHORT"}`, series: s, round: r, at: res.cleared_at };
  return { ...base, live, book, clearing, rows: rows.slice(0, WINDOW_ROWS), print, bundle, bundleError, actions, sealed, chips };
}

const bookKey = (b: BookTotals | null) => (b ? [b.commits, b.revealed] : null);

export const frontKey = (d: FrontData): string => JSON.stringify([d.live ? [d.live.series, d.live.round, d.live.phase] : null, d.last?.bucket ?? null, bookKey(d.book)]);

/** Polled while the page is open: the round in progress, the last print and the book's size. */
export async function frontProbe(src: Source): Promise<string | null> {
  const [st, l] = await Promise.all([src.view("get_status", {}), src.view("get_last_print", {})]);
  if (!st.ok || !l.ok) return null;
  const live = st.value.live.find((x) => x.round !== null) ?? st.value.live[0] ?? null;
  let book: BookTotals | null = null;
  if (live && live.round !== null) {
    const r = await src.view("get_round", { series: live.series, round: live.round });
    if (!r.ok) return null;
    book = r.value ? bookTotals(bookRows(r.value)) : bookTotals([]);
  }
  return JSON.stringify([live ? [live.series, live.round, live.phase] : null, l.value?.bucket ?? null, bookKey(book)]);
}
