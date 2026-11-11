// Which sellers count, and under what name.
//
// In the composite: neoclouds and marketplaces that sell H100 on demand at a price
// that moves with the market. Out of the composite, reported separately: the four
// hyperscalers' on-demand list prices (AWS, Azure, GCP, OCI). At 6.88 to 11 dollars
// they are static rate cards two to three times the market and would only pull the
// median toward a number almost nobody pays.

export const HYPERSCALERS = new Set(["aws", "azure", "gcp", "oci"]);

/** Source ids → one canonical provider id. DataCrunch renamed itself Verda in 2025;
 * gpuhunt publishes both files for a while with identical rows, so they are one
 * provider and the `verda` file wins when both exist. */
const CANONICAL: Record<string, string> = {
  lambdalabs: "lambda",
  datacrunch: "verda",
  verda: "verda",
  vastai: "vast",
};

export function canonicalProvider(sourceId: string): string {
  const id = sourceId.toLowerCase();
  return CANONICAL[id] ?? id;
}

export function inComposite(provider: string): boolean {
  return !HYPERSCALERS.has(provider);
}

/** Minimum in-composite providers on a day for the index to have a value. */
export const MIN_PROVIDERS = 4;
