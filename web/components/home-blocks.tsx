"use client";
// The home page's data blocks, drawn from one HomeData (lib/data/home.ts): read by the build for
// the static page, then by the browser for live figures. Pure: no reads here.
import Link from "next/link";
import type { WireParams } from "@weir/engine";
import { valueOf } from "@/lib/cache.ts";
import { withMarket, type MarketId } from "@/lib/config.ts";
import { dollarsOfPrice, fmtBps, fmtGpuH, fmtPrice, fmtSpan, fmtUtc, shortAccount, shortHash } from "@/lib/format.ts";
import type { CoreData, HomeData } from "@/lib/data/home.ts";
import { RANGES, rangeOf } from "@/lib/data/home.ts";
import { type LoadedBundle } from "@/lib/load.ts";
import { isNotDeployed } from "@/lib/source-types.ts";
import { average, printView, seriesTimes, settlementLine, timesOf, tradedAverage } from "@/lib/views.ts";
import { seriesStage } from "@/lib/timeline.ts";
import { Countdown } from "./countdown.tsx";
import { IndexChart } from "./index-chart.tsx";
import { indexSummary } from "@/lib/index-chart.ts";
import { PayoffSizer } from "./payoff-sizer.tsx";
import { SeriesStrip } from "./series-strip.tsx";
import { Empty, NotDeployed, RpcError } from "./state.tsx";
import { SheetHead } from "./sheet-head.tsx";


/** The figures came from the build: count clocks against this machine, not the build's "now". */
export interface HomeView {
  d: HomeData;
  wall: boolean;
}

function coreProblem(core: CoreData, market: MarketId, href: string, what: string) {
  if (isNotDeployed(core.params)) return <NotDeployed market={market} what={what} />;
  if (!core.params.ok && !valueOf(core.params)) return <RpcError read={core.params} href={href} model={core.kind === "model"} />;
  if (!core.status.ok && !valueOf(core.status)) return <RpcError read={core.status} href={href} model={core.kind === "model"} />;
  return null;
}

// 1. Index head

/** The live index figure in the hero: last final print, its age, and what it is the median of. */
export function IndexSources({ d, sample }: HomeView & { sample: LoadedBundle | null }) {
  const { core, pv, hosted, market } = d;
  const problem = coreProblem(core, market, withMarket("/", market), "index print");
  if (problem) return problem;
  const tick = valueOf(core.params)?.tick;
  const hostedOk = hosted && hosted.ok ? hosted.value : null;
  return (
    <div className="grid-2 sources-grid">
      <SourcesTable loaded={hostedOk ?? sample} hostedError={hosted && !hosted.ok ? hosted.error : null} reporterOfBundle={hostedOk ? (pv?.reporters[0]?.reporter ?? null) : null} tick={tick} />
      {pv ? <ReportersTable pv={pv} tick={tick} /> : <Empty>No print has become final yet, so there are no reports to list.</Empty>}
    </div>
  );
}

