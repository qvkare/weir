import { toMicro, type Offer, type Source } from "../method.ts";
import { gpus, list, obj, str } from "./shape.ts";

/** Instance types with model "H100" priced in USD; price price_per_hour / gpu.number_of_gpus (never spot_price). */
export function parse(json: unknown): Offer[] {
  const offers: Offer[] = [];
  for (const x of list(json, "instance types")) {
    const t = obj(x, "instance type");
    if (t.model !== "H100" || str(t.currency).toLowerCase() !== "usd" || str(t.price_per_hour) === "") continue;
    const n = gpus(obj(t.gpu, "gpu").number_of_gpus, "instance type");
    offers.push({ sku: str(t.instance_type), price: toMicro(str(t.price_per_hour), n) });
  }
  return offers;
}

export const source: Source = {
  id: "verda",
  kind: "rate-card",
  url: "https://api.verda.com/v1/instance-types",
  method: "GET",
  parse: (json) => [{ id: "verda", offers: parse(json) }],
};
