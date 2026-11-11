import type { Chip } from "../chips.ts";
import { toMicro, type Draft, type Source } from "../method.ts";
import { list, obj, str } from "./shape.ts";

/**
 * The `models[]` entries with the chip's model (and ram, if the chip names one); each
 * contributes its `price.med` as one offer. Availability is kept as a note.
 */
export function parse(json: unknown, chip: Chip): Draft {
  const draft: Draft = { id: "akash", offers: [] };
  const notes: string[] = [];
  for (const x of list(obj(json, "response").models, "models")) {
    const m = obj(x, "model");
    if (m.model !== chip.akash.model || (chip.akash.ram !== undefined && m.ram !== chip.akash.ram)) continue;
    const price = obj(m.price, "price");
    if (typeof price.med !== "number") continue;
    const sku = [chip.akash.model, str(m.ram), str(m.interface)].filter(Boolean).join(" ");
    draft.offers.push({ sku, price: toMicro(price.med) });
    const a = obj(m.availability, "availability");
    const p = obj(m.providerAvailability, "providerAvailability");
    notes.push(`${sku}: availability ${str(a.available)}/${str(a.total)} GPUs, providerAvailability ${str(p.available)}/${str(p.total)}`);
  }
  if (notes.length > 0) draft.note = notes.join("; ");
  return draft;
}

/** One call returns every model, so all chips share it. */
export function source(chip: Chip): Source {
  return {
    id: "akash",
    kind: "open-market",
    url: "https://console-api.akash.network/v1/gpu-prices",
    method: "GET",
    parse: (json) => [parse(json, chip)],
  };
}
