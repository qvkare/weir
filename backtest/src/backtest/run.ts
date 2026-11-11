// Recompute every file in results/ from data/derived/. Offline and deterministic:
// sorted inputs, fixed number formatting, no timestamps.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toCsv } from "../lib/csv.ts";
import { fmtUsd } from "../lib/money.ts";
import { PARAMS } from "./model.ts";
import { analyse, weekRows } from "./analysis.ts";
import { loadInputs } from "./io.ts";
import { renderMarkdown } from "./report.ts";
import type { OrnnGap } from "./report.ts";

const dollars = (micro: number): string => ((micro * PARAMS.hoursPerWeek) / 1_000_000).toFixed(2);

export function runBacktest(derivedDir: string, resultsDir: string): void {
  const inp = loadInputs(derivedDir);
  const summary = analyse(inp);
  const bps = summary.recommendation.band_bps;
  const rows = weekRows(inp, bps, summary.regimes.trough_week);

  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");

  writeFileSync(
    join(resultsDir, "weeks.csv"),
    toCsv(
      [
        "week_start", "regime", "anchor_day", "anchor", "delivery_prints", "fixing", "move",
        "band_bps", "mid", "floor", "cap", "band", "inside_band",
        "long_price", "long_payout", "short_payout", "forward",
        "buyer_unhedged_usd", "buyer_hedged_usd", "buyer_locked_usd",
        "seller_unhedged_usd", "seller_hedged_usd", "seller_locked_usd",
      ],
      rows.map(({ w, h, regime }) => [
        w.week, regime, w.anchorDay, fmtUsd(w.anchor), w.prints, fmtUsd(w.fixing), (w.fixing / w.anchor - 1).toFixed(6),
        bps, fmtUsd(w.mid), fmtUsd(w.floor), fmtUsd(w.cap), fmtUsd(w.band), w.inside ? 1 : 0,
        fmtUsd(h.p), fmtUsd(w.longPayout), fmtUsd(w.shortPayout), fmtUsd(h.forward),
        dollars(h.buyerUnhedged), dollars(h.buyerHedged), dollars(h.buyerLock),
        dollars(h.sellerUnhedged), dollars(h.sellerHedged), dollars(h.sellerLock),
      ]),
    ),
  );

  const site = {
    underlying: "H100 on-demand composite, USD per GPU-hour",
    band_bps: bps,
    hours_per_week: PARAMS.hoursPerWeek,
    note: "Auction assumed to clear at the anchor (forward = mid). hedged = fixing - LONG payout + LONG price.",
    weeks: rows.map(({ w }) => w.week),
    anchor: rows.map(({ w }) => Number(fmtUsd(w.anchor))),
    fixing: rows.map(({ w }) => Number(fmtUsd(w.fixing))),
    floor: rows.map(({ w }) => Number(fmtUsd(w.floor))),
    cap: rows.map(({ w }) => Number(fmtUsd(w.cap))),
    hedged: rows.map(({ h }) => Number(fmtUsd(h.buyerHedged))),
    unhedged: rows.map(({ h }) => Number(fmtUsd(h.buyerUnhedged))),
    inside: rows.map(({ w }) => w.inside),
  };
  writeFileSync(join(resultsDir, "site.json"), JSON.stringify(site) + "\n");
  const validation = JSON.parse(readFileSync(join(derivedDir, "validation.json"), "utf8")) as { ornn_ocpi_h100_daily?: OrnnGap };
  writeFileSync(join(resultsDir, "summary.md"), renderMarkdown(summary, validation.ornn_ocpi_h100_daily));
}
