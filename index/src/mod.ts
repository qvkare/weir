// Public entry: everything another package needs to produce, hash and check a print.
// Browser-safe; the HTTP lives in fetch.ts and the file IO in cli.ts.
export * from "./method.ts";
export { CHIP_IDS, CHIPS, chipById, H100_V1, matches, type Chip, type ChipId, type Match } from "./chips.ts";
export { bundleHash, canonical, sha256Hex, sourcesOf, verifyBundle, verifyRaw, type Check, type Sha256Hex } from "./bundle.ts";
export { SOURCES, SOURCES_V1, sourceById, sourcesFor } from "./sources/mod.ts";
