import type { MetadataRoute } from "next";
import { DEFAULT_MARKET, MARKET_IDS, withMarket } from "@/lib/config.ts";
import { SITE_URL } from "@/lib/site.ts";

export const dynamic = "force-static";

// Every page the build writes: the default market's at the plain path, the others under /m/<market>.
const PER_MARKET = ["/", "/auction", "/simulate", "/how", "/proof", "/agents"];
const ONCE = ["/backtest", "/spec", "/audit"];

export default function sitemap(): MetadataRoute.Sitemap {
  const urls = [...PER_MARKET, ...ONCE].map((p) => `${SITE_URL}${p}`);
  for (const m of MARKET_IDS) if (m !== DEFAULT_MARKET) for (const p of PER_MARKET) urls.push(`${SITE_URL}${withMarket(p, m)}`);
  return urls.map((url) => ({ url }));
}
