// The repository data inlined at build time (see next.config.ts and build-data.ts).
import type { BuildData } from "./build-types.ts";
import { MARKET_IDS, parseDeployments, type Deployments, type MarketId } from "./config.ts";
import { fundingStatus, type FundingStatus } from "./evidence.ts";

const EMPTY: BuildData = {
  builtAt: 0,
  specVersion: null,
  spec: null,
  audit: null,
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

/** The markets this site offers: all four in model mode, else those deployments.json lists (all four when it lists none, each saying it is not deployed). */
export function liveMarkets(): MarketId[] {
  if (isModel()) return [...MARKET_IDS];
  const listed = deployments().markets.map((m) => m.id);
  return listed.length ? MARKET_IDS.filter((m) => listed.includes(m)) : [...MARKET_IDS];
}

/** Where a market's data comes from in this process. */
export function sourceKind(market: MarketId): "model" | "chain" | "none" {
  if (isModel()) return "model";
  return deployments().markets.some((m) => m.id === market) ? "chain" : "none";
}
