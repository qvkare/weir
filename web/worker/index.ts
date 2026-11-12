// The site's Worker. Static assets (out/, from `next build`) are served by Cloudflare without it;
// it runs only for the paths in WORKER_FIRST: the per-market pages (to redirect ?m=<market>), the
// /api routes and old /m/ names. It holds no secret and needs none.
import { apiHandler, type ApiContext } from "../lib/api-handlers.ts";
import { fail } from "../lib/api.ts";
import { clientSource } from "../lib/client-source.ts";
import type { SiteConfig } from "../lib/site-config.ts";
import { route } from "./route.ts";

interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> };
  /** Optional: a NEAR mainnet account to name as the recipient of dry quotes. */
  WEIR_QUOTE_RECIPIENT?: string;
}

type Site = SiteConfig & { headers: Record<string, string> };

// Read once per isolate from the static file the build wrote (app/site.json/route.ts).
let site: Promise<Site> | null = null;
function siteOf(env: Env, url: URL): Promise<Site> {
  site ??= env.ASSETS.fetch(new URL("/site.json", url).toString()).then(async (r) => {
    if (!r.ok) throw new Error(`site.json answered HTTP ${r.status}`);
    return (await r.json()) as Site;
  });
  site.catch(() => (site = null));
  return site;
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) if (!out.headers.has(k) || k === "Content-Security-Policy") out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const r = route(url);
    if (r.kind === "asset") {
      const [res, s] = await Promise.all([env.ASSETS.fetch(req), siteOf(env, url).catch(() => null)]);
      return s ? withHeaders(res, s.headers) : res;
    }
    const s = await siteOf(env, url);
    if (r.kind === "redirect") return withHeaders(new Response(null, { status: 302, headers: { location: r.location, "cache-control": "public, max-age=300" } }), s.headers);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-max-age": "86400" } });
    if (req.method !== "GET" && req.method !== "HEAD") return withHeaders(fail(405, "method_not_allowed", "The API is read-only: use GET."), s.headers);
    const ctx: ApiContext = { network: s.network, sourceOf: (m) => clientSource(s, m), quoteRecipient: env.WEIR_QUOTE_RECIPIENT };
    const res = (await apiHandler(ctx, url))!;
    return withHeaders(res, s.headers);
  },
};
