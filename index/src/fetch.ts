// The only module that does HTTP. Identical requests are made once per call, so sources that
// return every model in one response are fetched once however many chips are priced.
import { sha256Hex } from "./bundle.ts";
import type { Chip } from "./chips.ts";
import { EMPTY_SHA256, type Outcome, type Source } from "./method.ts";
import { sourcesFor } from "./sources/mod.ts";

export const USER_AGENT = "weir-index/0.2 (GPU on-demand price index; public keyless endpoints)";
export const TIMEOUT_MS = 15_000;
export const RETRY_DELAY_MS = 2_000;

/** Any function shaped like the global `fetch` (a meter, a fake, a scheduler, a proxy). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchOptions {
  /** Defaults to the global `fetch`. Called once per attempt. */
  fetch?: FetchFn;
  /** Per attempt; default 15 000 ms. */
  timeoutMs?: number;
  /** Pause before a retry; default 2 000 ms. */
  retryDelayMs?: number;
  /** Retries after a failed attempt; default 1. */
  retries?: number;
}

export interface Fetched extends Outcome {
  bytes: Uint8Array | null;
}

/** Two sources with the same key are the same HTTP request. */
export const requestKey = (s: Pick<Source, "method" | "url" | "body">): string => `${s.method} ${s.url}\n${s.body ?? ""}`;

/** The HTTP request a source makes (method, headers, body), without the abort signal. */
export function requestInit(source: Pick<Source, "method" | "body">): RequestInit {
  return {
    method: source.method,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(source.body ? { "Content-Type": "application/json" } : {}) },
    ...(source.body ? { body: source.body } : {}),
  };
}

type Body = { bytes: Uint8Array; raw_sha256: string } | { error: string };

async function request(source: Source, o: FetchOptions): Promise<Body> {
  const fetchFn: FetchFn = o.fetch ?? ((url, init) => fetch(url, init));
  const timeout = o.timeoutMs ?? TIMEOUT_MS;
  const retries = o.retries ?? 1;
  let error = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, o.retryDelayMs ?? RETRY_DELAY_MS));
    try {
      const res = await fetchFn(source.url, { ...requestInit(source), signal: AbortSignal.timeout(timeout) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { bytes, raw_sha256: await sha256Hex(bytes) };
    } catch (e) {
      const err = e as Error;
      error = err.name === "TimeoutError" ? `timed out after ${timeout / 1000} s` : err.message;
    }
  }
  return { error };
}

function outcome(source: Source, b: Body): Fetched {
  return "error" in b
    ? { source, bytes: null, body: null, raw_sha256: EMPTY_SHA256, error: b.error }
    : { source, bytes: b.bytes, body: new TextDecoder().decode(b.bytes), raw_sha256: b.raw_sha256 };
}

/** Fetches one source, retrying as configured. Never throws. */
export async function fetchSource(source: Source, options: FetchOptions = {}): Promise<Fetched> {
  return outcome(source, await request(source, options));
}

/**
 * Fetches the given sources in parallel, making each distinct request (`requestKey`) once;
 * sources that share a request share its body. Never throws; a failure is an outcome.
 */
export async function fetchAll(sources: readonly Source[], options: FetchOptions = {}): Promise<Fetched[]> {
  const pending = new Map<string, Promise<Body>>();
  for (const s of sources) if (!pending.has(requestKey(s))) pending.set(requestKey(s), request(s, options));
  return Promise.all(sources.map(async (s) => outcome(s, await pending.get(requestKey(s))!)));
}

/** One run for several chips: every chip's sources, each distinct request made once. */
export async function fetchChips(chips: readonly Chip[], options: FetchOptions = {}): Promise<{ chip: Chip; outcomes: Fetched[] }[]> {
  const sets = chips.map((chip) => ({ chip, sources: sourcesFor(chip) }));
  const all = await fetchAll(sets.flatMap((s) => s.sources), options);
  let i = 0;
  return sets.map(({ chip, sources }) => ({ chip, outcomes: all.slice(i, (i += sources.length)) }));
}
