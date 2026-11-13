// The repository's deployments.json, read at build time and parsed here. Tolerant: a field that
// is missing or of the wrong type is treated as absent, never guessed.

// A market is one chip on one cadence. The ids are the agents package's MARKETS
// (agents/src/presets.ts); a test checks the two lists agree.
export type MarketId = "h100-weekly" | "h100-fast" | "h200-weekly" | "a100-80-weekly";
export const MARKET_IDS: readonly MarketId[] = ["h100-weekly", "h100-fast", "h200-weekly", "a100-80-weekly"];
export const DEFAULT_MARKET: MarketId = "h100-weekly";

export type ChipKey = "h100" | "h200" | "a100-80";
export const CHIP_KEYS: readonly ChipKey[] = ["h100", "h200", "a100-80"];
export const CHIP_LABEL: Record<ChipKey, string> = { h100: "H100", h200: "H200", "a100-80": "A100 80 GB" };

export interface MarketInfo {
  chip: ChipKey;
  /** "Weekly" or "Hourly": the cadence, for the switcher. */
  cadence: string;
  /** "H100 weekly": the market's name in running text. */
  name: string;
  delivery: string;
  rounds: string;
}

export const MARKET_INFO: Record<MarketId, MarketInfo> = {
  "h100-weekly": { chip: "h100", cadence: "Weekly", name: "H100 weekly", delivery: "one-week delivery", rounds: "hourly rounds" },
  "h100-fast": { chip: "h100", cadence: "Hourly", name: "H100 hourly (demo)", delivery: "one-hour delivery", rounds: "five-minute rounds" },
  "h200-weekly": { chip: "h200", cadence: "Weekly", name: "H200 weekly", delivery: "one-week delivery", rounds: "hourly rounds" },
  "a100-80-weekly": { chip: "a100-80", cadence: "Weekly", name: "A100 80 GB weekly", delivery: "one-week delivery", rounds: "hourly rounds" },
};

/** Old market names in links: `?m=weekly` and `?m=fast` were the two H100 markets. */
const ALIASES: Record<string, MarketId> = { weekly: "h100-weekly", fast: "h100-fast" };

/** The markets of one chip, in switcher order. */
export const marketsOfChip = (chip: ChipKey, among: readonly MarketId[] = MARKET_IDS): MarketId[] => among.filter((m) => MARKET_INFO[m].chip === chip);

/** The pages written once per market; the rest (/spec, /audit, /backtest) are the same for all. */
export const PER_MARKET_PAGES: readonly string[] = ["/", "/auction", "/auction/book", "/auction/clearings", "/auction/prints", "/agents", "/proof", "/proof/solvency", "/proof/review", "/proof/record", "/how", "/simulate", "/try"];

/**
 * A page of a market: the plain path for the default market, /m/<market>/<page> for the others
 * (each written once at build). `extra` is a query string without its "?".
 */
export function withMarket(path: string, market: MarketId, extra = ""): string {
  const base = market === DEFAULT_MARKET || !PER_MARKET_PAGES.includes(path) ? path : `/m/${market}${path === "/" ? "" : path}`;
  return extra ? `${base}?${extra}` : base;
}

/** The market and the page of a site path: /m/h200-weekly/proof is the H200 market's /proof. */
export function marketOfPath(pathname: string): { market: MarketId; page: string } {
  const m = /^\/m\/([^/]+)(\/.*)?$/.exec(pathname);
  if (m && isMarketId(m[1]!)) return { market: m[1] as MarketId, page: (m[2] ?? "/").replace(/(.)\/$/, "$1") };
  return { market: DEFAULT_MARKET, page: pathname };
}

export interface MarketDeployment {
  id: MarketId;
  /** As deployments.json labels it, if it does. */
  label: string | null;
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

export function isMarketId(v: unknown): v is MarketId {
  return typeof v === "string" && (MARKET_IDS as readonly string[]).includes(v);
}

export function parseDeployments(raw: unknown): Deployments {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rpc = Array.isArray(o.rpc) ? o.rpc.map(str).filter((s): s is string => !!s && /^https:\/\//.test(s)) : str(o.rpc) ? [str(o.rpc)!] : [];
  const markets: MarketDeployment[] = [];
  const list = Array.isArray(o.markets) ? o.markets : o.markets && typeof o.markets === "object" ? Object.entries(o.markets).map(([id, v]) => ({ id, ...(v as object) })) : [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const e = m as Record<string, unknown>;
    const raw = e.id ?? e.name ?? e.market;
    const id = typeof raw === "string" ? (ALIASES[raw] ?? raw) : raw;
    const contract = str(e.contract) ?? str(e.account_id) ?? str(e.account) ?? str(e.contract_id);
    if (!isMarketId(id) || !contract || markets.some((x) => x.id === id)) continue;
    const accounts: { role: string; account: string }[] = [];
    for (const [role, v] of Object.entries(e)) {
      if (["id", "name", "market", "contract", "account_id", "account", "contract_id", "usdc", "label", "chip"].includes(role)) continue;
      if (str(v) && /^[a-z0-9._-]+$/.test(str(v)!)) accounts.push({ role, account: str(v)! });
      if (Array.isArray(v)) for (const a of v) if (str(a) && /^[a-z0-9._-]+$/.test(str(a)!)) accounts.push({ role, account: str(a)! });
    }
    markets.push({ id, label: str(e.label), contract, usdc: str(e.usdc), accounts });
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

/** The market a request asks for: `?m=h200-weekly` (or the old `?m=fast`, `?m=weekly`), else the default. */
export function marketFromParam(param: string | string[] | undefined | null): MarketId {
  const v = Array.isArray(param) ? param[0] : param;
  const id = v ? (ALIASES[v] ?? v) : v;
  return isMarketId(id) ? id : DEFAULT_MARKET;
}

/** A market id from an API parameter, or null when it names no market. */
export function parseMarket(param: string | null): MarketId | null {
  if (param === null) return DEFAULT_MARKET;
  const id = ALIASES[param] ?? param;
  return isMarketId(id) ? id : null;
}

export const accountUrl = (explorer: string | null, account: string): string | null =>
  explorer ? `${explorer}/address/${encodeURIComponent(account)}` : null;

export const txUrl = (explorer: string | null, hash: string): string | null => (explorer ? `${explorer}/txns/${encodeURIComponent(hash)}` : null);
