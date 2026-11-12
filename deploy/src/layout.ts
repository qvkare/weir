// What a deployment consists of, worked out from the network, the suffix and the markets
// alone: every account with its role and why it exists, every agent with its strategy, its
// test dollars, its guard and its round lock limit. Pure: nothing here reads a network.
import { MARKETS, type MarketId } from "../../agents/src/presets.ts";
import type { AgentSpec } from "../../keeper/src/config.ts";

export const TOOL = "@weir/deploy";
export const VERSION = "0.1.0";

export type NetworkId = "sandbox" | "testnet";

export interface Network {
  id: NetworkId;
  /** RPC URLs, in the order tried. */
  rpc: string[];
  explorer: string;
  /** The account every top-level name ends in: `testnet`, or the sandbox's root `test.near`. */
  root: string;
  /** How a new top-level account comes to exist. */
  creation: "faucet" | "root";
}

export const TESTNET: Network = {
  id: "testnet",
  // Not rpc.testnet.near.org: on 2026-11-12 it answered HTTP 429 "THIS ENDPOINT IS DEPRECATED" to
  // every request (deploy/README.md, "Run against testnet").
  rpc: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"],
  explorer: "https://testnet.nearblocks.io",
  root: "testnet",
  creation: "faucet",
};

export const sandboxNetwork = (rpcUrl: string): Network => ({ id: "sandbox", rpc: [rpcUrl], explorer: "", root: "test.near", creation: "root" });

export const MARKET_IDS = Object.keys(MARKETS) as MarketId[];
export type { MarketId };

export type Role = "usdc" | "market" | "ops" | "reporter" | "agent" | "keeper";

export interface AccountPlan {
  id: string;
  role: Role;
  /** Set for market contracts, reporters and agents. */
  market?: MarketId;
  /** Who creates it: the faucet (testnet) or the root account (sandbox) for top-level
   * accounts, the ops account for operators. */
  createdBy: "top-level" | "ops";
  why: string;
}

export type AgentRole = AgentSpec["role"];

/** One trading agent: the keeper's `AGENTS` entry without its key, and what the tool gives it. */
export interface AgentPlan {
  account: string;
  market: MarketId;
  /** The keeper's settings for the strategy (keeper/src/config.ts `AgentSpec`), role included. */
  spec: Omit<AgentSpec, "account_id" | "secret_key" | "markets">;
  /** Test dollars minted and deposited into its market, micro-USDC: `working + feesPerDay x days`. */
  deposit: bigint;
  /** Working balance for its locks, sized as the agents package sizes a simulated agent. */
  working: bigint;
  /** Commit fees it pays a day at most: one commit per order per round (a maker places two). */
  feesPerDay: bigint;
  /** `set_guard` arguments: a price distance in micro-USD and a lock limit in micro-USDC. */
  guard: number;
  maxRoundLock: bigint;
}

export interface Layout {
  network: Network;
  suffix: string;
  markets: MarketId[];
  usdc: string;
  ops: string;
  keeper: string;
  contracts: Record<string, string>;
  reporters: Record<string, string[]>;
  agents: AgentPlan[];
  accounts: AccountPlan[];
}

const DOLLAR = 1_000_000n;

/** Six agents per market, with the roles and settings the integration run used
 * (integration/src/swarm.ts), at the fast market's scale. `baseDollars` is the simulation's
 * working balance per role (agents/src/sim.ts, `makeAgents`: buyer $60, seller $200, maker
 * $400, noise $30). */
export const AGENT_MIX: readonly { name: string; spec: AgentPlan["spec"]; baseDollars: number }[] = [
  { name: "buyer-1", spec: { role: "buyer", need: 40, premium_bps: 400 }, baseDollars: 60 },
  { name: "buyer-2", spec: { role: "buyer", need: 30, premium_bps: 600 }, baseDollars: 60 },
  { name: "seller-1", spec: { role: "seller", capacity: 150, premium_bps: 300 }, baseDollars: 200 },
  { name: "seller-2", spec: { role: "seller", capacity: 120, premium_bps: 500 }, baseDollars: 200 },
  { name: "maker-1", spec: { role: "maker", spread_bps: 500, share_bps: 1000, max_size: 30 }, baseDollars: 400 },
  { name: "noise-1", spec: { role: "noise", view_bps: 1000, min_size: 3, max_size: 10 }, baseDollars: 30 },
];

