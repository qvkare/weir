import { toMicro, type Draft, type Source } from "../method.ts";
import { gpus, list, obj, str } from "./shape.ts";

/**
 * One draft per `cloud`. Rows qualify when configuration.gpu_type is H100 and at least one
 * availability entry is on_demand. hourly_price is US cents per instance, so the price per
 * GPU-hour is hourly_price / 100 / configuration.num_gpus. sku `<shade_instance_type>/<cloud_instance_type>`.
 */
export function parse(json: unknown): Draft[] {
  const byCloud = new Map<string, Draft>();
  for (const x of list(obj(json, "response").instance_types, "instance_types")) {
    const t = obj(x, "instance type");
    const c = obj(t.configuration, "configuration");
    if (str(c.gpu_type).toUpperCase() !== "H100" || typeof t.hourly_price !== "number") continue;
    if (!list(t.availability ?? [], "availability").some((a) => obj(a, "availability").rental_type === "on_demand")) continue;
    const cloud = str(t.cloud);
    if (cloud === "") continue;
    const draft = byCloud.get(cloud) ?? { id: cloud, offers: [] };
    const sku = `${str(t.shade_instance_type)}/${str(t.cloud_instance_type)}`;
    draft.offers.push({ sku, price: toMicro(t.hourly_price, 100 * gpus(c.num_gpus, "configuration")) });
    byCloud.set(cloud, draft);
  }
  return [...byCloud.values()];
}

export const source: Source = {
  id: "shadeform",
  kind: "rate-card",
  url: "https://api.shadeform.ai/v1/instances/types?gpu_type=H100",
  method: "GET",
  aggregator: true,
  parse,
};
