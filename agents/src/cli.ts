// Node CLI: `sim --preset fast --seed 7 --rounds 20 [--buyers 20 --sellers 5 --makers 2 --noise 3]`.
// Runs the simulation on the engine (no keys, no network): one line per round, then
// settlement and a table per agent.
import { parseArgs } from "node:util";
import { agentReports, createSimulation, PRESETS, type PresetName } from "./sim.ts";

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
      preset: { type: "string", default: "fast" },
      seed: { type: "string", default: "7" },
      rounds: { type: "string", default: "20" },
      buyers: { type: "string", default: "20" },
      sellers: { type: "string", default: "5" },
      makers: { type: "string", default: "2" },
      noise: { type: "string", default: "3" },
    },
  });
  const preset = values.preset as PresetName;
  if (!(preset in PRESETS)) throw new Error(`--preset must be ${Object.keys(PRESETS).join(" or ")}`);
  const n = (name: keyof typeof values) => {
    const v = Number(values[name]);
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`--${name} must be a whole number`);
    return v;
  };
  const config = { seed: n("seed"), buyers: n("buyers"), sellers: n("sellers"), makers: n("makers"), noise: n("noise"), market: preset };
  const s = createSimulation(config);
  const p = PRESETS[preset];
  const unit = p.period_secs === 7 * 86_400 ? "week" : p.period_secs === 3600 ? "hour" : `${p.period_secs} s`;
  console.log(
    `Weir sim, ${preset} preset: each ${unit} of delivery is auctioned the ${unit} before, in ${p.commit_secs / 60}+${p.reveal_secs / 60} min rounds. ` +
      `Seed ${config.seed}: ${config.buyers} buyers, ${config.sellers} sellers, ${config.makers} makers, ${config.noise} noise. Prices per H100-hour.`,
  );
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
  console.log(`${traded} of ${rounds} rounds traded. ` + settled.map((x) => `Series ${x.series} fixed at ${per(x.fixing)}, LONG paid ${per(x.longPayout)}.`).join(" "));
  console.log(`Money check: deposits ${usd(deposits)} = free ${usd(t.free)} + locked ${usd(t.locked)} + sets ${usd(t.setsBacking)} + pools ${usd(t.pools)} + unredeemed ${usd(t.unredeemed)}.`);
  console.log("agent       role    LONG  SHORT      paid  received   result");
  for (const r of agentReports(s)) {
    console.log(`${r.id.padEnd(10)}  ${r.role.padEnd(6)} ${pad(r.long, 5)}  ${pad(r.short, 5)}  ${pad(usd(r.paid), 8)}  ${pad(usd(r.received), 8)}  ${pad(usd(r.result, true), 7)}`);
  }
  console.log("paid: cost of auction fills; received: payout at settlement; result: free balance now minus deposit (forfeits included).");
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "sim") sim(rest);
  else {
    console.log("usage: node agents/src/cli.ts sim --preset fast|weekly --seed 7 --rounds 20 [--buyers 20 --sellers 5 --makers 2 --noise 3]");
    process.exitCode = command ? 1 : 0;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