function SourcesTable({ loaded, hostedError, reporterOfBundle, tick }: { loaded: LoadedBundle | null; hostedError: string | null; reporterOfBundle: string | null; tick?: number }) {
  if (!loaded) return <Empty>No bundle is published yet and none is recorded, so the sources cannot be listed.</Empty>;
  const b = loaded.bundle;
  const included = b.providers.filter((p) => p.status === "included");
  const recorded = loaded.origin.kind === "recorded";
  return (
    <div className="table-wrap">
      <table>
        <caption>
          {recorded ? (
            <>
              <span className="flag">Recorded sample</span>, bucket {fmtUtc(b.bucket)}, from a file recorded with the project, not a print on chain. It is not the data behind the print above
              {hostedError ? ` (the bundle host failed: ${hostedError})` : ""}.
            </>
          ) : (
            <>
              Sources in {reporterOfBundle ? shortAccount(reporterOfBundle) : "the first reporter"}&rsquo;s bundle for {fmtUtc(b.bucket)}. Re-hashed in <Link href="/auction/prints#verifier">Index prints</Link>.
            </>
          )}
        </caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col" className="collapse-sm">
              Kind
            </th>
            <th scope="col" className="num">
              USD /GPU-h
            </th>
          </tr>
        </thead>
        <tbody>
          {b.providers.map((p) => (
            <tr key={p.id} className={p.status === "included" ? undefined : "dim"}>
              <td>
                {p.id}
                {p.status === "excluded" ? <div className="tiny muted">Excluded: {p.reason ?? "no reason given"}</div> : null}
              </td>
              <td className="collapse-sm muted">{p.kind}</td>
              <td className="num">{p.value !== undefined ? dollarsOfPrice(p.value, tick) : "no data"}</td>
            </tr>
          ))}
          <tr className="ink">
            <th scope="row">Median of {included.length} included</th>
            <td className="collapse-sm" />
            <td className="num">{b.index === null ? `none: ${b.reason ?? "no reason given"}` : dollarsOfPrice(b.index, tick)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ReportersTable({ pv, tick }: { pv: NonNullable<ReturnType<typeof printView>>; tick?: number }) {
  return (
    <div className="table-wrap">
      <table>
        <caption>Reports behind this print. The print is their median{pv.middle.length === 2 ? " (the two middle reports agreed within max_spread_bps; the print is their mean, rounded down)" : ""}. A bucket is decided once every reporter has reported or its window has closed.</caption>
        <thead>
          <tr>
            <th scope="col">Reporter</th>
            <th scope="col" className="num">
              USD /GPU-h
            </th>
            <th scope="col" className="num">
              Bundle
            </th>
          </tr>
        </thead>
        <tbody>
          {pv.reporters.map((r) => (
            <tr key={r.reporter} className={pv.middle.includes(r.reporter) ? undefined : "dim"}>
              <td className="mono" title={r.reporter}>
                {shortAccount(r.reporter, 24)}
                {pv.middle.includes(r.reporter) ? <span className="tiny muted"> middle</span> : null}
              </td>
              <td className="num">{dollarsOfPrice(r.price, tick)}</td>
              <td className="num mono">{shortHash(r.bundle)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Index chart

export function IndexChartBlock({ d, no, onRange }: HomeView & { no?: string; onRange?: (id: string) => void }) {
  const { core, market } = d;
  const r = rangeOf(market, d.chart.range);
  const params = valueOf(core.params);
  const nav = (
    <nav aria-label="Chart range" className="switch">
      {RANGES[market].map((x) => (
        <a
          key={x.id}
          href={`${withMarket("/auction/prints", market, `range=${x.id}`)}#index`}
          aria-current={x.id === r.id ? "true" : undefined}
          onClick={
            onRange
              ? (e) => {
                  e.preventDefault();
                  onRange(x.id);
                }
              : undefined
          }
        >
          {x.label}
        </a>
      ))}
    </nav>
  );
  // The chart draws only the span that has prints: a market younger than the range starts at
  // its first print, and the title says since when, so the line never sits alone at one edge.
  const all = valueOf(d.chart.prints) ?? [];
  const firstPrint = all.length ? all[0]!.bucket : null;
  const young = params && firstPrint !== null && firstPrint - d.chart.from > 2 * params.print_interval_secs ? firstPrint : null;
  const title = young !== null ? <>Index since {fmtUtc(young)}, the first print</> : <>Index, last {r.label}</>;
  const head = no ? (
    <SheetHead no={no} id="index-h" title={title} note={nav} />
  ) : (
    <div className="section-head">
      <h2 id="index-h">{title}</h2>
      {nav}
    </div>
  );
  const problem = coreProblem(core, market, withMarket("/auction/prints", market), "index history");
  if (problem || !params) return (
    <>
      {head}
      {problem}
    </>
  );
  const { prints } = d.chart;
  const from = young ?? d.chart.from;
  const list = valueOf(prints) ?? [];
  const noPrint = d.chart.gaps.noPrint.filter((b) => b >= from);
  const open = d.chart.gaps.open.filter((b) => b >= from);
  // Buckets in the drawn span with no final print that were not asked about (one view each).
  const span = Math.max(0, Math.floor(core.now / params.print_interval_secs) - Math.ceil(from / params.print_interval_secs));
  const gaps = { noPrint, open, unread: young === null ? d.chart.gaps.unread : Math.max(0, span - list.length - noPrint.length - open.length) };
  const delivering = d.set.find((s) => s.series === d.chart.delivering) ?? null;
  const dInfo = delivering ? valueOf(delivering.info) : null;
  const t = delivering ? timesOf(delivering.series, params) : null;
  const avg = average(d.chart.acc);
  const indexPrints = list.map((p) => ({ bucket: p.bucket, price: p.price!, reports: p.reports.map((x) => ({ reporter: x.reporter, price: x.price })) }));
  const rows = [...list.map((p) => ({ bucket: p.bucket, price: p.price as number | null, reports: p.reports.length, open: false })), ...gaps.noPrint.map((b) => ({ bucket: b, price: null, reports: 0, open: false })), ...gaps.open.map((b) => ({ bucket: b, price: null, reports: 0, open: true }))].sort((a, b) => b.bucket - a.bucket);
  const asked = gaps.noPrint.length + gaps.open.length;
  return (
    <>
      {head}
      {!prints.ok ? <RpcError read={prints} href={withMarket("/", market)} model={core.kind === "model"} /> : null}
      <IndexChart
        tick={params.tick}
        summary={indexSummary(indexPrints, params.tick, from, core.now) + (gaps.noPrint.length ? ` ${gaps.noPrint.length} bucket${gaps.noPrint.length === 1 ? "" : "s"} ended with no print.` : "") + (dInfo && avg !== null ? ` Series ${dInfo.series} is in delivery with a band of ${fmtPrice(dInfo.floor, params.tick)} to ${fmtPrice(dInfo.floor + dInfo.band, params.tick)} and an average so far of ${fmtPrice(avg, params.tick)}.` : "")}
        input={{ prints: indexPrints, interval: params.print_interval_secs, from, to: core.now, band: dInfo && t ? { floor: dInfo.floor, band: dInfo.band, start: t.deliveryStart, end: t.deliveryEnd, average: avg } : null, noPrint: gaps.noPrint }}
      />
      <div className="legend" aria-hidden="true">
        <span className="key">
          <span className="swatch" style={{ color: "var(--ink)" }} /> Index: final prints
        </span>
        <span className="key">
          <span style={{ color: "var(--flag)", fontWeight: 600 }}>×</span> No print: too few reports, or the two middle reports did not agree
          {gaps.unread ? ` (the newest ${asked} of ${asked + gaps.unread} buckets without a final print were read, one view each)` : ""}
        </span>
        <span className="key">
          <span className="swatch thin" style={{ color: "var(--ink-3)" }} /> Each reporter&rsquo;s reports
        </span>
        {dInfo ? (
          <span className="key">
            <span className="swatch dash" style={{ color: "var(--ink)" }} /> Average so far of series {dInfo.series}
          </span>
        ) : null}
      </div>
      <details className="data">
        <summary>
          Prints as a table ({list.length} final{gaps.noPrint.length ? `, ${gaps.noPrint.length} with no print` : ""})
        </summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Bucket</th>
                <th scope="col" className="num">
                  Index
                </th>
                <th scope="col" className="num">
                  Reports
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((p) => (
                <tr key={p.bucket} className={p.price === null ? "dim" : undefined}>
                  <td>{fmtUtc(p.bucket)}</td>
                  <td className="num">{p.price !== null ? fmtPrice(p.price, params.tick) : p.open ? <span className="muted">open, not decided yet</span> : <span className="flag">no print</span>}</td>
                  <td className="num">{p.price !== null ? p.reports : "no data"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

// 2. Series strip

export function SeriesStrips({ d, wall }: HomeView) {
  const { core, market, set } = d;
  const params = valueOf(core.params);
  const problem = coreProblem(core, market, withMarket("/auction", market), "series");
  if (problem || !params) return problem;
  if (set.length === 0) return <Empty>No series is in auction or delivery.</Empty>;
  return (
    <>
      {set.map((s) => {
        const times = s.live ? seriesTimes(s.live, params) : timesOf(s.series, params);
        const info = valueOf(s.info);
        const live = s.live;
        const stage = seriesStage(times, core.now);
        const phaseText = live && live.phase !== "Closed" && live.phase_ends_at ? (
          <>
            Round {live.round} {live.phase === "Commit" ? "commits" : "reveals"}, ends in <Countdown endsAt={live.phase_ends_at} serverNow={core.now} wall={wall} />
          </>
        ) : live ? (
          "Between rounds"
        ) : null;
        return (
          <div className="strip" key={s.series}>
            <div className="strip-head">
              <h3>Series {s.series}</h3>
              <span className="muted small">
                Delivery {fmtUtc(times.deliveryStart)} to {fmtUtc(times.deliveryEnd)}
              </span>
              <span className="tag">{stage}</span>
            </div>
            <SeriesStrip
              times={times}
              now={core.now}
              round={live?.round ?? null}
              summary={`Series ${s.series}: auctions from ${fmtUtc(times.auctionOpen)} to the cutoff at ${fmtUtc(times.auctionClose)}, delivery from ${fmtUtc(times.deliveryStart)} to ${fmtUtc(times.deliveryEnd)}, settlement from ${fmtUtc(times.settleAt)}. ${stage}.`}
            />
            <div className="strip-facts">
              {info ? (
                <>
                  <span>
                    Floor <b>{fmtPrice(info.floor, params.tick)}</b>
                  </span>
                  <span>
                    Band <b>{fmtPrice(info.band, params.tick)}</b>
                  </span>
                  <span>
                    Floor + band <b>{fmtPrice(info.floor + info.band, params.tick)}</b>
                  </span>
                  <span>
                    Open sets <b>{fmtGpuH(info.open_sets)}</b>
                  </span>
                  {tradedAverage(info) !== null ? (
                    <span>
                      Average traded LONG price <b>{fmtPrice(tradedAverage(info), params.tick)}</b> <span className="muted">(information only)</span>
                    </span>
                  ) : null}
                  {info.settlement ? (
                    <span className={info.settlement.void ? "flag" : undefined}>Settled: {settlementLine(info.settlement, params.tick)}</span>
                  ) : null}
                </>
              ) : s.info.ok ? (
                <span className="muted">Not opened yet. The first commit sets the band from the last print.</span>
              ) : (
                <span className="bad">Series read failed: {s.info.ok ? "" : s.info.error}</span>
              )}
              {phaseText ? <span>{phaseText}</span> : null}
              {live ? (
                <Link href={withMarket("/auction", market)}>Open the auction</Link>
              ) : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

// 3. Last clearing and 4. payoff

export function PayoffBlock({ d }: HomeView) {
  const { core, market } = d;
  const params = valueOf(core.params);
  const problem = coreProblem(core, market, withMarket("/how", market), "band to draw");
  if (problem || !params) return problem;
  const { series, info, traded } = d.clearing;
  if (!info || series === null) return <Empty>No series is open yet, so there is no band to draw. The first commit of a series sets it from the last print.</Empty>;
  const half = Math.floor(info.band / 2 / params.tick) * params.tick;
  const p = traded?.result.price ?? half;
  const pSource = traded ? `the last clearing price, ${fmtPrice(p, params.tick)} (round ${traded.round})` : `the middle of the band, ${fmtPrice(p, params.tick)}: no round of this series has traded yet`;
  return <PayoffSizer key={`${series}-${info.floor}-${p}`} floor={info.floor} band={info.band} tick={params.tick} p={p} pSource={pSource} maxOrderSize={params.max_order_size} series={series} />;
}

// 5. Facts and 6. limits

export function LimitsList({ params, network }: { params: WireParams | null; network: string }) {
  const p = params;
  return (
    <ul className="limits">
      <li>
        <span>NEAR {network} only. No real money is at stake.</span>
        <code>network</code>
      </li>
      <li>
        <span>The index is what {p ? `${p.quorum} of ${p.reporters.length}` : "a majority of the"} named reporters say it is. All three are run by one operator today, who can set any price; a majority acting together can set the fixing; with one absent either of the others can leave a bucket without a print, or make a series void (half the band to each side), which a reporter who also trades can profit from.</span>
        <code>quorum</code>
      </li>
      <li>
        <span>The band caps the hedge{p ? `: ${fmtBps(p.band_bps)} of the anchor each way` : ""}. Outside it you pay the market again.</span>
        <code>band_bps</code>
      </li>
      <li>
        <span>A commit not revealed forfeits {p ? fmtBps(p.forfeit_bps) : "a share"} of its lock.</span>
        <code>forfeit_bps</code>
      </li>
      <li>
        <span>A series settles no earlier than {p ? fmtSpan(p.report_grace_secs) : "the report window"} after its delivery ends.</span>
        <code>report_grace_secs</code>
      </li>
    </ul>
  );
}

