// Polite, cached HTTP for the fetch step. One request at a time per caller, a pause
// between requests to the same host, and every body written to disk under data/raw/.
// A file already on disk is never downloaded again, so an interrupted run resumes.

import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const USER_AGENT = "weir-backtest/0.1 (price-history research; low rate)";
const lastHit = new Map<string, number>();

function pauseMsFor(host: string): number {
  if (host.endsWith("archive.org")) return 1500;
  if (host.endsWith("github.com")) return 1000;
  return 150;
}

async function politeWait(url: string): Promise<void> {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + pauseMsFor(host) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
  throw new Error(`${what}: ${String(lastErr)}`);
}

/** HTTP status of a HEAD request (no body, nothing cached). */
export async function headStatus(url: string): Promise<number> {
  return withRetry(`HEAD ${url}`, async () => {
    await politeWait(url);
    const res = await fetch(url, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
    if (res.status >= 500 || res.status === 429) throw new Error(`status ${res.status}`);
    return res.status;
  });
}

/**
 * Download `url` to `path` unless `path` already exists. Returns the bytes, or null
 * when the server answers 404/403 (the miss is not cached; callers keep their own
 * record of misses).
 */
export async function cachedGet(url: string, path: string): Promise<Buffer | null> {
  if (existsSync(path)) return readFileSync(path);
  return withRetry(`GET ${url}`, async () => {
    await politeWait(url);
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.part`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
    return body;
  });
}

export function readJsonIfExists<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.part`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n");
  renameSync(tmp, path);
}
