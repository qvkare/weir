/**
 * Smoke test: builds the site, starts it in model mode on a free port, requests every page and
 * API route, and checks status, key text and that no page shows NaN, undefined, a $0.00
 * placeholder or TODO. Then starts it again with no model and checks the "not deployed" states
 * (deployments.json has no markets when this runs; with markets configured that part is skipped).
 *
 *   node scripts/smoke.ts            build, then test
 *   node scripts/smoke.ts --no-build test the existing .next build
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const failures: string[] = [];
let checks = 0;
const check = (ok: boolean, what: string) => {
  checks++;
  if (!ok) failures.push(what);
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function start(env: Record<string, string>): Promise<{ base: string; proc: ChildProcess }> {
  const port = await freePort();
  const proc = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: web,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d));
  proc.stderr!.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/robots.txt`);
      if (r.ok) return { base, proc };
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error(`server did not start:\n${log}`);
}

/** Visible text: scripts, styles and tags removed, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&rsquo;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

async function page(base: string, path: string, expect: string[], status = 200): Promise<string> {
  const res = await fetch(base + path);
  const body = await res.text();
  check(res.status === status, `${path}: status ${res.status}, expected ${status}`);
  const t = text(body);
  for (const e of expect) check(t.includes(e), `${path}: missing "${e}"`);
  for (const bad of ["NaN", "undefined", "TODO", "[object Object]", "Infinity", "unwound at"]) check(!t.includes(bad), `${path}: contains "${bad}"`);
  // The reduced-motion test override is wired on every page: the head script that sets data-motion.
  check(body.includes('setAttribute("data-motion","reduce")'), `${path}: no motion=reduce override script`);
  // The head scripts must be the strings themselves, not a client reference turned into text.
  check(!body.includes("not possible to invoke a client function"), `${path}: a head script is a client reference`);
  // A placeholder zero: "$0.00" not followed by another digit ("$0.003" is a real price).
  check(!/\$0\.00(?!\d)/.test(t), `${path}: contains a "$0.00" placeholder`);
  return body;
}

async function api(base: string, path: string, status: number): Promise<Record<string, unknown>> {
  const res = await fetch(base + path);
  check(res.status === status, `${path}: status ${res.status}, expected ${status}`);
  check((res.headers.get("content-type") ?? "").includes("application/json"), `${path}: not JSON`);
  check(!!res.headers.get("cache-control"), `${path}: no cache-control`);
  return (await res.json()) as Record<string, unknown>;
}

if (!process.argv.includes("--no-build")) {
  console.log("building…");
  const b = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), "build"], { cwd: web, stdio: "inherit" });
  if (b.status !== 0) throw new Error("next build failed");
}

const PAGES: [string, string[]][] = [
  ["/", ["Take the heat out of your", "GPU bill.", "Who is in the room", "One round, as work", "Example orders", "Simulated", "H100, USD per GPU-hour", "Series and phase clock", "Last clearing", "Payoff and hedge size", "Limits", "Model data, not the chain"]],
  ["/?m=fast", ["H100, USD per GPU-hour", "H100 hourly (demo)", "Model data, not the chain"]],
  ["/?m=h100-fast", ["H100, USD per GPU-hour", "H100 hourly (demo)"]],
  ["/?m=h200-weekly", ["H200, USD per GPU-hour", "Week-ahead H200 auctions", "H200 weekly", "Open the A100 market", "This is the H200 market"]],
  ["/?m=a100-80-weekly", ["A100 80 GB, USD per GPU-hour", "A100 80 GB weekly", "Open the H100 market"]],
  ["/?m=h200-weekly&range=30d", ["Index, last 30 d"]],
  ["/?m=fast&range=6h", ["Index, last 6 h"]],
  ["/auction", ["Sealed book", "Bid with an agent", "Recent rounds"]],
  ["/auction?m=fast", ["Sealed book", "Recent rounds"]],
  ["/simulate", ["Simulation. Nothing here touches the chain.", "Skip to clearing", "Run 10 rounds"]],
  ["/simulate?m=fast", ["H100 hourly (demo) market"]],
  ["/simulate?m=a100-80-weekly", ["A100 80 GB weekly market"]],
  ["/auction?m=h200-weekly", ["Sealed book", "Recent rounds", "Commit fees held"]],
  ["/proof?m=a100-80-weekly", ["Solvency, A100 80 GB weekly market", "evidence/bundles/a100-80/"]],
  ["/spec", ["The rules, as written", "Settlement"]],
  ["/audit", ["What the review found", "not an audit by a security firm", "Verdict"]],
  ["/simulate?m=h100-fast", ["Silent reporters (void series)", "cancelled at the centre of the band"]],
  ["/?motion=reduce", ["Take the heat out of your", "Simulated"]],
  ["/how?motion=reduce", ["One round, as work", "One price for all"]],
  ["/backtest", ["What a hedge would have done", "The rule", "Average stayed inside the band in", "What this does not show"]],
  ["/how", ["cancelled at the centre of the band", "who also trades", "How a print is decided", "max_spread_bps", "records the guard and the reference", "burned", "The series clock", "Commit and reveal", "weir:v1", "Clearing", "Settlement", "Funding from another chain", "quotes only", "Limits", "Trust"]],
  ["/proof", ["Audited", "Closed by a rule", "Open", "Stated limits", "A fix that was itself found faulty", "$6.40 a round", "limit_blocking_a_round_costs_1_28_dollars", "Not fit for real dollars", "AI reviewer", "audit_one_reporter_can_no_longer_steer_the_index", "Burned", "max_spread_bps", "commit_fee", "Check every print yourself", "Contracts", "Solvency", "Bundle verifier", "Parameters", "Transactions on record", "Testnet"]],
  ["/agents", ["A key that bids and stops there", "Who can do what", "Agents on the book", "max_round_lock", "Three things bound an agent"]],
];

let server = await start({ WEIR_MODEL: "1" });
try {
  console.log(`model mode on ${server.base}`);
  for (const [path, expect] of PAGES) await page(server.base, path, expect);
  await page(server.base, "/no-such-page", ["No page at this address"], 404);
  for (const m of ["h100-weekly", "h100-fast", "h200-weekly", "a100-80-weekly", "weekly", "fast"]) {
    const s = await api(server.base, `/api/status?m=${m}`, 200);
    check(s.source === "model", `/api/status?m=${m}: source ${String(s.source)}`);
    const live = (s.series as { series: number; last_clearing: { round: number } | null }[])[0];
    check(!!live, `/api/status?m=${m}: no live series`);
    const lc = (s.series as { series: number; last_clearing: { round: number } | null }[]).find((x) => x.last_clearing);
    if (lc) {
      const r = await api(server.base, `/api/round?m=${m}&series=${lc.series}&round=${lc.last_clearing!.round}`, 200);
      check(r.state === "cleared", `/api/round ${m}: state ${String(r.state)}`);
      await page(server.base, `/auction?m=${m}&series=${lc.series}&round=${lc.last_clearing!.round}`, ["Result", "Filled orders", "Burned in this round", "Other rounds"]);
    } else check(false, `/api/status?m=${m}: no last clearing to request`);
  }
  await api(server.base, "/api/status?m=nope", 400);
  await api(server.base, "/api/round?m=fast&series=x&round=1", 400);
  await api(server.base, "/api/round?m=fast&series=0&round=0", 404);
  const totals = (await api(server.base, "/api/status?m=h200-weekly", 200)) as { params?: { max_spread_bps?: number; commit_fee?: string } };
  check(typeof totals.params?.max_spread_bps === "number" && typeof totals.params?.commit_fee === "string", "/api/status: 0.4 parameters");
  for (const f of ["/llms.txt", "/robots.txt", "/opengraph-image.png", "/icon.svg", "/apple-icon.png"]) {
    const r = await fetch(server.base + f);
    check(r.ok, `${f}: status ${r.status}`);
  }
} finally {
  server.proc.kill();
}

const deployed = JSON.parse(readFileSync(new URL("../../deployments.json", import.meta.url), "utf8")) as { markets?: unknown[] };
if ((deployed.markets ?? []).length === 0) {
  server = await start({ WEIR_MODEL: "" });
  try {
    console.log(`no markets, no model, on ${server.base}`);
    for (const [path] of PAGES) {
      const html = await page(server.base, path, []);
      check(!text(html).includes("Model data, not the chain"), `${path}: model ribbon without model mode`);
    }
    for (const p of ["/", "/?m=fast", "/?m=h200-weekly", "/auction", "/proof", "/agents"]) await page(server.base, p, ["is not deployed yet"]);
    await page(server.base, "/proof", ["No market is deployed yet", "Recorded sample"]);
    const s = await api(server.base, "/api/status?m=weekly", 404);
    check((s.error as { code?: string })?.code === "not_deployed", "/api/status: error code");
    await api(server.base, "/api/round?m=fast&series=1&round=0", 404);
  } finally {
    server.proc.kill();
  }
} else console.log("markets are configured: the not-deployed pass is skipped");

if (failures.length) {
  console.error(`smoke: ${failures.length} of ${checks} checks failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`smoke: all ${checks} checks passed`);
