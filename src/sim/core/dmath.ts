/**
 * Deterministic maths for sim/ai. [FND-03]
 * Only +, -, *, /, Math.sqrt/abs/min/max/floor/ceil/round/trunc and typed-array bit access are used inside;
 * trig, atan2, exp and log come from range reduction with exact split constants followed by fixed polynomial
 * kernels (fdlibm-derived coefficients). IEEE-754 basic operations are correctly rounded and JS never fuses
 * them, so every result is bit-identical in every JS engine.
 *
 * Accuracy (verified by tests/unit/fnd-03-dmath.test.ts against Math.*):
 *  - dsin / dcos: |error| < 1e-15 on [-1e4, 1e4] (a few ulp; reduction degrades slowly beyond ~1e6).
 *  - datan2: < 1e-15 rad in all quadrants; datan2(0, 0) = 0; result in (-PI, PI] (y = -0 is treated as 0).
 *  - dasin / dacos: < 1e-14 rad on [-1, 1] (inputs are clamped to [-1, 1]).
 *  - dexp: relative error < 1e-15 on [-700, 700]; overflow -> Infinity, underflow -> 0.
 *  - dlog: relative error < 1e-15 for x > 0 (incl. subnormals); dlog(0) = -Infinity, dlog(x < 0) = NaN.
 *  - dpow: repeated squaring for integer |y| <= 1024 (exact whenever the result is representable, e.g.
 *    dpow(2, 10) === 1024), dexp(y * dlog(x)) otherwise; relative error < 1e-13 on typical game ranges.
 *  - datan2(y, x) with y < 0 that would round to -PI returns -PI + 1 ulp (keeps the (-PI, PI] contract).
 * NaN inputs propagate to NaN (except dpow(NaN, 0) = 1, as IEEE pow).
 */

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

// ---------------------------------------------------------------- shared constants

/** 2/PI rounded to double. */
const INV_PIO2 = 0.6366197723675814;
/** PI/2 split into a 33-bit head (k * PIO2_1 exact for |k| < 2^20) and tails (Cody-Waite). */
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
/** PI/4 boundary for the kernels. */
const PIO4 = 7.85398163397448278999e-01;
/** 1/(2*PI). */
const INV_TWO_PI = 0.15915494309189535;
/** Smallest angle above -PI (-PI + 1 ulp). */
const NEG_PI_UP = -3.1415926535897927;
/** Low part of pi: the true pi ~= PI + PI_LO to ~107 bits. */
const PI_LO = 1.2246467991473532e-16;

// ---------------------------------------------------------------- sin / cos kernels (|x| <= PI/4)

const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

