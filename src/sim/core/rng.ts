/**
 * Seeded deterministic RNG stored in sim state (sfc32). [FND-03]
 * The only source of randomness allowed in sim/ai. Never use Math.random there.
 *
 * sfc32 ("Small Fast Counting", Chris Doty-Humphrey, PractRand) on four uint32 words. All arithmetic is
 * integer arithmetic on values < 2^53 followed by `>>> 0`, so the stream is bit-identical in every engine.
 * Every helper consumes exactly the documented number of draws regardless of its arguments, so call
 * sequences (not argument values) define the stream position.
 */
import type { RngState } from '../../contracts/state';

/** 2^-32 as an exact double. */
const INV_2_32 = 1 / 4294967296;
/** sqrt(3): rescales a sum of 4 uniforms (variance 4/12) to unit variance. */
const SQRT3 = 1.7320508075688772;

/** Seed the generator from a uint32 (warms up 12 rounds). Non-integer seeds are truncated to uint32. */
export function rngSeed(r: RngState, seed: number): void {
  r.a = 0x9e3779b9;
  r.b = seed >>> 0;
  r.c = 0x85ebca6b;
  r.d = 1;
  for (let i = 0; i < 12; i++) rngNext(r);
}

/** Next uint32 (one draw). */
export function rngNext(r: RngState): number {
  const a = r.a >>> 0;
  const b = r.b >>> 0;
  const c = r.c >>> 0;
  const d = r.d >>> 0;
  const t = (((a + b) >>> 0) + d) >>> 0;
  r.d = (d + 1) >>> 0;
  r.a = (b ^ (b >>> 9)) >>> 0;
  r.b = (c + (c << 3)) >>> 0;
  r.c = ((((c << 21) | (c >>> 11)) >>> 0) + t) >>> 0;
  return t;
}

/** Uniform float in [0, 1) with 32 bits of resolution (one draw). */
export function rngFloat(r: RngState): number {
  return rngNext(r) * INV_2_32;
}

/** Uniform float in [lo, hi) (one draw). */
export function rngRange(r: RngState, lo: number, hi: number): number {
  return lo + (hi - lo) * rngFloat(r);
}

/** Uniform integer in [0, n) (one draw). n is truncated; n <= 1 returns 0 (still consumes a draw). */
export function rngInt(r: RngState, n: number): number {
  const f = rngFloat(r);
  const m = Math.trunc(n);
  return m > 1 ? Math.floor(f * m) : 0;
}

/**
 * Approximately normal (mean 0, sd 1), deterministic (four draws): Irwin-Hall sum of 4 uniforms, centred
 * and rescaled. Bounded to +-2*sqrt(3) (about 3.46 sd), which is what gameplay noise wants anyway.
 */
export function rngGauss(r: RngState): number {
  const s = rngFloat(r) + rngFloat(r) + rngFloat(r) + rngFloat(r);
  return (s - 2) * SQRT3;
}

/** True with probability p (one draw; p <= 0 is never, p >= 1 is always). */
export function rngChance(r: RngState, p: number): boolean {
  return rngFloat(r) < p;
}
