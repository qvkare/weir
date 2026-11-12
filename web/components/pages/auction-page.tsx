import { AuctionLive } from "./auction-live.tsx";
import type { MarketId } from "@/lib/config.ts";
import { loadAuction } from "@/lib/data/auction.ts";
import { siteCfg } from "@/lib/site.ts";
import { liveMarkets } from "@/lib/build.ts";
import { source } from "@/lib/source.ts";

export async function AuctionPage({ market }: { market: MarketId }) {
  return <AuctionLive cfg={siteCfg()} initial={await loadAuction(source(market), null)} market={market} offered={liveMarkets()} />;
}