/** The agents package's sizing rule (agents/src/sim.ts `makeAgents`, which does not export it;
 * keeper/test/harness.ts copies it too): needs, capacities and the maker's size are GPU-hours
 * per delivery period, 8.4 times larger on a weekly market than on the fast one; working
 * balances scale with that and with the chip's start price over the H100's. Applied to
 * `MARKETS`, read at run time. */
export const periodScale = (m: MarketId): number => (MARKETS[m].params.period_secs >= 7 * 86_400 ? 8.4 : 1);
export const priceScale = (m: MarketId): number => Math.max(1, MARKETS[m].startPrice / 2_900_000);

export function scaledSpec(m: MarketId, spec: AgentPlan["spec"]): AgentPlan["spec"] {
  const k = periodScale(m);
  const out = { ...spec };
  if (out.need !== undefined) out.need = Math.round(out.need * k);
  if (out.capacity !== undefined) out.capacity = Math.round(out.capacity * k);
  if (out.role === "maker" && out.max_size !== undefined) out.max_size = Math.round(out.max_size * k);
  return out;
}

export const workingBalance = (m: MarketId, baseDollars: number): bigint => BigInt(Math.ceil(baseDollars * periodScale(m) * priceScale(m))) * DOLLAR;

/** At most one commit per order per round, every round of the day, at the preset's commit fee. */
export function feesPerDay(m: MarketId, role: AgentRole): bigint {
  const p = MARKETS[m].params;
  const rounds = BigInt(86_400 / (p.commit_secs + p.reveal_secs));
  return rounds * (role === "maker" ? 2n : 1n) * BigInt(p.commit_fee);
}

/** Days of commit fees each agent's deposit carries unless `--days` says otherwise. */
export const DEFAULT_FEE_DAYS = 2;

export const REPORTER_LETTERS = ["a", "b", "c"] as const;

/** The guard, as a share of the band the market opens with at the chip's start price:
 * band = 2 * startPrice * band_bps / 10000, so with band_bps 1500 the guard is 6% of the
 * index level. Every strategy bids within 6% of the band of fair value (buyer and seller
 * premiums of 3 to 6%, the maker's half-spread of 2.5%, noise within 5%), so 20% never voids
 * an honest order and stops a faulty key from bidding far from the index. */
export const GUARD_SHARE_OF_BAND_BPS = 2000;

/** The round lock limit, as a share of the agent's working balance, but at least $10: a
 * hijacked key can then forfeit at most `forfeit_bps` (1%) of a quarter of it per round, plus
 * fees.
 * The maker, the largest locker, puts up 10% of its balance a side (20% a round). */
export const ROUND_LOCK_SHARE_BPS = 2500n;
export const ROUND_LOCK_MIN = 10n * DOLLAR;

export function guardFor(market: MarketId): number {
  const m = MARKETS[market];
  const band = (2 * m.startPrice * m.params.band_bps) / 10_000;
  const g = Math.floor((band * GUARD_SHARE_OF_BAND_BPS) / 10_000);
  return g - (g % m.params.tick);
}

export function maxRoundLockFor(deposit: bigint): bigint {
  const l = (deposit * ROUND_LOCK_SHARE_BPS) / 10_000n;
  return l > ROUND_LOCK_MIN ? l : ROUND_LOCK_MIN;
}

/** Lowercase letters and digits, hyphens inside, 1 to 16 characters: every name stays far
 * under NEAR's 64-character limit. */
export function checkSuffix(suffix: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,14}[a-z0-9])?$/.test(suffix) || suffix.includes("--")) {
    throw new Error(`--suffix must be 1 to 16 lowercase letters, digits or inner hyphens (got ${JSON.stringify(suffix)})`);
  }
}

/** NEAR's account-id rule (nearcore `AccountId::validate`). */
export const isAccountId = (id: string): boolean =>
  id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);

