// The site's three read-only JSON endpoints. They run in the site's Worker (worker/index.ts) with
// the browser's RPC source, and in the smoke test with the model. No build data is imported here,
// so the Worker stays small.
import { IntentsClient, summarize, usdcToNear, usdcUnits, type Chain } from "@weir/chain";
import { fail, intParam, json } from "./api.ts";
import { valueOf } from "./cache.ts";
import { MARKET_IDS, parseMarket, type MarketId } from "./config.ts";
import { loadCore, loadLastClearing } from "./load.ts";
import type { Source } from "./source-types.ts";

export interface ApiContext {
  network: string;
  sourceOf: (m: MarketId) => Source;
  /** A NEAR mainnet account named as the recipient of dry quotes; default a 64-hex implicit account. */
  quoteRecipient?: string;
}

const badMarket = () => fail(400, "bad_market", `m must be one of ${MARKET_IDS.join(", ")} (weekly and fast still mean the H100 markets).`);
const notDeployed = (m: MarketId) => fail(404, "not_deployed", `The ${m} market is not deployed yet: deployments.json lists no contract for it.`);

/** GET /api/status?m=<market>: get_status, the parameters, the last print and each live series. */
export async function apiStatus(ctx: ApiContext, q: URLSearchParams): Promise<Response> {
  const market = parseMarket(q.get("m"));
  if (!market) return badMarket();
  const src = ctx.sourceOf(market);
  if (src.kind === "none") return notDeployed(market);
  const core = await loadCore(src);
  const status = valueOf(core.status);
  const params = valueOf(core.params);
  if (!status || !params) {
    const err = !core.status.ok ? core.status.error : !core.params.ok ? core.params.error : "no data";
    return fail(503, "rpc_unavailable", `The NEAR RPC did not answer: ${err}`);
  }
  const series = await Promise.all(
    status.live.map(async (l) => {
      const info = valueOf(await src.view("get_series", { series: l.series }));
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
      source: src.kind,
      contract: src.contract,
      network: ctx.network,
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

/** GET /api/round?m=&series=&round=: the sealed book of an open round, or the result of a cleared one. */
export async function apiRound(ctx: ApiContext, q: URLSearchParams): Promise<Response> {
  const m = parseMarket(q.get("m"));
  if (!m) return badMarket();
  const series = intParam(q.get("series"));
  const round = intParam(q.get("round"));
  if (series === null || round === null) return fail(400, "bad_round", "series and round must be whole numbers, for example /api/round?m=h100-fast&series=7460&round=3.");
  const src = ctx.sourceOf(m);
  if (src.kind === "none") return notDeployed(m);
  const [r, res, s] = await Promise.all([src.view("get_round", { series, round }), src.view("get_result", { series, round }), src.view("get_series", { series })]);
  const failed = [r, res, s].find((x) => !x.ok);
  if (failed && !failed.ok) return fail(503, "rpc_unavailable", `The NEAR RPC did not answer: ${failed.error}`);
  const book = valueOf(r);
  const result = valueOf(res);
  const info = valueOf(s);
  if (!book && !result) return fail(404, "no_round", `Series ${series} has no commits or result for round ${round}: it has not started, held no commits, or its result was pruned after settlement.`);
  return json({ market: m, source: src.kind, series, round, state: result ? "cleared" : "open", band: info ? { floor: info.floor, band: info.band } : null, book, result }, 200, result ? 60 : 2);
}

const FROM: Record<string, Exclude<Chain, "near">> = { base: "base", arbitrum: "arb", ethereum: "eth", solana: "sol" };

// A dry quote needs a recipient that exists on NEAR mainnet or is a 64-hex implicit account.
// Nothing is sent to it: the quote is dry.
const RECIPIENT = "0".repeat(64);


/** GET /api/quote?from=base|arbitrum|ethereum|solana&amount=20: a dry NEAR Intents (1Click) quote, USDC to USDC on NEAR. */
export async function apiQuote(q: URLSearchParams, recipient = RECIPIENT): Promise<Response> {
  const from = FROM[q.get("from") ?? ""];
  if (!from) return fail(400, "bad_from", `from must be one of ${Object.keys(FROM).join(", ")}.`);
  let units: string;
  try {
    units = usdcUnits(q.get("amount") ?? "20");
  } catch (e) {
    return fail(400, "bad_amount", (e as Error).message);
  }
  if (BigInt(units) < 1_000_000n || BigInt(units) > 10_000_000_000n) return fail(400, "bad_amount", "amount must be from 1 to 10,000 USDC.");
  try {
    const res = await new IntentsClient({ timeoutMs: 10_000 }).quote(usdcToNear({ from, amount: units, recipient }));
    const s = summarize(res);
    return json(
      {
        dry: true,
        from: q.get("from"),
        to: "USDC on NEAR",
        amount_in_usdc: s.amountIn,
        amount_out_usdc: s.amountOut,
        min_amount_out_usdc: s.minAmountOut,
        estimated_seconds: s.seconds,
        quoted_at: res.timestamp,
        note: "Dry quote from the NEAR Intents 1Click API on mainnet. Nothing was signed or sent. Weir itself is on testnet.",
      },
      200,
      30,
    );
  } catch (e) {
    return fail(502, "quote_unavailable", `The 1Click API gave no quote: ${(e as Error).message}`);
  }
}

/** Routes /api/<name> to its handler; null for any other path. */
export function apiHandler(ctx: ApiContext, url: URL): Promise<Response> | null {
  if (url.pathname === "/api/status") return apiStatus(ctx, url.searchParams);
  if (url.pathname === "/api/round") return apiRound(ctx, url.searchParams);
  if (url.pathname === "/api/quote") return apiQuote(url.searchParams, ctx.quoteRecipient || RECIPIENT);
  if (url.pathname.startsWith("/api/")) return Promise.resolve(fail(404, "no_endpoint", "The site has /api/status, /api/round and /api/quote."));
  return null;
}
