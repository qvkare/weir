// A tolerant reader for transaction records in evidence/. The format is not fixed yet, so any
// JSON file that holds objects with a transaction hash is accepted: a bare array, or an object
// with `transactions`, `txs`, `records` or `runs`. Unknown fields are ignored; a record without
// a hash is dropped. Failed transactions are kept and marked.

export type TxGroup = "report" | "commit" | "reveal" | "clear" | "settle" | "redeem" | "deploy" | "funding" | "other";

export const TX_GROUPS: readonly TxGroup[] = ["report", "commit", "reveal", "clear", "settle", "redeem", "funding", "deploy", "other"];

export interface TxRecord {
  hash: string;
  method: string;
  group: TxGroup;
  ok: boolean | null;
  signer: string | null;
  receiver: string | null;
  at: number | null;
  note: string | null;
  market: string | null;
  file: string;
  /** The deploy tool's step id, e.g. "key:<account>:<contract>"; null in other records. */
  step: string | null;
  /** The explorer link the record carries, if any. */
  explorer: string | null;
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function time(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 1e17) return Math.floor(v / 1e9); // nanoseconds (NEAR block_timestamp)
    if (v > 1e12) return Math.floor(v / 1e3); // milliseconds
    return Math.floor(v);
  }
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return time(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  return null;
}

export function groupOf(method: string, kind?: string | null): TxGroup {
  const m = `${kind ?? ""} ${method}`.toLowerCase();
  if (/intent|bridge|funding|ft_transfer_call|deposit/.test(m)) return "funding";
  for (const g of ["report", "commit", "reveal", "clear", "settle", "redeem"] as const) if (m.includes(g)) return g;
  if (/deploy|new\b|init|delete_key|deletekey|add_key/.test(m)) return "deploy";
  return "other";
}

function okOf(r: Record<string, unknown>): boolean | null {
  if (typeof r.ok === "boolean") return r.ok;
  if (typeof r.success === "boolean") return r.success;
  if (typeof r.failed === "boolean") return !r.failed;
  const st = s(r.status)?.toLowerCase() ?? (r.status && typeof r.status === "object" ? Object.keys(r.status as object)[0]?.toLowerCase() : null);
  if (!st) return null;
  if (/success|ok|landed|final/.test(st)) return true;
  if (/fail|error|revert|panic/.test(st)) return false;
  return null;
}

function records(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const k of ["transactions", "txs", "records", "runs", "steps"]) if (Array.isArray(o[k])) return o[k] as unknown[];
    if (s(o.hash) || s(o.tx_hash) || s(o.transaction_hash)) return [o];
  }
  return [];
}

/** Normalizes one parsed evidence file into transaction records. */
export function readTxFile(file: string, json: unknown): TxRecord[] {
  const out: TxRecord[] = [];
  for (const item of records(json)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const hash = s(r.hash) ?? s(r.tx_hash) ?? s(r.transaction_hash) ?? s(r.tx);
    if (!hash || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$|^0x[0-9a-fA-F]{64}$|^[0-9a-f]{64}$/.test(hash)) continue;
    const step = s(r.step);
    const method = s(r.method) ?? s(r.method_name) ?? s(r.action) ?? s(r.kind) ?? (step ? step.split(":")[0]! : "transaction");
    out.push({
      hash,
      method,
      group: groupOf(method, s(r.kind)),
      ok: okOf(r),
      signer: s(r.signer) ?? s(r.signer_id) ?? s(r.from),
      receiver: s(r.receiver) ?? s(r.receiver_id) ?? s(r.to) ?? s(r.contract),
      at: time(r.at ?? r.time ?? r.timestamp ?? r.block_timestamp),
      note: s(r.note) ?? s(r.label) ?? s(r.description) ?? s(r.purpose),
      market: s(r.market),
      file,
      step,
      explorer: s(r.explorer),
    });
  }
  return out;
}

/** Groups records by method group, newest first within a group; duplicates by hash removed. */
export function groupTxs(txs: TxRecord[]): { group: TxGroup; txs: TxRecord[] }[] {
  const seen = new Set<string>();
  const unique = txs.filter((t) => (seen.has(t.hash) ? false : (seen.add(t.hash), true)));
  return TX_GROUPS.map((group) => ({
    group,
    txs: unique.filter((t) => t.group === group).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
  })).filter((g) => g.txs.length > 0);
}

/** The deploy tool's steps, by the word before the first colon of the step id, in the order the tool runs them. */
export const STEP_KINDS: readonly { kind: string; label: string; steps: readonly string[] }[] = [
  { kind: "accounts", label: "Accounts created", steps: ["account"] },
  { kind: "contracts", label: "Contracts deployed", steps: ["deploy"] },
  { kind: "storage", label: "Token storage paid", steps: ["storage"] },
  { kind: "registrations", label: "Registrations on a market", steps: ["register"] },
  { kind: "mints", label: "Test dollars minted", steps: ["mint"] },
  { kind: "deposits", label: "Deposits", steps: ["deposit"] },
  { kind: "guards", label: "Guards set", steps: ["guard"] },
  { kind: "keys", label: "Keys added", steps: ["key"] },
  { kind: "funding", label: "Funding accounts created and swept", steps: ["fund", "sweep"] },
  { kind: "topup", label: "The top-up", steps: ["topup"] },
  { kind: "rotation", label: "The key rotation", steps: ["rotate", "retire"] },
];

export interface StepGroup {
  kind: string;
  label: string;
  txs: TxRecord[];
}

/**
 * Groups records by what they did: the deploy tool's step for records that carry one, the method
 * group for the rest. Order within a group is the record's own (the order they were sent).
 * Duplicates by hash are removed.
 */
export function stepGroups(txs: TxRecord[]): StepGroup[] {
  const seen = new Set<string>();
  const unique = txs.filter((t) => (seen.has(t.hash) ? false : (seen.add(t.hash), true)));
  const out: StepGroup[] = STEP_KINDS.map((k) => ({ kind: k.kind, label: k.label, txs: unique.filter((t) => t.step !== null && k.steps.includes(t.step.split(":")[0]!)) }));
  const known = new Set(out.flatMap((g) => g.txs.map((t) => t.hash)));
  for (const g of groupTxs(unique.filter((t) => !known.has(t.hash)))) out.push({ kind: `method-${g.group}`, label: g.group === "other" ? "Other" : g.group[0]!.toUpperCase() + g.group.slice(1), txs: g.txs });
  return out.filter((g) => g.txs.length > 0);
}

export type FundingStatus = { tag: "recorded"; tx: TxRecord } | { tag: "quotes only" };

/** "recorded" only when a successful cross-chain transfer is on record; otherwise quotes only. */
export function fundingStatus(txs: TxRecord[]): FundingStatus {
  const tx = txs.find((t) => t.group === "funding" && t.ok === true && /intent|bridge|cross/i.test(`${t.method} ${t.note ?? ""}`));
  return tx ? { tag: "recorded", tx } : { tag: "quotes only" };
}
