import { toMicro, type Offer, type Source } from "../method.ts";
import { list, obj, str } from "./shape.ts";

/** Executors whose machine_name contains H100; price price_per_gpu; sku the executor id. */
export function parse(json: unknown): Offer[] {
  const offers: Offer[] = [];
  for (const x of list(json, "executors")) {
    const e = obj(x, "executor");
    if (!str(e.machine_name).includes("H100") || typeof e.price_per_gpu !== "number") continue;
    offers.push({ sku: str(e.id), price: toMicro(e.price_per_gpu) });
  }
  return offers;
}

export const source: Source = {
  id: "lium",
  kind: "open-market",
  url: "https://lium.io/api/executors",
  method: "GET",
  parse: (json) => [{ id: "lium", offers: parse(json) }],
};
