// dstack's gpuhunt price catalogs. The bucket cannot be listed, and each catalog is
// named `{YYYYMMDD}-{run}` where `run` is the GitHub Actions run number of the job
// that built it (about 24 runs a day). For each day we guess the run number from
// the nearest catalog already found and try numbers around the guess until one
// exists for that date. Every hit and every miss is recorded in probes.json, so a
// re-run never repeats a request.

import { join } from "node:path";
import { cachedGet, readJsonIfExists, writeJson } from "../lib/http.ts";
import { RAW, HISTORY_START, HISTORY_END } from "../lib/paths.ts";
import { compact, dayRange, daysBetween } from "../lib/dates.ts";

const BUCKET = "https://dstack-gpu-pricing.s3.eu-west-1.amazonaws.com";
/** v1 catalogs stop after this day; later days use v2 (same CSV layout). */
const V1_LAST_DAY = "2026-08-18";
const RUNS_PER_DAY = 24.1;
const RADIUS = 30;

/** Catalog names verified by the earlier research pass. */
const KNOWN: Array<[string, number]> = [
  ["2024-11-12", 3992],
  ["2025-01-01", 5196],
  ["2025-03-01", 6625],
  ["2025-06-15", 9196],
  ["2025-12-01", 13311],
  ["2026-06-01", 17399],
  ["2026-11-11", 20922],
];

export interface Probe {
  day: string;
  base?: "v1" | "v2";
  version?: string;
  url?: string;
  file?: string;
  /** Run numbers tried without success, as an inclusive range. */
  missedRange?: [number, number];
  /** Further run numbers tried in the fill pass. */
  tried?: number[];
  /** Set when every run number between the neighbouring days' catalogs was tried. */
  exhausted?: [number, number];
  /** Successful workflow runs GitHub lists for that day (only for recent days). */
  githubSuccessRuns?: number[];
}

/** GitHub keeps workflow run history for about 400 days; older days are probed only. */
const GITHUB_FROM = "2025-11-15";
const GITHUB_RUNS = "https://api.github.com/repos/dstackai/gpuhunt/actions/workflows/67227846/runs";

/**
 * For recent days still without a catalog, ask GitHub which runs of the catalog
 * workflow succeeded on that day (one listing per stretch of consecutive missing
 * days) and fetch the catalog of the latest successful run. A day with no successful
 * run is settled as having no catalog. Unauthenticated: 60 requests an hour.
 */
async function githubPass(probes: Record<string, Probe>): Promise<void> {
  const missing = Object.keys(probes)
    .filter((d) => d >= GITHUB_FROM && !probes[d]!.version && !probes[d]!.githubSuccessRuns)
    .sort();
  const stretches: string[][] = [];
  for (const d of missing) {
    const last = stretches[stretches.length - 1];
    if (last && daysBetween(last[last.length - 1]!, d) === 1) last.push(d);
    else stretches.push([d]);
  }
  for (const s of stretches) {
    const runs = new Map<string, number[]>(s.map((d) => [d, []]));
    for (let page = 1; ; page++) {
      const url = `${GITHUB_RUNS}?created=${s[0]}..${s[s.length - 1]}&status=success&per_page=100&page=${page}`;
      const res = await fetch(url, { headers: { "user-agent": "weir-backtest/0.1", accept: "application/vnd.github+json" } });
      if (!res.ok) {
        console.log(`github: ${res.status} for ${s[0]}..${s[s.length - 1]}; leaving these days to probing`);
        return;
      }
      const body = (await res.json()) as { total_count: number; workflow_runs: Array<{ run_number: number; created_at: string }> };
      for (const r of body.workflow_runs) runs.get(r.created_at.slice(0, 10))?.push(r.run_number);
      await new Promise((r) => setTimeout(r, 1500));
      if (page * 100 >= body.total_count || body.workflow_runs.length === 0) break;
    }
    for (const d of s) {
      const list = runs.get(d)!.sort((a, b) => b - a);
      const base = d <= V1_LAST_DAY ? "v1" : "v2";
      let hit: Probe | null = null;
      for (const run of list.slice(0, 3)) {
        const version = `${compact(d)}-${run}`;
        const url = `${BUCKET}/${base}/${version}/catalog.zip`;
        const file = join(GPUHUNT_DIR, base, `${version}.zip`);
        if (await cachedGet(url, file)) {
          hit = { day: d, base, version, url, file: `gpuhunt/${base}/${version}.zip`, githubSuccessRuns: list };
          break;
        }
      }
      probes[d] = hit ?? { ...probes[d]!, githubSuccessRuns: list };
      writeJson(PROBES, probes);
      console.log(`gpuhunt github ${d}: ${list.length} successful runs, ${hit ? hit.version : "no catalog"}`);
    }
  }
}

