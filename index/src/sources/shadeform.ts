import { matches, type Chip } from "../chips.ts";
import { toMicro, type Draft, type Source } from "../method.ts";
import { gpus, list, obj, str } from "./shape.ts";

const URL = "https://api.shadeform.ai/v1/instances/types";

/**
 * One draft per `cloud`. Rows qualify when configuration.gpu_type is the chip's and at least
 * one availability entry is on_demand. hourly_price is US cents per instance, so the price per
 * GPU-hour is hourly_price / 100 / configuration.num_gpus. sku `<shade_instance_type>/<cloud_instance_type>`.
 */
export function parse(json: unknown, chip: Chip): Draft[] {
  const byCloud = new Map<string, Draft>();
  for (const x of list(obj(json, "response").instance_types, "instance_types")) {
    const t = obj(x, "instance type");
    const c = obj(t.configuration, "configuration");
    if (!matches(chip.shadeform, str(c.gpu_type)) || typeof t.hourly_price !== "number") continue;
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

/** Version 2 makes the unfiltered call, which returns every GPU type, so all chips share it. */
export function source(chip: Chip): Source {
  return { id: "shadeform", kind: "rate-card", url: URL, method: "GET", aggregator: true, parse: (json) => parse(json, chip) };
}

/** The call of method `weir-h100-od/1`: filtered to `gpu_type=H100`. */
export function sourceV1(chip: Chip): Source {
  return { ...source(chip), url: `${URL}?gpu_type=H100` };
}
