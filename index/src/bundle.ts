// Canonical JSON, the bundle hash and the bundle verifier. Standard JS plus Web Crypto
// (or a sha256 passed in), so it runs unchanged in a browser.
import { chipById } from "./chips.ts";
import {
  compareOffers, computeIndex, contextOf, EMPTY_SHA256, isFailure, METHOD_ID, METHOD_V1, providerEntry, providersFrom,
  type Bundle, type Outcome, type Source,
} from "./method.ts";
import { sourceById, sourcesFor, SOURCES_V1 } from "./sources/mod.ts";

export type Sha256Hex = (text: string) => string | Promise<string>;

export interface Check {
  name: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
}

/** UTF-8 JSON with object keys sorted (by UTF-16 code units) and no insignificant whitespace. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new Error(`cannot encode ${typeof v}`);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256 of bytes (or the UTF-8 of a string) via Web Crypto, as 64 lowercase hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** The value reported on chain as `bundle`: sha256 of the canonical form. */
export async function bundleHash(bundle: Bundle, sha: Sha256Hex = sha256Hex): Promise<string> {
  return sha(canonical(bundle));
}

const check = (name: string, expected: unknown, actual: unknown): Check => ({
  name,
  ok: canonical(expected ?? null) === canonical(actual ?? null),
  expected,
  actual,
});

/**
 * The sources a bundle was made with, from its `method` (and, for version 2, its `chip`),
 * or why they cannot be known.
 */
export function sourcesOf(bundle: Bundle): { sources: readonly Source[] } | { error: string } {
  if (bundle.method === METHOD_V1) return { sources: SOURCES_V1 };
  if (bundle.method !== METHOD_ID) return { error: `unknown method ${JSON.stringify(bundle.method)}` };
  const chip = chipById(String(bundle.chip));
  return chip ? { sources: sourcesFor(chip) } : { error: `unknown chip ${JSON.stringify(bundle.chip)}` };
}

const sorted = <T extends { sku: string; price: number }>(xs: readonly T[]): T[] => [...xs].sort(compareOffers);

/**
 * Recomputes every provider entry from its offers and the index from the provider values,
 * and checks the structural rules of the bundle's method (`weir-gpu-od/2` or
 * `weir-h100-od/1`, chosen by its `method` field). Returns every check; the bundle is valid
 * when all are ok.
 */
export function verifyBundle(bundle: Bundle): Check[] {
  const out: Check[] = [check("method", [METHOD_ID, METHOD_V1].includes(bundle.method) ? bundle.method : `${METHOD_ID} or ${METHOD_V1}`, bundle.method)];
  if (bundle.method === METHOD_V1) {
    out.push(check("version 1 has no chip or index_name", false, "chip" in bundle || "index_name" in bundle));
  } else if (bundle.method === METHOD_ID) {
    const chip = chipById(String(bundle.chip));
    out.push(check("chip is supported", true, chip !== undefined));
    if (chip) out.push(check("index_name matches chip", chip.index_name, bundle.index_name));
  }
  const known = sourcesOf(bundle);
  if ("error" in known) return out;
  const ctx = contextOf(bundle);
  const ids = bundle.providers.map((p) => p.id);
  out.push(check("providers sorted by id, unique", [...new Set(ids)].sort(), ids));
  for (const p of bundle.providers) {
    const src = sourceById(p.source, known.sources);
    out.push(check(`${p.id}: kind`, src?.kind ?? "known source", p.kind));
    out.push(check(`${p.id}: offers sorted`, sorted(p.offers), p.offers));
    const dropped = p.dropped ?? [];
    if (ctx.version === 1) out.push(check(`${p.id}: version 1 drops nothing`, false, "dropped" in p));
    else if (p.dropped !== undefined) out.push(check(`${p.id}: dropped sorted, not empty`, true, dropped.length > 0 && canonical(sorted(dropped)) === canonical(dropped)));
    const bad = [...p.offers, ...dropped].filter((o) => !Number.isSafeInteger(o.price) || o.price < 0).length;
    out.push(check(`${p.id}: offer prices are micro-USD integers`, 0, bad));
    if (!src) continue;
    if (isFailure(p.reason)) {
      // A source that gave no usable response holds nothing to recompute from.
      const empty = p.offers.length === 0 && dropped.length === 0 && p.value === undefined && p.id === p.source && p.status === "excluded";
      out.push(check(`${p.id}: failed source carries no offers`, true, empty));
      if (p.reason!.startsWith("fetch failed: ")) out.push(check(`${p.id}: failed fetch hashes the empty body`, EMPTY_SHA256, p.raw_sha256));
      continue;
    }
    const prefix = `${p.source}:`;
    const draft = { id: p.id.startsWith(prefix) ? p.id.slice(prefix.length) : p.id, offers: [...p.offers, ...dropped] };
    const e = providerEntry(src, draft, { kind: p.kind, source: p.source, url: p.url, raw_sha256: p.raw_sha256 }, ctx);
    if (e.id !== p.id) out.push(check(`${p.id}: id`, e.id, p.id));
    if (ctx.version === 2) out.push(check(`${p.id}: placeholders`, { offers: e.offers, dropped: e.dropped }, { offers: p.offers, dropped: p.dropped }));
    if (p.status === "included") {
      out.push(check(`${p.id}: value`, e.status === "included" ? e.value : `excluded (${e.reason})`, p.value));
    } else {
      out.push(check(`${p.id}: excluded with a reason that holds`, true, e.status === "excluded" && e.reason === p.reason && p.value === undefined));
    }
  }
  const idx = computeIndex(bundle.providers);
  out.push(check("index", idx.index, bundle.index));
  if (idx.index === null) out.push(check("index reason", idx.reason, bundle.reason));
  return out;
}

/**
 * Checks one source's raw body against the bundle: its hash matches, and parsing it again
 * under the bundle's method and chip yields exactly the provider entries the bundle holds
 * for that source.
 */
export async function verifyRaw(bundle: Bundle, sourceId: string, body: Uint8Array): Promise<Check[]> {
  const known = sourcesOf(bundle);
  const source = "sources" in known ? sourceById(sourceId, known.sources) : undefined;
  if (!source) return [check(`raw ${sourceId}: known source`, true, false)];
  const held = bundle.providers.filter((p) => p.source === sourceId);
  const raw_sha256 = await sha256Hex(body);
  const outcome: Outcome = { source, body: new TextDecoder().decode(body), raw_sha256 };
  const rebuilt = providersFrom(outcome, contextOf(bundle)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [
    check(`raw ${sourceId}: sha256`, raw_sha256, held[0]?.raw_sha256),
    check(`raw ${sourceId}: providers re-parsed`, rebuilt, held),
  ];
}
