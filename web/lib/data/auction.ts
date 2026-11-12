// The auction page's reads: the round in progress, or the round a link asks for. Browser-safe.
import type { WireLiveSeries, WireResult, WireRound, WireSeries } from "@weir/engine";
import { valueOf, type Read } from "../cache.ts";
import { latestRound, loadCore, loadResults } from "../load.ts";
import type { Source } from "../source-types.ts";
import { loadHome, probeKey, type CoreData, type HomeData } from "./home.ts";

export interface AuctionData {
  core: CoreData;
  /** The round a link asked for (?series=&round=), or null for the round in progress. */
  sel: { series: number; round: number } | null;
  /** The round in progress (null when there is none, or a round was asked for). */
  live: WireLiveSeries | null;
  round: Read<WireRound | null> | null;
  result: Read<WireResult | null> | null;
  series: Read<WireSeries | null> | null;
  /** The latest cleared rounds of the series shown, newest last. */
  recent: Read<[number, WireResult][]> | null;
  /** The series strips and phase clock (read for the round in progress only). */
  series2: HomeData | null;
  at: number;
}

export async function loadAuction(src: Source, sel: { series: number; round: number } | null): Promise<AuctionData> {
  const c = await loadCore(src);
  const core: CoreData = { kind: c.src.kind, params: c.params, status: c.status, last: c.last, now: c.now };
  const params = valueOf(c.params);
  const status = valueOf(c.status);
  const empty: AuctionData = { core, sel, live: null, round: null, result: null, series: null, recent: null, series2: null, at: Date.now() };
  if (!params || !status) return empty;
  if (sel) {
    const [round, result, series, recent] = await Promise.all([
      src.view("get_round", { series: sel.series, round: sel.round }),
      src.view("get_result", { series: sel.series, round: sel.round }),
      src.view("get_series", { series: sel.series }),
      loadResults(src, sel.series, latestRound(params, sel.series, c.now), 12),
    ]);
    return { ...empty, round, result, series, recent };
  }
  const live = status.live.find((l) => l.round !== null) ?? status.live[0] ?? null;
  const series2 = loadHome(src, { bundlesBase: null, chipSources: [], only: "series" });
  if (!live || live.round === null || live.phase_ends_at === null) return { ...empty, live, series2: await series2 };
  const [round, series, recent, strips] = await Promise.all([
    src.view("get_round", { series: live.series, round: live.round }),
    src.view("get_series", { series: live.series }),
    loadResults(src, live.series, Math.max(0, latestRound(params, live.series, c.now)), 12),
    series2,
  ]);
  return { ...empty, live, round, series, recent, series2: strips };
}

const bookKey = (r: WireRound | null) => (r ? [r.next_seq, r.commits.filter((x) => x.state !== "Committed").length] : null);

export const auctionKey = (d: AuctionData): string => JSON.stringify([probeKey(valueOf(d.core.status), null), d.sel, d.sel ? null : bookKey(d.round ? valueOf(d.round) : null)]);

/** Polled while the page is open: the round in progress and, for it, how many commits and reveals the book holds. */
export async function auctionProbe(src: Source, sel: AuctionData["sel"]): Promise<string | null> {
  const st = await src.view("get_status", {});
  if (!st.ok) return null;
  const live = st.value.live.find((l) => l.round !== null) ?? null;
  let book: unknown = null;
  if (!sel && live && live.round !== null) {
    const r = await src.view("get_round", { series: live.series, round: live.round });
    if (!r.ok) return null;
    book = bookKey(r.value);
  }
  return JSON.stringify([probeKey(st.value, null), sel, book]);
}
