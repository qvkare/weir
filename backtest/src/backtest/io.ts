// Load the committed derived files into the backtest's inputs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsvObjects } from "../lib/csv.ts";
import { parseUsd } from "../lib/money.ts";
import type { Inputs } from "./analysis.ts";
import type { Series } from "./model.ts";

export function loadInputs(derivedDir: string): Inputs {
  const days: string[] = [];
  const index: Series = new Map();
  for (const r of parseCsvObjects(readFileSync(join(derivedDir, "index.csv"), "utf8"))) {
    days.push(r.date!);
    if (r.index) index.set(r.date!, parseUsd(r.index));
  }
  const providers = new Map<string, Series>();
  const outOfComposite = new Set<string>();
  for (const [file, inComposite] of [
    ["providers.csv", true],
    ["hyperscalers.csv", false],
  ] as const) {
    for (const r of parseCsvObjects(readFileSync(join(derivedDir, file), "utf8"))) {
      const s = providers.get(r.provider!) ?? new Map<string, number>();
      s.set(r.date!, parseUsd(r.price_usd_per_gpu_hour!));
      providers.set(r.provider!, s);
      if (!inComposite) outOfComposite.add(r.provider!);
    }
  }
  return { days, index, providers, outOfComposite };
}
