// HMAC-SHA-256 (RFC 2104) over the engine's synchronous SHA-256, so salts and seeds can be
// derived in a browser or a Worker without Web Crypto's promises, and a seeded PRNG.
import { sha256, utf8 } from "@weir/engine";

const BLOCK = 64;

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const k = new Uint8Array(BLOCK);
  k.set(key.length > BLOCK ? sha256(key) : key);
  const inner = new Uint8Array(BLOCK + message.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(message, BLOCK);
  outer.set(sha256(inner), BLOCK);
  return sha256(outer);
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA-256 of two strings, as 64 lowercase hex characters. */
export const hmacHex = (secret: string, message: string): string => toHex(hmacSha256(utf8(secret), utf8(message)));

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PRNG seeded from HMAC(secret, label): the same label always gives the same stream. */
export const derivedRng = (secret: string, label: string): (() => number) =>
  mulberry32(parseInt(hmacHex(secret, label).slice(0, 8), 16));
