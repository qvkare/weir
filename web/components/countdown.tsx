"use client";
import { useEffect, useState } from "react";
import { fmtCountdown } from "@/lib/format.ts";

/**
 * Seconds until `endsAt`, ticking once a second. The first render uses the server's clock so
 * the HTML and the hydrated text agree; after that the browser's clock, corrected by the
 * difference seen at load.
 */
export function Countdown({ endsAt, serverNow, className }: { endsAt: number; serverNow: number; className?: string }) {
  const [left, setLeft] = useState(endsAt - serverNow);
  useEffect(() => {
    const skew = serverNow - Date.now() / 1000;
    const tick = () => setLeft(endsAt - (Date.now() / 1000 + skew));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAt, serverNow]);
  return (
    <time className={className ?? "countdown"} dateTime={`PT${Math.max(0, Math.floor(left))}S`}>
      {fmtCountdown(left)}
    </time>
  );
}
