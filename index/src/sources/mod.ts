import type { Source } from "../method.ts";
import { source as akash } from "./akash.ts";
import { source as lium } from "./lium.ts";
import { source as runpod } from "./runpod.ts";
import { source as shadeform } from "./shadeform.ts";
import { source as vast } from "./vast.ts";
import { source as verda } from "./verda.ts";

/** Every source of H100-OD, in a fixed order. */
export const SOURCES: readonly Source[] = [vast, runpod, akash, lium, verda, shadeform];

export function sourceById(id: string): Source | undefined {
  return SOURCES.find((s) => s.id === id);
}
