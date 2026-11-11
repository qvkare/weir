import { fail, intParam, json } from "@/lib/api.ts";
import { valueOf } from "@/lib/cache.ts";
import { MARKET_IDS, type MarketId } from "@/lib/config.ts";
import { source } from "@/lib/source.ts";

export const dynamic = "force-dynamic";

/** GET /api/round?m=&series=&round=: the sealed book of an open round, or the result of a cleared one. */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const m = q.get("m") ?? "weekly";
  if (!MARKET_IDS.includes(m as MarketId)) return fail(400, "bad_market", `m must be one of ${MARKET_IDS.join(", ")}.`);
  const series = intParam(q.get("series"));
  const round = intParam(q.get("round"));
  if (series === null || round === null) return fail(400, "bad_round", "series and round must be whole numbers, for example /api/round?m=fast&series=7460&round=3.");
  const src = source(m as MarketId);
  if (src.kind === "none") return fail(404, "not_deployed", `The ${m} market is not deployed yet: deployments.json lists no contract for it.`);
  const [r, res, s] = await Promise.all([src.view("get_round", { series, round }), src.view("get_result", { series, round }), src.view("get_series", { series })]);
  const failed = [r, res, s].find((x) => !x.ok);
  if (failed && !failed.ok) return fail(503, "rpc_unavailable", `The NEAR RPC did not answer: ${failed.error}`);
  const book = valueOf(r);
  const result = valueOf(res);
  const info = valueOf(s);
  if (!book && !result) return fail(404, "no_round", `Series ${series} has no commits or result for round ${round}: it has not started, held no commits, or its result was pruned after settlement.`);
  return json(
    {
      market: m,
      source: src.kind,
      series,
      round,
      state: result ? "cleared" : "open",
      band: info ? { floor: info.floor, band: info.band } : null,
      book,
      result,
    },
    200,
    result ? 60 : 2,
  );
}
