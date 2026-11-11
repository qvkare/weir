// Node adapter: the same tick and the same routes, with the store in a local directory.
//
//   node --env-file=keeper/.env keeper/src/node.ts --once
//   node --env-file=keeper/.env keeper/src/node.ts --loop [--port 8787]
//
// Options: --store <dir> (default keeper/store), --deployments <file> (default the
// repository's deployments.json), --budget <n> (default 40), --port <n> (serve the GET routes).
import { mkdirSync, readFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readSecrets, type Deployments } from "./config.ts";
import { DEFAULT_BUDGET, runTick, type TickReport } from "./keeper.ts";
import { handle } from "./routes.ts";
import type { KeeperStore } from "./store.ts";

/** One file per key; writes go through a temporary file and a rename, so a reader never sees half a value. */
export class DirStore implements KeeperStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  #path(key: string): string {
    return join(this.dir, encodeURIComponent(key));
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.#path(key), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async put(key: string, value: string): Promise<void> {
    const tmp = `${this.#path(key)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, value);
    await rename(tmp, this.#path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}

function summary(r: TickReport): string {
  const done = r.entries.filter((e) => e.status === "done").length;
  const failed = r.entries.filter((e) => e.status === "failed");
  const lines = [`tick ${new Date(r.now * 1000).toISOString()}: ${r.budget.used}/${r.budget.limit} requests, ${done} done, ${failed.length} failed, ${r.txs.length} transactions`];
  for (const e of r.entries) if (e.status !== "done" || e.action === "tx") lines.push(`  ${e.market ?? "-"} ${e.step}/${e.action} ${e.status}: ${e.text}${e.tx ? ` [${e.tx}]` : ""}`);
  for (const u of r.undone) lines.push(`  left undone: ${u}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      once: { type: "boolean" },
      loop: { type: "boolean" },
      port: { type: "string" },
      store: { type: "string", default: new URL("../store/", import.meta.url).pathname },
      deployments: { type: "string", default: new URL("../../deployments.json", import.meta.url).pathname },
      budget: { type: "string", default: String(DEFAULT_BUDGET) },
    },
  });
  if (!values.once && !values.loop) {
    console.error("usage: node keeper/src/node.ts --once | --loop [--port 8787] [--store dir] [--deployments file] [--budget 40]");
    process.exitCode = 2;
    return;
  }
  const store = new DirStore(values.store);
  const deployments = JSON.parse(readFileSync(values.deployments, "utf8")) as Deployments;
  const { REPORTERS, AGENTS, SWARM_SECRET } = process.env;
  const secrets = readSecrets({ REPORTERS, AGENTS, SWARM_SECRET });
  const tickAt = (now: number) => runTick({ deployments, store, secrets, fetch: (url, init) => fetch(url, init), budget: Number(values.budget), leaseConfirmMs: 200 }, now);

  if (values.port) {
    const port = Number(values.port);
    createServer(async (req, res) => {
      const response = await handle(new Request(`http://localhost:${port}${req.url ?? "/"}`, { method: req.method ?? "GET" }), store);
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    }).listen(port, () => console.log(`serving GET routes on http://localhost:${port}`));
  }

  if (values.once) {
    console.log(summary(await tickAt(Math.floor(Date.now() / 1000))));
    if (!values.port) return;
  }
  if (values.loop) {
    // Ticks at the start of every minute, one at a time; a tick that runs long skips the minutes it overlaps.
    for (;;) {
      const now = Date.now();
      await new Promise((r) => setTimeout(r, 60_000 - (now % 60_000)));
      const minute = Math.floor(Date.now() / 60_000) * 60;
      try {
        console.log(summary(await tickAt(minute)));
      } catch (e) {
        console.error(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) await main();
