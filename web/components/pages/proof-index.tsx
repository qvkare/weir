"use client";
// /proof: the index chart and the sources behind the last print. Moved here from the homepage.
// Read once when the page opens (and again when the range changes); it does not poll.
import { useEffect, useState } from "react";
import { IndexChartBlock, IndexSources } from "@/components/home-blocks.tsx";
import { LiveBar, useLive } from "@/components/live.tsx";
import { clientSource } from "@/lib/client-source.ts";
import type { MarketId } from "@/lib/config.ts";
import { loadHome, type HomeData } from "@/lib/data/home.ts";
import type { LoadedBundle } from "@/lib/load.ts";
import type { SiteConfig } from "@/lib/site-config.ts";

export function ProofIndex({ cfg, initial, market, sample }: { cfg: SiteConfig; initial: HomeData; market: MarketId; sample: LoadedBundle | null }) {
  const [range, setRange] = useState(initial.chart.range);
  useEffect(() => {
    const r = new URLSearchParams(location.search).get("range");
    if (r && r !== range) setRange(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [st, retry] = useLive<HomeData>({
    initial,
    initialAt: cfg.builtAt * 1000,
    mode: cfg.mode,
    load: async () => {
      const d = await loadHome(clientSource(cfg, market), { range, bundlesBase: cfg.bundlesBase, chipSources: [], only: "index" });
      if (!d.core.status.ok) throw new Error(d.core.status.error);
      return d;
    },
    pollSecs: 0,
    deps: [range],
  });
  const onRange = (id: string) => {
    setRange(id);
    const u = new URL(location.href);
    u.searchParams.set("range", id);
    u.hash = "index";
    history.replaceState(null, "", u);
  };
  const v = { d: st.data, wall: st.from === "build" };
  return (
    <>
      <section className="section" id="index" aria-label="Index history">
        <IndexChartBlock {...v} onRange={onRange} />
        <LiveBar st={st} mode={cfg.mode} builtAt={cfg.builtAt} polls="Read once when the page opens, and again when the range changes." retry={retry} />
      </section>
      <section className="section" id="sources" aria-labelledby="sources-h">
        <div className="section-head">
          <h2 id="sources-h">The index and its sources</h2>
          <a className="note" href="#verifier">
            Re-hash them below
          </a>
        </div>
        <IndexSources {...v} sample={sample} />
      </section>
    </>
  );
}