export function parseMarkets(text: string | undefined): MarketId[] {
  if (text === undefined || text.trim() === "") return [...MARKET_IDS];
  const ids = text.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) if (!MARKET_IDS.includes(id as MarketId)) throw new Error(`unknown market ${JSON.stringify(id)}: one of ${MARKET_IDS.join(", ")}`);
  // Always in MARKETS order, without duplicates, so the same set gives the same plan.
  return MARKET_IDS.filter((id) => ids.includes(id));
}

export function layout(network: Network, suffix: string, markets: readonly MarketId[], days = DEFAULT_FEE_DAYS): Layout {
  checkSuffix(suffix);
  if (markets.length === 0) throw new Error("no markets selected");
  const top = (name: string) => `weir-${name}-${suffix}.${network.root}`;
  const ops = top("ops");
  const usdc = top("usdc");
  const keeper = `keeper.${ops}`;
  const accounts: AccountPlan[] = [
    { id: usdc, role: "usdc", createdBy: "top-level", why: "the test dollar tUSDC (mock_usdc.wasm, open mint). Real USDC is out of scope for this tool" },
  ];
  const contracts: Record<string, string> = {};
  const reporters: Record<string, string[]> = {};
  const agents: AgentPlan[] = [];
  for (const m of markets) {
    contracts[m] = top(m);
    accounts.push({ id: contracts[m], role: "market", market: m, createdBy: "top-level", why: `the ${MARKETS[m].label} market contract (weir.wasm), its own account so its storage has its own NEAR and it can be sealed alone` });
  }
  accounts.push({ id: ops, role: "ops", createdBy: "top-level", why: "parent of every operator account; pays their NEAR, registrations and token storage" });
  // Three reporters serve every market. A function-call key names one contract, so each holds
  // one key per market contract (keeper.env: `keys: { <contract>: <secret> }`).
  const reporterIds = REPORTER_LETTERS.map((x) => `reporter-${x}.${ops}`);
  for (const [i, id] of reporterIds.entries()) {
    accounts.push({ id, role: "reporter", createdBy: "ops", why: `reporter ${REPORTER_LETTERS[i]}: reports each market's chip index, one function-call key per market contract` });
  }
  for (const m of markets) {
    reporters[m] = [...reporterIds];
    for (const a of AGENT_MIX) {
      const id = `${m}-${a.name}.${ops}`;
      const working = workingBalance(m, a.baseDollars);
      const fees = feesPerDay(m, a.spec.role);
      const deposit = working + fees * BigInt(days);
      agents.push({ account: id, market: m, spec: scaledSpec(m, a.spec), deposit, working, feesPerDay: fees, guard: guardFor(m), maxRoundLock: maxRoundLockFor(working) });
      accounts.push({ id, role: "agent", market: m, createdBy: "ops", why: `${a.spec.role} agent on ${m}: trades with a function-call key, deposit $${Number(deposit) / 1e6}` });
    }
  }
  accounts.push({ id: keeper, role: "keeper", createdBy: "ops", why: "the keeper's housekeeping account: one function-call key per market for clear, settle, finalize_print and the prunes" });
  for (const a of accounts) if (!isAccountId(a.id)) throw new Error(`${a.id} is not a valid NEAR account id`);
  return { network, suffix, markets: [...markets], usdc, ops, keeper, contracts, reporters, agents, accounts };
}

/** The accounts that hold a function-call key, the contract it names, and the methods. */
export interface FcKeyPlan {
  account: string;
  receiver: string;
  market: MarketId;
  methods: "reporter" | "agent" | "keeper";
}

export function fcKeys(l: Layout): FcKeyPlan[] {
  const out: FcKeyPlan[] = [];
  for (const m of l.markets) {
    for (const r of l.reporters[m]!) out.push({ account: r, receiver: l.contracts[m]!, market: m, methods: "reporter" });
    for (const a of l.agents.filter((x) => x.market === m)) out.push({ account: a.account, receiver: l.contracts[m]!, market: m, methods: "agent" });
  }
  for (const m of l.markets) out.push({ account: l.keeper, receiver: l.contracts[m]!, market: m, methods: "keeper" });
  return out;
}
