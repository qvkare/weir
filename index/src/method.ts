// The method: prices in micro-USD, medians, provider rules, the placeholder rule and the index
// rule. Pure functions only, so the same code runs in the CLI, the tests and a browser.
import { CHIPS, type Chip } from "./chips.ts";

/** The current method: any chip of `CHIPS`, one bundle per chip. */
export const METHOD_ID = "weir-gpu-od/2";
/** The first method, H100 only. Bundles made under it stay verifiable under it. */
export const METHOD_V1 = "weir-h100-od/1";
export const MIN_VALUE = 200_000; // 0.20 USD per GPU-hour
export const MAX_VALUE = 50_000_000; // 50.00 USD per GPU-hour
export const MIN_PROVIDERS = 6;
export const MIN_RATE_CARD = 3;
export const MIN_VAST_HOSTS = 3;
/** Version 2: an offer below 1/PLACEHOLDER_DIVISOR (25 %) of the bundle's median offer is a placeholder. */
export const PLACEHOLDER_DIVISOR = 4;
/** sha256 of the empty string: the raw_sha256 of a failed fetch. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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

/** An offer the placeholder rule set aside; it stays in the bundle but not in the value. */
export interface Dropped extends Offer {
  reason: string;
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
  /** Version 2 only, present when not empty. */
  dropped?: Dropped[];
  raw_sha256: string;
  note?: string;
}

