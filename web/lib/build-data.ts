// Reads the repository files the site depends on. next.config.ts runs this once at build time
// and inlines the result as WEIR_BUILD, because a Worker has no file system. Every file is
// optional; what is missing is recorded as missing.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readTxFile, type TxRecord } from "./evidence.ts";
import type { BuildData, RecordedBundle } from "./build-types.ts";

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function walk(dir: string, skip: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (skip(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, skip));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

export function readBuildData(root: string): BuildData {
  const evidence = join(root, "evidence");
  const bundlesDir = join(evidence, "bundles");

  // Version-2 bundles live in evidence/bundles/<chip>/; the version-1 H100 first print stays at
  // the top level and counts as an H100 bundle.
  const bundles: RecordedBundle[] = [];
  const readDir = (dir: string, rel: string, fallbackChip: string | null) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const text = readFileSync(join(dir, name), "utf8");
      const json = readJson(join(dir, name));
      if (!json || typeof json !== "object") continue;
      const b = json as { bucket?: unknown; chip?: unknown };
      const chip = typeof b.chip === "string" ? b.chip : fallbackChip;
      if (!chip) continue;
      bundles.push({ file: `${rel}/${name}`, text, bucket: typeof b.bucket === "number" ? b.bucket : null, chip });
    }
  };
  readDir(bundlesDir, "evidence/bundles", "h100");
  if (existsSync(bundlesDir)) for (const d of readdirSync(bundlesDir).sort()) if (d !== "raw" && !d.endsWith(".raw") && statSync(join(bundlesDir, d)).isDirectory()) readDir(join(bundlesDir, d), `evidence/bundles/${d}`, d);
  bundles.sort((a, b) => (b.bucket ?? 0) - (a.bucket ?? 0));

  const txs: TxRecord[] = [];
  for (const path of walk(evidence, (p) => p.startsWith(bundlesDir) || p.endsWith(".raw"))) {
    txs.push(...readTxFile(relative(root, path), readJson(path)));
  }

  const results = join(root, "backtest", "results");
  const site = existsSync(join(results, "site.json")) ? readJson(join(results, "site.json")) : undefined;
  const summary = existsSync(join(results, "summary.json")) ? readJson(join(results, "summary.json")) : undefined;
  const summaryMd = existsSync(join(results, "summary.md")) ? readFileSync(join(results, "summary.md"), "utf8") : null;

  return {
    builtAt: Math.floor(Date.now() / 1000),
    specVersion: specVersion(root),
    spec: existsSync(join(root, "docs", "SPEC.md")) ? readFileSync(join(root, "docs", "SPEC.md"), "utf8") : null,
    audit: existsSync(join(root, "docs", "AUDIT.md")) ? readFileSync(join(root, "docs", "AUDIT.md"), "utf8") : null,
    deployments: readJson(join(root, "deployments.json")) ?? null,
    // Only the newest recorded bundle of each chip travels with the build: the fixture and the fallback.
    bundles: [...new Set(bundles.map((b) => b.chip))].map((c) => bundles.find((b) => b.chip === c)!),
    bundleCount: bundles.length,
    txs,
    backtest: { site: site ?? null, summary: summary ?? null, summaryMd, siteMissing: site === undefined },
    modules: {
      sim: existsSync(join(root, "agents", "src", "sim.ts")),
      intents: existsSync(join(root, "chain", "src", "intents.ts")),
    },
  };
}

export function specVersion(root: string): string | null {
  try {
    return /^Version (\d+(?:\.\d+)+)/m.exec(readFileSync(join(root, "docs", "SPEC.md"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}
