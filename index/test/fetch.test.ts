// The fetcher with a fake fetch: request counts, sharing of bodies across chips, retries and
// the timeout. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHIPS } from "../src/chips.ts";
import { fetchAll, fetchChips, requestKey, USER_AGENT, type FetchFn } from "../src/fetch.ts";
import { makeBundle } from "../src/method.ts";
import { SOURCES, sourcesFor } from "../src/sources/mod.ts";
import { v2Text } from "./fixtures.ts";

const ALL = Object.values(CHIPS);

/** Serves the second day's bodies by request (Vast by chip, from the query's names); counts calls. */
function counting(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const src = ALL.flatMap(sourcesFor).find((s) => s.url === url && (s.body ?? "") === (init.body ?? ""));
    if (!src || status !== 200) return new Response("unavailable", { status: src ? status : 404 });
    const chip = src.id === "vast" ? ALL.find((c) => sourcesFor(c)[0]!.body === init.body) : undefined;
    return new Response(v2Text(src.id, chip), { status: 200 });
  };
  return { fn, calls };
}

test("one chip makes 6 requests; three chips make 8, not 18", async () => {
  const one = counting();
  await fetchChips([CHIPS.h100], { fetch: one.fn });
  assert.equal(one.calls.length, 6);
  const three = counting();
  const runs = await fetchChips(ALL, { fetch: three.fn });
  // vast x3 (one query per chip) + runpod, akash, lium, verda, shadeform once each.
  assert.equal(three.calls.length, 8);
  assert.deepEqual(three.calls.filter((c) => c.url.includes("vast.ai")).length, 3);
  assert.equal(new Set(ALL.flatMap(sourcesFor).map(requestKey)).size, 8);
  // Shared sources hand every chip the same body; each chip still gets its own bundle.
  const sha = (i: number, id: string) => runs[i]!.outcomes.find((o) => o.source.id === id)!.raw_sha256;
  assert.equal(sha(0, "shadeform"), sha(2, "shadeform"));
  assert.notEqual(sha(0, "vast"), sha(1, "vast"));
  const idx = runs.map(({ chip, outcomes }) => makeBundle(0, 0, outcomes, chip).index);
  assert.deepEqual(idx, [2_900_000, 4_250_000, 1_590_000]);
});

test("fetchAll keeps its old call shape and sends the User-Agent", async () => {
  const c = counting();
  const out = await fetchAll(SOURCES, { fetch: c.fn });
  assert.equal(out.length, 6);
  assert.ok(out.every((o) => o.body !== null && o.bytes !== null));
  const headers = c.calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["User-Agent"], USER_AGENT);
  assert.equal(c.calls.find((x) => x.url.includes("runpod"))!.init.method, "POST");
});

test("retries and the retry delay are options; a failure is an outcome, not a throw", async () => {
  const c = counting(503);
  const out = await fetchAll(SOURCES, { fetch: c.fn, retryDelayMs: 0 });
  assert.equal(c.calls.length, 12); // default: one retry
  assert.ok(out.every((o) => o.body === null && o.error === "HTTP 503"));
  const once = counting(503);
  await fetchAll(SOURCES, { fetch: once.fn, retries: 0 });
  assert.equal(once.calls.length, 6);
});

test("the timeout is an option, applied per attempt", async () => {
  // AbortSignal.timeout does not keep the process alive, so the fake holds a timer until aborted.
  const hang: FetchFn = (_url, init) => new Promise((_, reject) => {
    const keep = setTimeout(() => reject(new Error("never aborted")), 5_000);
    init.signal!.addEventListener("abort", () => (clearTimeout(keep), reject(init.signal!.reason)));
  });
  const [o] = await fetchAll(SOURCES.slice(0, 1), { fetch: hang, timeoutMs: 20, retries: 0 });
  assert.equal(o!.error, "timed out after 0.02 s");
});
