// The keeper as one SQLite-backed Durable Object: its storage is the keeper store, and its
// alarm runs `runTick` once a minute. The Worker in front of it (worker.ts) only passes calls on.
//
// The minute. Each alarm first arms the next one, for the start of the next minute, and then
// runs the minute it woke in. So a tick that throws or stalls still leaves the next minute
// armed, and a late alarm runs the current minute once, not the minutes it missed (the Node
// loop's rule). Cloudflare runs at most one `alarm()` per object at a time; on top of that the
// object refuses a second tick while one runs, and records the minute each tick starts, so an
// alarm delivered twice (alarms are at-least-once) does not run the same minute twice.
//
// The watchdog. The Worker's cron trigger calls `ensure`, which arms an alarm only when none
// is armed (a fresh deploy, or a chain broken by a failed `setAlarm`).
//
// The lease is off: the store is private to this object, and the one object never runs two
// ticks at once, so the lease (write, wait 1 s, read back) would only cost a second and two
// rows written per tick.
import deployments from "../../deployments.json" with { type: "json" };
import { readSecrets, type Deployments } from "./config.ts";
import { readLatest } from "./indexer.ts";
import { DEFAULT_BUDGET, runTick, type KeeperEnv, type TickReport } from "./keeper.ts";
import type { Chain, Fetch } from "./ports.ts";
import { handle } from "./routes.ts";
import { SqlStore, type SqlStorage } from "./sqlstore.ts";
import { KEYS } from "./store.ts";

/** The one instance's name. */
export const OBJECT_NAME = "keeper";
/** The watchdog's path inside the object. The Worker never forwards it from outside. */
export const ENSURE_PATH = "/_internal/ensure";
/** An alarm firing up to this early still counts as the minute it was set for. */
export const EARLY_MS = 1000;
/** Bundles and sealed orders are kept 15 days: prints may be pruned two periods after their
 * bucket (two weeks on the weekly markets), plus a day. */
export const RETAIN_SECS = 15 * 86_400;
/** How often the retention rule runs. */
export const RETAIN_EVERY_SECS = 6 * 3600;
export const STARTED_KEY = "object/started";
export const RETAINED_KEY = "object/retained";

