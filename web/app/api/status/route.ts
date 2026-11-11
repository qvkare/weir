import { deployments } from "@/lib/build.ts";
import { fail, json } from "@/lib/api.ts";
import { valueOf } from "@/lib/cache.ts";
import { MARKET_IDS, type MarketId } from "@/lib/config.ts";
import { loadCore, loadLastClearing } from "@/lib/load.ts";

export const dynamic = "force-dynamic";

/** GET /api/status?m=weekly|fast: get_status, the parameters, the last print and each live series. */
export async function GET(request: Request) {
  const m = new URL(request.url).searchParams.get("m") ?? "weekly";
  if (!MARKET_IDS.includes(m as MarketId)) return fail(400, "bad_market", `m must be one of ${MARKET_IDS.join(", ")}.`);
  const market = m as MarketId;
  const core = await loadCore(market);
  if (core.src.kind === "none") return fail(404, "not_deployed", `The ${market} market is not deployed yet: deployments.json lists no contract for it.`);
  const status = valueOf(core.status);
  const params = valueOf(core.params);
  if (!status || !params) {
    const err = !core.status.ok ? core.status.error : !core.params.ok ? core.params.error : "no data";
    return fail(503, "rpc_unavailable", `The NEAR RPC did not answer: ${err}`);
  }
  const series = await Promise.all(
    status.live.map(async (l) => {
      const info = valueOf(await core.src.view("get_series", { series: l.series }));
      const c = info ? await loadLastClearing(core, l.series) : null;
      const t = c?.traded;
      return {
        ...l,
        floor: info?.floor ?? null,
        band: info?.band ?? null,
        open_sets: info?.open_sets ?? null,
        last_clearing: t ? { round: t.round, price: t.result.price, forward: info && t.result.price !== null ? info.floor + t.result.price : null, volume: t.result.volume, cleared_at: t.result.cleared_at } : null,
      };
    }),
  );
  return json(
    {
      market,
      source: core.src.kind,
      contract: core.src.contract,
      network: deployments().network,
      units: { prices: "micro-USD per GPU-hour", amounts: "micro-USDC as decimal strings", sizes: "GPU-hours", times: "Unix seconds, UTC" },
      stale: !core.status.ok,
      status,
      params,
      last_print: valueOf(core.last),
      series,
    },
    200,
    2,
  );
}