/** sin(x) for |x| <= PI/4 (plus a tiny reduction tail). */
function kSin(x: number): number {
  const z = x * x;
  return x + x * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

/** cos(x) for |x| <= PI/4. Uses the fdlibm split 1 - (hz - (z*r)) for accuracy near PI/4. */
function kCos(x: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (((1 - w) - hz) + z * r);
}

/** Quadrant (0..3) of the last reduction. Module scratch: no allocation. */
let redN = 0;

/**
 * Reduce a >= 0 to y in [-PI/4, PI/4] with a = y + n * PI/2, n stored in redN. Exact head products for
 * a < ~1.6e6; beyond that the result is still deterministic but loses accuracy.
 */
function reduce(a: number): number {
  if (a <= PIO4) { redN = 0; return a; }
  const k = Math.round(a * INV_PIO2);
  // a - k*PIO2_1 is exact (Sterbenz); two tail terms give ~85 bits of PI/2.
  const r = a - k * PIO2_1;
  const w = k * PIO2_1T;
  let y = r - w;
  // Second round when the first leaves too few significant bits (a close to a multiple of PI/2).
  if (Math.abs(y) < 1e-6 * (k < 1 ? 1 : k)) {
    const r2 = r - k * PIO2_2;
    const w2 = k * PIO2_2T - ((r - r2) - k * PIO2_2);
    y = r2 - w2;
  }
  redN = k - 4 * Math.floor(k * 0.25);
  return y;
}

/**
 * Wrap an angle to (-PI, PI]. Works in the double-PI world of the sim (PI and TWO_PI are the constants
 * above): wrapAngle(TWO_PI) === 0 and wrapAngle(-PI) === PI exactly; one wrap of an angle in (-3PI, 3PI]
 * is a single exact-as-possible subtraction.
 */
export function wrapAngle(a: number): number {
  if (a > -PI && a <= PI) return a;
  let r: number;
  if (a > PI && a <= 3 * PI) r = a - TWO_PI;
  else if (a <= -PI && a > -3 * PI) r = a + TWO_PI;
  else r = a - TWO_PI * Math.round(a * INV_TWO_PI);
  if (r <= -PI) r += TWO_PI;
  else if (r > PI) r -= TWO_PI;
  return r;
}

/** Deterministic sin. Odd-symmetric: dsin(-a) === -dsin(a). */
export function dsin(a: number): number {
  if (a === 0) return a; // keeps the sign of zero like Math.sin
  const neg = a < 0;
  const y = reduce(neg ? -a : a);
  let v: number;
  switch (redN) {
    case 0: v = kSin(y); break;
    case 1: v = kCos(y); break;
    case 2: v = -kSin(y); break;
    default: v = -kCos(y); break;
  }
  return neg ? -v : v;
}

/** Deterministic cos. Even-symmetric: dcos(-a) === dcos(a). */
export function dcos(a: number): number {
  const y = reduce(a < 0 ? -a : a);
  switch (redN) {
    case 0: return kCos(y);
    case 1: return -kSin(y);
    case 2: return -kCos(y);
    default: return kSin(y);
  }
}

/** Deterministic tan (sin/cos of the reduced argument). Odd-symmetric. */
export function dtan(a: number): number {
  if (a === 0) return a;
  const neg = a < 0;
  const y = reduce(neg ? -a : a);
  const s = kSin(y);
  const c = kCos(y);
  const v = (redN & 1) === 0 ? s / c : -c / s;
  return neg ? -v : v;
}

// ---------------------------------------------------------------- atan (fdlibm s_atan.c)

const ATAN_HI0 = 4.63647609000806093515e-01; // atan(0.5)
const ATAN_HI1 = 7.85398163397448278999e-01; // atan(1)
const ATAN_HI2 = 9.82793723247329054082e-01; // atan(1.5)
const ATAN_HI3 = 1.57079632679489655800e+00; // atan(inf)
const ATAN_LO0 = 2.26987774529616870924e-17;
const ATAN_LO1 = 3.06161699786838301793e-17;
const ATAN_LO2 = 1.39033110312309984516e-17;
const ATAN_LO3 = 6.12323399573676603587e-17;
const AT0 = 3.33333333333329318027e-01;
const AT1 = -1.99999999998764832476e-01;
const AT2 = 1.42857142725034663711e-01;
const AT3 = -1.11111104054623557880e-01;
const AT4 = 9.09088713343650656196e-02;
const AT5 = -7.69187620504482999495e-02;
const AT6 = 6.66107313738753120669e-02;
const AT7 = -5.83357013379057348645e-02;
const AT8 = 4.97687799461593236017e-02;
const AT9 = -3.65315727442169155270e-02;
const AT10 = 1.62858201153657823623e-02;

/** atan(x) for x >= 0 (finite or +Infinity). */
function atanPos(x: number): number {
  let hi: number;
  let lo: number;
  if (x < 0.4375) {
    if (x < 3.725290298461914e-9) return x; // 2^-28: atan(x) == x to double precision
    hi = -1; lo = 0;
  } else if (x < 1.1875) {
    if (x < 0.6875) { hi = ATAN_HI0; lo = ATAN_LO0; x = (2 * x - 1) / (2 + x); } else { hi = ATAN_HI1; lo = ATAN_LO1; x = (x - 1) / (x + 1); }
  } else if (x < 2.4375) {
    hi = ATAN_HI2; lo = ATAN_LO2; x = (x - 1.5) / (1 + 1.5 * x);
  } else {
    if (x >= 7.378697629483821e19) return ATAN_HI3 + ATAN_LO3; // 2^66
    hi = ATAN_HI3; lo = ATAN_LO3; x = -1 / x;
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (hi < 0) return x - x * (s1 + s2);
  return hi - ((x * (s1 + s2) - lo) - x);
}

/** Deterministic atan. */
export function datan(x: number): number {
  if (x !== x) return NaN;
  return x < 0 ? -atanPos(-x) : atanPos(x);
}

/**
 * atan2(y, x) in (-PI, PI]. datan2(0, 0) = 0, datan2(+-0, x < 0) = PI (y = -0 is treated as +0 so the
 * result never equals -PI). Odd in y for y != 0.
 */
export function datan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  const ay = y < 0 ? -y : y;
  if (ay === 0) return x < 0 ? PI : 0;
  let r: number;
  if (x === 0) {
    r = HALF_PI;
  } else if (x > 0) {
    r = atanPos(ay / x);
  } else {
    // PI - atan(|y/x|) with the PI tail folded in for accuracy.
    r = PI - (atanPos(ay / -x) - PI_LO);
  }
  if (y >= 0) return r;
  // r rounds to PI only for y -> -0 with x < 0: return the largest double above -PI to keep (-PI, PI].
  return r === PI ? NEG_PI_UP : -r;
}

/** Deterministic asin; x is clamped to [-1, 1]. */
export function dasin(x: number): number {
  if (x !== x) return NaN;
  if (x >= 1) return HALF_PI;
  if (x <= -1) return -HALF_PI;
  // (1 - x)(1 + x) avoids the cancellation of 1 - x*x near |x| = 1.
  return datan2(x, Math.sqrt((1 - x) * (1 + x)));
}

/** Deterministic acos in [0, PI]; x is clamped to [-1, 1]. */
export function dacos(x: number): number {
  if (x !== x) return NaN;
  if (x >= 1) return 0;
  if (x <= -1) return PI;
  return datan2(Math.sqrt((1 - x) * (1 + x)), x);
}

// ---------------------------------------------------------------- exp (fdlibm e_exp.c)

const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+00;
const EP1 = 1.66666666666666019037e-01;
const EP2 = -2.77777777770155933842e-03;
const EP3 = 6.61375632143793436117e-05;
const EP4 = -1.65339022054652515390e-06;
const EP5 = 4.13813679705723846039e-08;
/** exp overflows above this. */
const EXP_MAX = 7.09782712893383973096e+02;
/** exp underflows to 0 below this. */
const EXP_MIN = -7.45133219101941108420e+02;

/** POW2[k + POW2_BIAS] = 2^k exactly for k in [-1022, 1023]; built by exact doubling/halving at load. */
const POW2_BIAS = 1022;
const POW2 = new Float64Array(2046);
POW2[POW2_BIAS] = 1;
for (let i = POW2_BIAS + 1; i < POW2.length; i++) POW2[i] = POW2[i - 1]! * 2;
for (let i = POW2_BIAS - 1; i >= 0; i--) POW2[i] = POW2[i + 1]! * 0.5;
/** 2^-60 for subnormal scaling. */
const TWO_M60 = POW2[POW2_BIAS - 60]!;

/** Multiply y by 2^k for any integer k in [-1100, 1100] (exact unless the result is subnormal). */
function scale2(y: number, k: number): number {
  if (k > 1023) return y * 2 * POW2[k - 1 + POW2_BIAS]!;
  if (k < -1022) return y * POW2[k + 60 + POW2_BIAS]! * TWO_M60;
  return y * POW2[k + POW2_BIAS]!;
}

/** Deterministic e^x. Relative error ~1 ulp on [-700, 700]. */
export function dexp(x: number): number {
  if (x !== x) return NaN;
  if (x > EXP_MAX) return Infinity;
  if (x < EXP_MIN) return 0;
  const ax = x < 0 ? -x : x;
  if (ax < 3.725290298461914e-9) return 1 + x; // 2^-28
  if (x === 1) return 2.718281828459045; // the kernel is 1 ulp high at exactly 1; return correctly rounded e
  let k = 0;
  let hi = x;
  let lo = 0;
  if (ax > 0.5 * LN2_HI) {
    k = Math.round(x * INV_LN2);
    hi = x - k * LN2_HI; // exact: k has <= 11 bits, LN2_HI has 32
    lo = k * LN2_LO;
  }
  const r = hi - lo;
  const t = r * r;
  const c = r - t * (EP1 + t * (EP2 + t * (EP3 + t * (EP4 + t * EP5))));
  const y = 1 - ((lo - (r * c) / (2 - c)) - hi);
  return k === 0 ? y : scale2(y, k);
}

// ---------------------------------------------------------------- log (fdlibm e_log.c)

const LG1 = 6.666666666666735130e-01;
const LG2 = 3.999999999940941908e-01;
const LG3 = 2.857142874366239149e-01;
const LG4 = 2.222219843214978396e-01;
const LG5 = 1.818357216161805012e-01;
const LG6 = 1.531383769920937332e-01;
const LG7 = 1.479819860511658591e-01;
const MIN_NORMAL = 2.2250738585072014e-308;
const TWO_P54 = POW2[54 + POW2_BIAS]!;

/** Bit access to doubles (IEEE-754 layout is fixed; only the word order depends on the platform). */
const LOG_F64 = new Float64Array(1);
const LOG_U32 = new Uint32Array(LOG_F64.buffer);
LOG_F64[0] = 1;
const HI = LOG_U32[1] === 0x3ff00000 ? 1 : 0;

/** Deterministic natural log. dlog(0) = -Infinity, dlog(x < 0) = NaN, dlog(Infinity) = Infinity. */
export function dlog(x: number): number {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let k = 0;
  if (x < MIN_NORMAL) { x *= TWO_P54; k = -54; }
  LOG_F64[0] = x;
  let hx = LOG_U32[HI]!;
  k += (hx >>> 20) - 1023;
  hx &= 0x000fffff;
  // Normalise the mantissa into [sqrt(2)/2, sqrt(2)).
  const i = (hx + 0x95f64) & 0x100000;
  LOG_U32[HI] = (hx | (i ^ 0x3ff00000)) >>> 0;
  k += i >>> 20;
  const f = LOG_F64[0]! - 1;
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const R = t2 + t1;
  const hfsq = 0.5 * f * f;
  if (k === 0) return f - (hfsq - s * (hfsq + R));
  return k * LN2_HI - ((hfsq - (s * (hfsq + R) + k * LN2_LO)) - f);
}

/** Integer powers by repeated squaring are used up to this |y|. */
const POW_INT_MAX = 1024;

/**
 * x^y. Integer y with |y| <= 1024 uses repeated squaring (any sign of x); otherwise x > 0 uses
 * dexp(y * dlog(x)). x < 0 with non-integer y gives NaN; 0^y follows the IEEE conventions.
 */
export function dpow(x: number, y: number): number {
  if (y === 0) return 1;
  if (x !== x || y !== y) return NaN;
  if (Math.trunc(y) === y && y <= POW_INT_MAX && y >= -POW_INT_MAX) {
    let n = y < 0 ? -y : y;
    let base = x;
    let acc = 1;
    while (n > 0) {
      if ((n & 1) === 1) acc *= base;
      n >>>= 1;
      if (n > 0) base *= base;
    }
    return y < 0 ? 1 / acc : acc;
  }
  if (x > 0) return dexp(y * dlog(x));
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (Math.trunc(y) !== y) return NaN;
  // Large integer exponent of a negative base: sign from parity.
  const mag = dexp(y * dlog(-x));
  const half = y * 0.5;
  return Math.trunc(half) === half ? mag : -mag;
}

// ---------------------------------------------------------------- helpers

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
