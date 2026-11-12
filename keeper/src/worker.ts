// Cloudflare Worker: a thin front for the keeper's Durable Object (durable.ts), which holds the
// store and runs the tick on its own alarm. The Worker's handlers do almost no work of their
// own, so they stay far under the free plan's 10 ms of CPU:
//   scheduled  the cron watchdog: asks the object to arm its alarm if none is armed;
//   fetch      the public GET routes, passed to the object; bundles and /latest.json go
//              through the Cache API first, so repeated reads need not wake the object.
// Binding: `KEEPER_OBJECT` (the Durable Object namespace, class `KeeperObject`).
// Secrets: `REPORTERS`, `AGENTS`, `SWARM_SECRET`, optional `KEEPER`. Variable: `BUDGET`.
import { ENSURE_PATH, KeeperObject, OBJECT_NAME, type KeeperVars } from "./durable.ts";
import { answerWithoutStore } from "./routes.ts";

export { KeeperObject };

/** What the Worker uses of a Durable Object namespace binding and its stub. */
export interface ObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface Env extends KeeperVars {
  KEEPER_OBJECT: ObjectNamespace;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

/** What the Worker uses of `caches.default`. Absent outside Cloudflare (Node tests can install one). */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

const defaultCache = (): CacheLike | null => (globalThis as { caches?: { default?: CacheLike } }).caches?.default ?? null;

const keeper = (env: Env) => env.KEEPER_OBJECT.get(env.KEEPER_OBJECT.idFromName(OBJECT_NAME));

/** Responses that may be cached at Cloudflare's edge: content-addressed bundles (immutable) and
 * /latest.json (30 s), as their own Cache-Control headers say. /status and /health are not. */
const cacheable = (request: Request): boolean => {
  if (request.method.toUpperCase() !== "GET") return false;
  const path = new URL(request.url).pathname;
  return path.startsWith("/bundles/") || path === "/latest.json";
};

const worker = {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const res = await keeper(env).fetch(new Request(`https://keeper.internal${ENSURE_PATH}`, { method: "POST" }));
    if (!res.ok) console.error(`watchdog: the keeper object answered ${res.status}`);
    else await res.body?.cancel();
  },

  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    // OPTIONS, other methods and unknown paths (the watchdog's path among them) never reach the object.
    const early = answerWithoutStore(request);
    if (early) return early;
    const cache = cacheable(request) ? defaultCache() : null;
    if (cache) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    const res = await keeper(env).fetch(request);
    if (cache && res.status === 200) {
      const put = cache.put(request, res.clone());
      if (ctx) ctx.waitUntil(put);
      else await put;
    }
    return res;
  },
};

export default worker;
