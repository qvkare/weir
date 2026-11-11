// Canonical JSON, the bundle hash and the bundle verifier. Standard JS plus Web Crypto
// (or a sha256 passed in), so it runs unchanged in a browser.
import { assess, computeIndex, METHOD_ID, MIN_VAST_HOSTS, providersFrom, vastHostPrices, type Bundle, type Outcome } from "./method.ts";
import { sourceById } from "./sources/mod.ts";

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
 * Recomputes every included provider's value from its offers and the index from the
 * provider values, and checks the structural rules of the method. Returns every check;
 * the bundle is valid when all are ok.
 */
export function verifyBundle(bundle: Bundle): Check[] {
  const out: Check[] = [check("method", METHOD_ID, bundle.method)];
  const ids = bundle.providers.map((p) => p.id);
  out.push(check("providers sorted by id, unique", [...new Set(ids)].sort(), ids));
  for (const p of bundle.providers) {
    const src = sourceById(p.source);
    out.push(check(`${p.id}: kind`, src?.kind ?? "known source", p.kind));
    const sorted = [...p.offers].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.price - b.price));
    out.push(check(`${p.id}: offers sorted`, sorted, p.offers));
    const bad = p.offers.filter((o) => !Number.isSafeInteger(o.price) || o.price < 0).length;
    out.push(check(`${p.id}: offer prices are micro-USD integers`, 0, bad));
    const a = assess(p.source, p.offers);
    if (p.status === "included") {
      out.push(check(`${p.id}: value`, "value" in a ? a.value : `excluded (${a.reason})`, p.value));
      if (p.source === "vast") out.push(check(`${p.id}: at least ${MIN_VAST_HOSTS} hosts`, true, vastHostPrices(p.offers).length >= MIN_VAST_HOSTS));
    } else {
      // An excluded provider whose offers would pass is only allowed for duplicates and failed fetches.
      const justified = "reason" in a || (p.reason ?? "").startsWith("duplicate of ");
      out.push(check(`${p.id}: excluded with a reason that holds`, true, justified && (p.reason ?? "") !== ""));
    }
  }
  const idx = computeIndex(bundle.providers);
  out.push(check("index", idx.index, bundle.index));
  if (idx.index === null) out.push(check("index reason", idx.reason, bundle.reason));
  return out;
}

/**
 * Checks one source's raw body against the bundle: its hash matches, and parsing it again
 * yields exactly the provider entries the bundle holds for that source.
 */
export async function verifyRaw(bundle: Bundle, sourceId: string, body: Uint8Array): Promise<Check[]> {
  const source = sourceById(sourceId);
  if (!source) return [check(`raw ${sourceId}: known source`, true, false)];
  const held = bundle.providers.filter((p) => p.source === sourceId);
  const raw_sha256 = await sha256Hex(body);
  const outcome: Outcome = { source, body: new TextDecoder().decode(body), raw_sha256 };
  const rebuilt = providersFrom(outcome).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [
    check(`raw ${sourceId}: sha256`, raw_sha256, held[0]?.raw_sha256),
    check(`raw ${sourceId}: providers re-parsed`, rebuilt, held),
  ];
}
