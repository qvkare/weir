import { CHIPS, H100_V1, type Chip } from "../chips.ts";
import type { Source } from "../method.ts";
import * as akash from "./akash.ts";
import * as lium from "./lium.ts";
import * as runpod from "./runpod.ts";
import * as shadeform from "./shadeform.ts";
import * as vast from "./vast.ts";
import * as verda from "./verda.ts";

/** The six sources of method `weir-gpu-od/2`, bound to one chip, in a fixed order. */
export function sourcesFor(chip: Chip): Source[] {
  return [vast.source(chip), runpod.source(chip), akash.source(chip), lium.source(chip), verda.source(chip), shadeform.source(chip)];
}

/** The H100 sources, kept for callers written before the chip became a parameter. */
export const SOURCES: readonly Source[] = sourcesFor(CHIPS.h100);

/** The sources exactly as method `weir-h100-od/1` called and parsed them. Verification only. */
export const SOURCES_V1: readonly Source[] = [
  vast.sourceV1(H100_V1), runpod.source(H100_V1), akash.source(H100_V1), lium.source(H100_V1), verda.source(H100_V1), shadeform.sourceV1(H100_V1),
];

export function sourceById(id: string, sources: readonly Source[] = SOURCES): Source | undefined {
  return sources.find((s) => s.id === id);
}
