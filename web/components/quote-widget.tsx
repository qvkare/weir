"use client";
import { useId, useState } from "react";

const CHAINS = [
  { id: "base", label: "Base" },
  { id: "arbitrum", label: "Arbitrum" },
  { id: "ethereum", label: "Ethereum" },
  { id: "solana", label: "Solana" },
] as const;

type Answer = { ok: true; body: Record<string, unknown> } | { ok: false; message: string } | null;

/** Asks this site's /api/quote for a dry quote. Nothing is signed or sent. */
export function QuoteWidget() {
  const id = useId();
  const [from, setFrom] = useState<string>("arbitrum");
  const [amount, setAmount] = useState("20");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer>(null);
  const ask = async () => {
    setBusy(true);
    setAnswer(null);
    try {
      const res = await fetch(`/api/quote?from=${from}&amount=${encodeURIComponent(amount)}`);
      const body = (await res.json()) as Record<string, unknown>;
      const msg = String((body.error as { message?: string })?.message ?? `HTTP ${res.status}`);
      if (res.status === 502) setAnswer({ ok: false, message: /not available|pair/i.test(msg) ? "this pair is not available from NEAR Intents right now. Try another chain." : `NEAR Intents gave no quote (${msg}).` });
      else if (!res.ok) setAnswer({ ok: false, message: msg });
      else setAnswer({ ok: true, body });
    } catch (e) {
      setAnswer({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="state none">
      <p className="small" style={{ marginBottom: 12 }}>
        A dry quote: what a solver would deliver on NEAR today. Nothing is signed or sent.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
        <div className="field" style={{ minWidth: 140 }}>
          <label htmlFor={`${id}-from`}>From</label>
          <select id={`${id}-from`} value={from} onChange={(e) => setFrom(e.target.value)}>
            {CHAINS.map((c) => (
              <option key={c.id} value={c.id}>
                USDC on {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ width: 120 }}>
          <label htmlFor={`${id}-amt`}>USDC</label>
          <input id={`${id}-amt`} type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <button type="button" className="button" onClick={ask} disabled={busy}>
          {busy ? "Asking" : "Get a quote"}
        </button>
      </div>
      <div aria-live="polite" className="small" style={{ marginTop: 12 }}>
        {answer?.ok ? (
          <dl className="kv">
            {Object.entries(answer.body)
              .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
              .map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
          </dl>
        ) : answer ? (
          <p className="bad">No quote: {answer.message}</p>
        ) : null}
      </div>
    </div>
  );
}
