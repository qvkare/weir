// What the keeper runs on: the public deployment file and the secrets. Secrets come only
// from the environment and are never echoed, not even in a parse error.
import { buyer, maker, noise, seller, type Strategy } from "@weir/agents";

export type MarketId = "weekly" | "fast";

export interface MarketDeployment {
  id: MarketId;
  label: string;
  /** The Weir contract account. */
  contract: string;
  usdc: string;
}

/** `deployments.json` at the repository root. */
export interface Deployments {
  network: string;
  rpc: string[];
  explorer: string;
  bundles_base: string | null;
  markets: MarketDeployment[];
}

/** One account the keeper signs for. */
export interface Signer {
  account_id: string;
  secret_key: string;
}

/** One trading agent: its account, its strategy and the strategy's settings. */
export interface AgentSpec extends Signer {
  role: "buyer" | "seller" | "maker" | "noise";
  /** buyer: GPU-hours it needs. Default 40. */
  need?: number;
  /** seller: GPU-hours it can sell. Default 180. */
  capacity?: number;
  /** buyer and seller: how far past fair value it will go, in bps of the band. Default 500. */
  premium_bps?: number;
  /** maker: total spread in bps of the band. Default 600. */
  spread_bps?: number;
  /** maker: share of its free balance per side, in bps. Default 1000. */
  share_bps?: number;
  /** noise: width of its random view around fair value, in bps of the band. Default 1000. */
  view_bps?: number;
  /** maker and noise: order sizes. Defaults: maker max 40; noise 3 to 10. */
  min_size?: number;
  max_size?: number;
  /** Market ids this agent trades on. Default: every market. */
  markets?: MarketId[];
}

export interface Secrets {
  reporters: Signer[];
  agents: AgentSpec[];
  /** Salts and random streams come from it. Null: the swarm does not run. */
  swarmSecret: string | null;
  /** Problems found while reading the secrets, in words that never contain a secret. */
  problems: string[];
}

const ROLES = new Set(["buyer", "seller", "maker", "noise"]);

function signerProblem(name: string, i: number, x: unknown): string | null {
  if (typeof x !== "object" || x === null) return `${name}[${i}] is not an object`;
  const o = x as Record<string, unknown>;
  if (typeof o.account_id !== "string" || o.account_id === "") return `${name}[${i}] has no account_id`;
  if (typeof o.secret_key !== "string" || !o.secret_key.startsWith("ed25519:")) {
    return `${name}[${i}] (${o.account_id}): secret_key must look like ed25519:<base58>`;
  }
  return null;
}

/** Parses a JSON array without letting the parser quote the input back in its message. */
function parseList(name: string, text: string | undefined, problems: string[]): unknown[] {
  if (text === undefined || text.trim() === "") return [];
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v)) return v;
    problems.push(`${name} must be a JSON array`);
  } catch {
    problems.push(`${name} is not valid JSON`);
  }
  return [];
}

/** Reads `REPORTERS`, `AGENTS` and `SWARM_SECRET`. Bad entries are dropped and named. */
export function readSecrets(vars: { REPORTERS?: string; AGENTS?: string; SWARM_SECRET?: string }): Secrets {
  const problems: string[] = [];
  const reporters: Signer[] = [];
  for (const [i, x] of parseList("REPORTERS", vars.REPORTERS, problems).entries()) {
    const p = signerProblem("REPORTERS", i, x);
    if (p) problems.push(p);
    else reporters.push({ account_id: (x as Signer).account_id, secret_key: (x as Signer).secret_key });
  }
  const agents: AgentSpec[] = [];
  for (const [i, x] of parseList("AGENTS", vars.AGENTS, problems).entries()) {
    const p = signerProblem("AGENTS", i, x);
    if (p) problems.push(p);
    else if (!ROLES.has(String((x as AgentSpec).role))) problems.push(`AGENTS[${i}] (${(x as AgentSpec).account_id}): role must be buyer, seller, maker or noise`);
    else agents.push(x as AgentSpec);
  }
  const ids = [...reporters, ...agents].map((s) => s.account_id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`${id} appears more than once`);
  const swarmSecret = vars.SWARM_SECRET && vars.SWARM_SECRET.length > 0 ? vars.SWARM_SECRET : null;
  if (agents.length > 0 && swarmSecret === null) problems.push("SWARM_SECRET is not set: the agents will not trade");
  return { reporters, agents, swarmSecret, problems };
}

/** The agents package's strategy for one agent, with the simulation's defaults. */
export function strategyOf(a: AgentSpec): Strategy {
  const premiumBps = a.premium_bps ?? 500;
  switch (a.role) {
    case "buyer":
      return buyer(a.account_id, { need: a.need ?? 40, premiumBps });
    case "seller":
      return seller(a.account_id, { capacity: a.capacity ?? 180, premiumBps });
    case "maker":
      return maker(a.account_id, { spreadBps: a.spread_bps ?? 600, shareBps: a.share_bps ?? 1000, maxSize: a.max_size ?? 40 });
    case "noise":
      return noise(a.account_id, { viewBps: a.view_bps ?? 1000, minSize: a.min_size ?? 3, maxSize: a.max_size ?? 10 });
  }
}

/** Replaces every secret in a value that is about to be stored or served. */
export function redactor(secrets: Pick<Secrets, "reporters" | "agents" | "swarmSecret">): <T>(v: T) => T {
  const needles = [...secrets.reporters, ...secrets.agents]
    .flatMap((s) => [s.secret_key, s.secret_key.slice("ed25519:".length)])
    .concat(secrets.swarmSecret ?? [])
    .filter((s) => s.length >= 8)
    .map((s) => JSON.stringify(s).slice(1, -1));
  return <T>(v: T): T => {
    if (needles.length === 0 || v === undefined) return v;
    let text = JSON.stringify(v);
    for (const n of needles) text = text.split(n).join("[redacted]");
    return JSON.parse(text) as T;
  };
}
