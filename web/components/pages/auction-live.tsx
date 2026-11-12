"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { AgentPanel, LiveCurves, NoRoundInProgress, auctionHref, RecentRounds, RoundResult, SealedBook } from "@/components/auction-blocks.tsx";
import { Countdown } from "@/components/countdown.tsx";
import { Figure } from "@/components/figure.tsx";
import { LiveBar, useLive } from "@/components/live.tsx";
import { NotDeployed, RpcError, Skeleton } from "@/components/state.tsx";
import { valueOf } from "@/lib/cache.ts";
import { clientSource } from "@/lib/client-source.ts";
import { MARKET_INFO, type MarketId } from "@/lib/config.ts";
import { auctionKey, auctionProbe, loadAuction, type AuctionData } from "@/lib/data/auction.ts";
import { fmtBps, fmtUsd, fmtUsdOrNone, fmtUtc } from "@/lib/format.ts";
import type { SiteConfig } from "@/lib/site-config.ts";
import { isNotDeployed } from "@/lib/source-types.ts";
import { bookRows, bookTotals, lastResult } from "@/lib/views.ts";

const int = (v: string | null): number | null => (v !== null && /^\d{1,10}$/.test(v) ? Number(v) : null);

export function AuctionLive({ cfg, initial, market }: { cfg: SiteConfig; initial: AuctionData; market: MarketId }) {
  // ?series=&round= is read in the browser; the static page shows the round in progress.
  const [sel, setSel] = useState<AuctionData["sel"]>(null);
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const s = int(p.get("series"));
    const r = int(p.get("round"));
    if (s !== null && r !== null) setSel({ series: s, round: r });
  }, []);
  const pollSecs = MARKET_INFO[market].cadence === "Hourly" ? 15 : 30;
  const [st, retry] = useLive<AuctionData>({
    initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const d = await loadAuction(clientSource(cfg, market), sel);
      if (!d.core.status.ok) throw new Error(d.core.status.error);
      return d;
    },
    probe: () => auctionProbe(clientSource(cfg, market), sel),
    keyOf: auctionKey,
    pollSecs,
    deps: [sel],
  });
  // A round asked for by link, before the browser has read it: say so rather than show another round.
  const d: AuctionData = st.data;
  const waiting = sel !== null && (d.sel?.series !== sel.series || d.sel?.round !== sel.round);
  const wall = st.from === "build";
  const params = valueOf(d.core.params);
  const status = valueOf(d.core.status);
  const href = auctionHref(market);
  const polls = sel ? "This round is read once; reload the page to read it again." : `Checks the round in progress and its book every ${pollSecs} s while this tab is visible.`;
  const bar = <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls={polls} retry={retry} />;

  const frame = (h1: ReactNode, sub: ReactNode, body: ReactNode) => (
    <main id="main">
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">
            Auction · {MARKET_INFO[market].name} market, {MARKET_INFO[market].delivery}
          </span>
          <h1>{h1}</h1>
          {sub ? <p className="sub">{sub}</p> : null}
          {bar}
        </header>
        {body}
      </div>
    </main>
  );

  if (isNotDeployed(d.core.params)) return frame("The round in progress", null, <section className="section"><NotDeployed market={market} what="auction" /></section>);
  if (!params || !status) return frame("The round in progress", null, <section className="section"><RpcError read={!d.core.params.ok ? d.core.params : d.core.status} href={href} model={d.core.kind === "model"} /></section>);

  if (sel && (waiting || cfg.mode !== "chain")) {
    return frame(
      `Series ${sel.series}, round ${sel.round}`,
      cfg.mode === "chain" ? "Reading this round from the chain…" : "A past round is read in the browser from the chain; this build has no chain to read.",
      <section className="section"><Skeleton lines={4} label="Reading the round" /></section>,
    );
  }

  // A specific round, from ?series=&round=
  if (d.sel) {
    const result = d.result ? valueOf(d.result) : null;
    const round = d.round ? valueOf(d.round) : null;
    const series = d.series ? valueOf(d.series) : null;
    const failed = [d.round, d.result, d.series].find((r) => r && !r.ok);
    return frame(
      `Series ${d.sel.series}, round ${d.sel.round}`,
      result ? `Cleared ${fmtUtc(result.cleared_at)}. ${result.price === null ? "Nothing traded." : "One price for every filled order."}` : round ? "Not cleared yet." : "This round has no commits, was pruned after settlement, or has not started.",
      <>
        {failed ? <section className="section"><RpcError read={failed} href={auctionHref(market, `series=${d.sel.series}&round=${d.sel.round}`)} model={d.core.kind === "model"} /></section> : null}
        <section className="section" aria-labelledby="r-h">
          <div className="section-head">
            <h2 id="r-h">{result ? "Result" : "Sealed book"}</h2>
            <Link className="note" href={href}>The round in progress</Link>
          </div>
          {result ? <RoundResult result={result} series={series} params={params} round={d.sel.round} /> : <SealedBook round={round} params={params} />}
        </section>
        <section className="section" aria-labelledby="recent-h">
          <h2 id="recent-h" className="section-head" style={{ fontSize: "var(--t21)" }}>Other rounds</h2>
          <RecentRounds read={d.recent} series={d.sel.series} params={params} market={market} current={d.sel.round} />
        </section>
      </>,
    );
  }

  const live = d.live;
  if (!live || live.round === null || live.phase_ends_at === null) {
    return frame("No round in progress", null, <section className="section"><NoRoundInProgress params={params} now={d.core.now} /></section>);
  }
  const round = d.round ? valueOf(d.round) : null;
  const series = d.series ? valueOf(d.series) : null;
  const totals = bookTotals(bookRows(round));
  const prev = lastResult(d.recent ? valueOf(d.recent) : null);
  const commit = live.phase === "Commit";
  const h1 = (
    <>
      Round {live.round} {commit ? "reveals" : "closes"} in <Countdown endsAt={live.phase_ends_at} serverNow={d.core.now} className="countdown" dots wall={wall} />
    </>
  );
  const sub = totals.commits === 0
    ? "No sealed commits yet. Sides and prices stay hidden until reveal."
    : commit
    ? `${totals.commits} sealed commit${totals.commits === 1 ? "" : "s"}, ${fmtUsd(totals.locked)} locked. Sides and prices stay hidden until reveal.`
    : `${totals.revealed} of ${totals.commits} commits revealed, ${fmtUsd(totals.locked)} locked. Unrevealed commits forfeit ${fmtBps(params.forfeit_bps)} of their lock, burned at clearing.`;

  return frame(
    h1,
    sub,
    <>
      <section className="section" aria-label="Round facts">
        <div className="figures">
          <Figure label="Series" value={String(live.series)} source={`Delivery ${fmtUtc(live.delivery_start)} to ${fmtUtc(live.delivery_end)}`} />
          <Figure label="Round" value={String(live.round)} source={`${commit ? "Commit" : "Reveal"} phase, ends ${fmtUtc(live.phase_ends_at)}`} />
          <Figure live label="Commits" value={String(totals.commits)} source={`${totals.revealed} revealed, ${totals.void} void, ${totals.sealed} sealed`} />
          <Figure live label="Total locked" value={fmtUsdOrNone(totals.locked)} source="An upper bound on what the orders can cost" />
          <Figure live label="Commit fees held" value={fmtUsdOrNone(totals.fees)} source="Burned when the round clears; they belong to nobody" />
        </div>
        {d.round && !d.round.ok ? <RpcError read={d.round} href={href} model={d.core.kind === "model"} /> : null}
      </section>
      <section className="section" aria-labelledby="book-h">
        <div className="grid-2 wide-left">
          <div>
            <div className="section-head">
              <h2 id="book-h">Sealed book</h2>
              <span className="note">Series {live.series}, round {live.round}</span>
            </div>
            <SealedBook round={round} params={params} />
          </div>
          <AgentPanel market={market} />
        </div>
      </section>
      {!commit ? (
        <section className="section" aria-labelledby="curves-h">
          <div className="section-head">
            <h2 id="curves-h">Curves as revealed</h2>
          </div>
          <LiveCurves round={round} series={series} params={params} />
        </section>
      ) : null}
      <section className="section" aria-labelledby="prev-h">
        <div className="section-head">
          <h2 id="prev-h">{prev ? `Round ${prev.round}, cleared` : "Last cleared round"}</h2>
          {prev ? <a className="note" href={auctionHref(market, `series=${live.series}&round=${prev.round}`)}>Open round {prev.round}</a> : null}
        </div>
        {prev ? <RoundResult result={prev.result} series={series} params={params} round={prev.round} animate /> : <p className="muted">No round of series {live.series} has cleared yet.</p>}
      </section>
      <section className="section" aria-labelledby="recent-h">
        <h2 id="recent-h" style={{ fontSize: "var(--t21)", marginBottom: 24 }}>Recent rounds</h2>
        <RecentRounds read={d.recent} series={live.series} params={params} market={market} current={null} />
      </section>
    </>,
  );
}
