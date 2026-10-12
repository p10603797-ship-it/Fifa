/**
 * Deterministic maths for sim/ai. [FND-03]
 * Only +, -, *, /, Math.sqrt/abs/min/max/floor/ceil/round/trunc are used inside; trig and atan2 come
 * from tables / polynomials so results are bit-identical in every JS engine.
 * Accuracy target: |dsin - sin| < 1e-5 over any input; datan2 error < 1e-5 rad.
 */

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number { throw new Error('FND-03'); }
export function dsin(a: number): number { throw new Error('FND-03'); }
export function dcos(a: number): number { throw new Error('FND-03'); }
export function dtan(a: number): number { throw new Error('FND-03'); }
/** atan2(y, x) in (-PI, PI]. */
export function datan2(y: number, x: number): number { throw new Error('FND-03'); }
export function dacos(x: number): number { throw new Error('FND-03'); }
export function dasin(x: number): number { throw new Error('FND-03'); }
/** e^x for |x| <= 20 (series / squaring), deterministic. */
export function dexp(x: number): number { throw new Error('FND-03'); }
/** Natural log for x > 0, deterministic. */
export function dlog(x: number): number { throw new Error('FND-03'); }
/** x^y for x > 0 via dexp(y * dlog(x)); integer y uses repeated multiplication. */
export function dpow(x: number, y: number): number { throw new Error('FND-03'); }

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
/** Inverse lerp clamped to [0,1]. */
export function unlerp(a: number, b: number, v: number): number { return b === a ? 0 : clamp01((v - a) / (b - a)); }
export function smoothstep(e0: number, e1: number, v: number): number { const t = unlerp(e0, e1, v); return t * t * (3 - 2 * t); }
export function sign(v: number): number { return v > 0 ? 1 : v < 0 ? -1 : 0; }
export function len2(x: number, z: number): number { return Math.sqrt(x * x + z * z); }
export function dist2(ax: number, az: number, bx: number, bz: number): number { const dx = bx - ax, dz = bz - az; return Math.sqrt(dx * dx + dz * dz); }
export function distSq2(ax: number, az: number, bx: number, bz: number): number { const dx = bx - ax, dz = bz - az; return dx * dx + dz * dz; }
/** Map an attribute 1..99 to [lo, hi] linearly. */
export function attr(v: number, lo: number, hi: number): number { return lo + (hi - lo) * clamp01((v - 1) / 98); }
/** Angle of a 2D vector on the ground plane: datan2(z, x). */
export function angleOf(x: number, z: number): number { return datan2(z, x); }
/** Signed smallest angle from a to b in (-PI, PI]. */
export function angleDiff(a: number, b: number): number { return wrapAngle(b - a); }
