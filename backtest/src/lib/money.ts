// Prices are carried as integer micro-USD per GPU-hour (spec section 2), so every
// derived number is exact and reproducible; floats appear only in reported ratios.

export const MICRO = 1_000_000;

export function toMicro(usd: number): number {
  return Math.round(usd * MICRO);
}

/** "2.490000" — six decimals, the exact micro-USD value. */
export function fmtUsd(micro: number): string {
  const neg = micro < 0;
  const a = Math.abs(micro);
  const s = `${Math.floor(a / MICRO)}.${String(a % MICRO).padStart(6, "0")}`;
  return neg ? `-${s}` : s;
}

export function parseUsd(s: string): number {
  const m = /^(-?)(\d+)\.(\d{6})$/.exec(s);
  if (!m) throw new Error(`not a 6-decimal USD value: ${s}`);
  const v = Number(m[2]) * MICRO + Number(m[3]);
  return m[1] ? -v : v;
}
