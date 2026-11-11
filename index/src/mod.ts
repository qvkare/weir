// Public entry: everything another package needs to produce, hash and check a print.
// Browser-safe; the HTTP lives in fetch.ts and the file IO in cli.ts.
export * from "./method.ts";
export { bundleHash, canonical, sha256Hex, verifyBundle, verifyRaw, type Check, type Sha256Hex } from "./bundle.ts";
export { SOURCES, sourceById } from "./sources/mod.ts";
