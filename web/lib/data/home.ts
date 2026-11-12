// Everything the home page shows from the chain, read in one pass. The build runs it with the
// server's source (chain or model) to write the static page; the browser runs it again with its
// own RPC reads to bring the page up to date. Browser-safe and serialisable (no functions).
import type { WireLastPrint, WireParams, WirePrint, WireResult, WireSeries, WireStatus } from "@weir/engine";
import { valueOf, type Read } from "../cache.ts";
import { MARKET_INFO, type MarketId } from "../config.ts";
import { loadBundle, loadCore, loadGaps, loadLastClearing, loadPrints, loadSeriesSet, type BucketGaps, type LoadedBundle, type SeriesBundle } from "../load.ts";
import type { Source, SourceKind } from "../source-types.ts";
import { printView, type PrintView } from "../views.ts";

export interface RangeDef {
  id: string;
  label: string;
  secs: number;
}

const RANGE_SETS: Record<"weekly" | "fast", RangeDef[]> = {
  weekly: [
    { id: "24h", label: "24 h", secs: 86_400 },
    { id: "7d", label: "7 d", secs: 7 * 86_400 },
    { id: "30d", label: "30 d", secs: 30 * 86_400 },
  ],
  fast: [
    { id: "1h", label: "1 h", secs: 3600 },
    { id: "6h", label: "6 h", secs: 6 * 3600 },
    { id: "24h", label: "24 h", secs: 86_400 },
  ],
};

export const RANGES = Object.fromEntries((Object.keys(MARKET_INFO) as MarketId[]).map((m) => [m, RANGE_SETS[MARKET_INFO[m].cadence === "Hourly" ? "fast" : "weekly"]])) as Record<MarketId, RangeDef[]>;

export const rangeOf = (market: MarketId, id: string | null | undefined) => RANGES[market].find((r) => r.id === id) ?? RANGES[market][1]!;

/** How many no-print buckets the chart asks about: one view each, so the chain gets a few. */
export const GAP_READS: Record<SourceKind, number> = { model: 2000, chain: 12, none: 0 };

export interface CoreData {
  kind: SourceKind;
  params: Read<WireParams>;
  status: Read<WireStatus>;
  last: Read<WireLastPrint | null>;
  now: number;
}

export interface ChipLast {
  market: MarketId;
  kind: SourceKind;
  last: WireLastPrint | null;
  tick: number | null;
  now: number;
}

export interface HomeData {
  market: MarketId;
  core: CoreData;
  pv: PrintView | null;
  hosted: Read<LoadedBundle> | null;
  set: SeriesBundle[];
  clearing: { series: number | null; info: WireSeries | null; traded: { round: number; result: WireResult } | null };
  chart: { range: string; from: number; prints: Read<WirePrint[]>; gaps: BucketGaps; delivering: number | null; acc: { sum: string; count: number } | null };
  /** The other chips' markets: their last print, for the chip cards. */
  chips: ChipLast[];
  /** When this was read, ms. */
  at: number;
}

const coreData = (c: Awaited<ReturnType<typeof loadCore>>): CoreData => ({ kind: c.src.kind, params: c.params, status: c.status, last: c.last, now: c.now });

export async function loadHome(src: Source, opts: { range?: string | null; bundlesBase: string | null; chipSources: Source[]; ticks?: Partial<Record<MarketId, number>> }): Promise<HomeData> {
  const market = src.market;
  const core = await loadCore(src);
  const params = valueOf(core.params);
  const last = valueOf(core.last);
  const r = rangeOf(market, opts.range);

  const [printR, set, chips] = await Promise.all([
    last ? src.view("get_print", { bucket: last.bucket }) : Promise.resolve(null),
    loadSeriesSet(core),
    // Each other chip needs only its last print. Parameters never change after deployment, so the
    // tick the build read is reused when it is given.
    Promise.all(
      opts.chipSources.map(async (s) => {
        const known = opts.ticks?.[s.market];
        const [l, p] = await Promise.all([s.view("get_last_print", {}), known ? Promise.resolve(null) : s.view("get_params", {})]);
        return { market: s.market, kind: s.kind, last: valueOf(l), tick: known ?? (p ? valueOf(p)?.tick ?? null : null), now: s.kind === "model" ? s.now() : Math.floor(Date.now() / 1000) } satisfies ChipLast;
      }),
    ),
  ]);
  const pv = printView(printR ? valueOf(printR) : null);
  const firstHash = pv?.reporters[0]?.bundle ?? null;

  // The last clearing: the live series first, else the delivering one.
  let clearing: HomeData["clearing"] = { series: null, info: null, traded: null };
  for (const s of [...set].sort((a, b) => Number(!!b.live) - Number(!!a.live))) {
    const info = valueOf(s.info);
    if (!info) continue;
    const c = await loadLastClearing(core, s.series);
    if (c.traded) {
      clearing = { series: s.series, info, traded: c.traded };
      break;
    }
  }
  if (!clearing.traded) {
    const first = set.find((s) => valueOf(s.info));
    clearing = { series: first?.series ?? set[0]?.series ?? null, info: first ? valueOf(first.info) : null, traded: null };
  }

  const from = core.now - r.secs;
  const delivering = set.find((s) => !s.live || (s.live.delivery_start <= core.now && core.now < s.live.delivery_end)) ?? null;
  const [hosted, prints, accR] = await Promise.all([
    firstHash ? loadBundle(opts.bundlesBase, firstHash) : Promise.resolve(null),
    params ? loadPrints(src, params, from, core.now) : Promise.resolve({ ok: false, error: "no parameters", lastGood: null } as Read<WirePrint[]>),
    delivering ? src.view("get_accumulator", { series: delivering.series }) : Promise.resolve(null),
  ]);
  const gaps = params ? await loadGaps(src, params, valueOf(prints) ?? [], from, core.now, GAP_READS[src.kind]) : { noPrint: [], open: [], unread: 0 };

  return {
    market,
    core: coreData(core),
    pv,
    hosted,
    set,
    clearing,
    chart: { range: r.id, from, prints, gaps, delivering: delivering?.series ?? null, acc: accR ? valueOf(accR) : null },
    chips,
    at: Date.now(),
  };
}

/** A cheap fingerprint to poll: when it changes, the whole page is read again. */
export async function homeProbe(src: Source): Promise<string | null> {
  const [st, l] = await Promise.all([src.view("get_status", {}), src.view("get_last_print", {})]);
  if (!st.ok || !l.ok) return null;
  return probeKey(st.value, l.value);
}

export const probeKey = (status: WireStatus | null, last: WireLastPrint | null): string =>
  JSON.stringify([status?.live.map((x) => [x.series, x.round, x.phase]) ?? null, last?.bucket ?? null]);

export const homeKey = (d: HomeData): string => probeKey(valueOf(d.core.status), valueOf(d.core.last));