export interface Bundle {
  method: string;
  /** Version 2: the chip id (`CHIPS`) and its index name. Absent in version 1, which is H100. */
  chip?: string;
  index_name?: string;
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

/**
 * What one provider's entry depends on beyond its own offers. Both parts are recomputable
 * from the bundle alone (see `contextOf`), which is what lets a verifier check them.
 */
export interface Context {
  version: 1 | 2;
  /** Version 2: the median of every offer parsed for the chip, across all providers. */
  reference: number | null;
  /** Version 2: sources whose response could not be used (fetch failed, unreadable). */
  failedDirect: ReadonlySet<string>;
}

const NO_CONTEXT: Context = { version: 2, reference: null, failedDirect: new Set() };

/** True for the reasons a provider gets when its source gave no usable response. */
export const isFailure = (reason: string | undefined): boolean =>
  reason !== undefined && (reason.startsWith("fetch failed: ") || reason.startsWith("unreadable response: "));

export const placeholderReason = (reference: number): string =>
  `placeholder: below 25% of the median offer ${usd(reference)} USD`;

/** Version 2: splits offers into the kept ones and the placeholders (price * 4 < reference). */
export function splitPlaceholders(offers: readonly Offer[], reference: number | null): { offers: Offer[]; dropped: Dropped[] } {
  if (reference === null) return { offers: [...offers], dropped: [] };
  const reason = placeholderReason(reference);
  return {
    offers: offers.filter((o) => o.price * PLACEHOLDER_DIVISOR >= reference),
    dropped: offers.filter((o) => o.price * PLACEHOLDER_DIVISOR < reference).map((o) => ({ ...o, reason })),
  };
}

type Base = Pick<Provider, "kind" | "source" | "url" | "raw_sha256">;

/**
 * One provider's entry from its parsed offers (kept and dropped together), under the
 * context's version. An aggregator's row for a company that is also a direct source is a
 * duplicate, except in version 2 when that direct source failed: then it stands in for it.
 */
export function providerEntry(source: Pick<Source, "id" | "aggregator">, draft: Draft, base: Base, ctx: Context = NO_CONTEXT): Provider {
  const split = splitPlaceholders([...draft.offers].sort(compareOffers), ctx.version === 2 ? ctx.reference : null);
  const offers = split.offers;
  const dropped = split.dropped.length > 0 ? { dropped: split.dropped } : {};
  const direct = source.aggregator ? SAME_COMPANY[draft.id.toLowerCase().replace(/[^a-z]/g, "")] : undefined;
  const id = direct === undefined ? draft.id : `${source.id}:${draft.id}`;
  let note = draft.note;
  if (direct !== undefined) {
    if (ctx.version === 1 || !ctx.failedDirect.has(direct)) {
      return { id, ...base, status: "excluded", reason: `duplicate of ${direct}`, offers, ...dropped, ...(note === undefined ? {} : { note }) };
    }
    note = [note, `stands in for ${direct}, whose direct response could not be used`].filter(Boolean).join("; ");
  }
  const a = assess(source.id, offers);
  const n = note === undefined ? {} : { note };
  return "value" in a
    ? { id, ...base, status: "included", value: a.value, offers, ...dropped, ...n }
    : { id, ...base, status: "excluded", reason: a.reason, offers, ...dropped, ...n };
}

/** Parses one outcome into drafts, or the reason it could not be used. */
export function parseOutcome(o: Outcome): { drafts: Draft[] } | { reason: string } {
  try {
    if (o.body === null) throw new Error(o.error ?? "no response");
    const drafts = o.source.parse(JSON.parse(o.body));
    return { drafts: drafts.length === 0 ? [{ id: o.source.id, offers: [] }] : drafts };
  } catch (e) {
    return { reason: o.body === null ? `fetch failed: ${o.error ?? "no response"}` : `unreadable response: ${(e as Error).message}` };
  }
}

const baseOf = (o: Outcome): Base => ({ kind: o.source.kind, source: o.source.id, url: o.source.url, raw_sha256: o.raw_sha256 });
const byId = (a: Provider, b: Provider): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Turns one source's outcome into provider entries. Deterministic in its inputs. */
export function providersFrom(o: Outcome, ctx: Context = NO_CONTEXT): Provider[] {
  const parsed = parseOutcome(o);
  const base = baseOf(o);
  if ("reason" in parsed) return [{ id: o.source.id, ...base, status: "excluded", reason: parsed.reason, offers: [] }];
  return parsed.drafts.map((d) => providerEntry(o.source, d, base, ctx));
}

/**
 * The context of a finished bundle: the median of every offer it holds (kept and dropped),
 * and the direct providers that failed. Equal to the context `makeBundle` used.
 */
export function contextOf(bundle: Bundle): Context {
  const all = bundle.providers.flatMap((p) => [...p.offers, ...(p.dropped ?? [])].map((o) => o.price));
  return {
    version: bundle.method === METHOD_V1 ? 1 : 2,
    reference: all.length > 0 ? median(all) : null,
    failedDirect: new Set(bundle.providers.filter((p) => p.id === p.source && isFailure(p.reason)).map((p) => p.id)),
  };
}

/** Builds the version-2 bundle of one chip for one bucket from every source's outcome. */
export function makeBundle(bucket: number, fetched_at: number, outcomes: readonly Outcome[], chip: Chip = CHIPS.h100): Bundle {
  const parsed = outcomes.map((o) => ({ o, p: parseOutcome(o) }));
  const all = parsed.flatMap(({ p }) => ("drafts" in p ? p.drafts.flatMap((d) => d.offers.map((x) => x.price)) : []));
  const ctx: Context = {
    version: 2,
    reference: all.length > 0 ? median(all) : null,
    failedDirect: new Set(parsed.filter(({ p }) => "reason" in p).map(({ o }) => o.source.id)),
  };
  const providers = parsed
    .flatMap(({ o, p }) =>
      "reason" in p
        ? [{ id: o.source.id, ...baseOf(o), status: "excluded" as const, reason: p.reason, offers: [] }]
        : p.drafts.map((d) => providerEntry(o.source, d, baseOf(o), ctx)),
    )
    .sort(byId);
  const ids = new Set(providers.map((p) => p.id));
  if (ids.size !== providers.length) throw new Error("two providers share an id");
  const { index, reason } = computeIndex(providers);
  return {
    method: METHOD_ID,
    chip: chip.id,
    index_name: chip.index_name,
    bucket,
    fetched_at,
    providers,
    index,
    ...(reason === undefined ? {} : { reason }),
  };
}
