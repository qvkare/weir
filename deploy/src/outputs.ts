// The files a deployment leaves under --out:
//   deployments.json  what the site and the keeper read (the repository root's shape)
//   keeper.env        the keeper's secrets, function-call keys only, mode 600
//   record.json       the public record, meant to be committed as evidence
// (state.json is written by apply.) Everything but keeper.env is checked to hold no secret.
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MARKETS, type MarketId } from "../../agents/src/presets.ts";
import type { WireParams } from "../../engine/src/mod.ts";
import type { Deployments } from "../../keeper/src/config.ts";
import { allowanceFor, fmtNear, METHODS_OF } from "./budget.ts";
import type { DeployChain } from "./chain.ts";
import type { Keystore } from "./keys.ts";
import { fcKeys, TOOL, VERSION, type Layout } from "./layout.ts";
import type { Plan } from "./steps.ts";
import { writeChecked, type State } from "./state.ts";
import type { Wasm } from "./wasm.ts";

export function deploymentsJson(l: Layout, markets: readonly MarketId[]): Deployments {
  return {
    network: l.network.id,
    rpc: [...l.network.rpc],
    explorer: l.network.explorer,
    bundles_base: null,
    markets: markets.map((id) => ({ id, label: MARKETS[id].label, chip: MARKETS[id].chip, contract: l.contracts[id]!, usdc: l.usdc })),
  };
}

const q = (v: unknown) => {
  const s = JSON.stringify(v);
  if (s.includes("'")) throw new Error("a keeper.env value cannot hold a single quote");
  return `'${s}'`;
};

/** keeper.env in the shape the keeper reads (one key per market contract, each named by the
 * contract it is for):
 *   REPORTERS=[{ account_id, keys: { <contract>: <secret> } }]
 *   AGENTS=[{ account_id, market, role, ...settings, keys: { <contract>: <secret> } }]
 *   KEEPER={ account_id, keys: { <contract>: <secret> } }
 *   SWARM_SECRET=<hex> */
export function keeperEnv(l: Layout, keys: Keystore): string {
  const keysOf = (account: string, markets: readonly string[]) =>
    Object.fromEntries(markets.map((m) => [l.contracts[m]!, keys.functionCallSecret(account, l.contracts[m]!)]));
  const reporterIds = [...new Set(l.markets.flatMap((m) => l.reporters[m]!))];
  const reporters = reporterIds.map((id) => ({ account_id: id, keys: keysOf(id, l.markets.filter((m) => l.reporters[m]!.includes(id))) }));
  const agents = l.agents.map((a) => ({ account_id: a.account, market: a.market, ...a.spec, keys: keysOf(a.account, [a.market]) }));
  const keeper = { account_id: l.keeper, keys: keysOf(l.keeper, l.markets) };
  const lines = [
    `# Written by ${TOOL} ${VERSION} for ${l.network.id}, suffix ${l.suffix}, markets ${l.markets.join(", ")}.`,
    "# Secrets. Mode 600; never commit. Every key here is a function-call key for the one contract it is",
    "# listed under: it cannot withdraw, move positions, change a guard or attach NEAR. The full-access",
    "# keys stay in the credentials directory and are not needed by the keeper.",
    "",
    "# Three reporters, each with one key per market contract (REPORTER_KEY_METHODS).",
    `REPORTERS=${q(reporters)}`,
    "",
    "# Six agents per market, each with one key for its market's contract (AGENT_KEY_METHODS).",
    `AGENTS=${q(agents)}`,
    "",
    `SWARM_SECRET='${keys.swarmSecret(l.suffix)}'`,
    "",
    "# The housekeeping account, one key per market contract (KEEPER_KEY_METHODS).",
    `KEEPER=${q(keeper)}`,
  ];
  return lines.join("\n") + "\n";
}

/** Checks keeper.env text against the shape above, the layout and the key files. Returns the
 * problems, in words that never contain a secret. */
