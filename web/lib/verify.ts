// The bundle verifier (DESIGN section 4, /proof). Runs in the browser: fetch each bundle, hash
// its canonical form with Web Crypto, compare with the hash the reporter put on chain, re-run
// the method's checks, compare the bundle's index with the reported price, and recompute each
// print as the median of its reports.
import { bundleHash, verifyBundle, type Bundle, type Check } from "@weir/index";
import { median } from "./views.ts";

export interface VerifyReport {
  reporter: string;
  price: number;
  bundle: string;
}

export interface VerifyPrint {
  bucket: number;
  price: number;
  reports: VerifyReport[];
}

export type Row =
  | { kind: "fetch"; label: string; ok: false; detail: string }
  | { kind: "hash"; label: string; ok: boolean; file: string; chain: string }
  | { kind: "rules"; label: string; ok: boolean; passed: number; failed: Check[] }
  | { kind: "index"; label: string; ok: boolean; file: number | null; chain: number }
  | { kind: "median"; label: string; ok: boolean; recomputed: number | null; chain: number };

/** Checks one bundle's text against the hash and price a reporter put on chain. */
export async function checkBundle(text: string, chainHash: string | null, reportedPrice: number | null, label: string): Promise<Row[]> {
  let bundle: Bundle;
  try {
    bundle = JSON.parse(text) as Bundle;
  } catch {
    return [{ kind: "fetch", label, ok: false, detail: "The file is not JSON." }];
  }
  const rows: Row[] = [];
  const file = await bundleHash(bundle);
  if (chainHash !== null) rows.push({ kind: "hash", label, ok: file === chainHash, file, chain: chainHash });
  let checks: Check[];
  try {
    checks = verifyBundle(bundle);
  } catch (e) {
    checks = [{ name: `checks could not run: ${(e as Error).message}`, ok: false, expected: true, actual: false }];
  }
  const failed = checks.filter((c) => !c.ok);
  rows.push({ kind: "rules", label, ok: failed.length === 0, passed: checks.length - failed.length, failed });
  if (reportedPrice !== null) rows.push({ kind: "index", label, ok: bundle.index === reportedPrice, file: bundle.index, chain: reportedPrice });
  return rows;
}

/** The print is the median of its reports (SPEC 9). */
export function checkMedian(print: VerifyPrint): Row {
  const m = median(print.reports.map((r) => r.price));
  return { kind: "median", label: `print ${print.bucket}`, ok: m === print.price, recomputed: m, chain: print.price };
}

/** The hash a recorded file's name carries: `<bucket>-<first 12 hex of the hash>.json`. */
export function hashFromFileName(file: string): string | null {
  const m = /-([0-9a-f]{12,64})\.json$/.exec(file);
  return m ? m[1]! : null;
}

/** What became of each report's bundle: its hash matched the chain's, did not, or the file was not to be had. */
export type ReportState = "matched" | "differs" | "unavailable";

export interface PrintCheckSummary {
  /** Reports whose bundle hashed to the chain's hash. */
  matched: number;
  /** Reports whose bundle was fetched and hashed to something else. */
  differs: number;
  /** Reports whose bundle the host did not have, or that could not be fetched: not a failed check. */
  unavailable: number;
  /** Method checks run on the bundles that were fetched: bundles that passed every check, and that did not. */
  rulesPassed: number;
  rulesFailed: number;
}

/** Counts a print's check rows by report (lib/verify.ts rows, labelled by reporter). */
export function summarizeChecks(rows: Row[], reporters: string[]): PrintCheckSummary {
  const out: PrintCheckSummary = { matched: 0, differs: 0, unavailable: 0, rulesPassed: 0, rulesFailed: 0 };
  for (const r of reporters) {
    const mine = rows.filter((x) => x.label === r);
    const hash = mine.find((x) => x.kind === "hash");
    if (mine.some((x) => x.kind === "fetch") || !hash) out.unavailable++;
    else if (hash.ok) out.matched++;
    else out.differs++;
    const rules = mine.find((x) => x.kind === "rules");
    if (rules) rules.ok ? out.rulesPassed++ : out.rulesFailed++;
  }
  return out;
}

/** The bundle host has published reports' bundles since this time (12 Nov 2026, 19:15 UTC, when the keeper moved to it). */
export const BUNDLES_SINCE = Date.UTC(2026, 10, 12, 19, 15) / 1000;
