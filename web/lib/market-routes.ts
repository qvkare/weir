// The pages written once per market at build time. The default market's are at the plain path
// (/auction); the others at /m/<market>/... The Worker (worker/route.ts) serves those for
// ?m=<market>, so the address bar keeps the ?m= form the site has always used.
import { DEFAULT_MARKET, MARKET_IDS, type MarketId } from "./config.ts";

export const marketParams = () => MARKET_IDS.filter((m) => m !== DEFAULT_MARKET).map((market) => ({ market }));

export interface MarketPageProps {
  params: Promise<{ market: MarketId }>;
}
