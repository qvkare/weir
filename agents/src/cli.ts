// Node CLI: `sim --market h100-fast --seed 7 --rounds 20 [--buyers 20 --sellers 5 --makers 2 --noise 3] [--void]`
// (`--preset fast|weekly` still works and means the H100 market on that preset).
// Runs the simulation on the engine (no keys, no network): one line per round, then
// settlement and a table per agent.
import { parseArgs } from "node:util";
import { agentReports, burned, createSimulation, marketOf, type MarketId } from "./sim.ts";

const usd = (micro: bigint, sign = false): string => {
  const v = Number(micro) / 1e6;
  return `${v < 0 ? "-" : sign ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
};
const per = (micro: number): string => `$${(micro / 1e6).toFixed(3)}`;
const pad = (s: string | number, n: number): string => String(s).padStart(n);

function sim(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      market: { type: "string" },
      preset: { type: "string" },
      seed: { type: "string", default: "7" },
      rounds: { type: "string", default: "20" },
      buyers: { type: "string", default: "20" },
      sellers: { type: "string", default: "5" },
      makers: { type: "string", default: "2" },
      noise: { type: "string", default: "3" },
      void: { type: "boolean", default: false },
    },
  });
  // --preset fast|weekly is kept as a short form of --market h100-fast|h100-weekly.
  const def = marketOf((values.market ?? (values.preset ? `h100-${values.preset}` : "h100-fast")) as MarketId);
  const n = (name: keyof typeof values) => {
    const v = Number(values[name]);
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`--${name} must be a whole number`);
    return v;
  };
  const config = { seed: n("seed"), buyers: n("buyers"), sellers: n("sellers"), makers: n("makers"), noise: n("noise"), market: def.id as MarketId, silentSeries: values.void ? 0 : undefined };
  const s = createSimulation(config);
  const p = def.params;
  const unit = p.period_secs === 7 * 86_400 ? "week" : p.period_secs === 3600 ? "hour" : `${p.period_secs} s`;
  console.log(
    `Weir sim, ${def.label} (${def.id}): each ${unit} of delivery is auctioned the ${unit} before, in ${p.commit_secs / 60}+${p.reveal_secs / 60} min rounds. ` +
      `Seed ${config.seed}: ${config.buyers} buyers, ${config.sellers} sellers, ${config.makers} makers, ${config.noise} noise. Prices per ${def.chip.toUpperCase()}-hour.`,
  );
  console.log(`Every commit burns a ${usd(BigInt(p.commit_fee))} fee, so taking a slot in a round always costs something and filling rounds to keep others out is not free.`);
  console.log("series round  commits revealed  LONG price  forward  volume  forfeits");

  const events = s.runRounds(n("rounds"));
  let traded = 0;
  for (const e of events) {
    if (e.kind !== "clear") continue;
    const { series, round } = e.data as { series: number; round: number };
    const r = s.market.getResult(series, round)!;
    const floor = s.market.getSeries(series)!.floor;
    if (r.volume > 0) traded++;
    const price = r.price === null ? "no trade" : per(r.price);
    const fwd = r.price === null ? "" : per(floor + r.price);
    console.log(`${pad(series, 6)} ${pad(round, 5)}  ${pad(r.commits, 7)} ${pad(r.orders, 8)}  ${pad(price, 10)}  ${pad(fwd, 7)}  ${pad(r.volume, 6)}  ${pad(usd(r.forfeited), 8)}`);
  }
  const rounds = events.filter((e) => e.kind === "clear").length;

  s.settleAll();
  const settled = s.market.events.flatMap((e) => (e.event === "settle" ? [e.data] : []));
  const t = s.market.getTotals();
  const deposits = s.agents.reduce((sum, a) => sum + BigInt(a.deposit), 0n);
  console.log(`${traded} of ${rounds} rounds traded. ` + settled.map((x) => (x.void ? `Series ${x.series} void, unwound at ${per(x.longPayout)} per LONG (its average traded price).` : `Series ${x.series} fixed at ${per(x.fixing)}, LONG paid ${per(x.longPayout)}.`)).join(" "));
  const b = burned(s.market);
  console.log(`Burned: ${usd(b.fees)} in commit fees and ${usd(b.forfeits)} in forfeits (${usd(t.burned)} in all; burned dollars belong to nobody).`);
  console.log(`Money check: deposits ${usd(deposits)} = free ${usd(t.free)} + locked ${usd(t.locked)} + sets ${usd(t.setsBacking)} + unredeemed ${usd(t.unredeemed)} + burned ${usd(t.burned)}.`);
  console.log("agent       role    LONG  SHORT      paid  received   fees   result");
  for (const r of agentReports(s)) {
    console.log(`${r.id.padEnd(10)}  ${r.role.padEnd(6)} ${pad(r.long, 5)}  ${pad(r.short, 5)}  ${pad(usd(r.paid), 8)}  ${pad(usd(r.received), 8)}  ${pad(usd(r.fees + r.forfeited), 5)}  ${pad(usd(r.result, true), 7)}`);
  }
  for (const x of settled.filter((x) => x.void)) {
    console.log(`Series ${x.series} is void: the reporters were silent through its delivery, so every position was unwound at ${per(x.longPayout)} per LONG and ${per(x.shortPayout)} per SHORT.`);
  }
  console.log("paid: auction fills; received: payout at settlement; fees: commit fees and forfeits burned; result: balance now minus deposit.");
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "sim") sim(rest);
  else {
    console.log(`usage: node agents/src/cli.ts sim [--market h100-fast|h100-weekly|h200-weekly|a100-80-weekly] --seed 7 --rounds 20 [--buyers 20 --sellers 5 --makers 2 --noise 3] [--void]`);
    process.exitCode = command ? 1 : 0;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
