"use client";
import { useCallback, useEffect, useState } from "react";
import { dollarsOfPrice, fmtUtc, shortHash } from "@/lib/format.ts";
import { checkBundle, checkMedian, hashFromFileName, type Row, type VerifyPrint } from "@/lib/verify.ts";
import { bundleHash, type Bundle } from "@weir/index";
import { CheckIcon, CrossIcon } from "./icons.tsx";

interface Props {
  prints: VerifyPrint[];
  bundlesBase: string | null;
  recorded: { file: string; text: string; bucket: number | null } | null;
  tick: number;
  /** True when the reports' hashes are the model's, with no files behind them. */
  model: boolean;
}

type Group = { title: string; rows: Row[]; status: "pending" | "done" };

/** Fetches every bundle from the bundle host and checks it here, with SubtleCrypto. */
export function BundleVerifier({ prints, bundlesBase, recorded, tick, model }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(0);

  const run = useCallback(async () => {
    setRunning(true);
    setRunId((n) => n + 1);
    const out: Group[] = [];
    const push = (g: Group) => {
      out.push(g);
      setGroups([...out]);
    };
    if (bundlesBase && !model) {
      for (const p of prints) {
        const rows: Row[] = [checkMedian(p)];
        for (const r of p.reports) {
          try {
            const res = await fetch(`${bundlesBase}/${r.bundle}.json`, { cache: "no-store" });
            if (!res.ok) {
              rows.push({ kind: "fetch", label: r.reporter, ok: false, detail: `bundle host answered HTTP ${res.status} for ${shortHash(r.bundle)}` });
              continue;
            }
            rows.push(...(await checkBundle(await res.text(), r.bundle, r.price, r.reporter)));
          } catch (e) {
            rows.push({ kind: "fetch", label: r.reporter, ok: false, detail: `could not fetch ${shortHash(r.bundle)}: ${(e as Error).message}` });
          }
        }
        push({ title: `Print for ${fmtUtc(p.bucket)}, ${dollarsOfPrice(p.price, tick)} /GPU-h`, rows, status: "done" });
      }
    } else {
      for (const p of prints) push({ title: `Print for ${fmtUtc(p.bucket)}, ${dollarsOfPrice(p.price, tick)} /GPU-h`, rows: [checkMedian(p)], status: "done" });
    }
    if (recorded) {
      const prefix = hashFromFileName(recorded.file);
      const rows = await checkBundle(recorded.text, null, null, "recorded");
      const full = await bundleHash(JSON.parse(recorded.text) as Bundle);
      rows.unshift({ kind: "hash", label: "file name", ok: prefix !== null && full.startsWith(prefix), file: full, chain: prefix ?? "none" });
      push({ title: `Recorded sample ${recorded.file}${recorded.bucket ? `, bucket ${fmtUtc(recorded.bucket)}` : ""}`, rows, status: "done" });
    }
    setRunning(false);
  }, [prints, bundlesBase, recorded, tick, model]);

  useEffect(() => {
    void run();
  }, [run]);

  const all = groups.flatMap((g) => g.rows);
  // Each check resolves after the one before it, so the list reads top to bottom (CSS, data-i).
  const offsets = groups.map((_, i) => groups.slice(0, i).reduce((n, g) => n + g.rows.length, 0));
  const bad = all.filter((r) => !r.ok).length;
  return (
    <div className="stack">
      <p className="small" aria-live="polite">
        {running ? "Checking in this browser…" : `${all.length} checks run in this browser, ${bad === 0 ? "all passed" : `${bad} failed`}.`}{" "}
        <button type="button" className="button ghost" onClick={() => void run()} disabled={running} style={{ marginLeft: 8 }}>
          Check again
        </button>
      </p>
      {model ? <p className="small flag">In model mode the reports carry model hashes with no files behind them, so only the medians are checked against the prints. The recorded sample below is a real bundle.</p> : null}
      {!bundlesBase && !model ? <p className="small flag">No bundle host is set for this deployment, so report hashes cannot be fetched yet. Unverified.</p> : null}
      {groups.map((g, i) => (
        <div className="table-wrap" key={`${runId}-${i}`}>
          <table>
            <caption>{g.title}</caption>
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Detail</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r, j) => (
                <tr key={j} className="check-row" style={{ ["--i" as string]: Math.min(offsets[i]! + j, 24) }}>
                  <td>{rowName(r)}</td>
                  <td className="mono small" style={{ overflowWrap: "anywhere" }}>{rowDetail(r, tick)}</td>
                  <td>
                    <span className="check-result">
                      <span className="check-pending muted" aria-hidden="true">checking</span>
                      {r.ok ? (
                        <span className="ok check-done">
                          <CheckIcon /> matches
                        </span>
                      ) : (
                        <span className="bad check-done">
                          <CrossIcon /> {r.kind === "fetch" ? "unverified" : "does not match"}
                        </span>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function rowName(r: Row): string {
  switch (r.kind) {
    case "fetch":
      return `${r.label}: fetch`;
    case "hash":
      return `${r.label}: sha256`;
    case "rules":
      return `${r.label}: method checks`;
    case "index":
      return `${r.label}: index = report`;
    case "median":
      return "median of reports = print";
  }
}

function rowDetail(r: Row, tick: number): string {
  switch (r.kind) {
    case "fetch":
      return r.detail;
    case "hash":
      return `file ${shortHash(r.file)} / ${r.label === "file name" ? "name" : "chain"} ${shortHash(r.chain)}`;
    case "rules":
      return r.ok ? `${r.passed} of ${r.passed} passed` : `${r.failed.length} failed: ${r.failed.map((c) => c.name).slice(0, 3).join("; ")}`;
    case "index":
      return `file ${dollarsOfPrice(r.file, tick)} / chain ${dollarsOfPrice(r.chain, tick)}`;
    case "median":
      return `recomputed ${dollarsOfPrice(r.recomputed, tick)} / chain ${dollarsOfPrice(r.chain, tick)}`;
  }
}
