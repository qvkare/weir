import { matches, type Chip } from "../chips.ts";
import { toMicro, type Offer, type Source } from "../method.ts";
import { list, obj, str } from "./shape.ts";

/** Every non-null securePrice and communityPrice of the GPU types whose displayName is the chip's. */
export function parse(json: unknown, chip: Chip): Offer[] {
  const offers: Offer[] = [];
  const data = obj(obj(json, "response").data, "data");
  for (const x of list(data.gpuTypes, "gpuTypes")) {
    const g = obj(x, "gpuType");
    if (!matches(chip.runpod, str(g.displayName))) continue;
    for (const [tier, price] of [["secure", g.securePrice], ["community", g.communityPrice]] as const) {
      if (typeof price === "number") offers.push({ sku: `${str(g.id)} ${tier}`, price: toMicro(price) });
    }
  }
  return offers;
}

/** One call returns every GPU type, so all chips share it. */
export function source(chip: Chip): Source {
  return {
    id: "runpod",
    kind: "rate-card",
    url: "https://api.runpod.io/graphql",
    method: "POST",
    body: JSON.stringify({ query: "query { gpuTypes { id displayName securePrice communityPrice } }" }),
    parse: (json) => [{ id: "runpod", offers: parse(json, chip) }],
  };
}
