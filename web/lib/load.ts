// Server-side reads shared by the pages and the API routes. Every function returns Reads, so a
// page can show each block's own loading, error, stale or not-deployed state.
import type { Bundle } from "@weir/index";
import type { WireLastPrint, WireLiveSeries, WireParams, WirePrint, WireResult, WireSeries, WireStatus } from "@weir/engine";
import { buildData, deployments } from "./build.ts";
import { readCache, valueOf, type Read } from "./cache.ts";
import type { ChipKey, MarketId } from "./config.ts";
import { source, type Source } from "./source.ts";
import { deliveringSeries, lastResult } from "./views.ts";

export interface Core {
  src: Source;
  params: Read<WireParams>;
  status: Read<WireStatus>;
  last: Read<WireLastPrint | null>;
  now: number;
}

export async function loadCore(market: MarketId): Promise<Core> {
  const src = source(market);
  const [params, status, last] = await Promise.all([src.view("get_params", {}), src.view("get_status", {}), src.view("get_last_print", {})]);
  const s = valueOf(status);
  return { src, params, status, last, now: s?.now ?? src.now() };
}

export interface SeriesBundle {
  live: WireLiveSeries | null;
  series: number;
  info: Read<WireSeries | null>;
}

/** The series to show: every live one, plus the one delivering now if it is not live. */
export async function loadSeriesSet(core: Core): Promise<SeriesBundle[]> {
  const params = valueOf(core.params);
  const status = valueOf(core.status);
  if (!params || !status) return [];
  const list: { live: WireLiveSeries | null; series: number }[] = status.live.map((l) => ({ live: l, series: l.series }));
  const d = deliveringSeries(params, core.now);
  if (d !== null && !list.some((x) => x.series === d)) list.push({ live: null, series: d });
  list.sort((a, b) => a.series - b.series);
  return Promise.all(list.map(async (x) => ({ ...x, info: await core.src.view("get_series", { series: x.series }) })));
}

/** The latest rounds of a series with results, newest last; at most 100 per call. */
export async function loadResults(src: Source, series: number, upToRound: number, limit = 100): Promise<Read<[number, WireResult][]>> {
  const from = Math.max(0, upToRound - limit + 1);
  return src.view("get_results", { series, from_round: from, limit: Math.min(limit, upToRound - from + 1) });
}

/** Rounds `0 .. count-1` a series has (SPEC 4). */
export function roundsOf(p: WireParams, series: number): number {
  const start = p.t0 + series * p.period_secs;
  const open = Math.max(0, start - p.lead_secs);
  const close = Math.max(0, start - p.cutoff_secs);
  return Math.max(0, Math.floor((close - open) / (p.commit_secs + p.reveal_secs)));
}

/** The round of a series that is current or most recently over at `now`. */
export function latestRound(p: WireParams, series: number, now: number): number {
  const open = Math.max(0, p.t0 + series * p.period_secs - p.lead_secs);
  const r = Math.floor((now - open) / (p.commit_secs + p.reveal_secs));
  return Math.min(Math.max(r, 0), Math.max(0, roundsOf(p, series) - 1));
}

export async function loadLastClearing(core: Core, series: number): Promise<{ read: Read<[number, WireResult][]>; last: { round: number; result: WireResult } | null; traded: { round: number; result: WireResult } | null }> {
  const params = valueOf(core.params);
  if (!params) return { read: { ok: false, error: "no parameters", lastGood: null }, last: null, traded: null };
  const read = await loadResults(core.src, series, latestRound(params, series, core.now));
  const list = valueOf(read);
  const traded = list ? lastResult(list.filter(([, r]) => r.price !== null)) : null;
  return { read, last: lastResult(list), traded };
}

/** What became of the buckets in a window that have no final print (SPEC 9). */
export interface BucketGaps {
  /** Decided without a print, for good. */
  noPrint: number[];
  /** Still taking reports, or waiting to be decided. */
  open: number[];
  /** Gaps not asked about: get_print is one call per bucket, so only the newest are read. */
  unread: number;
}

/** Asks get_print about the newest buckets in [from, to] without a final print, up to `cap` of them. */
export async function loadGaps(src: Source, params: WireParams, finals: WirePrint[], from: number, to: number, cap: number): Promise<BucketGaps> {
  const I = params.print_interval_secs;
  const have = new Set(finals.map((p) => p.bucket));
  const missing: number[] = [];
  for (let b = Math.floor(to / I) * I - I; b >= Math.ceil(from / I) * I; b -= I) if (!have.has(b)) missing.push(b);
  const asked = missing.slice(0, cap);
  const reads = await Promise.all(asked.map((bucket) => src.view("get_print", { bucket })));
  const noPrint: number[] = [];
  const open: number[] = [];
  reads.forEach((r, i) => {
    const p = valueOf(r);
    if (p?.state === "NoPrint") noPrint.push(asked[i]!);
    else if (p?.state === "Open") open.push(asked[i]!);
  });
  return { noPrint: noPrint.sort((a, b) => a - b), open: open.sort((a, b) => a - b), unread: missing.length - asked.length };
}

/** Final prints in [from, to], paging get_prints by 200. */
export async function loadPrints(src: Source, params: WireParams, from: number, to: number): Promise<Read<WirePrint[]>> {
  const I = params.print_interval_secs;
  const start = Math.ceil(from / I) * I;
  const pages = Math.min(6, Math.max(1, Math.ceil((to - start) / I / 200)));
  const reads = await Promise.all(Array.from({ length: pages }, (_, i) => src.view("get_prints", { from_bucket: start + i * 200 * I, limit: 200 })));
  const bad = reads.find((r) => !r.ok);
  if (bad && !bad.ok && !reads.some((r) => r.ok)) return bad;
  const all = reads.flatMap((r) => valueOf(r) ?? []).filter((p) => p.bucket <= to && p.price !== null);
  const seen = new Set<number>();
  return { ok: true, value: all.filter((p) => (seen.has(p.bucket) ? false : (seen.add(p.bucket), true))).sort((a, b) => a.bucket - b.bucket), at: Date.now() };
}

// Bundles

export interface LoadedBundle {
  bundle: Bundle;
  text: string;
  /** Where it came from: the bundle host, or a recorded file in evidence/. */
  origin: { kind: "host"; url: string } | { kind: "recorded"; file: string };
}

const bundles = readCache(10 * 60_000, 50);

/** Fetches `<bundles_base>/<hash>.json` on the server, for the sources table. Not verified here. */
export async function loadBundle(hash: string): Promise<Read<LoadedBundle> | null> {
  const base = deployments().bundlesBase;
  if (!base || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const url = `${base}/${hash}.json`;
  return bundles.read(url, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`bundle host answered HTTP ${res.status}`);
      const text = await res.text();
      return { bundle: JSON.parse(text) as Bundle, text, origin: { kind: "host" as const, url } };
    } finally {
      clearTimeout(t);
    }
  });
}

/** The newest bundle recorded in evidence/bundles for a chip, the fixture and fallback. */
export function recordedBundle(chip: ChipKey = "h100"): LoadedBundle | null {
  const r = buildData().bundles.find((b) => b.chip === chip);
  if (!r) return null;
  try {
    return { bundle: JSON.parse(r.text) as Bundle, text: r.text, origin: { kind: "recorded", file: r.file } };
  } catch {
    return null;
  }
}

export const isStale = (params: WireParams | null, last: WireLastPrint | null, now: number): boolean => !!params && !!last && now - last.bucket > params.max_anchor_age_secs;
