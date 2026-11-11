// The H100-OD method: prices in micro-USD, medians, provider rules and the index rule.
// Pure functions only, so the same code runs in the CLI, the tests and a browser.

export const METHOD_ID = "weir-h100-od/1";
export const MIN_VALUE = 200_000; // 0.20 USD per GPU-hour
export const MAX_VALUE = 50_000_000; // 50.00 USD per GPU-hour
export const MIN_PROVIDERS = 6;
export const MIN_RATE_CARD = 3;
export const MIN_VAST_HOSTS = 3;

export type Kind = "rate-card" | "open-market";

export interface Offer {
  sku: string;
  price: number; // micro-USD per GPU-hour
}

/** What a source's parser returns: one entry per provider found in the response. */
export interface Draft {
  id: string;
  offers: Offer[];
  note?: string;
}

export interface Source {
  id: string;
  kind: Kind;
  url: string;
  method: "GET" | "POST";
  body?: string;
  /** Sources that resell many clouds; their providers lose to a direct source. */
  aggregator?: boolean;
  parse(json: unknown): Draft[];
}

export interface Provider {
  id: string;
  kind: Kind;
  source: string;
  url: string;
  status: "included" | "excluded";
  reason?: string;
  value?: number;
  offers: Offer[];
  raw_sha256: string;
  note?: string;
}

export interface Bundle {
  method: string;
  bucket: number;
  fetched_at: number;
  providers: Provider[];
  index: number | null;
  reason?: string;
}

/** One source's fetch result: the body as text (null if the fetch failed) and its hash. */
export interface Outcome {
  source: Source;
  body: string | null;
  raw_sha256: string;
  error?: string;
}

/** Names an aggregator may use for a company that is also a direct source. */
export const SAME_COMPANY: Readonly<Record<string, string>> = {
  vast: "vast",
  vastai: "vast",
  runpod: "runpod",
  akash: "akash",
  akashnetwork: "akash",
  lium: "lium",
  verda: "verda",
  datacrunch: "verda",
};

/**
 * Converts a non-negative decimal (a JSON number or a decimal string) divided by
 * `divisor` to integer micro-USD, rounding half up. Exact: the decimal is read as
 * digits and the division is done on integers, so the result never depends on
 * floating-point arithmetic. A JSON number is read through its shortest round-trip
 * string (`String(x)`), which is what the source sent for any value it printed exactly.
 */
export function toMicro(x: number | string, divisor: number = 1): number {
  const text = typeof x === "number" ? String(x) : x.trim();
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m || !Number.isInteger(divisor) || divisor <= 0) throw new Error(`not a price: ${text} / ${divisor}`);
  const frac = m[2] ?? "";
  const exp = Number(m[3] ?? "0") - frac.length + 6;
  let num = BigInt(m[1] + frac);
  let den = BigInt(divisor);
  if (exp >= 0) num *= 10n ** BigInt(exp);
  else den *= 10n ** BigInt(-exp);
  const micro = (2n * num + den) / (2n * den);
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`price too large: ${text}`);
  return Number(micro);
}

/** Median of integers; even count takes the mean of the two middle values, rounded down. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : Math.floor((s[mid - 1]! + s[mid]!) / 2);
}

export function compareOffers(a: Offer, b: Offer): number {
  return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.price - b.price;
}

/** Vast offer skus are `<host_id>/<offer_id>`; each host gets one price, its median. */
export function vastHostPrices(offers: readonly Offer[]): number[] {
  const byHost = new Map<string, number[]>();
  for (const o of offers) {
    const host = o.sku.split("/")[0]!;
    byHost.set(host, [...(byHost.get(host) ?? []), o.price]);
  }
  return [...byHost.values()].map(median);
}

/** A provider's value: the median of its offers (for vast, the median of host medians). */
export function providerValue(source: string, offers: readonly Offer[]): number {
  return median(source === "vast" ? vastHostPrices(offers) : offers.map((o) => o.price));
}

export function usd(micro: number): string {
  return (micro / 1e6).toFixed(6).replace(/(\.\d\d\d*?)0+$/, "$1");
}

/** Applies the provider rules to qualifying offers: an exclusion reason, or the value. */
export function assess(source: string, offers: readonly Offer[]): { reason: string } | { value: number } {
  if (offers.length === 0) return { reason: "no qualifying offer" };
  if (source === "vast") {
    const hosts = vastHostPrices(offers).length;
    if (hosts < MIN_VAST_HOSTS) return { reason: `too few hosts (${hosts})` };
  }
  const value = providerValue(source, offers);
  if (value < MIN_VALUE || value > MAX_VALUE) return { reason: `value ${usd(value)} outside 0.20 to 50.00 USD` };
  return { value };
}

/** The index rule: median of included provider values, given enough providers and rate cards. */
export function computeIndex(providers: readonly Provider[]): { index: number | null; reason?: string } {
  const inc = providers.filter((p) => p.status === "included");
  const rateCards = inc.filter((p) => p.kind === "rate-card").length;
  if (inc.length < MIN_PROVIDERS) return { index: null, reason: `${inc.length} providers included, need ${MIN_PROVIDERS}` };
  if (rateCards < MIN_RATE_CARD) return { index: null, reason: `${rateCards} rate-card providers included, need ${MIN_RATE_CARD}` };
  return { index: median(inc.map((p) => p.value!)) };
}

/** Turns one source's outcome into provider entries. Deterministic in its inputs. */
export function providersFrom(o: Outcome): Provider[] {
  const { source } = o;
  const base = { kind: source.kind, source: source.id, url: source.url, raw_sha256: o.raw_sha256 };
  let drafts: Draft[];
  try {
    if (o.body === null) throw new Error(o.error ?? "no response");
    drafts = source.parse(JSON.parse(o.body));
  } catch (e) {
    const reason = o.body === null ? `fetch failed: ${o.error ?? "no response"}` : `unreadable response: ${(e as Error).message}`;
    return [{ id: source.id, ...base, status: "excluded", reason, offers: [] }];
  }
  if (drafts.length === 0) drafts = [{ id: source.id, offers: [] }];
  return drafts.map((d) => {
    const offers = [...d.offers].sort(compareOffers);
    const note = d.note === undefined ? {} : { note: d.note };
    const direct = source.aggregator ? SAME_COMPANY[d.id.toLowerCase().replace(/[^a-z]/g, "")] : undefined;
    if (direct !== undefined) {
      return { id: `${source.id}:${d.id}`, ...base, status: "excluded", reason: `duplicate of ${direct}`, offers, ...note };
    }
    const a = assess(source.id, offers);
    return "value" in a
      ? { id: d.id, ...base, status: "included", value: a.value, offers, ...note }
      : { id: d.id, ...base, status: "excluded", reason: a.reason, offers, ...note };
  });
}

/** Builds the bundle for one bucket from every source's outcome. */
export function makeBundle(bucket: number, fetched_at: number, outcomes: readonly Outcome[]): Bundle {
  const providers = outcomes.flatMap(providersFrom).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set(providers.map((p) => p.id));
  if (ids.size !== providers.length) throw new Error("two providers share an id");
  const { index, reason } = computeIndex(providers);
  return { method: METHOD_ID, bucket, fetched_at, providers, index, ...(reason === undefined ? {} : { reason }) };
}
