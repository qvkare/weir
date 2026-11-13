import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { readBuildData } from "./lib/build-data.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const build = readBuildData(root);

// Next's build keeps fetch responses in .next/cache/fetch-cache and replays them on the next build,
// JSON-RPC POSTs included: on 13 Nov 2026 a chain build at 06:46 UTC showed the chain as read at
// 21:49 UTC the day before. A build must read the chain now, so the cache is dropped each time.
rmSync(fileURLToPath(new URL(".next/cache/fetch-cache", import.meta.url)), { recursive: true, force: true });

// A static export: every page is written to out/ at build time and served as a static asset.
// Live figures are read by the browser from the NEAR RPC endpoints; the small Worker in worker/
// adds the /api routes, the ?m= redirects and the security headers (lib/headers.ts).
const config: NextConfig = {
  output: "export",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@weir/engine", "@weir/index", "@weir/agents", "@weir/chain"],
  // Server components read it at build time (lib/build.ts). Client code must never import that file.
  env: { WEIR_BUILD: JSON.stringify(build) },
  turbopack: { root },
};

export default config;
