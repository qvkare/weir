import { toMicro, type Draft, type Source } from "../method.ts";
import { list, obj, str } from "./shape.ts";

/**
 * The `models[]` entries with model "h100"; each contributes its `price.med` as one offer
 * (today there is exactly one, so the provider value is that median). Availability is
 * kept as a note.
 */
export function parse(json: unknown): Draft {
  const draft: Draft = { id: "akash", offers: [] };
  const notes: string[] = [];
  for (const x of list(obj(json, "response").models, "models")) {
    const m = obj(x, "model");
    if (m.model !== "h100") continue;
    const price = obj(m.price, "price");
    if (typeof price.med !== "number") continue;
    const sku = ["h100", str(m.ram), str(m.interface)].filter(Boolean).join(" ");
    draft.offers.push({ sku, price: toMicro(price.med) });
    const a = obj(m.availability, "availability");
    const p = obj(m.providerAvailability, "providerAvailability");
    notes.push(`${sku}: availability ${str(a.available)}/${str(a.total)} GPUs, providerAvailability ${str(p.available)}/${str(p.total)}`);
  }
  if (notes.length > 0) draft.note = notes.join("; ");
  return draft;
}

export const source: Source = {
  id: "akash",
  kind: "open-market",
  url: "https://console-api.akash.network/v1/gpu-prices",
  method: "GET",
  parse: (json) => [parse(json)],
};
