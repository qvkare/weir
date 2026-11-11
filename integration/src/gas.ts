// Scenario 5: gas burnt by every state-changing method as the client sends it, against the gas
// the client attaches (`CALLS` in chain/src/weir.ts, `TOKEN_CALLS` in chain/src/token.ts).
import { CALLS, TOKEN_CALLS } from "../../chain/src/mod.ts";
import type { CallRecord } from "./twin.ts";

export interface GasRow {
  method: string;
  calls: number;
  /** Total gas burnt by the transaction and every receipt, Tgas. */
  min_tgas: number;
  median_tgas: number;
  max_tgas: number;
  /** The most any one receipt burnt, Tgas. */
  max_receipt_tgas: number;
  attached_tgas: number;
  /** attached / max burnt. */
  margin: number;
  flag: "" | "margin under 2x" | "over 10x";
  proposed_tgas: number;
}

const T = 1e12;

/** Rounds up to a multiple of 5 Tgas, at least 2.5x the most burnt and at least 10 Tgas, at
 * most the 300 Tgas a transaction can carry. */
const propose = (maxTgas: number): number => Math.min(300, Math.max(10, Math.ceil((maxTgas * 2.5) / 5) * 5));

export function gasTable(calls: CallRecord[], tokenCalls: { method: string; gas_burnt: number; attached: number }[], tag: (r: CallRecord) => string | null): GasRow[] {
  const groups = new Map<string, { burnt: number[]; receipt: number[]; attached: number }>();
  const add = (method: string, burnt: number, receipt: number, attached: number) => {
    const g = groups.get(method) ?? { burnt: [], receipt: [], attached };
    g.burnt.push(burnt);
    g.receipt.push(receipt);
    groups.set(method, g);
  };
  for (const r of calls) {
    if (!r.chain.ok || r.chain.gas_burnt === undefined) continue;
    const t = tag(r);
    const name = t ? `${r.method} (${t})` : r.method;
    const attached = Number(CALLS[r.method as keyof typeof CALLS]?.gas ?? 0n);
    add(name, r.chain.gas_burnt, Math.max(0, ...(r.chain.receipts ?? []).map((x) => x.gas_burnt)), attached);
  }
  for (const c of tokenCalls) add(`token ${c.method}`, c.gas_burnt, 0, Number(TOKEN_CALLS[c.method as keyof typeof TOKEN_CALLS]?.gas ?? BigInt(c.attached)));
  const rows: GasRow[] = [];
  for (const [method, g] of groups) {
    const sorted = [...g.burnt].sort((a, b) => a - b);
    const max = sorted.at(-1)! / T;
    const attached = g.attached / T;
    const margin = attached / max;
    rows.push({
      method,
      calls: sorted.length,
      min_tgas: round(sorted[0]! / T),
      median_tgas: round(sorted[Math.floor(sorted.length / 2)]! / T),
      max_tgas: round(max),
      max_receipt_tgas: round(Math.max(...g.receipt) / T),
      attached_tgas: attached,
      margin: round(margin),
      flag: margin < 2 ? "margin under 2x" : margin > 10 ? "over 10x" : "",
      proposed_tgas: propose(max),
    });
  }
  return rows.sort((a, b) => a.method.localeCompare(b.method));
}

const round = (x: number) => Math.round(x * 100) / 100;

export function gasMarkdown(rows: GasRow[]): string {
  const lines = ["| Method | Calls | Burnt min / median / max (Tgas) | Largest receipt | Attached | Margin | Flag | Proposed |", "|---|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    lines.push(`| \`${r.method}\` | ${r.calls} | ${r.min_tgas} / ${r.median_tgas} / ${r.max_tgas} | ${r.max_receipt_tgas} | ${r.attached_tgas} | ${r.margin}x | ${r.flag} | ${r.proposed_tgas} |`);
  }
  return lines.join("\n");
}
