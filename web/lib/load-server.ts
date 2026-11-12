// Build-time reads that need the repository's files (inlined as WEIR_BUILD). Server only.
import type { Bundle } from "@weir/index";
import { buildData } from "./build.ts";
import type { ChipKey } from "./config.ts";
import type { LoadedBundle } from "./load.ts";

/** The newest bundle recorded in evidence/bundles for a chip, the fixture and fallback. */
export function recordedBundle(chip: ChipKey = "h100"): LoadedBundle | null {
  const r = buildData().bundles.find((b) => b.chip === chip);
  if (!r) return null;
  try {
    return { bundle: JSON.parse(r.text) as Bundle, text: r.text, origin: { kind: "recorded", file: r.file } };
  } catch {
    return null;
  }
}