/** What the object uses of `ctx.storage`. */
export interface ObjectStorage {
  sql: SqlStorage;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface ObjectState {
  storage: ObjectStorage;
}

/** The Worker's secrets and variables, as the object sees them. */
export interface KeeperVars {
  REPORTERS?: string;
  AGENTS?: string;
  SWARM_SECRET?: string;
  /** Optional housekeeping account. */
  KEEPER?: string;
  BUDGET?: string;
}

/** For tests: the runtime passes only the state and the environment. */
export interface ObjectOptions {
  deployments?: Deployments;
  chain?: Chain;
  fetch?: Fetch;
  /** Wall clock in milliseconds. */
  nowMs?: () => number;
  /** Replaces `runTick`. */
  tick?: (env: KeeperEnv, now: number) => Promise<TickReport>;
}

export type MinuteOutcome = "ran" | "failed" | "running" | "done before";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class KeeperObject {
  readonly store: SqlStore;
  /** The last tick's report (tests read it). */
  last: TickReport | null = null;
  readonly #storage: ObjectStorage;
  readonly #vars: KeeperVars;
  readonly #opts: ObjectOptions;
  #running = false;

  constructor(state: ObjectState, env: KeeperVars, opts: ObjectOptions = {}) {
    this.#storage = state.storage;
    this.#vars = env;
    this.#opts = opts;
    this.store = new SqlStore(state.storage.sql, () => this.#nowMs() / 1000);
  }

  #nowMs(): number {
    return this.#opts.nowMs?.() ?? Date.now();
  }

  async alarm(): Promise<void> {
    const minute = Math.floor((this.#nowMs() + EARLY_MS) / 60_000) * 60;
    // Arm the next minute before anything else, so nothing the tick does can break the chain.
    try {
      await this.#storage.setAlarm((minute + 60) * 1000);
    } catch (e) {
      console.error(`could not arm the next minute: ${errorText(e)}; the cron watchdog will`);
    }
    await this.runMinute(minute);
  }

  /** The tick for `minute`, unless a tick is running or this minute has already started. Never throws. */
  async runMinute(minute: number): Promise<MinuteOutcome> {
    if (this.#running) {
      console.log(`tick ${iso(minute)} not started: the previous tick is still running`);
      return "running";
    }
    this.#running = true;
    try {
      const started = Number((await this.store.get(STARTED_KEY)) ?? "-1");
      if (started >= minute) return "done before";
      await this.store.put(STARTED_KEY, String(minute));
      const t0 = this.#nowMs();
      const rows = [this.store.rowsRead, this.store.rowsWritten];
      const report = await (this.#opts.tick ?? runTick)(this.#keeperEnv(), minute);
      this.last = report;
      await this.#retain(minute);
      console.log(summary(report, (this.#nowMs() - t0) / 1000, this.store.rowsRead - rows[0]!, this.store.rowsWritten - rows[1]!));
      return "ran";
    } catch (e) {
      console.error(`tick ${iso(minute)} failed: ${errorText(e)}`);
      return "failed";
    } finally {
      this.#running = false;
    }
  }

  /** The watchdog: arms the next minute when no alarm is armed. */
  async ensure(): Promise<{ armed: boolean; alarm: number }> {
    const at = await this.#storage.getAlarm();
    if (at !== null) return { armed: false, alarm: at };
    const next = (Math.floor(this.#nowMs() / 60_000) + 1) * 60_000;
    await this.#storage.setAlarm(next);
    return { armed: true, alarm: next };
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === ENSURE_PATH && request.method === "POST") {
      return new Response(JSON.stringify(await this.ensure()), { headers: { "content-type": "application/json" } });
    }
    return handle(request, this.store, this.#nowMs() / 1000);
  }

  #keeperEnv(): KeeperEnv {
    const v = this.#vars;
    return {
      deployments: this.#opts.deployments ?? (deployments as Deployments),
      store: this.store,
      secrets: readSecrets(v),
      fetch: this.#opts.fetch ?? ((url, init) => fetch(url, init)),
      ...(this.#opts.chain ? { chain: this.#opts.chain } : {}),
      budget: v.BUDGET ? Number(v.BUDGET) : DEFAULT_BUDGET,
      lease: false,
      wallNow: () => this.#nowMs() / 1000,
    };
  }

  /** Every RETAIN_EVERY_SECS: drops bundles and orders older than RETAIN_SECS, except each chip's latest bundle. */
  async #retain(now: number): Promise<void> {
    const last = Number((await this.store.get(RETAINED_KEY)) ?? "0");
    if (now - last < RETAIN_EVERY_SECS) return;
    const keep = Object.values(await readLatest(this.store)).map((l) => KEYS.bundle(l.hash));
    const deleted = this.store.retain(now - RETAIN_SECS, keep);
    await this.store.put(RETAINED_KEY, String(now));
    if (deleted > 0) console.log(`retention: deleted ${deleted} bundles and orders written before ${iso(now - RETAIN_SECS)}`);
  }
}

const iso = (secs: number): string => new Date(secs * 1000).toISOString();

function summary(r: TickReport, secs: number, rowsRead: number, rowsWritten: number): string {
  const done = r.entries.filter((e) => e.status === "done").length;
  const failed = r.entries.filter((e) => e.status === "failed").length;
  const lines = [
    `tick ${iso(r.now)}: ${r.budget.used}/${r.budget.limit} requests, ${done} done, ${failed} failed, ${r.txs.length} transactions, ${secs.toFixed(1)} s, ${rowsRead} rows read, ${rowsWritten} rows written`,
  ];
  const notable = r.entries.filter((e) => e.status !== "done" || e.action === "tx");
  for (const e of notable.slice(0, 20)) lines.push(`  ${e.market ?? "-"} ${e.step}/${e.action} ${e.status}: ${e.text}${e.tx ? ` [${e.tx}]` : ""}`);
  if (notable.length > 20) lines.push(`  ... ${notable.length - 20} more in /status`);
  for (const u of r.undone) lines.push(`  left undone: ${u}`);
  return lines.join("\n");
}
