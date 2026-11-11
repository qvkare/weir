// The repository data inlined at build time (see next.config.ts and build-data.ts).
import type { BuildData } from "./build-types.ts";
import { parseDeployments, type Deployments, type MarketId } from "./config.ts";
import { fundingStatus, type FundingStatus } from "./evidence.ts";

const EMPTY: BuildData = {
  builtAt: 0,
  deployments: null,
  bundles: [],
  bundleCount: 0,
  txs: [],
  backtest: { site: null, summary: null, summaryMd: null, siteMissing: true },
  modules: { sim: false, intents: false },
};

let cached: BuildData | null = null;

export function buildData(): BuildData {
  if (cached) return cached;
  const raw = process.env.WEIR_BUILD;
  try {
    cached = raw ? (JSON.parse(raw) as BuildData) : EMPTY;
  } catch {
    cached = EMPTY;
  }
  return cached;
}

export const deployments = (): Deployments => parseDeployments(buildData().deployments);

/** Model mode: the server answers views from an in-process engine, never the chain. */
export const isModel = (): boolean => process.env.WEIR_MODEL === "1";

export const funding = (): FundingStatus => fundingStatus(buildData().txs);

/** Where a market's data comes from in this process. */
export function sourceKind(market: MarketId): "model" | "chain" | "none" {
  if (isModel()) return "model";
  return deployments().markets.some((m) => m.id === market) ? "chain" : "none";
}
