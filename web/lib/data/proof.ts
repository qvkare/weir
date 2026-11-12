// The parts of /proof that come from the chain: the contracts' keys and code hashes, the solvency
// check, and the last prints to verify. Browser-safe; the build runs it with server readers and
// the browser runs it again with its own. About a dozen views in all.
import type { WireParams, WireTotals } from "@weir/engine";
import { valueOf, type Read } from "../cache.ts";
import type { MarketId } from "../config.ts";
import type { AccessKeyInfo, AccountState } from "../near.ts";
import type { Reader } from "../reader.ts";
import type { SourceKind } from "../source-types.ts";
import type { VerifyPrint } from "../verify.ts";

export interface ContractRow {
  market: MarketId;
  account: string;
  role: string;
  kind: SourceKind;
}

export interface ProofData {
  contracts: (ContractRow & { keys: Read<AccessKeyInfo[]> | null; acct: Read<AccountState> | null })[];
  kind: SourceKind;
  params: Read<WireParams> | null;
  totals: Read<WireTotals> | null;
  balance: Read<string> | null;
  prints: VerifyPrint[];
  at: number;
}

export async function loadProof(rows: ContractRow[], readerOf: (m: MarketId) => Reader, market: MarketId): Promise<ProofData> {
  const r = readerOf(market);
  const src = r.src;
  const [contracts, params, totals, last] = await Promise.all([
    Promise.all(
      rows.map(async (row) => {
        if (row.kind !== "chain") return { ...row, keys: null, acct: null };
        const rr = readerOf(row.market);
        const [keys, acct] = await Promise.all([rr.keys(row.account), rr.account(row.account)]);
        return { ...row, keys, acct };
      }),
    ),
    src.kind === "none" ? Promise.resolve(null) : src.view("get_params", {}),
    src.kind === "none" ? Promise.resolve(null) : src.view("get_totals", {}),
    src.kind === "none" ? Promise.resolve(null) : src.view("get_last_print", {}),
  ]);
  const p = params ? valueOf(params) : null;
  const l = last ? valueOf(last) : null;
  const [balance, printsR] = await Promise.all([
    p && src.contract ? r.tokenBalance(p.usdc, src.contract) : Promise.resolve(null),
    p && l ? src.view("get_prints", { from_bucket: l.bucket - 4 * p.print_interval_secs, limit: 5 }) : Promise.resolve(null),
  ]);
  const prints = ((printsR ? valueOf(printsR) : null) ?? [])
    .filter((x) => x.price !== null)
    .reverse()
    .map((x) => ({ bucket: x.bucket, price: x.price!, reports: x.reports }));
  return { contracts, kind: src.kind, params, totals, balance, prints, at: Date.now() };
}
