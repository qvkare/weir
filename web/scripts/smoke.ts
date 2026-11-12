/**
 * Smoke test: builds the static site in model mode (out/), serves it from Node the way Cloudflare
 * does (static files, html_handling auto-trailing-slash, the 404 page) with the Worker's own
 * routing (worker/route.ts) and API handlers (lib/api-handlers.ts) in front, requests every page
 * and API route, and checks status, key text and that no page shows NaN, undefined, a $0.00
 * placeholder or TODO. When deployments.json lists no markets it also builds without the model
 * and checks the "not deployed" states.
 *
 *   node scripts/smoke.ts            build, then test
 *   node scripts/smoke.ts --no-build test the existing out/ build (must be a model build)
 *
 * What it cannot see: figures the browser reads after load (round pages, chart ranges). Those
 * loaders are tested in lib/pages.test.ts, and the local Workers run in README.md covers the rest.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildData } from "../lib/build-data.ts";
import { route } from "../worker/route.ts";

const web = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const out = join(web, "out");
const failures: string[] = [];
let checks = 0;
const check = (ok: boolean, what: string) => {
  checks++;
  if (!ok) failures.push(what);
};

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".xml": "application/xml" };

/** The file Cloudflare's asset handling would serve for a path, or null. */
function assetFor(pathname: string): string | null {
  const p = decodeURIComponent(pathname).replace(/\/+$/, "") || "/";
  const tries = p === "/" ? ["index.html"] : [p.slice(1), `${p.slice(1)}.html`, `${p.slice(1)}/index.html`];
  for (const t of tries) {
    const f = join(out, t);
    if (f.startsWith(out) && existsSync(f) && statSync(f).isFile()) return f;
  }
  return null;
}

async function start(model: boolean): Promise<{ base: string; server: Server }> {
  process.env.WEIR_BUILD = JSON.stringify(readBuildData(root));
  process.env.WEIR_MODEL = model ? "1" : "";
  const { apiHandler } = await import("../lib/api-handlers.ts");
  const { source } = await import("../lib/source.ts");
  const { deployments } = await import("../lib/build.ts");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const r = route(url);
    if (r.kind === "redirect") {
      res.writeHead(302, { location: r.location }).end();
      return;
    }
    if (r.kind === "api") {
      const a = (await apiHandler({ network: deployments().network, sourceOf: source }, url))!;
      res.writeHead(a.status, Object.fromEntries(a.headers)).end(await a.text());
      return;
    }
    const f = assetFor(url.pathname);
    if (!f) {
      res.writeHead(404, { "content-type": TYPES[".html"] }).end(readFileSync(join(out, "404.html")));
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, server };
}

function build(model: boolean) {
  console.log(`building${model ? " (model)" : ""}…`);
  const b = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), "build"], { cwd: web, stdio: "inherit", env: { ...process.env, WEIR_MODEL: model ? "1" : "" } });
  if (b.status !== 0) throw new Error("next build failed");
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

if (!process.argv.includes("--no-build")) build(true);

