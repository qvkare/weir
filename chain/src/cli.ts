// Node CLI. `quote --from arbitrum --amount 20 --to <near account>`: a dry 1Click quote for
// moving USDC from another chain to USDC on NEAR. Nothing is signed or sent.
import { parseArgs } from "node:util";
import { IntentsClient, PLACEHOLDER_REFUND, summarize, USDC, usdcToNear, usdcUnits, type Chain } from "./intents.ts";

const ORIGINS = Object.keys(USDC).filter((c) => c !== "near") as Exclude<Chain, "near">[];
/** Long names accepted for --from. */
const ALIASES: Record<string, Exclude<Chain, "near">> = { arbitrum: "arb", ethereum: "eth", solana: "sol" };

async function quote(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string", default: "arbitrum" },
      amount: { type: "string", default: "20" },
      to: { type: "string" },
      "refund-to": { type: "string" },
      slippage: { type: "string", default: "100" },
    },
  });
  const from = ALIASES[values.from] ?? (values.from as Exclude<Chain, "near">);
  if (!ORIGINS.includes(from)) throw new Error(`--from must be one of base, arbitrum, ethereum, solana`);
  if (!values.to) throw new Error("--to <near account> is required: the account that would receive USDC on NEAR");
  const refundTo = values["refund-to"];
  const req = usdcToNear({
    from,
    amount: usdcUnits(values.amount),
    recipient: values.to,
    refundTo,
    slippageBps: Number(values.slippage),
  });
  let res;
  try {
    res = await new IntentsClient().quote(req);
  } catch (e) {
    if (e instanceof Error && /not available/i.test(e.message)) {
      throw new Error(`1Click does not quote USDC on ${values.from} -> USDC on NEAR right now (pair not available). Try --from arbitrum, ethereum or solana.`);
    }
    throw e;
  }
  const s = summarize(res);
  const mins = s.seconds >= 120 ? ` (~${Math.round(s.seconds / 60)} min)` : "";
  console.log(`Dry 1Click quote: USDC on ${values.from} -> USDC on NEAR for ${values.to} (nothing was sent)`);
  console.log(`  amount in        ${s.amountIn} USDC`);
  console.log(`  amount out       ${s.amountOut} USDC`);
  console.log(`  minimum out      ${s.minAmountOut} USDC  (slippage tolerance ${req.slippageTolerance} bps)`);
  console.log(`  time estimate    ${s.seconds} s${mins}`);
  if (!refundTo) console.log(`  refund address   ${PLACEHOLDER_REFUND[from]}  (placeholder for the dry quote, not a real wallet)`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "quote") await quote(rest);
  else {
    console.log("usage: node chain/src/cli.ts quote --from arbitrum|ethereum|solana|base --amount 20 --to <near account> [--refund-to <address>] [--slippage 100]");
    process.exitCode = command ? 1 : 0;
  }
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(message);
  if (/Internal server error/.test(message)) {
    console.error("hint: --to must be an existing NEAR mainnet account or a 64-hex implicit account");
  }
  process.exitCode = 1;
}
