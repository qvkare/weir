// The repository's deployments.json, read at build time and parsed here. Tolerant: a field that
// is missing or of the wrong type is treated as absent, never guessed.

export type MarketId = "weekly" | "fast";
export const MARKET_IDS: readonly MarketId[] = ["weekly", "fast"];
export const DEFAULT_MARKET: MarketId = "weekly";

export const MARKET_INFO: Record<MarketId, { label: string; delivery: string; rounds: string }> = {
  weekly: { label: "Weekly", delivery: "one-week delivery", rounds: "hourly rounds" },
  fast: { label: "Fast", delivery: "one-hour delivery", rounds: "five-minute rounds" },
};

export interface MarketDeployment {
  id: MarketId;
  /** The Weir contract account. */
  contract: string;
  /** The USDC token account, when deployments.json names it (otherwise read from get_params). */
  usdc: string | null;
  /** Other accounts the deployment lists (reporters, keeper), shown on /proof. */
  accounts: { role: string; account: string }[];
}

export interface Deployments {
  network: string;
  rpc: string[];
  explorer: string | null;
  bundlesBase: string | null;
  markets: MarketDeployment[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function isMarketId(v: unknown): v is MarketId {
  return v === "weekly" || v === "fast";
}

export function parseDeployments(raw: unknown): Deployments {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rpc = Array.isArray(o.rpc) ? o.rpc.map(str).filter((s): s is string => !!s && /^https:\/\//.test(s)) : str(o.rpc) ? [str(o.rpc)!] : [];
  const markets: MarketDeployment[] = [];
  const list = Array.isArray(o.markets) ? o.markets : o.markets && typeof o.markets === "object" ? Object.entries(o.markets).map(([id, v]) => ({ id, ...(v as object) })) : [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const e = m as Record<string, unknown>;
    const id = e.id ?? e.name ?? e.market;
    const contract = str(e.contract) ?? str(e.account_id) ?? str(e.account) ?? str(e.contract_id);
    if (!isMarketId(id) || !contract || markets.some((x) => x.id === id)) continue;
    const accounts: { role: string; account: string }[] = [];
    for (const [role, v] of Object.entries(e)) {
      if (["id", "name", "market", "contract", "account_id", "account", "contract_id", "usdc"].includes(role)) continue;
      if (str(v) && /^[a-z0-9._-]+$/.test(str(v)!)) accounts.push({ role, account: str(v)! });
      if (Array.isArray(v)) for (const a of v) if (str(a) && /^[a-z0-9._-]+$/.test(str(a)!)) accounts.push({ role, account: str(a)! });
    }
    markets.push({ id, contract, usdc: str(e.usdc), accounts });
  }
  const base = str(o.bundles_base);
  return {
    network: str(o.network) ?? "testnet",
    rpc,
    explorer: str(o.explorer)?.replace(/\/+$/, "") ?? null,
    bundlesBase: base && /^https?:\/\//.test(base) ? base.replace(/\/+$/, "") : null,
    markets,
  };
}

/** The market a request asks for: `?m=fast` or `?m=weekly`, else the default. */
export function marketFromParam(param: string | string[] | undefined | null): MarketId {
  const v = Array.isArray(param) ? param[0] : param;
  return isMarketId(v) ? v : DEFAULT_MARKET;
}

export const accountUrl = (explorer: string | null, account: string): string | null =>
  explorer ? `${explorer}/address/${encodeURIComponent(account)}` : null;

export const txUrl = (explorer: string | null, hash: string): string | null => (explorer ? `${explorer}/txns/${encodeURIComponent(hash)}` : null);
