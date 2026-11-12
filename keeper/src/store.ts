// The keeper's only state: a string key-value store. The Durable Object keeps it in a SQL
// table (sqlstore.ts); the Node loop uses a directory; tests use memory.
import type { OrderStore } from "@weir/agents";

export interface KeeperStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryStore implements KeeperStore {
  readonly map = new Map<string, string>();
  /** Writes and deletes so far, to measure how hard a store is used. */
  writes = 0;

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.writes++;
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.writes++;
    this.map.delete(key);
  }
}

export const KEYS = {
  status: "status",
  latest: "latest",
  indexAttempt: "index/attempt",
  lease: "lease",
  keyFaults: "key-faults",
  bundle: (hash: string) => `bundles/${hash}.json`,
  params: (contract: string) => `params/${contract}`,
  marks: (contract: string) => `marks/${contract}`,
  costs: (contract: string) => `costs/${contract}`,
  order: (key: string) => `orders/${key}`,
} as const;

/** The swarm's order store inside the keeper store. */
export const orderStore = (store: KeeperStore): OrderStore => ({
  get: (key) => store.get(KEYS.order(key)),
  put: (key, value) => store.put(KEYS.order(key), value),
});

export async function readJson<T>(store: KeeperStore, key: string): Promise<T | null> {
  const text = await store.get(key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Lease {
  owner: string;
  until: number;
}

/**
 * Takes the keeper's lease, or returns the lease another run holds. Write, wait, read back:
 * of several runs that write within `confirmMs` of each other, only the last writer keeps it.
 * On a store without atomic writes (Cloudflare KV is eventually consistent) this is best
 * effort; the contract itself still refuses a second report or a second reveal.
 */
export async function takeLease(store: KeeperStore, owner: string, now: number, ttl: number, confirmMs: number): Promise<Lease | null> {
  const held = await readJson<Lease>(store, KEYS.lease);
  if (held && held.owner !== owner && held.until > now) return held;
  await store.put(KEYS.lease, JSON.stringify({ owner, until: now + ttl }));
  if (confirmMs > 0) await sleep(confirmMs);
  const after = await readJson<Lease>(store, KEYS.lease);
  return after && after.owner !== owner ? after : null;
}

/** Extends this run's lease. False when another run has taken it meanwhile. The lease is
 * never released: it expires on its own before the next minute's run, which saves a write. */
export async function renewLease(store: KeeperStore, owner: string, now: number, ttl: number): Promise<boolean> {
  const held = await readJson<Lease>(store, KEYS.lease);
  if (held && held.owner !== owner && held.until > now) return false;
  await store.put(KEYS.lease, JSON.stringify({ owner, until: now + ttl }));
  return true;
}
