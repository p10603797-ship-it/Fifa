/**
 * [FND-06] Seeded randomness for the tools (config variation, hostile inputs). Reuses the sim's sfc32 so runs
 * reproduce from a printed seed; never Math.random.
 */
import type { RngState } from '../../src/contracts/state';
import { rngChance, rngFloat, rngInt, rngNext, rngSeed } from '../../src/sim/core/rng';

export { rngChance, rngFloat, rngInt, rngNext };

/** murmur3 fmix32 of two words: well-spread uint32 seeds from (base seed, index). */
export function mix32(a: number, b: number): number {
  let h = (Math.imul(a >>> 0, 0x9e3779b1) ^ (b >>> 0)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function createRng(seed: number): RngState {
  const r: RngState = { a: 0, b: 0, c: 0, d: 0 };
  rngSeed(r, seed >>> 0);
  return r;
}

/** Uniform integer in [lo, hi] inclusive. */
export function rngIntIn(r: RngState, lo: number, hi: number): number {
  return lo + rngInt(r, hi - lo + 1);
}

/** Random element. */
export function pick<T>(r: RngState, items: readonly T[]): T {
  return items[rngInt(r, items.length)]!;
}
