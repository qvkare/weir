// The state file (`<out>/state.json`): what this tool has done, with transaction hashes and
// public keys, never a secret. The chain stays the authority: every step is checked against it
// before it is skipped, so a lost or stale state file costs only the hashes it held.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MARKETS, type MarketId } from "../../agents/src/presets.ts";
import type { WireParams } from "../../engine/src/mod.ts";
import type { Redactor } from "./keys.ts";
import { TOOL, VERSION, type Layout, type NetworkId } from "./layout.ts";

export interface StepRecord {
  purpose: string;
  /** Null when the step was found already done on chain (its hash, if any, is unknown). */
  tx: string | null;
  at: string;
  how: "sent" | "found on chain";
  gas_burnt?: number;
}

export interface State {
  tool: string;
  network: NetworkId;
  suffix: string;
  markets: MarketId[];
  created_at: string;
  updated_at: string;
  t0: Partial<Record<MarketId, { t0: number; reason: string }>>;
  steps: Record<string, StepRecord>;
  sealed: Partial<Record<MarketId, { tx: string; at: string }>>;
}

export function newState(network: NetworkId, suffix: string, markets: MarketId[], now: string): State {
  return { tool: `${TOOL} ${VERSION}`, network, suffix, markets, created_at: now, updated_at: now, t0: {}, steps: {}, sealed: {} };
}

export const statePath = (out: string) => join(out, "state.json");

export function readState(out: string): State | null {
  const p = statePath(out);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as State) : null;
}

/** Writes a file atomically (temporary file, then rename) after checking it holds no secret. */
export function writeChecked(path: string, text: string, redactor: Redactor, mode = 0o644): void {
  redactor.assertClean(text, path);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

export function writeState(out: string, s: State, redactor: Redactor): void {
  writeChecked(statePath(out), JSON.stringify(s, null, 2) + "\n", redactor);
}

/** The preset's parameters with `usdc`, `reporters` and `t0` replaced, and nothing else. */
export function expectedParams(l: Layout, m: MarketId, t0: number): WireParams {
  return { ...MARKETS[m].params, reporters: [...l.reporters[m]!], usdc: l.usdc, t0 };
}

/** Every field where `actual` differs from `expected`, as "name: actual (expected ...)". */
export function paramsDiff(actual: WireParams, expected: WireParams): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const k of keys) {
    const a = JSON.stringify((actual as unknown as Record<string, unknown>)[k]);
    const e = JSON.stringify((expected as unknown as Record<string, unknown>)[k]);
    if (a !== e) out.push(`${k}: ${a} (expected ${e})`);
  }
  return out;
}
