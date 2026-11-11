import { toMicro, type Offer, type Source } from "../method.ts";
import { list, obj, str } from "./shape.ts";

/** Every non-null securePrice and communityPrice of GPU types whose displayName contains H100. */
export function parse(json: unknown): Offer[] {
  const offers: Offer[] = [];
  const data = obj(obj(json, "response").data, "data");
  for (const x of list(data.gpuTypes, "gpuTypes")) {
    const g = obj(x, "gpuType");
    if (!str(g.displayName).includes("H100")) continue;
    for (const [tier, price] of [["secure", g.securePrice], ["community", g.communityPrice]] as const) {
      if (typeof price === "number") offers.push({ sku: `${str(g.id)} ${tier}`, price: toMicro(price) });
    }
  }
  return offers;
}

export const source: Source = {
  id: "runpod",
  kind: "rate-card",
  url: "https://api.runpod.io/graphql",
  method: "POST",
  body: JSON.stringify({ query: "query { gpuTypes { id displayName securePrice communityPrice } }" }),
  parse: (json) => [{ id: "runpod", offers: parse(json) }],
};
