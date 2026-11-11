// Cloudflare Worker adapter: the cron trigger runs one tick, and `fetch` serves the GET routes.
// Bindings: `STORE` (a KV namespace). Secrets: `REPORTERS`, `AGENTS`, `SWARM_SECRET`.
// Optional variable: `BUDGET` (outbound requests per tick, default 40).
import deployments from "../../deployments.json" with { type: "json" };
import type { Deployments } from "./config.ts";
import { readSecrets } from "./config.ts";
import { DEFAULT_BUDGET, runTick } from "./keeper.ts";
import { handle } from "./routes.ts";
import type { KeeperStore } from "./store.ts";

export interface Env {
  STORE: KeeperStore;
  REPORTERS?: string;
  AGENTS?: string;
  SWARM_SECRET?: string;
  BUDGET?: string;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** One tick, as the cron trigger runs it. Exported for tests. */
export function tickOnce(env: Env, now: number, extra: { deployments?: Deployments } = {}) {
  return runTick(
    {
      deployments: extra.deployments ?? (deployments as Deployments),
      store: env.STORE,
      secrets: readSecrets(env),
      fetch: (url, init) => fetch(url, init),
      budget: env.BUDGET ? Number(env.BUDGET) : DEFAULT_BUDGET,
    },
    now,
  );
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tickOnce(env, Math.floor(controller.scheduledTime / 1000)));
  },

  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env.STORE);
  },
};
