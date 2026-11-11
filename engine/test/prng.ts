// mulberry32: a tiny seeded PRNG, so every random test replays exactly from its seed.
export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  hex(chars: number): string {
    let s = "";
    for (let i = 0; i < chars; i++) s += "0123456789abcdef"[this.int(0, 15)];
    return s;
  }
}
