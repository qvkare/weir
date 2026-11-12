"use client";
import { EyeIcon, LockIcon } from "@/components/icons.tsx";
import { LiveBar, useLive } from "@/components/live.tsx";
import { Empty, NotDeployed, RpcError } from "@/components/state.tsx";
import { valueOf } from "@/lib/cache.ts";
import { clientReader } from "@/lib/client-source.ts";
import type { MarketId } from "@/lib/config.ts";
import { loadAgents, type AgentsData } from "@/lib/data/agents.ts";
import { fmtGpuH, fmtInt, fmtUsd, shortAccount } from "@/lib/format.ts";
import type { SiteConfig } from "@/lib/site-config.ts";

export function AgentsBook({ cfg, initial, market }: { cfg: SiteConfig; initial: AgentsData; market: MarketId }) {
  const [st, retry] = useLive<AgentsData>({
    initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const d = await loadAgents(clientReader(cfg, market));
      if (!d.core.status.ok) throw new Error(d.core.status.error);
      return d;
    },
    pollSecs: 0,
  });
  const d = st.data;
  const bar = <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls="Read once when the page opens; it does not poll." retry={retry} />;
  if (d.core.kind === "none") return <NotDeployed market={market} what="book" />;
  if (!valueOf(d.core.params) || !valueOf(d.core.status)) return <>{bar}<RpcError read={!d.core.params.ok ? d.core.params : d.core.status} href="/agents" model={d.core.kind === "model"} /></>;
  const { list, unknown, skipped } = d;
  const notes = `${unknown ? ` The keys of ${unknown} account${unknown === 1 ? "" : "s"} could not be read.` : ""}${skipped ? ` ${skipped} more account${skipped === 1 ? " was" : "s were"} not asked about.` : ""}`;
  return (
    <>
      {bar}
      {list.length === 0 ? (
        <div style={{ marginTop: 16 }}><Empty>No commit in the live and last ten cleared rounds came from an account that holds only function-call keys.{notes}</Empty></div>
      ) : (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Series, round, seq</th>
                <th scope="col">Side</th>
                <th scope="col" className="num">Size</th>
                <th scope="col" className="num collapse-sm">Lock</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={`${e.series}-${e.round}-${e.seq}-${e.state}`}>
                  <td className="mono" title={e.owner}>{shortAccount(e.owner)}</td>
                  <td>
                    {e.series}, {e.round}, {e.seq}
                  </td>
                  <td>{e.side ? <span className={e.side === "Long" ? "side-long" : "side-short"}>{e.side === "Long" ? "LONG" : "SHORT"}</span> : <span className="lock-cell"><LockIcon /> sealed</span>}</td>
                  <td className="num">{e.size !== null ? fmtGpuH(e.size) : <span className="lock-cell"><LockIcon /></span>}</td>
                  <td className="num collapse-sm">{e.lock ? fmtUsd(e.lock) : <span className="muted">cleared</span>}</td>
                  <td>{e.state === "Cleared" ? `filled ${fmtInt(e.filled ?? 0)}` : e.state === "Revealed" ? <><EyeIcon /> revealed</> : e.state === "Void" ? <span className="flag">void</span> : "sealed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {notes ? <p className="tiny muted" style={{ marginTop: 8 }}>{notes.trim()}</p> : null}
          {d.core.kind === "model" ? <p className="tiny flag" style={{ marginTop: 8 }}>Model: which accounts hold only function-call keys is set by the script, not read from the chain.</p> : null}
        </div>
      )}
    </>
  );
}
