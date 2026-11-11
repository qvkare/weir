// `pnpm --filter @weir/backtest run fetch [source ...]`
// Downloads every raw source into data/raw/ (git-ignored). Sequential and cached:
// nothing already on disk is fetched again, so the command can be interrupted and
// re-run. With no arguments every source is fetched.

import { fetchGpuhunt } from "./gpuhunt.ts";
import { fetchHubbard } from "./hubbard.ts";
import { fetchAkash } from "./akash.ts";
import { fetchCrosschecks } from "./crosscheck.ts";

const steps: Record<string, () => Promise<void>> = {
  gpuhunt: fetchGpuhunt,
  hubbard: fetchHubbard,
  akash: fetchAkash,
  crosscheck: fetchCrosschecks,
};

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : Object.keys(steps)) {
  const step = steps[name];
  if (!step) throw new Error(`unknown source ${name}; known: ${Object.keys(steps).join(", ")}`);
  console.log(`== ${name}`);
  await step();
}
