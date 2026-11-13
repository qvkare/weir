// /simulate for one market (server): the simulation's state right after setup, computed at build
// by the same engine, seed and agents the browser's worker uses, so the first paint is the market
// ready to run rather than an empty page. The browser then runs it in a Web Worker.
import { createSimulation } from "@weir/agents/sim";
import { SimApp } from "@/components/front/sim-app.tsx";
import type { MarketId } from "@/lib/config.ts";
import { snapshot, toLines } from "@/lib/sim-snapshot.ts";

const SEED = 7;

export function SimulatePage({ market }: { market: MarketId }) {
  // The same configuration as lib/sim-worker.ts's "init".
  const sim = createSimulation({ seed: SEED, buyers: 3, sellers: 3, makers: 2, noise: 2, market, silentSeries: undefined });
  const initial = { snapshot: snapshot(sim), log: toLines([...sim.log]).slice(-300), seed: SEED };
  return (
    <main id="main">
      <div className="mx-auto max-w-[1278px] px-3 pb-10 pt-8 sm:px-6">
        <header className="mb-6">
          <h1 className="font-display m-0 text-4xl text-foreground">
            A market of agents, <span className="text-muted-foreground">cleared by the real engine.</span>
          </h1>
          <p className="m-0 mt-3 max-w-3xl text-base text-muted-foreground">Buyers, sellers, makers and noise traders seal orders, reveal them and are cleared and settled by the same TypeScript engine the contract is tested against, running in this tab. Every commit pays a fee that is burned, as on chain. Simulation: nothing here touches the chain.</p>
        </header>
        <SimApp market={market} initial={initial} />
      </div>
    </main>
  );
}
