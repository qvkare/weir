import Link from "next/link";
import { cache } from "react";
import type { WireParams } from "@weir/engine";
import { funding } from "@/lib/build.ts";
import { valueOf } from "@/lib/cache.ts";
import { MARKET_INFO, type MarketId } from "@/lib/config.ts";
import { dollarsOfPrice, fmtBps, fmtDuration, fmtGpuH, fmtPrice, fmtSpan, fmtUtc, fmtUtcTime, shortAccount, shortHash } from "@/lib/format.ts";
import { isStale, loadBundle, loadCore, loadLastClearing, loadPrints, loadSeriesSet, recordedBundle, type Core, type LoadedBundle } from "@/lib/load.ts";
import { isNotDeployed } from "@/lib/source.ts";
import { average, printView, seriesTimes, stepOrdersFromResult, summarize, timesOf } from "@/lib/views.ts";
import { seriesStage } from "@/lib/timeline.ts";
import { Countdown } from "./countdown.tsx";
import { Figure, priceParts } from "./figure.tsx";
import { IndexChart } from "./index-chart.tsx";
import { indexSummary } from "@/lib/index-chart.ts";
import { PayoffSizer } from "./payoff-sizer.tsx";
import { SeriesStrip } from "./series-strip.tsx";
import { Empty, NotDeployed, RpcError, Stale } from "./state.tsx";
import { StepChart } from "./step-chart.tsx";

export const getCore = cache(loadCore);
const getSeriesSet = cache(async (market: MarketId) => loadSeriesSet(await getCore(market)));

const q = (market: MarketId, extra = "") => (market === "weekly" ? (extra ? `?${extra}` : "") : `?m=${market}${extra ? `&${extra}` : ""}`);

function coreProblem(core: Core, market: MarketId, href: string, what: string) {
  if (isNotDeployed(core.params)) return <NotDeployed market={market} what={what} />;
  if (!core.params.ok && !valueOf(core.params)) return <RpcError read={core.params} href={href} model={core.src.kind === "model"} />;
  if (!core.status.ok && !valueOf(core.status)) return <RpcError read={core.status} href={href} model={core.src.kind === "model"} />;
  return null;
}

// 1. Index head

