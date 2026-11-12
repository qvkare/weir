// The home page for one market, written at build time (server). The figures are the build's read
// of the chain (or the model); HomeLive then reads the chain in the browser.
import { HomeLive } from "./home-live.tsx";
import { funding, liveMarkets } from "@/lib/build.ts";
import { MARKET_INFO, marketsOfChip, type ChipKey, type MarketId } from "@/lib/config.ts";
import { loadHome } from "@/lib/data/home.ts";
import { buildFloor } from "@/lib/floor.ts";
import { CHIPS } from "@/lib/hardware.ts";
import { recordedBundle } from "@/lib/load-server.ts";
import { siteCfg } from "@/lib/site.ts";
import { source } from "@/lib/source.ts";

const FLOOR = buildFloor();

export async function HomePage({ market }: { market: MarketId }) {
  const cfg = siteCfg();
  const offered = liveMarkets();
  const chipMarkets = CHIPS.map((c) => c.id as ChipKey)
    .filter((c) => c !== MARKET_INFO[market].chip)
    .map((c) => marketsOfChip(c, offered)[0])
    .filter((m): m is MarketId => !!m);
  const initial = await loadHome(source(market), { range: null, bundlesBase: cfg.bundlesBase, chipSources: chipMarkets.map((m) => source(m)) });
  const f = funding();
  return <HomeLive cfg={cfg} initial={initial} offered={offered} chipMarkets={chipMarkets} sample={recordedBundle(MARKET_INFO[market].chip)} fundingTag={f.tag === "recorded" ? "recorded" : "quotes"} floor={FLOOR} />;
}
