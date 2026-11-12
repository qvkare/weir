// Build-time facts for the static pages: where figures come from and what the browser may read.
// Server only (it reads the build data).
import { buildData, deployments, isModel } from "./build.ts";
import { siteConfig, type SiteConfig } from "./site-config.ts";

/** The deployed address. Link previews, canonical links, robots, sitemap and the code on /agents use it. */
export const SITE_URL = (process.env.WEIR_SITE_URL ?? "https://weir.qvkare.workers.dev").replace(/\/+$/, "");

export function siteCfg(): SiteConfig {
  const d = deployments();
  const mode = isModel() ? "model" : d.markets.length ? "chain" : "none";
  return siteConfig(d, mode, buildData().builtAt, SITE_URL);
}
