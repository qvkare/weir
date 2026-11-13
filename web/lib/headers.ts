// The security headers every response carries. The browser may talk to this site, the NEAR RPC
// endpoints and the bundle host (deployments.json), the testnet faucet, and nothing else. Used by
// the Worker for the responses it makes and written to out/_headers for the assets Cloudflare
// serves directly.
import type { Deployments } from "./config.ts";

/** The NEAR testnet faucet that creates the test bid's throwaway account (chain/src/faucet.ts).
 * Allowed on every page, not only on /m/h100-fast/try: a policy is fixed when a document loads,
 * and the site moves between its views without loading a new document, so a test bid opened from
 * another view would run under that view's policy. The test bid's transactions go to the RPC
 * endpoints already listed (fastnear first for sends). */
export const FAUCET_ORIGIN = "https://helper.nearprotocol.com";

const originOf = (u: string): string | null => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

export function connectSources(d: Pick<Deployments, "rpc" | "bundlesBase" | "network">): string[] {
  return [...new Set(["'self'", ...d.rpc.map(originOf), d.bundlesBase ? originOf(d.bundlesBase) : null, d.network === "testnet" ? FAUCET_ORIGIN : null].filter((x): x is string => !!x))];
}

export function csp(d: Pick<Deployments, "rpc" | "bundlesBase" | "network">, dev = false): string {
  return [
    "default-src 'self'",
    // Next.js inlines its boot data as inline scripts in static pages, and the theme and motion
    // scripts run before first paint; no third-party script is loaded.
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connectSources(d).join(" ")}${dev ? " ws: http://localhost:*" : ""}`,
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function securityHeaders(d: Pick<Deployments, "rpc" | "bundlesBase" | "network">): Record<string, string> {
  return {
    "Content-Security-Policy": csp(d),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000",
  };
}
