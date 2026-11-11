import type { Chip } from "../chips.ts";
import { toMicro, type Draft, type Offer, type Source } from "../method.ts";
import { gpus, list, obj, str } from "./shape.ts";

/** Vast returns at most this many offers per call, whatever `limit` asks for. */
export const VAST_CAP = 64;
const URL = "https://console.vast.ai/api/v0/bundles/";

/**
 * Verified offers with reliability2 >= 0.95 whose gpu_name is one of the chip's (and whose
 * gpu_ram meets the chip's bound, if it has one); price dph_total / num_gpus; sku `<host_id>/<offer id>`.
 */
export function parse(json: unknown, chip: Chip): Offer[] {
  const offers: Offer[] = [];
  for (const x of list(obj(json, "response").offers, "offers")) {
    const o = obj(x, "offer");
    if (o.verification !== "verified" || typeof o.reliability2 !== "number" || o.reliability2 < 0.95) continue;
    if (!chip.vast.gpu_names.includes(str(o.gpu_name)) || typeof o.dph_total !== "number") continue;
    const min = chip.vast.min_gpu_ram_mb;
    if (min !== undefined && !(typeof o.gpu_ram === "number" && o.gpu_ram >= min)) continue;
    offers.push({ sku: `${str(o.host_id)}/${str(o.id)}`, price: toMicro(o.dph_total, gpus(o.num_gpus, "offer")) });
  }
  return offers;
}

/** How many offers the call returned, and whether that is the cap (so the offers are a sample). */
export function capNote(json: unknown): string {
  const n = list(obj(json, "response").offers, "offers").length;
  return n >= VAST_CAP ? `${n} offers returned: the ${VAST_CAP}-offer cap was hit, so these are a sample` : `${n} offers returned, under the ${VAST_CAP}-offer cap`;
}

/**
 * Version 2 asks Vast for exactly what qualifies (verified, reliability2 >= 0.95, the chip's
 * names and memory), so that the 64 offers a call can return are the right ones.
 */
export function source(chip: Chip): Source {
  const query: Record<string, unknown> = {
    gpu_name: { in: chip.vast.gpu_names },
    ...(chip.vast.min_gpu_ram_mb === undefined ? {} : { gpu_ram: { gte: chip.vast.min_gpu_ram_mb } }),
    rentable: { eq: true },
    verified: { eq: true },
    reliability2: { gte: 0.95 },
    type: "on-demand",
    limit: VAST_CAP,
  };
  return {
    id: "vast",
    kind: "open-market",
    url: URL,
    method: "POST",
    body: JSON.stringify(query),
    parse: (json): Draft[] => [{ id: "vast", offers: parse(json, chip), note: capNote(json) }],
  };
}

/** The call and parse of method `weir-h100-od/1`. */
export function sourceV1(chip: Chip): Source {
  return {
    id: "vast",
    kind: "open-market",
    url: URL,
    method: "POST",
    body: JSON.stringify({ gpu_name: { in: chip.vast.gpu_names }, rentable: { eq: true }, type: "on-demand", limit: 1000 }),
    parse: (json) => [{ id: "vast", offers: parse(json, chip) }],
  };
}
