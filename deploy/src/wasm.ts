// The two contracts as built by contracts/build.sh. A wasm older than its sources is refused,
// as the Rust sandbox tests and the integration harness refuse it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { base58Encode } from "../../chain/src/tx.ts";

const CONTRACTS = new URL("../../contracts/", import.meta.url).pathname;

export interface Wasm {
  name: "weir" | "mock_usdc";
  path: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
  /** What NEAR reports as the account's `code_hash`: base58 of the sha256. */
  codeHash: string;
}

export function loadWasm(name: Wasm["name"], opts: { checkFresh?: boolean } = {}): Wasm {
  const crate = name === "weir" ? "weir" : "mock-usdc";
  const path = `${CONTRACTS}target/near/${name}/${name}.wasm`;
  let built: number;
  try {
    built = statSync(path).mtimeMs;
  } catch {
    throw new Error(`${path} is missing: run contracts/build.sh`);
  }
  if (opts.checkFresh !== false) {
    const src = `${CONTRACTS}${crate}/src/`;
    const newest = Math.max(...readdirSync(src).map((f) => statSync(`${src}${f}`).mtimeMs));
    if (built < newest) throw new Error(`${path} is older than its source: run contracts/build.sh`);
  }
  const bytes = new Uint8Array(readFileSync(path));
  const digest = createHash("sha256").update(bytes).digest();
  return { name, path, bytes, size: bytes.length, sha256: digest.toString("hex"), codeHash: base58Encode(new Uint8Array(digest)) };
}
