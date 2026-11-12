import { deployments } from "@/lib/build.ts";
import { securityHeaders } from "@/lib/headers.ts";

export const dynamic = "force-static";

// out/_headers: Cloudflare applies it to the static assets it serves without the Worker. The
// Worker sets the same headers on what it serves (worker/index.ts).
export function GET() {
  const h = securityHeaders(deployments());
  const lines = ["/*", ...Object.entries(h).map(([k, v]) => `  ${k}: ${v}`), "", "/_next/static/*", "  Cache-Control: public, max-age=31536000, immutable", ""];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
