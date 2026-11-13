// The homepage for one market, written at build time (server). The figures are the build's read
// of the chain (or the model); the page then reads the chain again in the browser.
import { Front } from "@/components/front/front.tsx";
import { PayoffPanel } from "@/components/front/payoff-panel.tsx";
import { PrintsView, RoundView, SolvencyView } from "@/components/front/app/views.tsx";
import { viewById } from "@/lib/app-views.ts";
import { loadShell, loadPrintList } from "@/lib/data/app.ts";
import { loadAuction } from "@/lib/data/auction.ts";
import { loadHome } from "@/lib/data/home.ts";
import { loadProof } from "@/lib/data/proof.ts";
import { fmtUtc } from "@/lib/format.ts";
import { recordedBundle } from "@/lib/load-server.ts";
import { serverReader } from "@/lib/source.ts";
import { contractRows } from "./proof-page.tsx";
import { buildData, liveMarkets } from "@/lib/build.ts";
import { CLOSED, OPEN, PASSES, STATED } from "@/lib/audit.ts";
import { DEFAULT_MARKET, MARKET_IDS, MARKET_INFO, withMarket, type ChipKey, type MarketId } from "@/lib/config.ts";
import { loadFront } from "@/lib/data/front.ts";
import { CHIPS } from "@/lib/hardware.ts";
import { siteCfg } from "@/lib/site.ts";
import { source } from "@/lib/source.ts";

/** The backtest's spread of weekly moves (backtest/results/summary.json, "move"). */
function moves(): { weeks: number; min: number; max: number; first: string; last: string } | null {
  const s = buildData().backtest.summary as { move?: { weeks?: number; min?: number; max?: number }; weeks?: { first?: string; last?: string } } | null;
  const m = s?.move;
  if (!m || typeof m.weeks !== "number" || typeof m.min !== "number" || typeof m.max !== "number" || !s?.weeks?.first || !s.weeks.last) return null;
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return { weeks: m.weeks, min: m.min, max: m.max, first: day(s.weeks.first), last: day(s.weeks.last) };
}

export async function HomePage({ market }: { market: MarketId }) {
  const cfg = siteCfg();
  const offered = liveMarkets();
  // The default homepage opens its window on the hourly market: a round every five minutes.
  const first: MarketId = market === DEFAULT_MARKET && offered.includes("h100-fast") ? "h100-fast" : market;
  const chipMarkets = MARKET_IDS.filter((m) => offered.includes(m) || m === first);
  const src = source(first);
  const initial = await loadFront(src, chipMarkets.map((m) => (m === first ? src : source(m))), cfg.bundlesBase);
  const specs = Object.fromEntries(CHIPS.map((c) => [c.id, `${c.model}, ${c.memory}`])) as Record<ChipKey, string>;
  const fourViews = await fourViewTabs(cfg, first, chipMarkets);
  return <Front fourViews={fourViews} cfg={cfg} page={market} initial={initial} chipMarkets={chipMarkets} offered={offered} specs={specs} moves={moves()} passes={PASSES} agents={buildData().agents} findings={OPEN.length + STATED.length + CLOSED.length} />;
}

/** "One market, four views": the application's own views for the window's market, as published. */
async function fourViewTabs(cfg: ReturnType<typeof siteCfg>, market: MarketId, markets: MarketId[]) {
  const src = source(market);
  const embedCfg = { ...cfg, mode: cfg.mode === "chain" ? ("none" as const) : cfg.mode };
  const shell = await loadShell(src, markets.filter((m) => m !== market).map((m) => source(m)));
  const common = { cfg: embedCfg, market, shell, markets, embedded: true };
  const rows = contractRows();
  const [auction, prints, index, series, proof] = await Promise.all([
    loadAuction(src, null),
    loadPrintList(src),
    loadHome(src, { bundlesBase: cfg.bundlesBase, chipSources: [], only: "index" }),
    loadHome(src, { bundlesBase: null, chipSources: [], only: "series" }),
    loadProof(rows, serverReader, market),
  ]);
  const when = `as of ${fmtUtc(cfg.builtAt)}, when this page was published`;
  const open = (href: string, label: string) => (
    <a href={withMarket(href, market)} className="text-foreground underline underline-offset-4">
      {label}
    </a>
  );
  return [
    { id: "auction", label: "Auction", caption: <>The round in progress and the series clock, {when}. {open("/auction", "Open it live")}</>, panel: <RoundView {...common} view={viewById("round")} initial={auction} /> },
    { id: "index", label: "Index", caption: <>The last prints with their reports, the chart and the sources, {when}. {open("/auction/prints", "Check them in your browser")}</>, panel: <PrintsView {...common} view={viewById("prints")} initial={prints} index={index} sample={recordedBundle(MARKET_INFO[market].chip)} /> },
    { id: "payoff", label: "Payoff", caption: <>What a LONG and a SHORT are paid at settlement, on the band of the open series {when}. {open("/how", "How it works")}</>, panel: <PayoffPanel market={market} shell={shell} series={series} /> },
    { id: "proof", label: "Proof", caption: <>What the contract owes against what it holds, {when}. {open("/proof/solvency", "Read it live")}</>, panel: <SolvencyView {...common} view={viewById("solvency")} initial={proof} rows={rows} /> },
  ];
}
