// "Agents on the book": recent commits and fills from accounts that hold only function-call keys.
// Browser-safe; one keys read per distinct owner, at most MAX_OWNERS.
import { valueOf, type Read } from "../cache.ts";
import { latestRound, loadCore } from "../load.ts";
import { loadResults } from "../load.ts";
import { functionCallOnly } from "../near.ts";
import type { Reader } from "../reader.ts";
import type { CoreData } from "./home.ts";

export interface BookEntry {
  owner: string;
  series: number;
  round: number;
  seq: number;
  state: string;
  side: string | null;
  size: number | null;
  lock: string | null;
  filled: number | null;
}

export interface AgentsData {
  core: CoreData;
  list: BookEntry[];
  /** Owners whose keys could not be read, and owners not asked about (over the cap). */
  unknown: number;
  skipped: number;
  at: number;
}

export const MAX_OWNERS = 24;

export async function loadAgents(r: Reader): Promise<AgentsData> {
  const c = await loadCore(r.src);
  const core: CoreData = { kind: c.src.kind, params: c.params, status: c.status, last: c.last, now: c.now };
  const params = valueOf(c.params);
  const status = valueOf(c.status);
  const base: AgentsData = { core, list: [], unknown: 0, skipped: 0, at: Date.now() };
  if (!params || !status) return base;
  const entries: BookEntry[] = [];
  for (const l of status.live) {
    if (l.round !== null) {
      const rr = valueOf(await r.src.view("get_round", { series: l.series, round: l.round }));
      for (const x of [...(rr?.commits ?? [])].reverse()) entries.push({ owner: x.owner, series: l.series, round: l.round, seq: x.seq, state: x.state, side: x.order?.side ?? null, size: x.order?.size ?? null, lock: x.lock, filled: null });
    }
    const results = valueOf(await loadResults(r.src, l.series, latestRound(params, l.series, c.now), 10)) ?? [];
    for (const [round, res] of [...results].reverse()) for (const f of [...res.fills].reverse()) entries.push({ owner: f.owner, series: l.series, round, seq: f.seq, state: "Cleared", side: f.side, size: f.size, lock: null, filled: f.filled });
  }
  const owners = [...new Set(entries.map((e) => e.owner))];
  const asked = owners.slice(0, MAX_OWNERS);
  const keyReads: [string, Read<unknown>][] = await Promise.all(asked.map(async (o) => [o, await r.keys(o)] as [string, Read<unknown>]));
  const fc = new Set(keyReads.filter(([, k]) => { const v = valueOf(k) as Parameters<typeof functionCallOnly>[0] | null; return v !== null && functionCallOnly(v); }).map(([o]) => o));
  return { core, list: entries.filter((e) => fc.has(e.owner)).slice(0, 20), unknown: keyReads.filter(([, k]) => valueOf(k) === null).length, skipped: owners.length - asked.length, at: Date.now() };
}
