// What the browser needs to read the chain itself, and nothing more: the network, the RPC
// endpoints in the order the site uses them, the explorer, the bundle host, each market's
// contract, and where the build's figures came from. Built on the server at build time and
// passed down as props, so the client bundle never carries the build data.
import type { Deployments, MarketId } from "./config.ts";
import { rpcOrder } from "./near.ts";
import type { SourceKind } from "./source-types.ts";

export interface SiteConfig {
  network: string;
  /** dRPC first, fastnear second (lib/near.ts, rpcOrder). */
  rpc: string[];
  explorer: string | null;
  bundlesBase: string | null;
  contracts: Partial<Record<MarketId, { contract: string; usdc: string | null }>>;
  /** Where the build read its figures: the chain, the model, or nothing deployed. */
  mode: SourceKind;
  /** Unix seconds of the build. */
  builtAt: number;
  /** The site's own address, for links in copied code. */
  siteUrl: string;
}

export function siteConfig(d: Deployments, mode: SourceKind, builtAt: number, siteUrl: string): SiteConfig {
  const contracts: SiteConfig["contracts"] = {};
  for (const m of d.markets) contracts[m.id] = { contract: m.contract, usdc: m.usdc };
  return { network: d.network, rpc: rpcOrder(d.rpc), explorer: d.explorer, bundlesBase: d.bundlesBase, contracts, mode, builtAt, siteUrl };
}
