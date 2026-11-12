// The reads of the application's views (lib/app-views.ts). Browser-safe: the build runs them for
// the static page and the browser runs them again. Each returns serialisable data.
import type { WireAccount, WireLastPrint, WireLiveSeries, WireParams, WirePrint, WireResult, WireSeries } from "@weir/engine";
import { valueOf } from "../cache.ts";
import type { MarketId } from "../config.ts";
import { latestRound, loadCore, loadResults } from "../load.ts";
import type { Source, SourceKind } from "../source-types.ts";
import type { FrontChip, FrontRow } from "./front.ts";

// ── The frame: the title row and the sidebar's prints ────────────

export interface ShellData {
  market: MarketId;
  kind: SourceKind;
  error: string | null;
  tick: number | null;
  live: WireLiveSeries | null;
  last: WireLastPrint | null;
  now: number;
  chips: FrontChip[];
  at: number;
}

export async function loadShell(src: Source, others: Source[]): Promise<ShellData> {
  const [c, chips] = await Promise.all([
    loadCore(src),
    Promise.all(
      others.map(async (s): Promise<FrontChip> => {
        const [l, p] = await Promise.all([s.view("get_last_print", {}), s.view("get_params", {})]);
        return { market: s.market, kind: s.kind, last: valueOf(l), tick: valueOf(p)?.tick ?? null };
      }),
    ),
  ]);
  const params = valueOf(c.params);
  const status = valueOf(c.status);
  const live = status ? (status.live.find((l) => l.round !== null) ?? status.live[0] ?? null) : null;
  const own: FrontChip = { market: src.market, kind: src.kind, last: valueOf(c.last), tick: params?.tick ?? null };
  return {
    market: src.market,
    kind: src.kind,
    error: !c.status.ok ? c.status.error : !c.params.ok ? c.params.error : null,
    tick: params?.tick ?? null,
    live,
    last: valueOf(c.last),
    now: c.now,
    chips: [own, ...chips.filter((x) => x.market !== src.market)],
    at: Date.now(),
  };
}

export const shellKey = (d: ShellData): string => JSON.stringify([d.live ? [d.live.series, d.live.round, d.live.phase] : null, d.last?.bucket ?? null]);

// ── Clearings: every round of a series ───────────────────────────

export interface ClearingsData {
  market: MarketId;
  kind: SourceKind;
  error: string | null;
  params: WireParams | null;
  now: number;
  series: number | null;
  info: WireSeries | null;
  rows: FrontRow[];
  /** The round picked (?series=&round=), or the newest that traded. */
  picked: { series: number; round: number; result: WireResult | null; info: WireSeries | null } | null;
  at: number;
}

/** All cleared rounds of a series, newest first; get_results returns at most 100 a call. */
async function allResults(src: Source, series: number, upTo: number): Promise<[number, WireResult][]> {
  const out: [number, WireResult][] = [];
  for (let to = upTo; to >= 0; to -= 100) {
    const r = valueOf(await loadResults(src, series, to, 100));
    if (!r) break;
    out.push(...r);
    if (to - 100 < 0) break;
  }
  return out.sort((a, b) => b[0] - a[0]);
}

export async function loadClearings(src: Source, sel: { series: number; round: number } | null): Promise<ClearingsData> {
  const c = await loadCore(src);
  const params = valueOf(c.params);
  const status = valueOf(c.status);
  const base: ClearingsData = { market: src.market, kind: src.kind, error: !c.status.ok ? c.status.error : null, params, now: c.now, series: null, info: null, rows: [], picked: null, at: Date.now() };
  if (!params || !status) return base;
  const live = status.live.find((l) => l.round !== null) ?? status.live[0] ?? null;
  const series = sel?.series ?? live?.series ?? null;
  if (series === null) return base;
  const [infoR, list] = await Promise.all([src.view("get_series", { series }), allResults(src, series, latestRound(params, series, c.now))]);
  const info = valueOf(infoR);
  const rows: FrontRow[] = list.map(([r, res]) => ({ series, round: r, state: res.price === null ? "No trade" : "Cleared", price: res.price, forward: res.price !== null && info ? info.floor + res.price : null, volume: res.price === null ? null : res.volume, commits: res.commits, revealed: res.orders, fees: res.fees, locked: null, clearedAt: res.cleared_at }));
  let picked: ClearingsData["picked"] = null;
  if (sel) {
    const inList = list.find(([r]) => r === sel.round);
    const result = inList ? inList[1] : valueOf(await src.view("get_result", { series: sel.series, round: sel.round }));
    picked = { series: sel.series, round: sel.round, result: result ?? null, info };
  } else {
    const t = list.find(([, r]) => r.price !== null);
    if (t) picked = { series, round: t[0], result: t[1], info };
  }
  return { ...base, series, info, rows, picked };
}

