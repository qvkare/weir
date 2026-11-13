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
import { APP_VIEWS } from "../lib/app-views.ts";

const web = fileURLToPath(new URL("..", import.meta.url));
// The model's clock is pinned (lib/model.ts, modelNow), so the checks do not depend on the minute
// of the hour: 12 Nov 2026, 20:30:00 UTC, mid-hour; then 20:56:00 UTC, just after the hourly
// market's next series opened, when none of its rounds has cleared yet.
const MID_HOUR = 1_794_515_400;
const EDGE = 1_794_516_960;
process.env.WEIR_MODEL_NOW = String(MID_HOUR);
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

function build(model: boolean, now = MID_HOUR) {
  console.log(`building${model ? ` (model, clock ${new Date(now * 1000).toISOString()})` : ""}…`);
  process.env.WEIR_MODEL_NOW = String(now);
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

const seen = new Map<string, string>();

async function page(base: string, path: string, expect: string[], status = 200): Promise<string> {
  const res = await fetch(base + path);
  const body = await res.text();
  seen.set(path, body);
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
  ["/", ["GPU hours,", "priced today.", "See the live round", "How it works", "Markets · last index print, $/GPU-h", "Clearings", "Long price, $/GPU-h", "Cleared, UTC", "drawn as ridgelines", "Over 69 delivery weeks", "Three chips, a market each.", "H200", "A100 80 GB", "Check it yourself.", "All three price reporters are run by one operator today, who can set any price.", "The index is computed from the public price lists of", "Vast.ai", "RunPod", "Akash", "Lium", "Verda", "Shadeform", "no relationship with Weir is implied", "Sealed bids, one price,", "Bids arrive sealed", "One price clears the round", "worked example", "The life of a round", "Agents on this market", "Sources around the median", "A print, checked here", "Last events on chain", "What the review found,", "not customers, and not an audit firm", "Built by Qvkare.", "Blocks & pixel maxi", "Linea MCP", "Mirror Search", "Copil", "1st place, Linea Dev Cook-Off.", "2nd place, Chainlink Chromion Hackathon.", "Using it", "test dollars; no real money moves.", "Every limit", "What you are trusting", "Model figures, computed when this page was published", "Model data, not the chain"]],
  ["/?m=fast", ["H100 hourly · series", "Model data, not the chain"]],
  ["/?m=h100-fast", ["H100 hourly · series", "Hourly demo"]],
  ["/?m=h200-weekly", ["H200 weekly · series", "Weekly auction"]],
  ["/?m=a100-80-weekly", ["A100 80 GB weekly · series"]],
  // The range is applied in the browser; the static page carries the links and the default range.
  ["/auction/prints?m=h200-weekly&range=30d", ["Index, last 7 d", "30 d", "The index and its sources", "Index prints", "Median", "Hashes"]],
  ["/auction/prints?m=fast&range=6h", ["Index, last 6 h", "1 h", "24 h"]],
  ["/auction", ["Round in progress", "Sealed book", "Clearings", "Bid with an agent", "Series and phase clock", "Commit fees held"]],
  ["/auction/book", ["Sealed book", "Sides, sizes and prices appear as each commit is revealed"]],
  ["/auction/clearings", ["Clearings", "Long price, $/GPU-h", "Forward, $/GPU-h", "Cleared, UTC"]],
  ["/auction?m=fast", ["H100 hourly", "Round in progress"]],
  ["/simulate", ["nothing here touches the chain", "Skip to clearing", "Run 10 rounds", "Settle and redeem", "Press Play", "Agents", "Sealed book", "Last clearing", "Event log", "What it does"]],
  ["/simulate?m=fast", ["H100 hourly (demo) market"]],
  ["/simulate?m=a100-80-weekly", ["A100 80 GB weekly market"]],
  ["/auction?m=h200-weekly", ["H200 weekly", "Commit fees held"]],
  ["/proof/solvency?m=a100-80-weekly", ["Solvency, A100 80 GB weekly market", "What the contract owes"]],
  ["/auction/prints?m=a100-80-weekly", ["Recorded sample"]],
  ["/spec", ["The rules, as written", "Settlement"]],
  ["/audit", ["What the review found", "in four passes", "not an audit by a security firm", "Fourth pass (spec 0.6)", "Verdict"]],
  ["/simulate?m=h100-fast", ["Silent reporters (void series)", "cancelled at the centre of the band"]],
  ["/?motion=reduce", ["GPU hours,", "Over 69 delivery weeks"]],
  ["/how?motion=reduce", ["One round, as work", "One price for all", "Who is in the room", "Payoff and hedge size"]],
  ["/backtest", ["What a hedge would have done", "The rule", "Average stayed inside the band in", "What this does not show"]],
  ["/how", ["cancelled at the centre of the band", "who also trades", "How a print is decided", "max_spread_bps", "records the guard and the reference", "burned", "The series clock", "Commit and reveal", "weir:v1", "Clearing", "Settlement", "Funding from another chain", "quotes only", "Limits", "Trust"]],
  ["/proof/review", ["What you are trusting today", "Residual risks before real money", "All three are run by one operator, who can set any price", "Nothing on chain checks a report against its published data", "about 0.029 $ a unit", "up to 0.299 $ a unit", "A round can be blocked for 6.40 $", "Both are off by default", "remove protections", "settlement turns void", "No mainnet history and no upgrade path", "Contract against the engine", "264 of 264 checks passed", "1,315 state changes, 2,315 views and 61 refusals", "not on a public network", "4 passes, against specifications 0.3, 0.4, 0.5 and 0.6", "Closed by a rule", "Open, stated as limits in the specification", "A fix that was itself found faulty", "That fix was faulty", "$6.40 a round", "6.40 $ a round at the 0.10 $ commit fee", "0.299 $ a unit, 49.8% of the band", "About 0.029 $ a unit", "limit_blocking_a_round_costs_6_40_dollars_at_the_deployed_fee", "audit4_a_non_reporter_cannot_move_the_void_payout", "not fit for real dollars until", "AI reviewer", "audit_one_reporter_can_no_longer_steer_the_index", "NEAR testnet", "All three price reporters are run by one operator today, who can set any price."]],
  ["/proof", ["Contracts", "Keys and code hash", "Parameters, H100 weekly market", "max_spread_bps", "commit_fee", "NEAR testnet"]],
  ["/proof/solvency", ["Solvency, H100 weekly market", "Burned", "What the contract owes, against the dollars it holds"]],
  ["/proof/record", ["transactions in the deployment record", "Accounts created", "Keys added", "The key rotation"]],
  ["/agents", ["A key that bids and stops there", "Who can do what", "Agents on the book", "max_round_lock", "Three things bound an agent"]],
];

let server = await start(true);
try {
  console.log(`model mode on ${server.base}`);
  for (const [path, expect] of PAGES) await page(server.base, path, expect);
  await page(server.base, "/no-such-page", ["No page at this address"], 404);
  // The homepage keeps its links to the proof, the review and the limits.
  const front = seen.get("/")!;
  // The maker's block: his portrait from our own origin, and every outside link in a new tab with rel=noopener.
  check(existsSync(join(out, "maker", "qvkare.png")), "out/maker/qvkare.png: missing");
  check(front.includes('src="/maker/qvkare.png"'), "/: the portrait is not served from this site");
  for (const m of front.matchAll(/<a [^>]*href="(https:\/\/[^"]+)"[^>]*>/g)) check(/target="_blank"/.test(m[0]) && /rel="noopener"/.test(m[0]), `/: outside link ${m[1]} does not open in a new tab with rel=noopener`);
  for (const [p, body] of seen) check(!/written by AI|built by AI/i.test(text(body)), `${p}: calls the project written or built by AI`);
  // Levee is named in the README, which the hackathon's rule asks for; not on the site.
  for (const [p, body] of seen) check(!/Levee/.test(text(body)), `${p}: names Levee`);
  // Visitor wording: no repository paths or build jargon in what a visitor reads.
  for (const [p, body] of seen) if (p !== "/audit" && p !== "/spec") for (const bad of ["evidence/", "backtest/results", "deployments.json", "docs/AUDIT.md", "docs/SPEC.md", "integration/RESULTS.md", "at build time", "when this site was built", "when the site was built", "from the build"]) check(!text(body).includes(bad), `${p}: shows "${bad}"`);
  // How the project was made is said in the README, which the hackathon asks for; not on the site.
  for (const [p, body] of seen) check(!text(body).includes("AI was used as a tool"), `${p}: shows the line on how AI was used`);
  // Fail open: the built HTML shows the hero and the whole statement, with nothing hidden inline.
  const built = readFileSync(join(out, "index.html"), "utf8");
  check(/<h1[^>]*>Next week.s GPU hours,/.test(built), "index.html: no hero headline in the HTML");
  // (stop-opacity in the backdrop's gradients is a colour stop, not hidden content.)
  check(!/style="[^"]*(?<![-\w])opacity:\s*0(?![.\d])/.test(built), "index.html: an element starts at opacity 0 inline");
  check(!/style="[^"]*(?<![-\w])opacity:\s*0?\.\d/.test(built), "index.html: an element starts part-transparent inline");
  check(text(built).includes("Over 69 delivery weeks, the weekly average price of an H100 hour"), "index.html: the statement is not whole in the HTML");
  for (const h of ["/proof", "/auction/prints#verifier", "/audit", "/how#limits", "/backtest"]) check(front.includes(`href="${h}"`), `/: no link to ${h}`);
  // No internal link points at an anchor that its page does not have.
  const anchors = new Set<string>();
  for (const body of seen.values()) for (const m of body.matchAll(/href="(\/[^"#]*)#([a-zA-Z][\w-]*)"/g)) anchors.add(`${m[1]}#${m[2]}`);
  for (const a of anchors) {
    const [path, id] = a.split("#") as [string, string];
    const target = await (await fetch(server.base + (path || "/"))).text();
    check(target.includes(`id="${id}"`), `link ${a}: the page has no id="${id}"`);
  }
  check(anchors.size > 5, `only ${anchors.size} anchored links found`);
  // ?m= is a redirect to the market's own page; the other parameters ride along.
  for (const [from, to] of [["/proof?m=h200-weekly", "/m/h200-weekly/proof"], ["/?m=fast&range=6h", "/m/h100-fast?range=6h"], ["/auction?m=weekly", "/auction"], ["/m/h100-weekly/how", "/how"], ["/proof/review?m=h200-weekly", "/m/h200-weekly/proof/review"], ["/auction/clearings?m=fast&series=1&round=2", "/m/h100-fast/auction/clearings?series=1&round=2"]]) {
    const r = await fetch(server.base + from!, { redirect: "manual" });
    check(r.status === 302 && r.headers.get("location") === to, `${from}: ${r.status} to ${r.headers.get("location")}, expected 302 to ${to}`);
  }
  // Every market's pages exist as files, and each names its market.
  const SHORT: Record<string, string> = { "h100-fast": "H100 hourly", "h200-weekly": "H200 weekly", "a100-80-weekly": "A100 80 GB weekly" };
  for (const v of APP_VIEWS) await page(server.base, v.path, ["H100 weekly", v.label]);
  // Each item of the homepage window's sidebar opens a page that shows that view, marked as the one on screen.
  const aside = /<aside[^>]*aria-label="Markets and views"[\s\S]*?<\/aside>/.exec(seen.get("/")!)?.[0] ?? "";
  const hrefs = [...aside.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((x) => [x[1]!, text(x[2]!).trim()] as const);
  check(hrefs.length >= 9, `/: the window's sidebar has ${hrefs.length} links`);
  for (const [href, label] of hrefs) {
    const view = APP_VIEWS.find((v) => label.endsWith(v.label) || label.startsWith(v.label));
    const r = await fetch(server.base + href);
    const body = await r.text();
    check(r.ok, `window link ${href}: status ${r.status}`);
    if (view) check(new RegExp(`aria-current="page"[^>]*>[\\s\\S]{0,600}?${view.label}<`).test(body), `window link ${href}: the page does not show ${view.label} as the current view`);
  }
  for (const [m, name] of [["h100-fast", "H100 hourly (demo)"], ["h200-weekly", "H200 weekly"], ["a100-80-weekly", "A100 80 GB weekly"]]) {
    for (const p of ["", "/how", "/simulate"]) await page(server.base, `/m/${m}${p}`, p === "" ? [] : [name!]);
    // Every view of the application, for this market: its own page, its own market in the title row.
    for (const v of APP_VIEWS) await page(server.base, `/m/${m}${v.path}`, [SHORT[m!]!, v.label]);
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
      await page(server.base, `/auction?m=${m}&series=${lc.series}&round=${lc.last_clearing!.round}`, ["Round in progress"]);
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

// The edge of the hour: the hourly market's new series has no cleared round. The pages must
// show a state for it, not an error or a blank window.
if (!process.argv.includes("--no-build")) {
  build(true, EDGE);
  server = await start(true);
  try {
    console.log(`model mode at the edge of the hour on ${server.base}`);
    const home = await page(server.base, "/m/h100-fast", ["Clearings", "Committing", "Cleared"]);
    check(/Series \d+ and \d+/.test(text(home)), "/m/h100-fast at :56: the grid is not filled from the series before");
    await page(server.base, "/m/h100-fast/auction", ["Round 0 of series", "No round of series", "has cleared yet", "Series and phase clock"]);
    for (const p of ["/", "/m/h100-fast/proof", "/m/h100-fast/how"]) await page(server.base, p, []);
  } finally {
    server.server.close();
  }
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
