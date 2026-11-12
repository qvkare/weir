"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtUtc } from "@/lib/format.ts";
import type { SourceKind } from "@/lib/source-types.ts";

// The live layer every data page shares. The static page carries the figures the build read (with
// their time); in the browser the page reads the chain itself, straight from the RPC endpoints,
// and replaces them. It then polls one cheap fingerprint (the round in progress and the last
// print) and reads everything again only when that changes. Polling stops while the tab is
// hidden. A failed read keeps the last figures, says which endpoint said what, and offers a retry.

export interface LiveState<T> {
  data: T;
  /** Where the figures on screen came from. */
  from: "build" | "live";
  /** When they were read, ms. */
  at: number;
  error: string | null;
  busy: boolean;
}

export interface LiveOptions<T> {
  initial: T;
  initialAt: number;
  mode: SourceKind;
  /** Reads everything again. Returns the data, or throws with a message naming what failed. */
  load: () => Promise<T>;
  /** A cheap fingerprint of the chain's state; null when it could not be read. */
  probe?: () => Promise<string | null>;
  keyOf?: (d: T) => string;
  /** Seconds between probes while the tab is visible; 0 to read once and stop. */
  pollSecs: number;
  /** Changes when the page wants a different read (another round, another range). */
  deps?: unknown[];
}

export function useLive<T>(o: LiveOptions<T>): [LiveState<T>, () => void] {
  const [st, setSt] = useState<LiveState<T>>({ data: o.initial, from: "build", at: o.initialAt, error: null, busy: o.mode === "chain" });
  const seq = useRef(0);
  const key = useRef<string | null>(null);
  const opts = useRef(o);
  opts.current = o;

  const run = useCallback(async () => {
    if (opts.current.mode !== "chain") return;
    const n = ++seq.current;
    setSt((s) => ({ ...s, busy: true }));
    try {
      const data = await opts.current.load();
      if (n !== seq.current) return;
      key.current = opts.current.keyOf ? opts.current.keyOf(data) : null;
      setSt({ data, from: "live", at: Date.now(), error: null, busy: false });
    } catch (e) {
      if (n !== seq.current) return;
      setSt((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), busy: false }));
    }
  }, []);

  // Read on mount, and again whenever the page asks for something else.
  const depKey = JSON.stringify(o.deps ?? []);
  useEffect(() => {
    void run();
  }, [run, depKey]);

  // Poll the fingerprint while visible; read again when it moves.
  useEffect(() => {
    if (o.mode !== "chain" || !o.pollSecs || !o.probe) return;
    let timer = 0;
    const tick = async () => {
      if (document.hidden) return;
      const k = await opts.current.probe!();
      if (k !== null && k !== key.current) void run();
    };
    const start = () => {
      window.clearInterval(timer);
      timer = window.setInterval(() => void tick(), o.pollSecs * 1000);
    };
    const onVis = () => {
      if (document.hidden) window.clearInterval(timer);
      else {
        void tick();
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [o.mode, o.pollSecs, o.probe, run]);

  return [st, run];
}

const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** One line above a page's live figures: where they came from, when, and what is polled. */
export function LiveBar({ st, mode, builtAt, polls, retry, className }: { st: LiveState<unknown>; mode: SourceKind; builtAt: number; polls: string; retry: () => void; /** Added to "live-bar": "quiet" drops the box. */ className?: string }) {
  const cls = (base: string) => (className ? `${base} ${className}` : base);
  if (mode === "model") {
    return (
      <p className={cls("live-bar")} role="status">
        <span className="live-dot model" aria-hidden="true" /> Model figures, computed when the site was built ({fmtUtc(builtAt)}). They do not change in the browser.
      </p>
    );
  }
  if (mode === "none") return null;
  if (st.error) {
    return (
      <div className={cls("live-bar error")} role="alert">
        <span className="live-dot bad" aria-hidden="true" />
        <span>
          Could not read the chain just now: {st.error}. {st.from === "live" ? `Showing figures read at ${hms(st.at)} UTC.` : `Showing figures from the build (${fmtUtc(Math.floor(st.at / 1000))}).`}
        </span>
        <button type="button" className="button ghost live-retry" onClick={retry} disabled={st.busy}>
          {st.busy ? "Reading…" : "Try again"}
        </button>
      </div>
    );
  }
  if (st.from === "build") {
    return (
      <p className={cls("live-bar")} role="status">
        <span className="live-dot stale" aria-hidden="true" /> Figures from the build ({fmtUtc(Math.floor(st.at / 1000))}), not live. {st.busy ? "Reading NEAR testnet now…" : null}
      </p>
    );
  }
  return (
    <p className={cls("live-bar")} role="status">
      <span className="live-dot" aria-hidden="true" /> Read from NEAR testnet at {hms(st.at)} UTC, in this browser. {polls}
    </p>
  );
}
