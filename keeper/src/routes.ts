// The keeper's public read-only HTTP face, shared by the Worker and the Node loop:
// GET /bundles/<hash>.json, /latest.json, /status and /health, with permissive CORS.
// Nothing served here comes from the secrets; the stored log was redacted before it was saved.
import { chipById } from "@weir/index";
import { readLatest } from "./indexer.ts";
import type { StoredStatus } from "./keeper.ts";
import { KEYS, readJson, type KeeperStore } from "./store.ts";

/** /health answers 503 when the last tick is older than this. */
export const STALE_AFTER_SECS = 300;
/** Log entries /status shows. */
export const STATUS_LOG = 50;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function reply(status: number, body: string | null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...CORS, ...headers } });
}

const json = (status: number, value: unknown, cache = "no-store"): Response =>
  reply(status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8", "cache-control": cache });

const BUNDLE = /^\/bundles\/([0-9a-f]{64})\.json$/;

export async function handle(request: Request, store: KeeperStore, now: number = Date.now() / 1000): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return reply(204, null);
  if (method !== "GET" && method !== "HEAD") return reply(405, "only GET\n", { allow: "GET, HEAD, OPTIONS", "content-type": "text/plain" });
  const url = new URL(request.url);
  const res = await route(url.pathname, url.searchParams, store, now);
  return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

async function route(path: string, query: URLSearchParams, store: KeeperStore, now: number): Promise<Response> {
  const bundle = BUNDLE.exec(path);
  if (bundle) {
    const text = await store.get(KEYS.bundle(bundle[1]!));
    if (text === null) return json(404, { error: "no bundle with this hash" });
    // Content-addressed: the body's sha256 is its name, so it can be cached forever.
    return reply(200, text, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" });
  }
  if (path === "/latest.json") {
    const chip = query.get("chip") ?? "h100";
    if (!chipById(chip)) return json(404, { error: `unknown chip ${JSON.stringify(chip.slice(0, 32))}` });
    const latest = (await readLatest(store))[chip as keyof Awaited<ReturnType<typeof readLatest>>];
    const text = latest ? await store.get(KEYS.bundle(latest.hash)) : null;
    if (!latest || text === null) return json(404, { error: `no ${chip} bundle yet` });
    return reply(200, `{"chip":${JSON.stringify(chip)},"hash":${JSON.stringify(latest.hash)},"bundle":${text}}`, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30",
    });
  }
  if (path === "/status") {
    const status = await readJson<StoredStatus>(store, KEYS.status);
    if (!status) return json(200, { last_tick: null, note: "the keeper has not run yet" });
    const attempt = await store.get(KEYS.indexAttempt);
    return json(200, {
      last_tick: status.last_tick,
      age_secs: Math.max(0, Math.floor(now - status.last_tick)),
      operator_note: status.operator_note,
      // Configuration problems that held at the last tick, however much was logged after them.
      config: status.config ?? [],
      budget: status.budget,
      order: status.order,
      acting: status.acting,
      undone: status.undone,
      index: attempt ? JSON.parse(attempt) : null,
      markets: status.markets,
      key_faults: status.key_faults ?? [],
      rpc_cooling: status.rpc_cooling ?? [],
      log: status.log.slice(-STATUS_LOG),
    });
  }
  if (path === "/health") {
    const status = await readJson<StoredStatus>(store, KEYS.status);
    const age = status ? Math.max(0, Math.floor(now - status.last_tick)) : null;
    const ok = age !== null && age <= STALE_AFTER_SECS;
    return json(ok ? 200 : 503, { ok, last_tick: status?.last_tick ?? null, age_secs: age });
  }
  return json(404, { error: "not found" });
}
