// `pnpm --filter @weir/backtest run backtest`
import { DERIVED, RESULTS } from "../lib/paths.ts";
import { runBacktest } from "./run.ts";

runBacktest(DERIVED, RESULTS);
console.log(`wrote ${RESULTS}/summary.json, weeks.csv, summary.md, site.json`);
