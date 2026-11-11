import type { ReactNode } from "react";
import type { Read } from "@/lib/cache.ts";
import { fmtUtcTime } from "@/lib/format.ts";
import { MARKET_INFO, type MarketId } from "@/lib/config.ts";

/** Grey bars while a block loads. Never a zero. */
export function Skeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="stack" style={{ maxWidth: 520 }}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${90 - i * 17}%`, height: i === 0 ? 40 : 16 }} aria-hidden="true" />
      ))}
    </div>
  );
}

/** A wafer with no dies on it: "nothing here yet". Not deployed: the wafer's edge is dashed too. */
function Level({ dashed = false }: { dashed?: boolean }) {
  const dies: [number, number][] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if (Math.hypot(x - 2, y - 2) < 2.3) dies.push([9 + x * 5.4, 9 + y * 5.4]);
  return (
    <svg className="state-glyph" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
      <circle cx="22" cy="22" r="19" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray={dashed ? "3 3" : undefined} />
      {dies.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="4.4" height="4.4" rx="0.6" fill="none" stroke="currentColor" strokeWidth="0.8" />
      ))}
    </svg>
  );
}

export function NotDeployed({ market, what }: { market: MarketId; what?: string }) {
  return (
    <div className="state none designed" role="note">
      <Level dashed />
      <div>
        <p>
          The {MARKET_INFO[market].name} market is not deployed yet{what ? `, so there is no ${what} to show` : ""}.
        </p>
        <p className="tiny muted">
          The <a href="/simulate">simulation</a> and the <a href="/backtest">backtest</a> run without it.
        </p>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="state none designed">
      <Level />
      <p>{children}</p>
    </div>
  );
}

export function Stale({ children }: { children: ReactNode }) {
  return (
    <div className="state stale" role="note">
      <p>{children}</p>
    </div>
  );
}

/** "The NEAR RPC did not answer. Figures are from 14:02 UTC. Read again" */
export function RpcError({ read, href, model = false }: { read: Read<unknown>; href: string; model?: boolean }) {
  const last = !read.ok && read.lastGood ? Math.floor(read.lastGood.at / 1000) : null;
  return (
    <div className="state error" role="alert">
      <p>
        {model ? "The model could not answer this view." : "The NEAR RPC did not answer."}
        {last ? ` Figures are from ${fmtUtcTime(last)}.` : " No earlier reading is held."}{" "}
        <a className="again" href={href}>
          Read again
        </a>
      </p>
      {!read.ok ? <p className="tiny muted">{read.error}</p> : null}
    </div>
  );
}
