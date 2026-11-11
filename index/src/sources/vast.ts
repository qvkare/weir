import { toMicro, type Offer, type Source } from "../method.ts";
import { gpus, list, obj, str } from "./shape.ts";

const GPU_NAMES = ["H100 SXM", "H100 PCIE", "H100 NVL"];

/** Verified offers with reliability2 >= 0.95; price dph_total / num_gpus; sku `<host_id>/<offer id>`. */
export function parse(json: unknown): Offer[] {
  const offers: Offer[] = [];
  for (const x of list(obj(json, "response").offers, "offers")) {
    const o = obj(x, "offer");
    if (o.verification !== "verified" || typeof o.reliability2 !== "number" || o.reliability2 < 0.95) continue;
    if (!GPU_NAMES.includes(str(o.gpu_name)) || typeof o.dph_total !== "number") continue;
    offers.push({ sku: `${str(o.host_id)}/${str(o.id)}`, price: toMicro(o.dph_total, gpus(o.num_gpus, "offer")) });
  }
  return offers;
}

export const source: Source = {
  id: "vast",
  kind: "open-market",
  url: "https://console.vast.ai/api/v0/bundles/",
  method: "POST",
  body: JSON.stringify({ gpu_name: { in: GPU_NAMES }, rentable: { eq: true }, type: "on-demand", limit: 1000 }),
  parse: (json) => [{ id: "vast", offers: parse(json) }],
};
