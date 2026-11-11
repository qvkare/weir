import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { readBuildData } from "./lib/build-data.ts";
import { parseDeployments } from "./lib/config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const build = readBuildData(root);
const deployments = parseDeployments(build.deployments);

// The browser may talk to this site, the NEAR RPC endpoints and the bundle host. Nothing else.
const origin = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};
const connect = ["'self'", ...deployments.rpc.map(origin), deployments.bundlesBase && origin(deployments.bundlesBase)].filter(Boolean).join(" ");
const dev = process.env.NODE_ENV === "development";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src ${connect}${dev ? " ws: http://localhost:*" : ""}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@weir/engine", "@weir/index", "@weir/agents", "@weir/chain"],
  env: { WEIR_BUILD: JSON.stringify(build) },
  turbopack: { root },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default config;