export function checkKeeperEnv(text: string, l: Layout, keys: Keystore): string[] {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)='(.*)'$/.exec(line);
    if (m) vars[m[1]!] = m[2]!;
  }
  const out: string[] = [];
  const parse = (name: string): unknown => {
    try {
      return JSON.parse(vars[name] ?? "null");
    } catch {
      out.push(`${name} is not valid JSON`);
      return null;
    }
  };
  const checkKeys = (who: string, got: unknown, markets: readonly string[]) => {
    const want = markets.map((m) => l.contracts[m]!).sort();
    const k = (got ?? {}) as Record<string, string>;
    if (JSON.stringify(Object.keys(k).sort()) !== JSON.stringify(want)) out.push(`${who}: keys are for ${Object.keys(k).join(", ")}, expected ${want.join(", ")}`);
    for (const c of want) if (k[c] !== undefined && k[c] !== keys.functionCallSecret(who, c)) out.push(`${who}: the key for ${c} is not the one on file`);
  };
  const reps = parse("REPORTERS") as { account_id: string; keys: unknown }[] | null;
  const ids = [...new Set(l.markets.flatMap((m) => l.reporters[m]!))];
  if (!Array.isArray(reps) || reps.length !== ids.length) out.push("REPORTERS: wrong number of entries");
  else for (const r of reps) checkKeys(r.account_id, r.keys, l.markets.filter((m) => l.reporters[m]!.includes(r.account_id)));
  const ags = parse("AGENTS") as { account_id: string; market: string; role: string; keys: unknown }[] | null;
  if (!Array.isArray(ags) || ags.length !== l.agents.length) out.push("AGENTS: wrong number of entries");
  else {
    for (const a of ags) {
      const plan = l.agents.find((x) => x.account === a.account_id);
      if (!plan || plan.market !== a.market || plan.spec.role !== a.role) out.push(`AGENTS: ${a.account_id} does not match the plan`);
      else checkKeys(a.account_id, a.keys, [a.market]);
    }
  }
  const kp = parse("KEEPER") as { account_id: string; keys: unknown } | null;
  if (!kp || kp.account_id !== l.keeper) out.push("KEEPER: missing or wrong account");
  else checkKeys(kp.account_id, kp.keys, l.markets);
  if (!/^[0-9a-f]{64}$/.test(vars.SWARM_SECRET ?? "")) out.push("SWARM_SECRET is not 32 bytes of hex");
  for (const v of Object.keys(vars)) if (!["REPORTERS", "AGENTS", "SWARM_SECRET", "KEEPER"].includes(v)) out.push(`unexpected variable ${v}`);
  return out;
}

