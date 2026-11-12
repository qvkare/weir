// The homepage for one market, written at build time (server). The figures are the build's read
// of the chain (or the model); the page then reads the chain again in the browser.
import { Backdrop } from "@/components/front/backdrop.tsx";
import { Front } from "@/components/front/front.tsx";
import { buildData, liveMarkets } from "@/lib/build.ts";
import { CLOSED, OPEN, PASSES, STATED } from "@/lib/audit.ts";
import { DEFAULT_MARKET, MARKET_IDS, type ChipKey, type MarketId } from "@/lib/config.ts";
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

/** The backtest's weekly H100 series for the backdrop: band cap, weekly average, band floor. */
function backdropSeries(): { series: number[][]; note: string } | null {
  const site = buildData().backtest.site as { weeks?: string[]; cap?: number[]; fixing?: number[]; floor?: number[] } | null;
  if (!site?.weeks?.length || !site.cap || !site.fixing || !site.floor) return null;
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return {
    series: [site.cap, site.fixing, site.floor],
    note: `Behind the window: the H100 backtest's weekly band cap, weekly average price and band floor, ${site.weeks.length} weeks from ${day(site.weeks[0]!)} to ${day(site.weeks.at(-1)!)}, drawn as ridgelines.`,
  };
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
  const bd = backdropSeries();
  return <Front cfg={cfg} page={market} initial={initial} chipMarkets={chipMarkets} offered={offered} specs={specs} moves={moves()} passes={PASSES} backdrop={bd ? <Backdrop series={bd.series} /> : null} backdropNote={bd?.note ?? null} closeBackdrop={bd ? <Backdrop series={bd.series} id="bd-close" /> : null} agents={buildData().agents} findings={OPEN.length + STATED.length + CLOSED.length} />;
}
