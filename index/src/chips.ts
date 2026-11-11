// The chips the index prices, and for each one the exact rule every source's parser applies.
// Names are matched exactly (not by substring) so that, say, RunPod's "A100 SXM 40GB" can never
// slip into the 80 GB market. The spellings were read from each source's live response on
// 2026-11-11 (see CHIPS.md).

/** How a source's model name is matched: one of a list of exact names, or (version 1 only) a substring. */
export type Match = { exact: readonly string[]; caseless?: boolean } | { contains: string };

export function matches(m: Match, name: string): boolean {
  if ("contains" in m) return name.includes(m.contains);
  return m.caseless ? m.exact.some((x) => x.toUpperCase() === name.toUpperCase()) : m.exact.includes(name);
}

export interface Chip {
  /** Short id, used in bundles (`chip`), the CLI and file paths. */
  id: string;
  name: string;
  /** The index's name, carried in the bundle as `index_name`. */
  index_name: string;
  /** Vast: `gpu_name` values (sent in the query and checked again), and a lower bound on `gpu_ram` (MB) where a name covers two memory sizes. */
  vast: { gpu_names: readonly string[]; min_gpu_ram_mb?: number };
  /** RunPod: `displayName`. */
  runpod: Match;
  /** Akash: `model`, and `ram` where a model comes in two sizes. */
  akash: { model: string; ram?: string };
  /** Lium: `machine_name`. */
  lium: Match;
  /** Verda: `model`. */
  verda: Match;
  /** Shadeform: `configuration.gpu_type`. */
  shadeform: Match;
}

const NONE: Match = { exact: [] };

export const CHIPS = {
  h100: {
    id: "h100",
    name: "NVIDIA H100",
    index_name: "H100-OD",
    vast: { gpu_names: ["H100 SXM", "H100 PCIE", "H100 NVL"] },
    runpod: { exact: ["H100 SXM", "H100 PCIe", "H100 NVL"] },
    akash: { model: "h100" },
    lium: { exact: ["NVIDIA H100 80GB HBM3", "NVIDIA H100 PCIe"] },
    verda: { exact: ["H100"] },
    shadeform: { exact: ["H100", "H100_nvl"] },
  },
  h200: {
    id: "h200",
    name: "NVIDIA H200",
    index_name: "H200-OD",
    vast: { gpu_names: ["H200", "H200 NVL"] },
    runpod: { exact: ["H200 SXM", "H200 NVL"] },
    akash: { model: "h200" }, // Akash's lower-case naming; not listed on 2026-11-11
    lium: { exact: ["NVIDIA H200", "NVIDIA H200 NVL"] },
    verda: { exact: ["H200"] },
    shadeform: { exact: ["H200"] },
  },
  "a100-80": {
    id: "a100-80",
    name: "NVIDIA A100 80GB",
    index_name: "A100-80-OD",
    // Vast's "A100 SXM4" and "A100 PCIE" cover both the 40 GB and 80 GB cards; gpu_ram tells them apart.
    vast: { gpu_names: ["A100 SXM4", "A100 PCIE"], min_gpu_ram_mb: 70_000 },
    runpod: { exact: ["A100 SXM", "A100 PCIe"] }, // not "A100 SXM 40GB"
    akash: { model: "a100", ram: "80Gi" },
    lium: NONE, // Lium lists no A100; a name is added only once seen
    verda: { exact: ["A100 80GB"] },
    shadeform: { exact: ["A100_80G"] },
  },
} as const satisfies Record<string, Chip>;

export type ChipId = keyof typeof CHIPS;
export const CHIP_IDS = Object.keys(CHIPS) as ChipId[];

export function chipById(id: string): Chip | undefined {
  return Object.hasOwn(CHIPS, id) ? CHIPS[id as ChipId] : undefined;
}

/**
 * H100 as method `weir-h100-od/1` matched it: substrings for RunPod and Lium, Shadeform's
 * `gpu_type` compared case-insensitively to "H100" (so not "H100_nvl"). Used only to verify
 * version-1 bundles.
 */
export const H100_V1: Chip = {
  ...CHIPS.h100,
  runpod: { contains: "H100" },
  lium: { contains: "H100" },
  shadeform: { exact: ["H100"], caseless: true },
};
