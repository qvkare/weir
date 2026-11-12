// The keeper store inside a SQLite-backed Durable Object: one table, `kv`, with the time each
// value was written, so old bundles and orders can be dropped by a range delete (retention).
// Depends only on the `exec` method of the object's `ctx.storage.sql`; tests pass node:sqlite.
import type { KeeperStore } from "./store.ts";

/** What this store uses of a Durable Object's `ctx.storage.sql` (Cloudflare's `SqlStorage`). */
export interface SqlStorage {
  exec(query: string, ...bindings: (string | number | null)[]): SqlCursor;
}

export interface SqlCursor {
  toArray(): Record<string, unknown>[];
  /** Rows read and written so far by this statement, as Cloudflare meters them. */
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/** Key prefixes that only grow: one bundle per chip every five minutes, one order per commit. */
export const RETAINED_PREFIXES = ["bundles/", "orders/"] as const;

/** The upper end of a prefix range: the prefix with its last character raised by one, so
 * `key >= prefix AND key < end(prefix)` selects the prefix on the primary key, without a scan. */
const end = (prefix: string): string => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

export class SqlStore implements KeeperStore {
  readonly #sql: SqlStorage;
  readonly #clock: () => number;
  /** Rows read and written through this store since it was made (as the cursors report them). */
  rowsRead = 0;
  rowsWritten = 0;

  /** `clock` gives seconds; each value is stamped with it when written. */
  constructor(sql: SqlStorage, clock: () => number = () => Date.now() / 1000) {
    this.#sql = sql;
    this.#clock = clock;
    // WITHOUT ROWID: the key is the table's own index, so a write is one row, not a row and an index entry.
    this.#run("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID");
  }

  #run(query: string, ...bindings: (string | number | null)[]): Record<string, unknown>[] {
    const cursor = this.#sql.exec(query, ...bindings);
    const rows = cursor.toArray();
    this.rowsRead += cursor.rowsRead;
    this.rowsWritten += cursor.rowsWritten;
    return rows;
  }

  async get(key: string): Promise<string | null> {
    const row = this.#run("SELECT value FROM kv WHERE key = ?", key)[0];
    return row === undefined ? null : String(row.value);
  }

  async put(key: string, value: string): Promise<void> {
    this.#run(
      "INSERT INTO kv (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at",
      key,
      value,
      Math.floor(this.#clock()),
    );
  }

  async delete(key: string): Promise<void> {
    this.#run("DELETE FROM kv WHERE key = ?", key);
  }

  /** Deletes values under `RETAINED_PREFIXES` written before `before` (seconds), except the
   * keys in `keep`. Returns how many were deleted. */
  retain(before: number, keep: readonly string[] = []): number {
    let deleted = 0;
    for (const prefix of RETAINED_PREFIXES) {
      const old = this.#run("SELECT key FROM kv WHERE key >= ? AND key < ? AND at < ?", prefix, end(prefix), Math.floor(before))
        .map((r) => String(r.key))
        .filter((k) => !keep.includes(k));
      for (const key of old) {
        this.#run("DELETE FROM kv WHERE key = ?", key);
        deleted++;
      }
    }
    return deleted;
  }

  /** Every key with its value's size in bytes (UTF-16 length) and write time: for checks and for an export. */
  sizes(): { key: string; bytes: number; at: number }[] {
    return this.#run("SELECT key, length(value) AS bytes, at FROM kv ORDER BY key").map((r) => ({ key: String(r.key), bytes: Number(r.bytes), at: Number(r.at) }));
  }
}
