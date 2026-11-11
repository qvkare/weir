// The hardware printed on the site (DESIGN section 6.6): the chip cards and the specimen's sheet.
// Every figure here was checked against the public source named beside it on 12 Nov 2026. Model
// names are written in plain text; no maker's logo or trade dress is drawn anywhere. The
// drawings are illustrations, not to scale, and say so.
//
// Sources
//   [H100]   NVIDIA H100 product page, specifications table, H100 SXM column:
//            https://www.nvidia.com/en-us/data-center/h100/
//            "GPU Memory 80GB", "GPU Memory Bandwidth 3.35TB/s", "Up to 700W (configurable)", "SXM"
//   [HOPPER] NVIDIA Technical Blog, "NVIDIA Hopper Architecture In-Depth" (2022):
//            https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/
//            GH100 "fabricated using the TSMC 4N process ... with 80 billion transistors, a die
//            size of 814 mm2"; H100 SXM5 "80 GB HBM3, 5 HBM3 stacks"; Table 3, "GPU Die Size"
//            826 mm2 for the NVIDIA A100.
//   [H200]   NVIDIA H200 product page: "141 gigabytes (GB) of HBM3e memory at 4.8 terabytes per
//            second"; specifications table, H200 SXM: "Up to 700W (configurable)", "SXM".
//            https://www.nvidia.com/en-us/data-center/h200/
//   [A100]   NVIDIA A100 product page, specifications table, A100 80GB SXM column:
//            https://www.nvidia.com/en-us/data-center/a100/
//            "80GB HBM2e", "2,039 GB/s", "400W" (standard configuration), "SXM".
// Removed for want of a source checked here: the H200's die area, any HBM stack count for the
// H200 and the A100, and every price other than Weir's own index.

export type ChipId = "h100" | "h200" | "a100-80";

export interface Chip {
  id: ChipId;
  /** Drawn in the dot-matrix face. */
  name: string;
  model: string;
  formFactor: string;
  memory: string;
  bandwidth: string;
  power: string;
  /** Die name and area, only where a source gives it. */
  die: string | null;
  /** Memory stacks drawn on the card: only where a source gives the count. */
  stacks: number | null;
}

export const CHIPS: Chip[] = [
  { id: "h100", name: "H100", model: "NVIDIA H100 SXM", formFactor: "SXM", memory: "80 GB HBM3", bandwidth: "3.35 TB/s", power: "up to 700 W", die: "GH100 · 814 mm²", stacks: 5 },
  { id: "h200", name: "H200", model: "NVIDIA H200 SXM", formFactor: "SXM", memory: "141 GB HBM3e", bandwidth: "4.8 TB/s", power: "up to 700 W", die: null, stacks: null },
  { id: "a100-80", name: "A100", model: "NVIDIA A100 80GB SXM", formFactor: "SXM", memory: "80 GB HBM2e", bandwidth: "2,039 GB/s", power: "400 W", die: "826 mm²", stacks: null },
];
