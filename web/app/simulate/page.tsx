import type { Metadata } from "next";
import { SimRunner } from "@/components/sim-runner.tsx";
import { marketFromParam, MARKET_INFO } from "@/lib/config.ts";

export const metadata: Metadata = { title: "Simulate", description: "Scripted agents trade a whole Weir market in your browser, cleared and settled by the real engine. Nothing touches the chain." };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function SimulatePage({ searchParams }: { searchParams: Search }) {
  const market = marketFromParam((await searchParams).m);
  return (
    <main id="main">
      <div className="ribbon sim" role="note">
        Simulation. Nothing here touches the chain.
      </div>
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">Simulate · {MARKET_INFO[market].name} market, {MARKET_INFO[market].delivery}, {MARKET_INFO[market].rounds}</span>
          <h1>A market of agents, cleared by the real engine</h1>
          <p className="sub">Buyers, sellers, makers and noise traders seal orders, reveal them and are cleared and settled by the same TypeScript engine the contract is tested against, running in a Web Worker in this tab. The index is a seeded random walk starting from the chip&rsquo;s index level. Every commit pays a fee that is burned, as on chain.</p>
        </header>
        <SimRunner market={market} />
      </div>
    </main>
  );
}
