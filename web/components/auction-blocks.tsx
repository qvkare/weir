"use client";
import Link from "next/link";
import type { WireParams, WireResult, WireRound, WireSeries } from "@weir/engine";
import { valueOf, type Read } from "@/lib/cache.ts";
import { withMarket, type MarketId } from "@/lib/config.ts";
import { fmtBps, fmtGpuH, fmtInt, fmtPrice, fmtUsd, fmtUsdOrNone, fmtUtc, shortAccount, shortHash } from "@/lib/format.ts";
import { bookRows, bookTotals, fillRows, nextOpening, stepOrdersFromResult, stepOrdersFromRound, summarize } from "@/lib/views.ts";
import { Figure, priceParts } from "./figure.tsx";
import { EyeIcon, LockIcon } from "./icons.tsx";
import { Empty } from "./state.tsx";
import { StepChart } from "./step-chart.tsx";
import { stepSummary } from "@/lib/step.ts";

/** An auction link: a full page load, so the page reads its ?series=&round= again. */
export const auctionHref = (market: MarketId, extra = "") => withMarket("/auction", market, extra);

export function SealedBook({ round, params }: { round: WireRound | null; params: WireParams }) {
  const rows = bookRows(round);
  if (rows.length === 0) return <Empty>No commits in this round yet.</Empty>;
  const sealed = <span className="lock-cell" title="Sealed until reveal"><LockIcon /> <span className="sr-only">sealed</span></span>;
  return (
    <div className="table-wrap">
      <table>
        <caption>One row per commit, in arrival order. A commit shows only its hash and lock; side, size and price appear as reveals land.</caption>
        <thead>
          <tr>
            <th scope="col" className="num">Seq</th>
            <th scope="col">Owner</th>
            <th scope="col" className="collapse-sm">Hash</th>
            <th scope="col" className="num">Lock</th>
            <th scope="col">Side</th>
            <th scope="col" className="num">Size</th>
            <th scope="col" className="num collapse-sm">Limit</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.seq} className={r.state === "Committed" ? undefined : r.state === "Void" ? "dim landed" : "landed"}>
              <td className="num">{r.seq}</td>
              <td className="mono" title={r.owner}>{shortAccount(r.owner)}</td>
              <td className="mono collapse-sm" title={r.hash ?? undefined}>{r.hash ? shortHash(r.hash) : "no data"}</td>
              <td className="num">{fmtUsd(r.lock)}</td>
              <td>{r.side ? <span className={r.side === "Long" ? "side-long" : "side-short"}>{r.side === "Long" ? "LONG" : "SHORT"}</span> : sealed}</td>
              <td className="num">{r.size !== null ? fmtGpuH(r.size) : sealed}</td>
              <td className="num collapse-sm">{r.price !== null ? fmtPrice(r.price, params.tick) : sealed}</td>
              <td>
                {r.state === "Committed" ? (
                  <span className="lock-cell"><LockIcon /> Sealed</span>
                ) : r.state === "Revealed" ? (
                  <span><EyeIcon /> Revealed</span>
                ) : (
                  <span className="flag">Void (guard)</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RoundResult({ result, series, params, round, animate = false }: { result: WireResult; series: WireSeries | null; params: WireParams; round: number; animate?: boolean }) {
  const band = series?.band ?? null;
  const floor = series?.floor ?? null;
  const s = summarize(result, floor);
  const fills = fillRows(result, band);
  const p = priceParts(fmtPrice(s.price, params.tick));
  const f = priceParts(fmtPrice(s.forward, params.tick));
  return (
    <div className="stack">
      <div className="figures">
        <Figure label="LONG price p*" value={s.price === null ? "none" : p.value} unit={s.price === null ? undefined : p.unit} source={s.price === null ? "The curves did not cross" : "Every filled LONG paid this"} />
        <Figure label="SHORT price, band - p*" value={s.price === null || band === null ? "none" : priceParts(fmtPrice(band - s.price, params.tick)).value} unit={s.price === null || band === null ? undefined : "/GPU-h"} source="Every filled SHORT paid this" />
        <Figure label="Forward, floor + p*" value={s.forward === null ? "none" : f.value} unit={s.forward === null ? undefined : f.unit} />
        <Figure label="Volume" value={fmtInt(s.volume)} unit="GPU-h" source={`Cleared ${fmtUtc(s.clearedAt)}`} />
      </div>
      {band !== null ? (
        <>
          <StepChart orders={stepOrdersFromResult(result)} band={band} floor={floor} tick={params.tick} price={result.price} volume={result.volume} cleared animate={animate} />
          <div className="legend" aria-hidden="true">
            <span className="key long"><span className="swatch" /> Demand: LONG orders, highest first</span>
            <span className="key short"><span className="swatch" /> Supply: SHORT orders, lowest first</span>
            <span className="key"><span className="swatch" style={{ color: "var(--ink)" }} /> Clearing price</span>
            <span className="key"><span className="swatch box" style={{ color: "var(--long-soft)" }} /> What filled LONGs paid</span>
            <span className="key"><span className="swatch box hatched" /> What filled SHORTs paid</span>
          </div>
          <p className="small muted">{stepSummary({ orders: stepOrdersFromResult(result), price: result.price, volume: result.volume, cleared: true, floor, tick: params.tick })} The result keeps only the filled orders (SPEC 12), so the curves show what traded.</p>
        </>
      ) : (
        <Empty>The series record is gone, so the band for this chart is unknown.</Empty>
      )}
      <FillsTable rows={fills} tick={params.tick} />
      <p className="small">
        {s.commits} commit{s.commits === 1 ? "" : "s"}, {s.orders} took part in clearing. {s.outside > 0 ? `${s.outside} did not: void by guard (lock returned at reveal) or never revealed. ` : ""}
        Burned in this round: {fmtUsdOrNone(s.forfeited)} in forfeits and {fmtUsdOrNone(s.fees)} in commit fees. Burned dollars belong to nobody.
        {s.outside > 0 ? ` (${fmtBps(params.forfeit_bps)} of each unrevealed lock)` : ""}. Refunds are each lock minus what it paid; locks are in the commit events, not in this view.
      </p>
      <p className="tiny muted">Series {series?.series ?? "no data"}, round {round}.</p>
    </div>
  );
}

export function FillsTable({ rows, tick }: { rows: ReturnType<typeof fillRows>; tick: number }) {
  if (rows.length === 0) return <Empty>Nothing was filled in this round. A result keeps only filled orders, so there are no rows to list.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <caption>Filled orders, in seq order; unfilled orders are not kept in a result. LONG pays p* per unit filled; SHORT pays band - p*.</caption>
        <thead>
          <tr>
            <th scope="col" className="num collapse-sm">Seq</th>
            <th scope="col">Owner</th>
            <th scope="col">Side</th>
            <th scope="col" className="num collapse-sm">Size</th>
            <th scope="col" className="num collapse-sm">Limit</th>
            <th scope="col" className="num">Filled</th>
            <th scope="col" className="num">Paid</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.seq} className={r.filled === 0 ? "dim" : undefined}>
              <td className="num collapse-sm">{r.seq}</td>
              <td className="mono" title={r.owner}>
                {shortAccount(r.owner)}
                <span className="only-sm tiny muted"> seq {r.seq}, {fmtGpuH(r.size)} at {fmtPrice(r.limit, tick)}</span>
              </td>
              <td><span className={r.side === "Long" ? "side-long" : "side-short"}>{r.side === "Long" ? "LONG" : "SHORT"}</span></td>
              <td className="num collapse-sm">{fmtGpuH(r.size)}</td>
              <td className="num collapse-sm">{fmtPrice(r.limit, tick)}</td>
              <td className="num">
                {fmtInt(r.filled)}
                {r.part ? <span className="tag" style={{ marginLeft: 6 }}>part</span> : null}
              </td>
              <td className="num">{fmtUsdOrNone(r.paid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LiveCurves({ round, series, params }: { round: WireRound | null; series: WireSeries | null; params: WireParams }) {
  const orders = stepOrdersFromRound(round);
  if (!series) return null;
  if (orders.length === 0) return <Empty>No order is revealed yet. The curves appear here as reveals land.</Empty>;
  return (
    <>
      <StepChart orders={orders} band={series.band} floor={series.floor} tick={params.tick} price={null} volume={0} cleared={false} />
      <p className="small muted">Revealed so far: {stepSummary({ orders, price: null, volume: 0, cleared: false, floor: series.floor, tick: params.tick })} The clearing price is set once the round is over and someone calls clear.</p>
    </>
  );
}

export function RecentRounds({ read, series, params, market, current }: { read: Read<[number, WireResult][]> | null; series: number; params: WireParams; market: MarketId; current: number | null }) {
  const list = [...(valueOf(read) ?? [])].reverse();
  if (list.length === 0) return <Empty>No round of series {series} has cleared yet.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <caption>Latest cleared rounds of series {series}</caption>
        <thead>
          <tr>
            <th scope="col" className="num">Round</th>
            <th scope="col" className="num">p*</th>
            <th scope="col" className="num">Volume</th>
            <th scope="col" className="num collapse-sm">Orders</th>
            <th scope="col">Cleared</th>
          </tr>
        </thead>
        <tbody>
          {list.map(([round, r]) => (
            <tr key={round}>
              <td className="num">
                <a href={auctionHref(market, `series=${series}&round=${round}`)} aria-current={round === current ? "true" : undefined}>
                  Round {round}
                </a>
              </td>
              <td className="num">{r.price === null ? <span className="muted">no trade</span> : fmtPrice(r.price, params.tick)}</td>
              <td className="num">{fmtGpuH(r.volume)}</td>
              <td className="num collapse-sm">{r.orders} of {r.commits}</td>
              <td>{fmtUtc(r.cleared_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NoRoundInProgress({ params, now }: { params: WireParams; now: number }) {
  const n = nextOpening(params, now);
  return <Empty>No round in progress. Round 0 of series {n.series} opens {fmtUtc(n.at)}.</Empty>;
}

export function AgentPanel({ market }: { market: MarketId }) {
  return (
    <aside className="state none" aria-labelledby="bid-agent-h">
      <h3 id="bid-agent-h" style={{ fontSize: "var(--t17)" }}>Bid with an agent</h3>
      <p className="small" style={{ marginTop: 8 }}>
        This version of the site reads the chain and does not hold keys. To bid, give an agent a function-call key that can commit, reveal, clear and redeem, and cannot withdraw.
      </p>
      <p style={{ marginTop: 12 }}>
        <Link className="button" href={withMarket("/agents", market)}>Set up an agent</Link>
      </p>
    </aside>
  );
}
