// The keeper's secrets as one JSON object for `wrangler secret bulk`, with the agent list (and
// the reporter list, if it must be) split so that no value exceeds LIMIT_BYTES. Cloudflare
// refuses a secret over 5 KB ("Variable size", Workers limits; the API said 5.1 kB).
//
//   node --env-file=keeper/.env keeper/scripts/secrets.ts | pnpm --filter @weir/keeper exec wrangler secret bulk
//
// Reads REPORTERS, AGENTS (and any AGENTS_* already split), SWARM_SECRET and KEEPER from the
// process environment. Writes only that JSON to stdout. On stderr: names and byte counts, never
// a value. Agents are split by market first (AGENTS_H100_FAST), then into numbered parts
// (AGENTS_H100_FAST_2) if a market alone is too large. When it emits AGENTS_* parts it sets
// AGENTS itself to null, so a stale whole AGENTS secret cannot sit beside them. Parts named by
// an earlier run and not by this one are not deleted: `wrangler secret list` shows them.
// Refuses (exit 1, nothing on stdout) when a value cannot be brought under the limit, when a
// value is not valid JSON, or when reading the result back does not give the same lists.
import { listParts, readSecrets, type AgentSpec, type SecretVars } from "../src/config.ts";

export const LIMIT_BYTES = 5000;

const bytes = (s: string): number => new TextEncoder().encode(s).length;

export class SecretsRefused extends Error {}

const partName = (market: string): string => `AGENTS_${market.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/** Splits `items` into JSON arrays of at most `limit` bytes each, in order. */
function chunks(name: string, items: unknown[], limit: number): string[] {
  const out: string[] = [];
  let current: unknown[] = [];
  for (const item of items) {
    const next = JSON.stringify([...current, item]);
    if (bytes(next) <= limit) {
      current.push(item);
      continue;
    }
    if (current.length === 0) throw new SecretsRefused(`${name}: one entry alone is ${bytes(JSON.stringify([item]))} bytes, over the ${limit}-byte limit`);
    out.push(JSON.stringify(current));
    current = [item];
    if (bytes(JSON.stringify(current)) > limit) throw new SecretsRefused(`${name}: one entry alone is ${bytes(JSON.stringify(current))} bytes, over the ${limit}-byte limit`);
  }
  if (current.length > 0) out.push(JSON.stringify(current));
  return out;
}

/** Parses every part of a list into one array, or refuses naming the part. */
function joined(vars: SecretVars, list: "REPORTERS" | "AGENTS"): unknown[] {
  const all: unknown[] = [];
  for (const { name, value } of listParts(vars, list)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(value);
    } catch {
      throw new SecretsRefused(`${name} is not valid JSON`);
    }
    if (!Array.isArray(v)) throw new SecretsRefused(`${name} must be a JSON array`);
    all.push(...v);
  }
  return all;
}

export interface Split {
  /** The object for `wrangler secret bulk`; null deletes a secret. */
  out: Record<string, string | null>;
  /** One line per value: its name and its size in bytes. */
  sizes: string[];
}

export function splitSecrets(vars: SecretVars, limit = LIMIT_BYTES): Split {
  const out: Record<string, string | null> = {};
  // Reporters: as one value if it fits, else REPORTERS_1, REPORTERS_2, ... and REPORTERS null.
  const reporters = joined(vars, "REPORTERS");
  if (reporters.length > 0) {
    const parts = chunks("REPORTERS", reporters, limit);
    if (parts.length === 1) out.REPORTERS = parts[0]!;
    else {
      out.REPORTERS = null;
      parts.forEach((p, i) => (out[`REPORTERS_${i + 1}`] = p));
    }
  }
  // Agents: by market, in the order markets first appear, then numbered if still too large.
  const agents = joined(vars, "AGENTS") as AgentSpec[];
  if (agents.length > 0) {
    const byMarket = new Map<string, unknown[]>();
    for (const a of agents) {
      const m = a.market ?? (a.markets ? a.markets.join("+") : "all");
      byMarket.set(m, [...(byMarket.get(m) ?? []), a]);
    }
    out.AGENTS = null;
    for (const [market, list] of byMarket) {
      const name = partName(market);
      const parts = chunks(name, list, limit);
      parts.forEach((p, i) => (out[i === 0 ? name : `${name}_${i + 1}`] = p));
    }
  }
  for (const name of ["SWARM_SECRET", "KEEPER"] as const) {
    const v = vars[name];
    if (typeof v !== "string" || v === "") continue;
    if (name === "KEEPER") {
      try {
        JSON.parse(v);
      } catch {
        throw new SecretsRefused("KEEPER is not valid JSON");
      }
    }
    out[name] = v;
  }
  for (const [name, v] of Object.entries(out)) if (v !== null && bytes(v) > limit) throw new SecretsRefused(`${name} is ${bytes(v)} bytes, over the ${limit}-byte limit`);
  // Read the result back as the keeper will: the same agents and reporters, and no problem
  // that the input did not have.
  const before = readSecrets(vars);
  const after = readSecrets(Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null)) as SecretVars);
  const ids = (xs: { account_id: string; market?: string }[]) => xs.map((x) => `${x.account_id}|${x.market ?? ""}`).sort().join(",");
  if (ids(before.agents) !== ids(after.agents) || ids(before.reporters) !== ids(after.reporters)) throw new SecretsRefused("reading the split lists back does not give the same agents and reporters");
  const fresh = after.problems.filter((p) => !before.problems.includes(p));
  if (fresh.length > 0) throw new SecretsRefused(`reading the split lists back gives new problems: ${fresh.join("; ")}`);
  const sizes = Object.entries(out).map(([name, v]) => (v === null ? `${name}: deleted (null)` : `${name}: ${bytes(v)} bytes`));
  return { out, sizes };
}

function main(): void {
  const { REPORTERS, AGENTS, SWARM_SECRET, KEEPER } = process.env;
  const vars: SecretVars = { REPORTERS, AGENTS, SWARM_SECRET, KEEPER };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("AGENTS_") || k.startsWith("REPORTERS_")) vars[k] = v;
  try {
    const { out, sizes } = splitSecrets(vars);
    for (const line of sizes) console.error(line);
    console.error(`${Object.keys(out).length} values, none over ${LIMIT_BYTES} bytes`);
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    console.error(`refused: ${e instanceof SecretsRefused ? e.message : "unexpected error (not shown: it could quote a value)"}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) main();
