// Compare the composite with two outside series where they overlap, and check that
// the two gpuhunt-based sources agree where both cover a provider on the same day.

import { readFileSync } from "node:fs";
import { median } from "@weir/engine";
import { parseCsvObjects } from "../lib/csv.ts";
import { addDays } from "../lib/dates.ts";
import { fmtUsd, toMicro } from "../lib/money.ts";
import type { IndexDay, Observation, ProviderDay } from "../lib/compose.ts";
import { HENRY_FILE, ORNN_FILE } from "../fetch/crosscheck.ts";

interface Pair {
  date: string;
  ours: number;
  theirs: number;
}

const pct = (x: number): number => Number((x * 100).toFixed(2));

function gapStats(pairs: Pair[], showTheirs: boolean) {
  const gaps = pairs.map((p) => ({ ...p, gap: p.ours / p.theirs - 1 }));
  const abs = gaps.map((g) => Math.abs(g.gap));
  const worst = [...gaps].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || (a.date < b.date ? -1 : 1)).slice(0, 5);
  return {
    overlap: pairs.length,
    first: pairs[0]?.date ?? null,
    last: pairs[pairs.length - 1]?.date ?? null,
    mean_abs_pct_gap: pairs.length ? pct(abs.reduce((a, b) => a + b, 0) / abs.length) : null,
    max_abs_pct_gap: pairs.length ? pct(Math.max(...abs)) : null,
    mean_signed_pct_gap: pairs.length ? pct(gaps.reduce((a, g) => a + g.gap, 0) / gaps.length) : null,
    worst: worst.map((g) => ({
      date: g.date,
      ours: fmtUsd(g.ours),
      ...(showTheirs ? { theirs: fmtUsd(g.theirs) } : {}),
      pct_gap: pct(g.gap),
    })),
  };
}

export function validate(index: IndexDay[], rows: ProviderDay[], gpuhunt: Observation[], hubbard: Observation[]) {
  const byDay = new Map(index.filter((d) => d.index !== null).map((d) => [d.day, d.index!]));

  // henryzhangpku: weekly rows labelled by their Monday.
  const henryValue: Pair[] = [];
  const henryRaw: Pair[] = [];
  for (const r of parseCsvObjects(readFileSync(HENRY_FILE, "utf8"))) {
    if (r.index_code !== "GIX-H100" || r.status !== "published") continue;
    const week: number[] = [];
    for (let i = 0; i < 7; i++) {
      const v = byDay.get(addDays(r.period!, i));
      if (v !== undefined) week.push(v);
    }
    if (week.length < 4) continue;
    const ours = Math.round(week.reduce((a, b) => a + b, 0) / week.length);
    if (Number(r.value) > 0) henryValue.push({ date: r.period!, ours, theirs: toMicro(Number(r.value)) });
    if (Number(r.raw_on_demand_median) > 0) {
      henryRaw.push({ date: r.period!, ours, theirs: toMicro(Number(r.raw_on_demand_median)) });
    }
  }
  henryValue.sort((a, b) => (a.date < b.date ? -1 : 1));
  henryRaw.sort((a, b) => (a.date < b.date ? -1 : 1));

  // Ornn: daily values stamped 04:00 UTC.
  const ornn: Pair[] = [];
  const doc = JSON.parse(readFileSync(ORNN_FILE, "utf8")) as { data: Array<{ timestamp: string; index_value: number }> };
  for (const d of doc.data) {
    const day = d.timestamp.slice(0, 10);
    const ours = byDay.get(day);
    if (ours !== undefined && d.index_value > 0) ornn.push({ date: day, ours, theirs: toMicro(d.index_value) });
  }
  ornn.sort((a, b) => (a.date < b.date ? -1 : 1));

  // gpuhunt catalogs vs afhubbard snapshots for the same provider and day.
  const hub = new Map(hubbard.map((o) => [`${o.day}|${o.provider}`, median(o.offers)]));
  const agree: Pair[] = [];
  for (const o of gpuhunt) {
    const h = hub.get(`${o.day}|${o.provider}`);
    if (h !== undefined) agree.push({ date: `${o.day} ${o.provider}`, ours: median(o.offers), theirs: h });
  }
  agree.sort((a, b) => (a.date < b.date ? -1 : 1));
  const exact = agree.filter((p) => p.ours === p.theirs).length;

  const ourMean = (pairs: Pair[]): string =>
    pairs.length ? fmtUsd(Math.round(pairs.reduce((a, p) => a + p.ours, 0) / pairs.length)) : "";
  const theirMean = (pairs: Pair[]): string =>
    pairs.length ? fmtUsd(Math.round(pairs.reduce((a, p) => a + p.theirs, 0) / pairs.length)) : "";

  return {
    note: "pct_gap = ours / theirs - 1, in percent. Weekly comparisons use the mean of our daily index over Monday..Sunday when at least 4 days have a value.",
    henryzhangpku_weekly_value: {
      what: "GIX-H100 'value' column (their normalised rate-card index, unaudited, MIT)",
      ...gapStats(henryValue, true),
      mean_ours: ourMean(henryValue),
      mean_theirs: theirMean(henryValue),
    },
    henryzhangpku_weekly_raw_on_demand_median: {
      what: "GIX-H100 'raw_on_demand_median' column (median of raw on-demand rate cards)",
      ...gapStats(henryRaw, true),
      mean_ours: ourMean(henryRaw),
      mean_theirs: theirMean(henryRaw),
    },
    ornn_ocpi_h100_daily: {
      what: "Ornn OCPI-H100 SXM daily index (transaction-based by its own description). Only gap statistics are published here; Ornn's values are not redistributed.",
      ...gapStats(ornn, false),
      mean_ours: ourMean(ornn),
    },
    source_consistency_gpuhunt_vs_afhubbard: {
      what: "Same provider, same day: gpuhunt catalog median vs afhubbard snapshot median (both come from gpuhunt; differences come from snapshot time and filters)",
      ...gapStats(agree, true),
      identical: exact,
    },
    providers_seen: [...new Set(rows.map((r) => r.provider))].sort(),
  };
}
