import { deployments } from "@/lib/build.ts";
import { securityHeaders } from "@/lib/headers.ts";
import { siteCfg } from "@/lib/site.ts";

export const dynamic = "force-static";

// What the site's Worker needs at run time, written as a static file at build: the RPC endpoints
// in the order the site uses them, each market's contract, and the security headers. All of it is
// public (deployments.json is in the repository); it holds no secret.
export function GET() {
  return Response.json({ ...siteCfg(), headers: securityHeaders(deployments()) });
}