export function writeSecretFile(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export interface RecordJson {
  tool: string;
  version: string;
  network: string;
  suffix: string;
  updated_at: string;
  note: string;
  wasm: Record<string, { file: string; bytes: number; sha256: string; code_hash: string }>;
  accounts: { id: string; role: string; market?: string; created_by: string; why: string }[];
  markets: { id: string; label: string; contract: string; usdc: string; t0: number | null; t0_reason: string | null; params: WireParams | null; sealed: { tx: string; at: string } | null }[];
  keys: { account: string; public_key: string; kind: string; receiver?: string; methods?: string[]; allowance?: string; allowance_arithmetic?: string }[];
  agents: { account: string; market: string; role: string; deposit_usdc: string; guard: number; max_round_lock: string }[];
  transactions: { step: string; purpose: string; tx: string | null; how: string; at: string; explorer: string | null }[];
}

export async function buildRecord(plan: Plan, state: State, chain: DeployChain, keys: Keystore, wasm: { weir: Wasm; usdc: Wasm }): Promise<RecordJson> {
  const l = plan.layout;
  const markets: RecordJson["markets"] = [];
  for (const m of l.markets) {
    const contract = l.contracts[m]!;
    let params: WireParams | null = null;
    try {
      params = await chain.view<WireParams>(contract, "get_params", {});
    } catch {
      params = null;
    }
    markets.push({
      id: m, label: MARKETS[m].label, contract, usdc: l.usdc, t0: params?.t0 ?? state.t0[m]?.t0 ?? null, t0_reason: state.t0[m]?.reason ?? null,
      params, sealed: state.sealed[m] ?? null,
    });
  }
  const keyRows: RecordJson["keys"] = [];
  for (const a of l.accounts) {
    const fa = await keys.existingFullAccess(a.id);
    if (fa) keyRows.push({ account: a.id, public_key: fa.publicKeyString, kind: a.role === "market" && state.sealed[a.market!] ? "full access (deleted when sealed)" : "full access (kept in the credentials directory)" });
  }
  for (const k of fcKeys(l)) {
    const al = allowanceFor(l, k);
    const kp = await keys.existingFunctionCall(k.account, k.receiver);
    if (!kp) continue;
    keyRows.push({ account: k.account, public_key: kp.publicKeyString, kind: `function call (${k.methods})`, receiver: k.receiver, methods: [...METHODS_OF[k.methods]], allowance: fmtNear(al.allowance, 2), allowance_arithmetic: al.arithmetic });
  }
  const explorer = (tx: string | null) => (tx && l.network.explorer ? `${l.network.explorer}/txns/${tx}` : null);
  return {
    tool: TOOL,
    version: VERSION,
    network: l.network.id,
    suffix: l.suffix,
    updated_at: state.updated_at,
    note:
      l.network.id === "sandbox"
        ? "A local near-sandbox run: nothing here exists on testnet."
        : "Written by apply against testnet. Real USDC is out of scope: the dollar is the test token tUSDC.",
    wasm: {
      weir: { file: "contracts/target/near/weir/weir.wasm", bytes: wasm.weir.size, sha256: wasm.weir.sha256, code_hash: wasm.weir.codeHash },
      mock_usdc: { file: "contracts/target/near/mock_usdc/mock_usdc.wasm", bytes: wasm.usdc.size, sha256: wasm.usdc.sha256, code_hash: wasm.usdc.codeHash },
    },
    accounts: l.accounts.map((a) => ({ id: a.id, role: a.role, ...(a.market ? { market: a.market } : {}), created_by: a.createdBy === "ops" ? l.ops : l.network.creation, why: a.why })),
    markets,
    keys: keyRows,
    agents: l.agents.map((a) => ({ account: a.account, market: a.market, role: a.spec.role, deposit_usdc: (Number(a.deposit) / 1e6).toFixed(2), guard: a.guard, max_round_lock: a.maxRoundLock.toString() })),
    transactions: [
      ...plan.steps.map((s) => s.id),
      ...Object.keys(state.steps).filter((id) => !plan.steps.some((s) => s.id === id)),
    ]
      .filter((id) => state.steps[id])
      .map((id) => {
        const r = state.steps[id]!;
        return { step: id, purpose: r.purpose, tx: r.tx, how: r.how, at: r.at, explorer: explorer(r.tx) };
      }),
  };
}

export async function writeOutputs(out: string, plan: Plan, state: State, chain: DeployChain, keys: Keystore, wasm: { weir: Wasm; usdc: Wasm }): Promise<string[]> {
  const l = plan.layout;
  const dep = deploymentsJson(l, l.markets);
  const files = [join(out, "deployments.json"), join(out, "keeper.env"), join(out, "record.json")];
  writeChecked(files[0]!, JSON.stringify(dep, null, 2) + "\n", keys.redactor);
  const env = keeperEnv(l, keys);
  const bad = checkKeeperEnv(env, l, keys);
  if (bad.length > 0) throw new Error(`keeper.env would be wrong: ${bad.join("; ")}`);
  writeSecretFile(files[1]!, env);
  writeChecked(files[2]!, JSON.stringify(await buildRecord(plan, state, chain, keys, wasm), null, 2) + "\n", keys.redactor);
  return files;
}
