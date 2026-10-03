// Seeded PRNG (mulberry32) whose state is a plain number, so it survives JSON snapshots.
export type RngState = { s: number };

export function makeRng(seed: number): RngState {
  return { s: (seed >>> 0) ^ 0x9e3779b9 };
}

export function next(r: RngState): number {
  r.s = (r.s + 0x6d2b79f5) | 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function range(r: RngState, lo: number, hi: number): number {
  return lo + next(r) * (hi - lo);
}

export function int(r: RngState, lo: number, hiInclusive: number): number {
  return Math.floor(range(r, lo, hiInclusive + 1));
}

export function pick<T>(r: RngState, items: readonly T[]): T {
  return items[Math.floor(next(r) * items.length)];
}

/** Approximately normal(0, 1) via the sum of uniforms. */
export function gauss(r: RngState): number {
  return next(r) + next(r) + next(r) + next(r) - 2;
}
