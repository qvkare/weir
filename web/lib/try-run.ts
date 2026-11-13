// The test bid's chain side, loaded by components/front/app/try-view.tsx with a dynamic import,
// so only that page's chunk carries the guest (key making, signing, the faucet). Browser only.
import { Guest, GuestError, readPlan, viewPort, type GuestConfig, type GuestDeps, type GuestEvent } from "@weir/chain/guest";
import { adviceFor, guestKey, guestStorage, type KV, type PlanView, type ViewError } from "./try-state.ts";

export { Guest };

export interface TryTarget {
  contractId: string;
  usdcId: string | null;
  /** The site's order (dRPC first); the guest sends transactions to fastnear first itself. */
  rpcUrls: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Bound, so the browser's fetch is called on window.
const fetchFn: GuestDeps["fetch"] = (url, init) => fetch(url, init);

export function guestConfig(t: TryTarget): GuestConfig {
  return { contractId: t.contractId, usdcId: t.usdcId ?? undefined, rpcUrls: t.rpcUrls, storageKey: guestKey(t.contractId) };
}

/** The stored guest (or a new one; nothing is created until `run`). */
export function openGuest(t: TryTarget, kv: KV, onEvent: (e: GuestEvent) => void): Promise<Guest> {
  const store = guestStorage(kv);
  const deps: GuestDeps = {
    fetch: fetchFn,
    now: Date.now,
    sleep,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    storage: { get: store.get, set: store.set },
    onEvent,
  };
  return Guest.load(guestConfig(t), deps);
}

// One port per market for the plan, so its reads stay at least 1 s apart however often they are asked for.
const ports = new Map<string, ReturnType<typeof viewPort>>();

/** Reads the market and the order the guest would place. Views only. */
export async function readTryPlan(t: TryTarget): Promise<PlanView> {
  let port = ports.get(t.contractId);
  if (!port) ports.set(t.contractId, (port = viewPort(guestConfig(t), { fetch: fetchFn, now: Date.now, sleep })));
  const plan = await readPlan(port);
  const p = plan.params;
  return {
    now: plan.now,
    readAt: Date.now(),
    status: plan.status,
    reason: plan.reason,
    series: plan.series,
    round: plan.round,
    phase: plan.phase,
    phaseEndsAt: plan.phaseEndsAt,
    floor: plan.floor,
    band: plan.band,
    tick: plan.tick,
    lastClearing: plan.lastClearing,
    order: plan.order,
    commitSecs: p.commit_secs,
    revealSecs: p.reveal_secs,
    t0: p.t0,
    periodSecs: p.period_secs,
    forfeitBps: p.forfeit_bps,
  };
}

/** Any failure as the view shows it: the guest's kind, its words, the contract's text and what to do. */
export function viewError(e: unknown): ViewError {
  if (e instanceof GuestError) return { kind: e.kind, message: e.message, refusal: e.refusal, advice: adviceFor(e.kind, e.step) };
  const message = e instanceof Error ? e.message : String(e);
  const rpc = /RPC|fetch|network|timed? ?out|did not answer|HTTP \d{3}|Failed to fetch/i.test(message);
  return { kind: rpc ? "rpc" : "unknown", message, refusal: null, advice: adviceFor(rpc ? "rpc" : "unknown", null) };
}
