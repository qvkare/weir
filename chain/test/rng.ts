// mulberry32, so every random test replays exactly from its seed.
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

export const bytes = (r: () => number, n: number): Uint8Array => Uint8Array.from({ length: n }, () => int(r, 0, 255));

/** A uniform unsigned integer below 2^bits. */
export function bigUint(r: () => number, bits: number): bigint {
  let v = 0n;
  for (const b of bytes(r, bits / 8)) v = (v << 8n) | BigInt(b);
  return v;
}