const PAGES: [string, string[]][] = [
  ["/", ["one operator today", "Take the heat out of your", "GPU bill.", "Who is in the room", "One round, as work", "Example orders", "Simulated", "H100, USD per GPU-hour", "Series and phase clock", "Last clearing", "Payoff and hedge size", "Limits", "Model data, not the chain"]],
  ["/?m=fast", ["H100, USD per GPU-hour", "H100 hourly (demo)", "Model data, not the chain"]],
  ["/?m=h100-fast", ["H100, USD per GPU-hour", "H100 hourly (demo)"]],
  ["/?m=h200-weekly", ["H200, USD per GPU-hour", "Week-ahead H200 auctions", "H200 weekly", "Open the A100 market", "This is the H200 market"]],
  ["/?m=a100-80-weekly", ["A100 80 GB, USD per GPU-hour", "A100 80 GB weekly", "Open the H100 market"]],
  // The range is applied in the browser; the static page carries the links and the default range.
  ["/?m=h200-weekly&range=30d", ["H200, USD per GPU-hour", "Index, last 7 d", "30 d"]],
  ["/?m=fast&range=6h", ["Index, last 6 h", "1 h", "24 h"]],
  ["/auction", ["Sealed book", "Bid with an agent", "Recent rounds"]],
  ["/auction?m=fast", ["Sealed book", "Recent rounds"]],
  ["/simulate", ["Simulation. Nothing here touches the chain.", "Skip to clearing", "Run 10 rounds"]],
  ["/simulate?m=fast", ["H100 hourly (demo) market"]],
  ["/simulate?m=a100-80-weekly", ["A100 80 GB weekly market"]],
  ["/auction?m=h200-weekly", ["Sealed book", "Recent rounds", "Commit fees held"]],
  ["/proof?m=a100-80-weekly", ["Solvency, A100 80 GB weekly market", "evidence/bundles/a100-80/"]],
  ["/spec", ["The rules, as written", "Settlement"]],
  ["/audit", ["What the review found", "in four passes", "not an audit by a security firm", "Fourth pass (spec 0.6)", "Verdict"]],
  ["/simulate?m=h100-fast", ["Silent reporters (void series)", "cancelled at the centre of the band"]],
  ["/?motion=reduce", ["Take the heat out of your", "Simulated"]],
  ["/how?motion=reduce", ["One round, as work", "One price for all"]],
  ["/backtest", ["What a hedge would have done", "The rule", "Average stayed inside the band in", "What this does not show"]],
  ["/how", ["cancelled at the centre of the band", "who also trades", "How a print is decided", "max_spread_bps", "records the guard and the reference", "burned", "The series clock", "Commit and reveal", "weir:v1", "Clearing", "Settlement", "Funding from another chain", "quotes only", "Limits", "Trust"]],
  ["/proof", ["What you are trusting today", "Residual risks before real money", "All three are run by one operator, who can set any price", "Nothing on chain checks a report against its published data", "about 0.029 $ a unit", "up to 0.299 $ a unit", "A round can be blocked for 6.40 $", "Both are off by default", "remove protections", "settlement turns void", "No mainnet history and no upgrade path", "Contract against the engine", "264 of 264 checks passed", "1,315 state changes, 2,315 views and 61 refusals", "not on a public network", "Audited", "Four passes", "4 passes, against specifications 0.3, 0.4, 0.5 and 0.6", "Closed by a rule", "Open, stated as limits in the specification", "A fix that was itself found faulty", "That fix was faulty", "$6.40 a round", "6.40 $ a round at the 0.10 $ commit fee", "0.299 $ a unit, 49.8% of the band", "About 0.029 $ a unit", "limit_blocking_a_round_costs_6_40_dollars_at_the_deployed_fee", "audit4_a_non_reporter_cannot_move_the_void_payout", "not fit for real dollars until", "AI reviewer", "audit_one_reporter_can_no_longer_steer_the_index", "Burned", "max_spread_bps", "commit_fee", "Check every print yourself", "Contracts", "Solvency", "Bundle verifier", "Parameters", "Transactions on record", "Testnet"]],
  ["/agents", ["A key that bids and stops there", "Who can do what", "Agents on the book", "max_round_lock", "Three things bound an agent"]],
];