export async function IndexHead({ market }: { market: MarketId }) {
  const core = await getCore(market);
  const href = `/${q(market)}`;
  const params = valueOf(core.params);
  const last = valueOf(core.last);
  const problem = coreProblem(core, market, href, "index print");
  const print = last ? valueOf(await core.src.view("get_print", { bucket: last.bucket })) : null;
  const pv = printView(print);
  const stale = isStale(params, last, core.now);
  const tick = params?.tick;
  const shown = last ? priceParts(fmtPrice(last.price, tick)) : null;

  // Sources: the bundle behind the first report, from the bundle host, else the recorded sample.
  const firstHash = pv?.reporters[0]?.bundle ?? null;
  const hosted = firstHash ? await loadBundle(firstHash) : null;
  const hostedOk = hosted && hosted.ok ? hosted.value : null;
  const sample = hostedOk ? null : recordedBundle();

  return (
    <div className="index-head">
      <div>
        <h1 className="hero-title">One price for next week&rsquo;s GPU-hour</h1>
        <p className="hero-sub">Buyers and sellers of H100 time bid in sealed rounds. Everyone filled pays the same clearing price.</p>
        <div style={{ marginTop: 32 }}>
          {problem ?? (
            <>
              <Figure
                display
                label="H100, USD per GPU-hour"
                value={shown?.value ?? null}
                unit={shown?.unit}
                source={
                  last ? (
                    <>
                      Final print for the bucket from {fmtUtcTime(last.bucket)}, {fmtDuration(core.now - last.bucket)} old
                      {pv ? `, median of ${pv.reporters.length} report${pv.reporters.length === 1 ? "" : "s"}` : ""}.
                    </>
                  ) : (
                    "No print has become final yet."
                  )
                }
              />
              {stale && last && params ? (
                <div style={{ marginTop: 16 }}>
                  <Stale>
                    Last print is {fmtDuration(core.now - last.bucket)} old. A series cannot open on it (max_anchor_age_secs is {fmtSpan(params.max_anchor_age_secs)}).
                  </Stale>
                </div>
              ) : null}
              {!core.last.ok ? (
                <div style={{ marginTop: 16 }}>
                  <RpcError read={core.last} href={href} model={core.src.kind === "model"} />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div>
        <SourcesTable loaded={hostedOk ?? sample} hostedError={hosted && !hosted.ok ? hosted.error : null} reporterOfBundle={hostedOk ? (pv?.reporters[0]?.reporter ?? null) : null} tick={tick} />
        {pv ? <ReportersTable pv={pv} tick={tick} /> : null}
      </div>
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
              <span className="flag">Recorded sample</span>, bucket {fmtUtc(b.bucket)}, from <code>{loaded.origin.kind === "recorded" ? loaded.origin.file : ""}</code>. It is not the data behind the print on the left
              {hostedError ? ` (the bundle host failed: ${hostedError})` : ""}.
            </>
          ) : (
            <>
              Sources in {reporterOfBundle ? shortAccount(reporterOfBundle) : "the first reporter"}&rsquo;s bundle for {fmtUtc(b.bucket)}. Re-hashed on <Link href="/proof#verifier">Proof</Link>.
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
    <div className="table-wrap" style={{ marginTop: 24 }}>
      <table>
        <caption>Reports behind this print. The print is their median{pv.middle.length === 2 ? " (mean of the two middle reports, rounded down)" : ""}.</caption>
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

export const RANGES: Record<MarketId, { id: string; label: string; secs: number }[]> = {
  weekly: [
    { id: "24h", label: "24 h", secs: 86_400 },
    { id: "7d", label: "7 d", secs: 7 * 86_400 },
    { id: "30d", label: "30 d", secs: 30 * 86_400 },
  ],
  fast: [
    { id: "1h", label: "1 h", secs: 3600 },
    { id: "6h", label: "6 h", secs: 6 * 3600 },
    { id: "24h", label: "24 h", secs: 86_400 },
  ],
};

export const rangeOf = (market: MarketId, id: string | undefined) => RANGES[market].find((r) => r.id === id) ?? RANGES[market][1]!;

export async function IndexChartBlock({ market, range }: { market: MarketId; range: string | undefined }) {
  const core = await getCore(market);
  const r = rangeOf(market, range);
  const params = valueOf(core.params);
  const head = (
    <div className="section-head">
      <h2>Index, last {r.label}</h2>
      <nav aria-label="Chart range" className="switch">
        {RANGES[market].map((x) => (
          <a key={x.id} href={`/${q(market, `range=${x.id}`)}#index`} aria-current={x.id === r.id ? "true" : undefined}>
            {x.label}
          </a>
        ))}
      </nav>
    </div>
  );
  const problem = coreProblem(core, market, `/${q(market)}`, "index history");
  if (problem || !params) return (
    <>
      {head}
      {problem}
    </>
  );
  const from = core.now - r.secs;
  const prints = await loadPrints(core.src, params, from, core.now);
  const list = valueOf(prints) ?? [];
  const set = await getSeriesSet(market);
  const delivering = set.find((s) => !s.live || (s.live.delivery_start <= core.now && core.now < s.live.delivery_end));
  const dInfo = delivering ? valueOf(delivering.info) : null;
  const acc = delivering ? valueOf(await core.src.view("get_accumulator", { series: delivering.series })) : null;
  const t = delivering ? timesOf(delivering.series, params) : null;
  const avg = average(acc);
  const indexPrints = list.map((p) => ({ bucket: p.bucket, price: p.price!, reports: p.reports.map((x) => ({ reporter: x.reporter, price: x.price })) }));
  return (
    <>
      {head}
      {!prints.ok ? <RpcError read={prints} href={`/${q(market)}`} model={core.src.kind === "model"} /> : null}
      <IndexChart
        tick={params.tick}
        summary={indexSummary(indexPrints, params.tick, from, core.now) + (dInfo && avg !== null ? ` Series ${dInfo.series} is in delivery with a band of ${fmtPrice(dInfo.floor, params.tick)} to ${fmtPrice(dInfo.floor + dInfo.band, params.tick)} and an average so far of ${fmtPrice(avg, params.tick)}.` : "")}
        input={{ prints: indexPrints, interval: params.print_interval_secs, from, to: core.now, band: dInfo && t ? { floor: dInfo.floor, band: dInfo.band, start: t.deliveryStart, end: t.deliveryEnd, average: avg } : null }}
      />
      <div className="legend" aria-hidden="true">
        <span className="key">
          <span className="swatch" style={{ color: "var(--ink)" }} /> Index: final prints, a gap where a bucket has none
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
        <summary>Prints as a table ({list.length})</summary>
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
              {[...list].reverse().slice(0, 200).map((p) => (
                <tr key={p.bucket}>
                  <td>{fmtUtc(p.bucket)}</td>
                  <td className="num">{fmtPrice(p.price, params.tick)}</td>
                  <td className="num">{p.reports.length}</td>
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

export async function SeriesStrips({ market }: { market: MarketId }) {
  const core = await getCore(market);
  const params = valueOf(core.params);
  const problem = coreProblem(core, market, `/${q(market)}`, "series");
  if (problem || !params) return problem;
  const set = await getSeriesSet(market);
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
            Round {live.round} {live.phase === "Commit" ? "commits" : "reveals"}, ends in <Countdown endsAt={live.phase_ends_at} serverNow={core.now} />
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
                </>
              ) : s.info.ok ? (
                <span className="muted">Not opened yet. The first commit sets the band from the last print.</span>
              ) : (
                <span className="bad">Series read failed: {s.info.ok ? "" : s.info.error}</span>
              )}
              {phaseText ? <span>{phaseText}</span> : null}
              {live ? (
                <Link href={`/auction${q(market, `series=${s.series}`)}`}>Open the auction</Link>
              ) : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

// 3. Last clearing and 4. payoff

async function pickClearing(market: MarketId) {
  const core = await getCore(market);
  const set = await getSeriesSet(market);
  for (const s of [...set].sort((a, b) => Number(!!b.live) - Number(!!a.live))) {
    const info = valueOf(s.info);
    if (!info) continue;
    const c = await loadLastClearing(core, s.series);
    if (c.traded) return { core, series: s.series, info, c };
  }
  const first = set.find((s) => valueOf(s.info));
  return { core, series: first?.series ?? set[0]?.series ?? null, info: first ? valueOf(first.info) : null, c: null };
}
const getClearing = cache(pickClearing);

export async function LastClearing({ market }: { market: MarketId }) {
  const core = await getCore(market);
  const params = valueOf(core.params);
  const problem = coreProblem(core, market, `/${q(market)}`, "clearing");
  if (problem || !params) return problem;
  const { series, info, c } = await getClearing(market);
  if (!c || !c.traded || !info) return <Empty>No round of {series === null ? "a live series" : `series ${series}`} has cleared with a trade yet.</Empty>;
  const { round, result } = c.traded;
  const s = summarize(result, info.floor);
  const pp = priceParts(fmtPrice(s.price, params.tick));
  const fp = priceParts(fmtPrice(s.forward, params.tick));
  return (
    <div className="grid-2 wide-left">
      <StepChart compact orders={stepOrdersFromResult(result)} band={info.band} floor={info.floor} tick={params.tick} price={result.price} volume={result.volume} cleared />
      <div>
        <p className="small muted">
          Series {series}, round {round}, cleared {fmtUtc(result.cleared_at)}.
        </p>
        <div className="figures">
          <Figure label="LONG price p*" value={pp.value} unit={pp.unit} source="Paid by every filled LONG" />
          <Figure label="Implied forward, floor + p*" value={fp.value} unit={fp.unit} source="The GPU-hour price this round locks" />
          <Figure label="Volume" value={s.volume.toLocaleString("en-US")} unit="GPU-h" source={`${s.orders} orders of ${s.commits} commits took part`} />
        </div>
        <Link className="button ghost" href={`/auction${q(market, `series=${series}&round=${round}`)}`}>
          Open round {round}
        </Link>
      </div>
    </div>
  );
}

export async function PayoffBlock({ market }: { market: MarketId }) {
  const core = await getCore(market);
  const params = valueOf(core.params);
  const problem = coreProblem(core, market, `/${q(market)}`, "band to draw");
  if (problem || !params) return problem;
  const { series, info, c } = await getClearing(market);
  if (!info || series === null) return <Empty>No series is open yet, so there is no band to draw. The first commit of a series sets it from the last print.</Empty>;
  const traded = c?.traded;
  const half = Math.floor(info.band / 2 / params.tick) * params.tick;
  const p = traded?.result.price ?? half;
  const pSource = traded ? `the last clearing price, ${fmtPrice(p, params.tick)} (round ${traded.round})` : `the middle of the band, ${fmtPrice(p, params.tick)}: no round of this series has traded yet`;
  return <PayoffSizer floor={info.floor} band={info.band} tick={params.tick} p={p} pSource={pSource} maxOrderSize={params.max_order_size} series={series} />;
}

// 5. Facts and 6. limits

export async function Facts({ market }: { market: MarketId }) {
  const core = await getCore(market);
  const params = valueOf(core.params);
  const set = await getSeriesSet(market);
  const opened = set.map((s) => valueOf(s.info)).find(Boolean) ?? null;
  const f = funding();
  return (
    <div className="facts">
      <div className="fact">
        <h3>Sealed, one price</h3>
        <p className="small">Each order is a hash until the reveal phase. The clearing price is the one that trades the most, and every filled order pays it.</p>
        <Link className="small" href="/how#clearing">
          How a round clears
        </Link>
      </div>
      <div className="fact">
        <h3>Paid in full at the open</h3>
        <p className="small">
          A LONG and a SHORT together are backed by exactly the band
          {opened && params ? `, ${fmtPrice(opened.band, params.tick)} in series ${opened.series}` : ""}, locked when the position opens. Nothing is liquidated.
        </p>
        <Link className="small" href="/proof#solvency">
          Solvency, read live
        </Link>
      </div>
      <div className="fact">
        <h3>
          Funding from another chain <span className="tag flag">{f.tag === "recorded" ? "recorded" : "quotes only"}</span>
        </h3>
        <p className="small">USDC on Base, Arbitrum, Ethereum or Solana can reach NEAR through NEAR Intents and then be deposited into Weir. {f.tag === "recorded" ? "One transfer is on record." : "No transfer is on record yet; only quotes."}</p>
        <Link className="small" href="/how#funding">
          The funding path
        </Link>
      </div>
    </div>
  );
}

export function LimitsList({ params, network }: { params: WireParams | null; network: string }) {
  const p = params;
  return (
    <ul className="limits">
      <li>
        <span>NEAR {network} only. No real money is at stake.</span>
        <code>network</code>
      </li>
      <li>
        <span>The index is what {p ? `${p.quorum} of ${p.reporters.length}` : "a quorum of"} named reporters say it is.</span>
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

export async function Limits({ market, network }: { market: MarketId; network: string }) {
  const core = await getCore(market);
  return <LimitsList params={valueOf(core.params)} network={network} />;
}

export async function HomeRefresh({ market }: { market: MarketId }) {
  const core = await getCore(market);
  const status = valueOf(core.status);
  const next = status?.live.map((l) => l.phase_ends_at).filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null;
  const { AutoRefresh } = await import("./auto-refresh.tsx");
  return core.src.kind === "none" ? null : <AutoRefresh everySecs={market === "fast" ? 15 : 30} at={next} serverNow={core.now} />;
}

export const marketLine = (market: MarketId) => `${MARKET_INFO[market].label} market: ${MARKET_INFO[market].delivery}, ${MARKET_INFO[market].rounds}`;