// ── Index prints, with their reports ─────────────────────────────

export interface PrintsData {
  market: MarketId;
  kind: SourceKind;
  error: string | null;
  tick: number | null;
  interval: number | null;
  prints: WirePrint[];
  at: number;
}

export const PRINT_ROWS = 8;

export async function loadPrintList(src: Source): Promise<PrintsData> {
  const c = await loadCore(src);
  const params = valueOf(c.params);
  const last = valueOf(c.last);
  const base: PrintsData = { market: src.market, kind: src.kind, error: !c.status.ok ? c.status.error : null, tick: params?.tick ?? null, interval: params?.print_interval_secs ?? null, prints: [], at: Date.now() };
  if (!params || !last) return base;
  const r = await src.view("get_prints", { from_bucket: last.bucket - (PRINT_ROWS - 1) * params.print_interval_secs, limit: PRINT_ROWS });
  return { ...base, prints: [...(valueOf(r) ?? [])].sort((a, b) => b.bucket - a.bucket) };
}

// ── Agents: the accounts on a market ─────────────────────────────

export interface AgentRow {
  account: string;
  role: string;
  balance: string | null;
  guard: number | null;
  maxRoundLock: string | null;
  position: { long: number; short: number } | null;
  last: { what: string; series: number; round: number; at: number | null } | null;
}

export interface AgentsViewData {
  market: MarketId;
  kind: SourceKind;
  error: string | null;
  series: number | null;
  rows: AgentRow[];
  at: number;
}

export async function loadAgentRows(src: Source, accounts: { account: string; role: string }[]): Promise<AgentsViewData> {
  const c = await loadCore(src);
  const params = valueOf(c.params);
  const status = valueOf(c.status);
  const live = status ? (status.live.find((l) => l.round !== null) ?? status.live[0] ?? null) : null;
  const [round, results, accts, positions] = await Promise.all([
    live && live.round !== null ? src.view("get_round", { series: live.series, round: live.round }) : Promise.resolve(null),
    live && params ? loadResults(src, live.series, latestRound(params, live.series, c.now), 100) : Promise.resolve(null),
    Promise.all(accounts.map((a) => src.view("get_account", { account_id: a.account }))),
    Promise.all(accounts.map((a) => (live ? src.view("get_position", { series: live.series, account_id: a.account }) : Promise.resolve(null)))),
  ]);
  const last: Record<string, AgentRow["last"]> = {};
  for (const x of (round ? valueOf(round) : null)?.commits ?? []) last[x.owner] ??= { what: x.state === "Revealed" ? "revealed" : x.state === "Void" ? "void" : "committed, sealed", series: live!.series, round: live!.round!, at: null };
  for (const [r, res] of [...((results ? valueOf(results) : null) ?? [])].reverse()) for (const f of res.fills) last[f.owner] ??= { what: `filled ${f.filled} GPU-h ${f.side === "Long" ? "LONG" : "SHORT"}`, series: live!.series, round: r, at: res.cleared_at };
  const rows: AgentRow[] = accounts.map((a, i) => {
    const acc: WireAccount | null = valueOf(accts[i]!) ?? null;
    const pos = positions[i] ? valueOf(positions[i]!) : null;
    return { account: a.account, role: a.role, balance: acc?.balance ?? null, guard: acc?.guard ?? null, maxRoundLock: acc?.max_round_lock ?? null, position: pos ? { long: pos.long, short: pos.short } : null, last: last[a.account] ?? null };
  });
  return { market: src.market, kind: src.kind, error: !c.status.ok ? c.status.error : null, series: live?.series ?? null, rows, at: Date.now() };
}
