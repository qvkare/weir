// One view of the Weir application for one market, written at build (server): reads the figures
// the page shows first, then hands them to the view, which reads the chain again in the browser.
import { AgentsView, BookView, ClearingsView, ContractsView, PrintsView, RecordView, ReviewView, RoundView, SolvencyView } from "@/components/front/app/views.tsx";
import { NotDeployed, RpcError } from "@/components/state.tsx";
import { viewById } from "@/lib/app-views.ts";
import { buildData, deployments, liveMarkets } from "@/lib/build.ts";
import { valueOf } from "@/lib/cache.ts";
import { MARKET_IDS, MARKET_INFO, type MarketId } from "@/lib/config.ts";
import { loadAgentRows, loadClearings, loadPrintList, loadShell } from "@/lib/data/app.ts";
import { loadAuction } from "@/lib/data/auction.ts";
import { loadHome } from "@/lib/data/home.ts";
import { loadProof } from "@/lib/data/proof.ts";
import { fmtUtc } from "@/lib/format.ts";
import { recordedBundle } from "@/lib/load-server.ts";
import { siteCfg } from "@/lib/site.ts";
import { serverReader, source } from "@/lib/source.ts";
import { TryViewLazy } from "@/components/front/app/try-view-lazy.tsx";
import { AgentsGuide } from "./agents-page.tsx";
import { Audited, contractRows, ParamsTable, SandboxLine, Transactions } from "./proof-page.tsx";

export async function AppPage({ viewId, market }: { viewId: string; market: MarketId }) {
  const view = viewById(viewId);
  const cfg = siteCfg();
  const offered = liveMarkets();
  const markets = MARKET_IDS.filter((m) => offered.includes(m) || m === market);
  const src = source(market);
  const shell = await loadShell(src, markets.filter((m) => m !== market).map((m) => source(m)));
  const common = { cfg, market, view, shell, markets };
  let body;
  switch (view.id) {
    case "round":
      body = <RoundView {...common} initial={await loadAuction(src, null)} />;
      break;
    case "book":
      body = <BookView {...common} initial={await loadAuction(src, null)} />;
      break;
    case "clearings":
      body = <ClearingsView {...common} initial={await loadClearings(src, null)} />;
      break;
    case "prints": {
      const rec = recordedBundle(MARKET_INFO[market].chip);
      body = <PrintsView {...common} initial={await loadPrintList(src)} index={await loadHome(src, { bundlesBase: cfg.bundlesBase, chipSources: [], only: "index" })} sample={rec} />;
      break;
    }
    case "agents": {
      const accounts = buildData().agents.filter((a) => a.market === market).map((a) => ({ account: a.account, role: a.role }));
      body = <AgentsView {...common} initial={await loadAgentRows(src, accounts)} accounts={accounts} guide={await AgentsGuide({ market })} />;
      break;
    }
    case "contracts":
    case "solvency": {
      const rows = contractRows();
      const initial = await loadProof(rows, serverReader, market);
      if (view.id === "solvency") body = <SolvencyView {...common} initial={initial} rows={rows} />;
      else {
        const p = initial.params ? valueOf(initial.params) : null;
        const params = (
          <section id="params" className="border-b border-border px-4 py-6 md:px-6">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="m-0 text-lg font-medium text-foreground">Parameters, {MARKET_INFO[market].name} market</h2>
              <span className="text-xs text-muted-foreground">Read from the contract when this page was published ({fmtUtc(cfg.builtAt)}). Set once at deployment; no method changes them.</span>
            </div>
            {initial.kind === "none" ? <NotDeployed market={market} what="parameter" /> : p ? <ParamsTable p={p} /> : <RpcError read={initial.params!} href="/proof#params" model={initial.kind === "model"} />}
          </section>
        );
        body = <ContractsView {...common} initial={initial} rows={rows} params={params} />;
      }
      break;
    }
    case "try":
      body = <TryViewLazy {...common} />;
      break;
    case "review": {
      const c = await loadProof([], serverReader, market);
      body = <ReviewView {...common} review={<Audited market={market} params={c.params ? valueOf(c.params) : null} kind={c.kind} />} sandbox={<SandboxLine />} />;
      break;
    }
    default:
      body = <RecordView {...common} record={<Transactions />} count={buildData().txs.length} />;
  }
  return (
    <main id="main" className="app-main">
      <div className="mx-auto max-w-[1278px] px-3 pb-10 pt-6 sm:px-6">
        <h1 className="sr-only">
          {view.label}, {MARKET_INFO[market].name} market, NEAR {deployments().network}
        </h1>
        {body}
      </div>
    </main>
  );
}