export const GPUHUNT_DIR = join(RAW, "gpuhunt");
const PROBES = join(GPUHUNT_DIR, "probes.json");

function estimate(day: string, found: Array<[string, number]>): number {
  const pts = [...found].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let before: [string, number] | undefined;
  let after: [string, number] | undefined;
  for (const p of pts) {
    if (p[0] <= day) before = p;
    else if (!after) after = p;
  }
  if (before && after) {
    const span = daysBetween(before[0], after[0]);
    return Math.round(before[1] + ((after[1] - before[1]) * daysBetween(before[0], day)) / span);
  }
  const ref = before ?? after!;
  return Math.round(ref[1] + RUNS_PER_DAY * daysBetween(ref[0], day));
}

export async function fetchGpuhunt(): Promise<void> {
  const probes = readJsonIfExists<Record<string, Probe>>(PROBES, {});
  await githubPass(probes);
  const found: Array<[string, number]> = [...KNOWN];
  for (const p of Object.values(probes)) {
    if (p.version) found.push([p.day, Number(p.version.split("-")[1])]);
  }
  let hits = 0;
  let misses = 0;
  for (const day of dayRange(HISTORY_START, HISTORY_END)) {
    const done = probes[day];
    if (done) {
      if (done.version) hits++;
      else misses++;
      continue;
    }
    const base = day <= V1_LAST_DAY ? "v1" : "v2";
    const guess = estimate(day, found);
    let probe: Probe = { day, missedRange: [guess - RADIUS, guess + RADIUS] };
    for (let k = 0; k <= 2 * RADIUS; k++) {
      const run = guess + (k % 2 === 0 ? k / 2 : -(k + 1) / 2);
      const version = `${compact(day)}-${run}`;
      const url = `${BUCKET}/${base}/${version}/catalog.zip`;
      const file = join(GPUHUNT_DIR, base, `${version}.zip`);
      const body = await cachedGet(url, file);
      if (body) {
        probe = { day, base, version, url, file: `gpuhunt/${base}/${version}.zip` };
        found.push([day, run]);
        break;
      }
    }
    probes[day] = probe;
    if (probe.version) hits++;
    else misses++;
    writeJson(PROBES, probes);
    console.log(`gpuhunt ${day}: ${probe.version ?? "none found"}`);
  }
  console.log(`gpuhunt: ${hits} days with a catalog, ${misses} without`);
  await githubPass(probes);
  await fillPass(probes);
}

/**
 * Second pass over days with no catalog. Run numbers grow with time, so every run of
 * day D lies strictly between a run found on an earlier day and one found on a later
 * day. Probing every number in that interval (that was not tried already) settles
 * whether D has a catalog at all, instead of relying on the first guess.
 */
async function fillPass(probes: Record<string, Probe>): Promise<void> {
  const days = Object.keys(probes).sort();
  const runOf = (d: string): number | null => {
    const v = probes[d]?.version;
    return v ? Number(v.split("-")[1]) : null;
  };
  let filled = 0;
  for (let i = 0; i < days.length; i++) {
    const day = days[i]!;
    const p = probes[day]!;
    if (p.version || p.exhausted || p.githubSuccessRuns) continue;
    let lo: number | null = null;
    let hi: number | null = null;
    for (let j = i - 1; j >= 0 && lo === null; j--) lo = runOf(days[j]!);
    for (let j = i + 1; j < days.length && hi === null; j++) hi = runOf(days[j]!);
    if (lo === null || hi === null || hi - lo > 400) continue;
    const tried = new Set(p.tried ?? []);
    const [a, b] = p.missedRange ?? [0, -1];
    const base = day <= V1_LAST_DAY ? "v1" : "v2";
    for (let run = lo + 1; run < hi; run++) {
      if ((run >= a && run <= b) || tried.has(run)) continue;
      const version = `${compact(day)}-${run}`;
      const url = `${BUCKET}/${base}/${version}/catalog.zip`;
      const file = join(GPUHUNT_DIR, base, `${version}.zip`);
      const body = await cachedGet(url, file);
      if (body) {
        probes[day] = { day, base, version, url, file: `gpuhunt/${base}/${version}.zip` };
        filled++;
        break;
      }
      tried.add(run);
    }
    if (!probes[day]!.version) {
      probes[day] = { ...p, tried: [...tried].sort((x, y) => x - y), exhausted: [lo + 1, hi - 1] };
    }
    writeJson(PROBES, probes);
    console.log(`gpuhunt fill ${day}: ${probes[day]!.version ?? `no catalog among runs ${lo + 1}..${hi - 1}`}`);
  }
  console.log(`gpuhunt fill pass: ${filled} more days found`);
}
