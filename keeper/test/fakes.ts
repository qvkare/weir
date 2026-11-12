// Fakes for the Durable Object's runtime: `ctx.storage.sql` on node:sqlite (real SQL, so the
// store's statements are checked by SQLite itself), the alarm API, a namespace binding and
// `caches.default`.
import { DatabaseSync } from "node:sqlite";
import { KeeperObject, type ObjectOptions, type ObjectStorage } from "../src/durable.ts";
import type { SqlCursor, SqlStorage } from "../src/sqlstore.ts";
import type { CacheLike, Env, ObjectNamespace } from "../src/worker.ts";

/** `exec` on an in-memory SQLite database. Rows read is the number of rows returned, rows
 * written the number changed: close to, not the same as, what Cloudflare meters. */
export function fakeSql(): SqlStorage & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec(query, ...bindings): SqlCursor {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = stmt.all(...bindings) as Record<string, unknown>[];
        return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
      }
      const r = stmt.run(...bindings);
      return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) };
    },
  };
}

/** The object's storage: SQL plus one alarm. `fire` runs the armed alarm the way the runtime
 * does: the alarm is cleared when its handler starts. */
export class FakeStorage implements ObjectStorage {
  readonly sql = fakeSql();
  alarm: number | null = null;
  setAlarmCalls = 0;
  /** Makes the next `setAlarm` throw. */
  failNextSetAlarm = false;

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(t: number): Promise<void> {
    this.setAlarmCalls++;
    if (this.failNextSetAlarm) {
      this.failNextSetAlarm = false;
      throw new Error("storage unavailable");
    }
    this.alarm = t;
  }
}

/** A clock in milliseconds that tests move by hand. */
export class Clock {
  ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
  readonly now = (): number => this.ms;
}

/** One object on fake storage, and `fire()`, which runs its alarm as the runtime would. */
export function fakeObject(vars: Record<string, string | undefined>, opts: ObjectOptions & { clock: Clock }) {
  const storage = new FakeStorage();
  const object = new KeeperObject({ storage }, vars, { ...opts, nowMs: opts.clock.now });
  const fire = async () => {
    storage.alarm = null;
    await object.alarm();
  };
  return { storage, object, fire };
}

/** A namespace binding with one object behind it. Records every name asked for and every request. */
export function fakeNamespace(object: KeeperObject): ObjectNamespace & { names: string[]; requests: string[] } {
  const names: string[] = [];
  const requests: string[] = [];
  return {
    names,
    requests,
    idFromName(name) {
      names.push(name);
      return `id:${name}`;
    },
    get() {
      return {
        fetch: async (request: Request) => {
          requests.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
          return object.fetch(request);
        },
      };
    },
  };
}

export const workerEnv = (object: KeeperObject, vars: Record<string, string> = {}) => {
  const ns = fakeNamespace(object);
  return { env: { ...vars, KEEPER_OBJECT: ns } as Env, ns };
};

/** `caches.default`, keyed by URL, keeping what `put` was given. */
export class FakeCache implements CacheLike {
  readonly map = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    return this.map.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    this.map.set(request.url, response);
  }
}

/** Installs a FakeCache as `caches.default` for the duration of `fn`. */
export async function withCache<T>(fn: (cache: FakeCache) => Promise<T>): Promise<T> {
  const g = globalThis as { caches?: unknown };
  const before = g.caches;
  const cache = new FakeCache();
  g.caches = { default: cache };
  try {
    return await fn(cache);
  } finally {
    g.caches = before;
  }
}
