// What the keeper runs on: the public deployment file and the secrets. Secrets come only
// from the environment and are never echoed, not even in a parse error.
import { buyer, maker, noise, seller, type MarketId, type Strategy } from "@weir/agents";
import type { ChipId } from "@weir/index";

export type { MarketId } from "@weir/agents";

export interface MarketDeployment {
  /** One of the agents package's `MARKETS`: `h100-fast`, `h100-weekly`, `h200-weekly`, `a100-80-weekly`. */
  id: MarketId;
  label: string;
  /** The index package's chip id: the bundle this market's reporters report from. */
  chip: ChipId;
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

/** One account the keeper signs for. A NEAR function-call key names exactly one contract, so
 * an account acting on several markets with function-call keys needs one key per contract:
 * `keys` maps a contract account to its key. `secret_key` is used for any contract without an
 * entry in `keys`: right for a full-access key (tests, the sandbox), wrong for a function-call
 * key on more than one market. */
export interface Signer {
  account_id: string;
  secret_key?: string;
  keys?: Record<string, string>;
}

/** The key this signer uses on `contract`, or null when it has none. */
export const keyFor = (s: Signer, contract: string): string | null => s.keys?.[contract] ?? s.secret_key ?? null;

/** Every secret key a signer carries. */
export const keysOf = (s: Signer): string[] => [...(s.secret_key ? [s.secret_key] : []), ...Object.values(s.keys ?? {})];

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
  /** The market this agent trades on (the deploy tool's form), or `markets` for several.
   * Default: every market. */
  market?: MarketId;
  markets?: MarketId[];
}

export interface Secrets {
  reporters: Signer[];
  /** Optional housekeeping account, holding a key for `KEEPER_KEY_METHODS`. It signs clear,
   * settle, finalize_print and the prunes; without it the first agent signs clear and settle,
   * the first reporter finalize_print, and nothing is pruned. */
  keeper: Signer | null;
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
  const isKey = (k: unknown) => typeof k === "string" && k.startsWith("ed25519:");
  if (o.secret_key !== undefined && !isKey(o.secret_key)) return `${name}[${i}] (${o.account_id}): secret_key must look like ed25519:<base58>`;
  if (o.keys !== undefined) {
    if (typeof o.keys !== "object" || o.keys === null || Array.isArray(o.keys)) return `${name}[${i}] (${o.account_id}): keys must map contract accounts to keys`;
    for (const [contract, k] of Object.entries(o.keys)) if (!isKey(k)) return `${name}[${i}] (${o.account_id}): the key for ${contract} must look like ed25519:<base58>`;
  }
  if (o.secret_key === undefined && (o.keys === undefined || Object.keys(o.keys as object).length === 0)) return `${name}[${i}] (${o.account_id}): needs keys (one per contract) or secret_key`;
  return null;
}

const signerOf = (x: Signer): Signer => ({
  account_id: x.account_id,
  ...(x.secret_key !== undefined ? { secret_key: x.secret_key } : {}),
  ...(x.keys !== undefined ? { keys: { ...x.keys } } : {}),
});

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
export function readSecrets(vars: { REPORTERS?: string; AGENTS?: string; SWARM_SECRET?: string; KEEPER?: string }): Secrets {
  const problems: string[] = [];
  let keeper: Signer | null = null;
  if (vars.KEEPER !== undefined && vars.KEEPER.trim() !== "") {
    let v: unknown = null;
    try {
      v = JSON.parse(vars.KEEPER);
    } catch {
      problems.push("KEEPER is not valid JSON");
    }
    if (v !== null) {
      const p = signerProblem("KEEPER", 0, v);
      if (p) problems.push(p.replace("KEEPER[0]", "KEEPER"));
      else keeper = signerOf(v as Signer);
    }
  }
  const reporters: Signer[] = [];
  for (const [i, x] of parseList("REPORTERS", vars.REPORTERS, problems).entries()) {
    const p = signerProblem("REPORTERS", i, x);
    if (p) problems.push(p);
    else reporters.push(signerOf(x as Signer));
  }
  const agents: AgentSpec[] = [];
  for (const [i, x] of parseList("AGENTS", vars.AGENTS, problems).entries()) {
    const p = signerProblem("AGENTS", i, x);
    if (p) problems.push(p);
    else if (!ROLES.has(String((x as AgentSpec).role))) problems.push(`AGENTS[${i}] (${(x as AgentSpec).account_id}): role must be buyer, seller, maker or noise`);
    else agents.push(x as AgentSpec);
  }
  // An agent appears once per market it trades (the deploy tool writes one entry per agent and
  // market); any other repetition, or one account in two roles, is a mistake.
  const agentIds = [...new Set(agents.map((a) => a.account_id))];
  const ids = [...reporters.map((s) => s.account_id), ...agentIds, ...(keeper ? [keeper.account_id] : [])];
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`${id} appears more than once`);
  const slots = agents.flatMap((a) => (a.market ? [a.market] : a.markets ? a.markets : ["*"]).map((m) => `${a.account_id} on ${m}`));
  for (const slot of new Set(slots.filter((x, i) => slots.indexOf(x) !== i))) problems.push(`agent ${slot} appears more than once`);
  const swarmSecret = vars.SWARM_SECRET && vars.SWARM_SECRET.length > 0 ? vars.SWARM_SECRET : null;
  if (agents.length > 0 && swarmSecret === null) problems.push("SWARM_SECRET is not set: the agents will not trade");
  return { reporters, keeper, agents, swarmSecret, problems };
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
export function redactor(secrets: Pick<Secrets, "reporters" | "agents" | "swarmSecret" | "keeper">): <T>(v: T) => T {
  const needles = [...secrets.reporters, ...secrets.agents, ...(secrets.keeper ? [secrets.keeper] : [])]
    .flatMap(keysOf)
    .flatMap((k) => [k, k.slice("ed25519:".length)])
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
