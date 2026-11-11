// A small per-isolate cache of finished reads. Fresh entries are served for `ttlMs`; after a
// failed read the last good value is returned with its time, so a page can say "Figures are
// from 14:02 UTC" instead of going blank. Values, not promises, are stored: on a Worker a
// promise belongs to the request that made it.

export type Read<T> =
  | { ok: true; value: T; at: number }
  | { ok: false; error: string; lastGood: { value: T; at: number } | null };

export interface ReadCache {
  read<T>(key: string, load: () => Promise<T>): Promise<Read<T>>;
}

export function readCache(ttlMs: number, maxEntries = 500, now: () => number = Date.now): ReadCache {
  const entries = new Map<string, { value: unknown; at: number }>();
  return {
    async read<T>(key: string, load: () => Promise<T>): Promise<Read<T>> {
      const hit = entries.get(key) as { value: T; at: number } | undefined;
      if (hit && now() - hit.at < ttlMs) return { ok: true, value: hit.value, at: hit.at };
      try {
        const value = await load();
        const at = now();
        entries.delete(key);
        entries.set(key, { value, at });
        if (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
        return { ok: true, value, at };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), lastGood: hit ?? null };
      }
    },
  };
}

/** The value of a read, the last good one after a failure, or null. */
export const valueOf = <T>(r: Read<T> | null | undefined): T | null => (!r ? null : r.ok ? r.value : (r.lastGood?.value ?? null));
