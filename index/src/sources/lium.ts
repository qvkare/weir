import { matches, type Chip } from "../chips.ts";
import { toMicro, type Offer, type Source } from "../method.ts";
import { list, obj, str } from "./shape.ts";

/** Executors whose machine_name is the chip's; price price_per_gpu; sku the executor id. */
export function parse(json: unknown, chip: Chip): Offer[] {
  const offers: Offer[] = [];
  for (const x of list(json, "executors")) {
    const e = obj(x, "executor");
    if (!matches(chip.lium, str(e.machine_name)) || typeof e.price_per_gpu !== "number") continue;
    offers.push({ sku: str(e.id), price: toMicro(e.price_per_gpu) });
  }
  return offers;
}

/** One call returns every executor, so all chips share it. */
export function source(chip: Chip): Source {
  return {
    id: "lium",
    kind: "open-market",
    url: "https://lium.io/api/executors",
    method: "GET",
    parse: (json) => [{ id: "lium", offers: parse(json, chip) }],
  };
}
