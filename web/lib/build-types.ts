import type { TxRecord } from "./evidence.ts";

export interface RecordedBundle {
  /** Path from the repository root. */
  file: string;
  /** The file's exact text, so its hash can be recomputed in the browser. */
  text: string;
  bucket: number | null;
  /** The chip the bundle prices: "h100", "h200" or "a100-80". */
  chip: string;
}

export interface BuildData {
  builtAt: number;
  /** "0.2", from the first "Version x.y" line of docs/SPEC.md. */
  specVersion: string | null;
  /** docs/SPEC.md as text, for /spec. */
  spec: string | null;
  /** docs/AUDIT.md as text, for /audit. */
  audit: string | null;
  /** integration/RESULTS.md as text: the sandbox comparison of the contract and the engine. */
  integration: string | null;
  deployments: unknown;
  bundles: RecordedBundle[];
  bundleCount: number;
  txs: TxRecord[];
  /** The agents the deploy tool recorded (evidence/deploy/*.json, "agents"): account, market, role. */
  agents: { account: string; market: string; role: string; file: string }[];
  backtest: { site: unknown; summary: unknown; summaryMd: string | null; siteMissing: boolean };
  modules: { sim: boolean; intents: boolean };
}
