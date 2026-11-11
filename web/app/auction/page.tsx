import type { Metadata } from "next";
import Link from "next/link";
import { AgentPanel, LiveCurves, NoRoundInProgress, qs, RecentRounds, RoundResult, SealedBook } from "@/components/auction-blocks.tsx";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { Countdown } from "@/components/countdown.tsx";
import { Figure } from "@/components/figure.tsx";
import { NotDeployed, RpcError } from "@/components/state.tsx";
import { valueOf } from "@/lib/cache.ts";
import { marketFromParam, MARKET_INFO } from "@/lib/config.ts";
import { fmtBps, fmtUsd, fmtUsdOrNone, fmtUtc } from "@/lib/format.ts";
import { latestRound, loadCore, loadResults } from "@/lib/load.ts";
import { isNotDeployed } from "@/lib/source.ts";
import { bookRows, bookTotals, lastResult } from "@/lib/views.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Auction", description: "The sealed round in progress, the phase clock, and every cleared round with its step chart and fills." };

type Search = Promise<Record<string, string | string[] | undefined>>;
const int = (v: string | string[] | undefined): number | null => (typeof v === "string" && /^\d{1,10}$/.test(v) ? Number(v) : null);

export default async function AuctionPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const market = marketFromParam(sp.m);
  const core = await loadCore(market);
  const href = `/auction${qs(market)}`;
  const params = valueOf(core.params);
  const status = valueOf(core.status);

  const frame = (h1: React.ReactNode, sub: React.ReactNode, body: React.ReactNode) => (
    <main id="main">
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">
            Auction · {MARKET_INFO[market].label} market, {MARKET_INFO[market].delivery}
          </span>
          <h1>{h1}</h1>
          {sub ? <p className="sub">{sub}</p> : null}
        </header>
        {body}
      </div>
    </main>
  );

  if (isNotDeployed(core.params)) return frame("The round in progress", null, <section className="section"><NotDeployed market={market} what="auction" /></section>);
  if (!params || !status) return frame("The round in progress", null, <section className="section"><RpcError read={!core.params.ok ? core.params : core.status} href={href} model={core.src.kind === "model"} /></section>);

  const seriesQ = int(sp.series);
  const roundQ = int(sp.round);

  // A specific round, from ?series=&round=
  if (seriesQ !== null && roundQ !== null) {
    const [roundR, resultR, seriesR] = await Promise.all([
      core.src.view("get_round", { series: seriesQ, round: roundQ }),
      core.src.view("get_result", { series: seriesQ, round: roundQ }),
      core.src.view("get_series", { series: seriesQ }),
    ]);
    const result = valueOf(resultR);
    const round = valueOf(roundR);
    const series = valueOf(seriesR);
    const failed = [roundR, resultR, seriesR].find((r) => !r.ok);
    const live = status.live.find((l) => l.series === seriesQ && l.round === roundQ);
    return frame(
      `Series ${seriesQ}, round ${roundQ}`,
      result ? `Cleared ${fmtUtc(result.cleared_at)}. ${result.price === null ? "Nothing traded." : "One price for every filled order."}` : round ? "Not cleared yet." : "This round has no commits, was pruned after settlement, or has not started.",
      <>
        {failed ? <section className="section"><RpcError read={failed} href={`/auction${qs(market, `series=${seriesQ}&round=${roundQ}`)}`} model={core.src.kind === "model"} /></section> : null}
        <section className="section" aria-labelledby="r-h">
          <div className="section-head">
            <h2 id="r-h">{result ? "Result" : "Sealed book"}</h2>
            <Link className="note" href={href}>The round in progress</Link>
          </div>
          {result ? <RoundResult result={result} series={series} params={params} round={roundQ} /> : <SealedBook round={round} params={params} />}
        </section>
        <section className="section" aria-labelledby="recent-h">
          <h2 id="recent-h" className="section-head" style={{ fontSize: "var(--t21)" }}>Other rounds</h2>
          <RecentRounds src={core.src} series={seriesQ} params={params} now={core.now} market={market} current={roundQ} />
        </section>
        {live ? <AutoRefresh at={live.phase_ends_at} serverNow={core.now} /> : null}
      </>,
    );
  }

  const live = status.live.find((l) => l.series === seriesQ) ?? status.live.find((l) => l.round !== null) ?? status.live[0] ?? null;
  if (!live || live.round === null || live.phase_ends_at === null) {
    return frame("No round in progress", null, <section className="section"><NoRoundInProgress params={params} now={core.now} /></section>);
  }

  const [roundR, seriesR, recentR] = await Promise.all([
    core.src.view("get_round", { series: live.series, round: live.round }),
    core.src.view("get_series", { series: live.series }),
    loadResults(core.src, live.series, Math.max(0, latestRound(params, live.series, core.now)), 3),
  ]);
  const round = valueOf(roundR);
  const series = valueOf(seriesR);
  const totals = bookTotals(bookRows(round));
  const prev = lastResult(valueOf(recentR));
  const commit = live.phase === "Commit";

  const h1 = (
    <>
      Round {live.round} {commit ? "reveals" : "closes"} in <Countdown endsAt={live.phase_ends_at} serverNow={core.now} className="countdown" />
    </>
  );
  const sub = totals.commits === 0
    ? "No sealed commits yet. Sides and prices stay hidden until reveal."
    : commit
    ? `${totals.commits} sealed commit${totals.commits === 1 ? "" : "s"}, ${fmtUsd(totals.locked)} locked. Sides and prices stay hidden until reveal.`
    : `${totals.revealed} of ${totals.commits} commits revealed, ${fmtUsd(totals.locked)} locked. Unrevealed commits forfeit ${fmtBps(params.forfeit_bps)} of their lock.`;

  return frame(
    h1,
    sub,
    <>
      <section className="section" aria-label="Round facts">
        <div className="figures">
          <Figure label="Series" value={String(live.series)} source={`Delivery ${fmtUtc(live.delivery_start)} to ${fmtUtc(live.delivery_end)}`} />
          <Figure label="Round" value={String(live.round)} source={`${commit ? "Commit" : "Reveal"} phase, ends ${fmtUtc(live.phase_ends_at)}`} />
          <Figure label="Commits" value={String(totals.commits)} source={`${totals.revealed} revealed, ${totals.void} void, ${totals.sealed} sealed`} />
          <Figure label="Total locked" value={fmtUsdOrNone(totals.locked)} source="An upper bound on what the orders can cost" />
        </div>
        {!roundR.ok ? <RpcError read={roundR} href={href} model={core.src.kind === "model"} /> : null}
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
          {prev ? <Link className="note" href={`/auction${qs(market, `series=${live.series}&round=${prev.round}`)}`}>Open round {prev.round}</Link> : null}
        </div>
        {prev ? <RoundResult result={prev.result} series={series} params={params} round={prev.round} animate /> : <p className="muted">No round of series {live.series} has cleared yet.</p>}
      </section>
      <section className="section" aria-labelledby="recent-h">
        <h2 id="recent-h" style={{ fontSize: "var(--t21)", marginBottom: 24 }}>Recent rounds</h2>
        <RecentRounds src={core.src} series={live.series} params={params} now={core.now} market={market} current={null} />
      </section>
      <AutoRefresh everySecs={market === "fast" ? 10 : 30} at={live.phase_ends_at} serverNow={core.now} />
    </>,
  );
}
