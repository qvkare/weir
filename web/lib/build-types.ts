import type { TxRecord } from "./evidence.ts";

export interface RecordedBundle {
  /** Path from the repository root. */
  file: string;
  /** The file's exact text, so its hash can be recomputed in the browser. */
  text: string;
  bucket: number | null;
}

export interface BuildData {
  builtAt: number;
  deployments: unknown;
  bundles: RecordedBundle[];
  bundleCount: number;
  txs: TxRecord[];
  backtest: { site: unknown; summary: unknown; summaryMd: string | null; siteMissing: boolean };
  modules: { sim: boolean; intents: boolean };
}
