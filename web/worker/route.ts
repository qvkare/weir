// Which requests the Worker answers itself. Pure, so it is tested in Node (worker/route.test.ts).
//
// Every page is a static file. The default market's pages are at the plain path (/proof); the
// other markets' at /m/<market>/... Links from before used ?m=<market>; those are redirected to
// the path, so a shared link still opens the market it named.
import { DEFAULT_MARKET, isMarketId, marketFromParam, PER_MARKET_PAGES, withMarket } from "../lib/config.ts";

export { PER_MARKET_PAGES };

/** Paths the Worker sees before the static assets (wrangler.jsonc, assets.run_worker_first). */
export const WORKER_FIRST = [...PER_MARKET_PAGES, "/api/*", "/m/h100-weekly", "/m/h100-weekly/*", "/m/weekly", "/m/weekly/*", "/m/fast", "/m/fast/*"];

export type Route = { kind: "api" } | { kind: "redirect"; location: string } | { kind: "asset" };

export function route(url: URL): Route {
  const path = url.pathname;
  if (path.startsWith("/api/")) return { kind: "api" };
  const page = path.length > 1 ? path.replace(/\/+$/, "") : path;

  // /m/<default market or old name>/<page>: the market's own address.
  const m = /^\/m\/([^/]+)(\/.*)?$/.exec(page);
  if (m && (m[1] === DEFAULT_MARKET || !isMarketId(m[1]!))) {
    const market = marketFromParam(m[1]);
    if (market === DEFAULT_MARKET && m[1] !== DEFAULT_MARKET && m[1] !== "weekly") return { kind: "asset" };
    const rest = m[2] ?? "/";
    if (!PER_MARKET_PAGES.includes(rest)) return { kind: "asset" };
    return { kind: "redirect", location: withMarket(rest, market, url.searchParams.toString()) };
  }

  // ?m=<market> on a page that has one version per market.
  if (url.searchParams.has("m") && PER_MARKET_PAGES.includes(page)) {
    const q = new URLSearchParams(url.searchParams);
    const market = marketFromParam(q.get("m"));
    q.delete("m");
    return { kind: "redirect", location: withMarket(page, market, q.toString()) };
  }
  return { kind: "asset" };
}
