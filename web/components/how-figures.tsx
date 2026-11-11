"use client";
// The five drawings on /how as short sequences: each can be played, paused and stepped by
// hand. The markup is the last frame; lib/how-scores.ts says when each part appears.
import { useMemo } from "react";
import { clearingScore, commitScore, fundingScore, seriesClockScore, settlementScore } from "@/lib/how-scores.ts";
import type { StepOrder } from "@/lib/step.ts";
import { ClearingChart } from "./clearing-film.tsx";
import { CheckIcon, LockIcon } from "./icons.tsx";
import { MotionFigure } from "./motion-figure.tsx";

// 1. The series clock

export interface ClockLabels {
  lead: string;
  commit: string;
  reveal: string;
  cutoff: string;
  period: string;
  grace: string;
}

const ROUNDS = 8;

export function SeriesClockFigure({ labels, series, summary }: { labels: ClockLabels; series: number; summary: string }) {
  const score = useMemo(() => seriesClockScore({ ...labels, rounds: ROUNDS }), [labels]);
  return <MotionFigure name="the series clock" score={score} summary={summary} render={(w) => <Clock width={w ?? 640} series={series} labels={labels} />} />;
}

function Clock({ width, series, labels }: { width: number; series: number; labels: ClockLabels }) {
  const narrow = width < 520;
  const x0 = 4;
  const L = width - 8;
  // Not to scale: the auction window and delivery are drawn at fixed shares so each part is legible.
  const a = { x: x0, w: L * 0.46 };
  const d = { x: x0 + L * 0.52, w: L * 0.34 };
  const gr = { x: d.x + d.w, w: L * 0.06 };
  const settleX = gr.x + gr.w;
  const lane = { y: 46, h: 22 };
  const rw = a.w / ROUNDS;
  const H = narrow ? 150 : 140;
  return (
    <svg className="how-svg" viewBox={`0 0 ${width} ${H}`} width="100%" height={H} aria-hidden="true">
      <defs>
        <pattern id={`hatch-clock-${series}`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="var(--paper)" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="var(--ink-2)" strokeWidth="1.5" />
        </pattern>
      </defs>
      <text data-track="auction-label" x={a.x} y={lane.y - 12}>
        {narrow ? "Auction" : `Auction window, opens ${labels.lead} before delivery`}
      </text>
      <rect data-track="auction" data-origin="left" x={a.x} y={lane.y} width={a.w} height={lane.h} fill="none" stroke="var(--ink)" />
      <rect data-track="r0-commit" data-origin="left" x={a.x} y={lane.y} width={rw * 0.55} height={lane.h} fill="var(--ink)" />
      <rect data-track="r0-reveal" data-origin="left" x={a.x + rw * 0.55} y={lane.y} width={rw * 0.45 - 2} height={lane.h} fill={`url(#hatch-clock-${series})`} stroke="var(--ink)" strokeWidth={0.5} />
      {Array.from({ length: ROUNDS - 1 }, (_, i) => (
        <g key={i} data-track={`r${i + 1}`}>
          <rect x={a.x + rw * (i + 1)} y={lane.y} width={rw * 0.55} height={lane.h} fill="var(--ink)" />
          <rect x={a.x + rw * (i + 1.55)} y={lane.y} width={rw * 0.45 - 2} height={lane.h} fill={`url(#hatch-clock-${series})`} stroke="var(--ink)" strokeWidth={0.5} />
        </g>
      ))}
      <g data-track="round-label">
        <path d={`M${a.x},${lane.y + lane.h + 6}v4h${rw - 2}v-4`} fill="none" stroke="var(--ink)" />
        <text x={a.x} y={lane.y + lane.h + 24}>
          {narrow ? "1 round" : `1 round: ${labels.commit} + ${labels.reveal}`}
        </text>
      </g>
      <g data-track="cutoff">
        <line x1={a.x + a.w + 2} x2={a.x + a.w + 2} y1={lane.y - 6} y2={lane.y + lane.h + 34} stroke="var(--long)" strokeWidth={2} />
      </g>
      <text data-track="cutoff-label" className="long" x={a.x + a.w + 6} y={lane.y + lane.h + 46} textAnchor={narrow ? "middle" : "start"}>
        Cutoff
      </text>
      <text data-track="delivery-label" x={d.x} y={lane.y - 12}>
        {narrow ? "Delivery" : `Delivery, ${labels.period}`}
      </text>
      <rect data-track="delivery" data-origin="left" x={d.x} y={lane.y} width={d.w} height={lane.h} fill="var(--panel)" stroke="var(--ink)" />
      <g data-track="prints">
        {Array.from({ length: 14 }, (_, i) => (
          <line key={i} x1={d.x + ((i + 0.5) * d.w) / 14} x2={d.x + ((i + 0.5) * d.w) / 14} y1={lane.y + 6} y2={lane.y + lane.h - 6} stroke="var(--ink-2)" />
        ))}
      </g>
      <rect data-track="grace" data-origin="left" x={gr.x} y={lane.y + lane.h / 2 - 1} width={gr.w} height={2} fill="var(--ink-3)" />
      <g data-track="settle">
        <rect x={settleX - 6} y={lane.y + lane.h / 2 - 6} width={12} height={12} fill="var(--short)" transform={`rotate(45 ${settleX} ${lane.y + lane.h / 2})`} />
      </g>
      <text data-track="settle-label" className="short" x={settleX + (narrow ? 0 : 0)} y={lane.y + lane.h + 46} textAnchor="end">
        Settle
      </text>
      <text x={width - 4} y={H - 4} textAnchor="end" className="how-note">
        Series {series}, not to scale
      </text>
    </svg>
  );
}

// 2. Commit and reveal

export interface CommitExample {
  sideText: string;
  size: string;
  price: string;
  salt: string;
  preimage: string;
  hash: string;
  lock: string;
}

export function CommitFigure({ ex, summary }: { ex: CommitExample; summary: string }) {
  const score = useMemo(() => commitScore(), []);
  const parts = ex.preimage.split("|");
  return (
    <MotionFigure
      name="commit and reveal"
      score={score}
      summary={summary}
      render={() => (
        <div className="cr">
          <div className="cr-card" data-track="order">
            <span className="cr-k">Your order</span>
            <span className="cr-fields" data-track="order-fields">
              <span className="side-long">{ex.sideText}</span> · {ex.size} · LONG price {ex.price}
            </span>
          </div>
          <div className="cr-hashing" data-track="preimage">
            <p className="preimage">
              {parts.map((part, i) => (
                <span key={i}>
                  <span className="part" data-track={i === parts.length - 1 ? "salt" : undefined}>
                    {part}
                  </span>
                  {i < parts.length - 1 ? "|" : ""}
                </span>
              ))}
            </p>
            <p className="cr-hash" data-track="hash">
              <span className="cr-k">sha256</span> <span className="mono">{ex.hash}</span>
            </p>
          </div>
          <span className="cr-arrow" data-track="arrow-1" data-origin="top" aria-hidden="true" />
          <div className="cr-card cr-chain" data-track="chain">
            <span className="cr-k">On chain while commits are open</span>
            <span className="cr-row">
              <span className="mono">{ex.hash.slice(0, 12)}…</span>
              <span>lock {ex.lock}</span>
              <span className="lock-cell">
                <LockIcon /> side
              </span>
              <span className="lock-cell">
                <LockIcon /> size
              </span>
              <span className="lock-cell">
                <LockIcon /> price
              </span>
            </span>
          </div>
          <span className="cr-arrow" data-track="arrow-2" data-origin="top" aria-hidden="true" />
          <div className="cr-card cr-reveal" data-track="reveal">
            <span className="cr-k">Reveal: order and salt</span>
            <span className="cr-row">
              <span className="cr-check" data-track="check">
                <CheckIcon /> same hash
              </span>
              <span data-track="revealed">
                <span className="side-long">{ex.sideText}</span> {ex.size} at {ex.price}, in the round
              </span>
            </span>
          </div>
        </div>
      )}
    />
  );
}

// 3. Clearing

export function ClearingFigure({ orders, band, price, volume, tick, priceText, fillsText, summary }: { orders: StepOrder[]; band: number; price: number; volume: number; tick: number; priceText: string; fillsText: string; summary: string }) {
  const score = useMemo(() => clearingScore({ price: priceText, fills: fillsText }), [priceText, fillsText]);
  return (
    <MotionFigure
      name="the clearing"
      score={score}
      summary={summary}
      render={(w) => (
        <>
          <ul className="chips" data-track="chips">
            {orders.map((o) => (
              <li key={o.seq} className={o.side === "Long" ? "is-long" : "is-short"}>
                <b>{o.owner}</b> {o.side === "Long" ? "LONG" : "SHORT"} {o.size} GPU-h, limit {priceLabel(o.price, tick)}
              </li>
            ))}
          </ul>
          <ClearingChart orders={orders} band={band} price={price} volume={volume} tick={tick} width={w} fillLabels />
        </>
      )}
    />
  );
}

const priceLabel = (micro: number, tick: number) => {
  const dec = tick >= 10_000 ? 2 : 3;
  return `$${(micro / 1e6).toFixed(dec)}`;
};

// 4. Settlement

export interface SettlementExample {
  floor: number;
  band: number;
  prints: number[];
  fixing: number;
  longPay: number;
  tick: number;
  text: { floor: string; cap: string; fixing: string; long: string; short: string; band: string; prints: string[] };
}

export function SettlementFigure({ ex, summary }: { ex: SettlementExample; summary: string }) {
  const score = useMemo(() => settlementScore(ex.prints.length, { band: `${ex.text.floor} to ${ex.text.cap}`, fixing: ex.text.fixing, long: ex.text.long, short: ex.text.short }), [ex]);
  return (
    <MotionFigure
      name="the settlement"
      score={score}
      summary={summary}
      render={(w) => (
        <>
          <SettleChart ex={ex} width={w ?? 640} />
          <div className="pay" aria-hidden="true">
            <div className="pay-bar">
              <span className="pay-long" data-track="pay-long" data-origin="left" style={{ width: `${(ex.longPay / ex.band) * 100}%` }}>
                <span data-track="pay-long-label">LONG {ex.text.long}</span>
              </span>
              <span className="pay-short" data-track="pay-short" data-origin="left" style={{ width: `${(1 - ex.longPay / ex.band) * 100}%` }}>
                <span data-track="pay-short-label">SHORT {ex.text.short}</span>
              </span>
            </div>
            <p className="pay-total tiny" data-track="pay-total">
              Per unit, LONG and SHORT together: {ex.text.band}, the band. Paid from the dollars locked at the open.
            </p>
          </div>
        </>
      )}
    />
  );
}

function SettleChart({ ex, width }: { ex: SettlementExample; width: number }) {
  const narrow = width < 520;
  const H = narrow ? 200 : 230;
  const plot = { x0: narrow ? 44 : 56, x1: width - (narrow ? 64 : 120), y0: 16, y1: H - 26 };
  const lo = ex.floor - ex.band * 0.3;
  const hi = ex.floor + ex.band * 1.3;
  const Y = (p: number) => plot.y1 - ((p - lo) / (hi - lo)) * (plot.y1 - plot.y0);
  const n = ex.prints.length;
  const X = (i: number) => plot.x0 + ((i + 0.5) / n) * (plot.x1 - plot.x0);
  let sum = 0;
  const running = ex.prints.map((p, i) => {
    sum += p;
    return `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(sum / (i + 1)).toFixed(1)}`;
  });
  const fy = Y(ex.fixing);
  return (
    <svg className="how-svg" viewBox={`0 0 ${width} ${H}`} width="100%" height={H} aria-hidden="true">
      <g data-track="band">
        <rect x={plot.x0} y={Y(ex.floor + ex.band)} width={plot.x1 - plot.x0} height={Y(ex.floor) - Y(ex.floor + ex.band)} fill="var(--panel)" />
        <line x1={plot.x0} x2={plot.x1} y1={Y(ex.floor)} y2={Y(ex.floor)} stroke="var(--ink-3)" />
        <line x1={plot.x0} x2={plot.x1} y1={Y(ex.floor + ex.band)} y2={Y(ex.floor + ex.band)} stroke="var(--ink-3)" />
      </g>
      <g data-track="band-label">
        <text x={plot.x0 - 6} y={Y(ex.floor) + 4} textAnchor="end">
          {ex.text.floor}
        </text>
        <text x={plot.x0 - 6} y={Y(ex.floor + ex.band) + 4} textAnchor="end">
          {ex.text.cap}
        </text>
        <text x={plot.x0 + 6} y={Y(ex.floor + ex.band) + 14} className="how-note">
          Band
        </text>
      </g>
      <g data-track="axes">
        <line className="axis" x1={plot.x0} x2={plot.x1} y1={plot.y1} y2={plot.y1} />
        <text x={plot.x0} y={plot.y1 + 18}>
          Delivery week
        </text>
        <text x={plot.x1} y={plot.y1 + 18} textAnchor="end">
          {narrow ? "" : `${n} example prints`}
        </text>
      </g>
      <path data-track="average" d={running.join("")} pathLength={1} style={{ strokeDasharray: 1 }} fill="none" stroke="var(--ink)" strokeWidth={2} />
      {ex.prints.map((p, i) => (
        <circle key={i} data-track={`p${i}`} cx={X(i)} cy={Y(p)} r={4} fill="var(--paper)" stroke="var(--ink)" strokeWidth={1.5}>
          <title>{ex.text.prints[i]}</title>
        </circle>
      ))}
      <g data-track="fixing">
        <line x1={plot.x0} x2={plot.x1 + 6} y1={fy} y2={fy} stroke="var(--ink)" strokeDasharray="4 3" />
        <text x={plot.x1 + 10} y={fy - 4} className="ink">
          Fixing
        </text>
        <text x={plot.x1 + 10} y={fy + 12} className="ink">
          {ex.text.fixing}
        </text>
      </g>
    </svg>
  );
}

// 5. Funding

export function FundingFigure({ recorded, summary }: { recorded: boolean; summary: string }) {
  const score = useMemo(() => fundingScore(recorded), [recorded]);
  return (
    <MotionFigure
      name="the funding path"
      score={score}
      summary={summary}
      render={() => (
        <ol className="flow">
          <li className="flow-step" data-track="chains">
            <span className="flow-k">Start</span>
            <span className="flow-chains">
              {["Base", "Arbitrum", "Ethereum", "Solana"].map((c) => (
                <span key={c} className="flow-chip">
                  USDC, {c}
                </span>
              ))}
            </span>
          </li>
          <li className="flow-link" aria-hidden="true">
            <span data-track="link-1" data-origin="top" className={recorded ? undefined : "dashed"} />
          </li>
          <li className={`flow-step${recorded ? "" : " unproven"}`} data-track="intents">
            <span className="flow-k">NEAR Intents</span>
            <span>A solver quotes and delivers{recorded ? "" : ". No transfer on record yet"}</span>
          </li>
          <li className="flow-link" aria-hidden="true">
            <span data-track="link-2" data-origin="top" />
          </li>
          <li className="flow-step" data-track="near">
            <span className="flow-k">USDC on NEAR</span>
            <span>Your account</span>
          </li>
          <li className="flow-link" aria-hidden="true">
            <span data-track="link-3" data-origin="top" />
            <code>ft_transfer_call</code>
          </li>
          <li className="flow-step flow-weir" data-track="weir">
            <span className="flow-k">Weir</span>
            <span>Your free balance, ready to commit</span>
          </li>
        </ol>
      )}
    />
  );
}