let server = await start(true);
try {
  console.log(`model mode on ${server.base}`);
  for (const [path, expect] of PAGES) await page(server.base, path, expect);
  await page(server.base, "/no-such-page", ["No page at this address"], 404);
  // ?m= is a redirect to the market's own page; the other parameters ride along.
  for (const [from, to] of [["/proof?m=h200-weekly", "/m/h200-weekly/proof"], ["/?m=fast&range=6h", "/m/h100-fast?range=6h"], ["/auction?m=weekly", "/auction"], ["/m/h100-weekly/how", "/how"]]) {
    const r = await fetch(server.base + from!, { redirect: "manual" });
    check(r.status === 302 && r.headers.get("location") === to, `${from}: ${r.status} to ${r.headers.get("location")}, expected 302 to ${to}`);
  }
  // Every market's pages exist as files, and each names its market.
  for (const [m, name] of [["h100-fast", "H100 hourly (demo)"], ["h200-weekly", "H200 weekly"], ["a100-80-weekly", "A100 80 GB weekly"]]) {
    for (const p of ["", "/auction", "/agents", "/proof", "/how", "/simulate"]) await page(server.base, `/m/${m}${p}`, p === "/agents" || p === "" ? [] : [name!]);
  }
  for (const m of ["h100-weekly", "h100-fast", "h200-weekly", "a100-80-weekly", "weekly", "fast"]) {
    const s = await api(server.base, `/api/status?m=${m}`, 200);
    check(s.source === "model", `/api/status?m=${m}: source ${String(s.source)}`);
    const live = (s.series as { series: number; last_clearing: { round: number } | null }[])[0];
    check(!!live, `/api/status?m=${m}: no live series`);
    const lc = (s.series as { series: number; last_clearing: { round: number } | null }[]).find((x) => x.last_clearing);
    if (lc) {
      const r = await api(server.base, `/api/round?m=${m}&series=${lc.series}&round=${lc.last_clearing!.round}`, 200);
      check(r.state === "cleared", `/api/round ${m}: state ${String(r.state)}`);
      // The static page shows the round in progress; the browser reads the round asked for.
      await page(server.base, `/auction?m=${m}&series=${lc.series}&round=${lc.last_clearing!.round}`, ["Sealed book", "Recent rounds"]);
    } else check(false, `/api/status?m=${m}: no last clearing to request`);
  }
  await api(server.base, "/api/status?m=nope", 400);
  await api(server.base, "/api/round?m=fast&series=x&round=1", 400);
  await api(server.base, "/api/round?m=fast&series=0&round=0", 404);
  const totals = (await api(server.base, "/api/status?m=h200-weekly", 200)) as { params?: { max_spread_bps?: number; commit_fee?: string } };
  check(typeof totals.params?.max_spread_bps === "number" && typeof totals.params?.commit_fee === "string", "/api/status: 0.4 parameters");
  for (const f of ["/llms.txt", "/robots.txt", "/sitemap.xml", "/opengraph-image.png", "/icon.svg", "/apple-icon.png", "/site.json"]) {
    const r = await fetch(server.base + f);
    check(r.ok, `${f}: status ${r.status}`);
  }
  // Cloudflare reads out/_headers for the assets it serves without the Worker; it is not served.
  const headersFile = existsSync(join(out, "_headers")) ? readFileSync(join(out, "_headers"), "utf8") : "";
  check(/^\/\*\n  Content-Security-Policy: .*connect-src 'self'/m.test(headersFile), "out/_headers: no CSP for /*");
  const site = (await (await fetch(server.base + "/site.json")).json()) as { mode?: string; headers?: Record<string, string> };
  check(site.mode === "model", `/site.json: mode ${String(site.mode)}`);
  check(/connect-src 'self'/.test(site.headers?.["Content-Security-Policy"] ?? ""), "/site.json: no CSP");
  const robots = await (await fetch(server.base + "/robots.txt")).text();
  check(/Sitemap: https:\/\//.test(robots), "/robots.txt: no absolute sitemap address");
  const home = await (await fetch(server.base + "/")).text();
  check(/<link rel="canonical" href="https:\/\/[^"/]+\/?"/.test(home), "/: no absolute canonical link");
  const h200 = await (await fetch(server.base + "/m/h200-weekly/proof")).text();
  check(/<link rel="canonical" href="https:\/\/[^"]+\/m\/h200-weekly\/proof"/.test(h200), "/m/h200-weekly/proof: canonical link is not its own address");
  check(/<meta property="og:image" content="https:\/\/[^"]+\/opengraph-image\.png"/.test(home), "/: no absolute og:image");
} finally {
  server.server.close();
}

const deployed = JSON.parse(readFileSync(new URL("../../deployments.json", import.meta.url), "utf8")) as { markets?: unknown[] };
if ((deployed.markets ?? []).length === 0) {
  build(false);
  server = await start(false);
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
    server.server.close();
  }
} else console.log("markets are configured: the not-deployed pass is skipped");

if (failures.length) {
  console.error(`smoke: ${failures.length} of ${checks} checks failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`smoke: all ${checks} checks passed`);
