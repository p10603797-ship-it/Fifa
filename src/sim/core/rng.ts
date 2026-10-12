/**
 * Seeded deterministic RNG stored in sim state (sfc32). [FND-03]
 * The only source of randomness allowed in sim/ai. Never use Math.random there.
 */
import type { RngState } from '../../contracts/state';

/** Seed the generator from a uint32 (warms up 12 rounds). */
export function rngSeed(r: RngState, seed: number): void {
  throw new Error('FND-03: rngSeed not implemented');
}
/** Next uint32. */
export function rngNext(r: RngState): number {
  throw new Error('FND-03: rngNext not implemented');
}
/** Uniform float in [0, 1). */
export function rngFloat(r: RngState): number {
  throw new Error('FND-03: rngFloat not implemented');
}
/** Uniform float in [lo, hi). */
export function rngRange(r: RngState, lo: number, hi: number): number {
  throw new Error('FND-03: rngRange not implemented');
}
/** Uniform integer in [0, n). */
export function rngInt(r: RngState, n: number): number {
  throw new Error('FND-03: rngInt not implemented');
}
/** Approximately normal (mean 0, sd 1), deterministic (sum of uniforms, no transcendental functions). */
export function rngGauss(r: RngState): number {
  throw new Error('FND-03: rngGauss not implemented');
}
/** True with probability p. */
export function rngChance(r: RngState, p: number): boolean {
  throw new Error('FND-03: rngChance not implemented');
}
