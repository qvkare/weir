import { IntentsClient, summarize, usdcToNear, usdcUnits, type Chain } from "@weir/chain";
import { fail, json } from "@/lib/api.ts";

export const dynamic = "force-dynamic";

const FROM: Record<string, Exclude<Chain, "near">> = { base: "base", arbitrum: "arb", ethereum: "eth", solana: "sol" };

// A dry quote needs a recipient that exists on NEAR mainnet or is a 64-hex implicit account.
// Nothing is sent to it: the quote is dry. Override with WEIR_QUOTE_RECIPIENT.
const RECIPIENT = process.env.WEIR_QUOTE_RECIPIENT ?? "0".repeat(64);

/** GET /api/quote?from=base|arbitrum|ethereum|solana&amount=20: a dry NEAR Intents (1Click) quote, USDC to USDC on NEAR. */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
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
    const res = await new IntentsClient({ timeoutMs: 10_000 }).quote(usdcToNear({ from, amount: units, recipient: RECIPIENT }));
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
