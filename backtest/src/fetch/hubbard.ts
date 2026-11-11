// afhubbard/gpu-prices on Hugging Face (CC BY 4.0): gpuhunt run twice a day since
// 2026-01-12, one parquet file per run under prices/dt=YYYY-MM-DD/. We take the
// earliest snapshot of each day. The file listing is saved once (tree.json) and its
// LFS sha256 is checked against every download.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cachedGet, readJsonIfExists, writeJson } from "../lib/http.ts";
import { RAW } from "../lib/paths.ts";

const REPO = "afhubbard/gpu-prices";
export const HUBBARD_DIR = join(RAW, "hubbard");
const TREE = join(HUBBARD_DIR, "tree.json");
export const HUBBARD_README_URL = `https://huggingface.co/datasets/${REPO}/raw/main/README.md`;
export const HUBBARD_README = join(HUBBARD_DIR, "README.md");

export interface TreeFile {
  path: string;
  size: number;
  sha256: string;
}

async function listTree(): Promise<TreeFile[]> {
  const cached = readJsonIfExists<TreeFile[] | null>(TREE, null);
  if (cached) return cached;
  const files: TreeFile[] = [];
  let url: string | null = `https://huggingface.co/api/datasets/${REPO}/tree/main/prices?recursive=true`;
  while (url) {
    const res: Response = await fetch(url, { headers: { "user-agent": "weir-backtest/0.1" } });
    if (!res.ok) throw new Error(`HF tree ${res.status}`);
    const items = (await res.json()) as Array<{ type: string; path: string; size: number; lfs?: { oid: string } }>;
    for (const it of items) {
      if (it.type === "file" && it.path.endsWith(".parquet") && it.lfs) {
        files.push({ path: it.path, size: it.size, sha256: it.lfs.oid });
      }
    }
    const link = res.headers.get("link");
    const next = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
    url = next ? next[1]! : null;
    await new Promise((r) => setTimeout(r, 500));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  writeJson(TREE, files);
  return files;
}

/** The earliest snapshot file of each day, keyed by day. */
export function dailyPicks(files: TreeFile[]): Map<string, TreeFile> {
  const picks = new Map<string, TreeFile>();
  for (const f of files) {
    const m = /dt=(\d{4}-\d{2}-\d{2})\//.exec(f.path);
    if (!m) continue;
    const prev = picks.get(m[1]!);
    if (!prev || f.path < prev.path) picks.set(m[1]!, f);
  }
  return picks;
}

export function hubbardTree(): TreeFile[] {
  return readJsonIfExists<TreeFile[]>(TREE, []);
}

export function localPath(f: TreeFile): string {
  return join(HUBBARD_DIR, f.path);
}

export async function fetchHubbard(): Promise<void> {
  await cachedGet(HUBBARD_README_URL, HUBBARD_README);
  const files = await listTree();
  const picks = dailyPicks(files);
  console.log(`hubbard: ${files.length} snapshot files, ${picks.size} days`);
  for (const f of [...picks.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const file = localPath(f);
    const fresh = !existsSync(file);
    const body = await cachedGet(`https://huggingface.co/datasets/${REPO}/resolve/main/${f.path}`, file);
    if (!body) throw new Error(`missing ${f.path}`);
    const sha = createHash("sha256").update(body).digest("hex");
    if (sha !== f.sha256) throw new Error(`sha256 mismatch for ${f.path}`);
    if (fresh) console.log(`hubbard ${f.path}`);
  }
}
