import { MarketSwitch } from "@/components/site-nav.tsx";
import { liveMarkets } from "@/lib/build.ts";
import { SimRunner } from "@/components/sim-runner.tsx";
import { MARKET_INFO, type MarketId } from "@/lib/config.ts";

export function SimulatePage({ market }: { market: MarketId }) {
  return (
    <main id="main">
      <div className="ribbon sim" role="note">
        Simulation. Nothing here touches the chain.
      </div>
      <div className="wrap">
        <header className="page-head">
          <span className="eyebrow">Simulate · {MARKET_INFO[market].name} market, {MARKET_INFO[market].delivery}, {MARKET_INFO[market].rounds}</span>
          <MarketSwitch markets={liveMarkets()} />
          <h1>A market of agents, cleared by the real engine</h1>
          <p className="sub">Buyers, sellers, makers and noise traders seal orders, reveal them and are cleared and settled by the same TypeScript engine the contract is tested against, running in a Web Worker in this tab. The index is a seeded random walk starting from the chip&rsquo;s index level. Every commit pays a fee that is burned, as on chain.</p>
        </header>
        <SimRunner market={market} />
      </div>
    </main>
  );
}
