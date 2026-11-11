// What the /simulate page shows, taken from a running simulation through the same views the
// chain answers (callView). Plain JSON: bigints become decimal strings, so it crosses postMessage
// and React state without surprises.
import { callView, type WireParams, type WireResult, type WireRound, type WireSeries } from "@weir/engine";
import { agentReports, type SimEvent, type Simulation } from "@weir/agents/sim";

export interface SimConfigInput {
  seed: number;
  market: "weekly" | "fast";
}

export interface SimSnapshot {
  now: number;
  params: WireParams;
  live: null | { series: number; round: number | null; phase: string; phaseEndsAt: number | null; info: WireSeries | null; book: WireRound | null };
  last: null | { series: number; round: number; result: WireResult; info: WireSeries | null };
  lastPrint: { bucket: number; price: number } | null;
  agents: { id: string; role: string; rule: string; deposit: string; balance: string }[];
  /** Per-agent results once at least one series has settled. */
  results: null | { id: string; role: string; long: number; short: number; paid: string; received: string; forfeited: string; result: string }[];
  settled: number;
}

export interface LogLine {
  at: number;
  kind: string;
  agent?: string;
  text: string;
}

export const toLines = (events: SimEvent[]): LogLine[] => events.map((e) => ({ at: e.at, kind: e.kind, agent: e.agent, text: e.text }));

/** The newest cleared round in the log, if any. */
export function lastClear(events: readonly SimEvent[]): { series: number; round: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "clear" && e.data && typeof e.data === "object") {
      const d = e.data as { series?: number; round?: number };
      if (typeof d.series === "number" && typeof d.round === "number") return { series: d.series, round: d.round };
    }
  }
  return null;
}

export function snapshot(sim: Simulation): SimSnapshot {
  const m = sim.market;
  const params = callView(m, "get_params", {});
  const status = callView(m, "get_status", {});
  const l = status.live[0] ?? null;
  const balances = sim.balances();
  const lc = lastClear(sim.log);
  const result = lc ? callView(m, "get_result", lc) : null;
  let settled = 0;
  for (const e of sim.log) if (e.kind === "settle") settled++;
  return {
    now: sim.now(),
    params,
    live: l
      ? {
          series: l.series,
          round: l.round,
          phase: l.phase,
          phaseEndsAt: l.phase_ends_at,
          info: callView(m, "get_series", { series: l.series }),
          book: l.round === null ? null : callView(m, "get_round", { series: l.series, round: l.round }),
        }
      : null,
    last: lc && result ? { ...lc, result, info: callView(m, "get_series", { series: lc.series }) } : null,
    lastPrint: callView(m, "get_last_print", {}),
    agents: sim.agents.map((a) => ({ id: a.id, role: a.role, rule: a.rule, deposit: String(a.deposit), balance: String(balances[a.id] ?? "0") })),
    results:
      settled > 0
        ? agentReports(sim).map((r) => ({ id: r.id, role: r.role, long: r.long, short: r.short, paid: r.paid.toString(), received: r.received.toString(), forfeited: r.forfeited.toString(), result: r.result.toString() }))
        : null,
    settled,
  };
}
