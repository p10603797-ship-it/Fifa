/**
 * REVIEW of FND-03 (independent reviewer): adversarial tests for src/sim/core/dmath.ts.
 * Math.* is allowed here (tests are outside src/sim). Failing tests in this file are confirmed defects and
 * stay in place as regression tests.
 */
import { describe, expect, it } from 'vitest';
import {
  HALF_PI, PI, TWO_PI, angleDiff, dacos, dasin, datan, datan2, dcos, dexp, dlog, dpow, dsin, dtan, wrapAngle,
} from '../../src/sim/core/dmath';

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/** Move n ulps toward +Infinity (finite, non-zero v; small n so zero is never crossed). */
const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);
function nextUp(v: number, n = 1): number {
  if (v === 0) return n * 5e-324;
  f64[0] = v;
  i64[0]! += BigInt(v > 0 ? n : -n);
  return f64[0]!;
}

describe('review FND-03 dmath: accuracy where reductions are hardest', () => {
  it('dsin/dcos within 1e-6 (spec) at and around every multiple of PI/2 in [-1e4, 1e4]', () => {
    let worst = 0;
    for (let k = -6367; k <= 6367; k++) {
      const c = k * (Math.PI / 2);
      for (let u = -3; u <= 3; u++) {
        const a = u === 0 ? c : nextUp(c, u);
        if (Math.abs(a) > 1e4) continue;
        worst = Math.max(worst, Math.abs(dsin(a) - Math.sin(a)), Math.abs(dcos(a) - Math.cos(a)));
      }
    }
    expect(worst).toBeLessThan(1e-6);
    expect(worst).toBeLessThan(1e-15); // documented accuracy
  });

  it('dsin/dcos dense random sweep over [-1e4, 1e4] (500k points) within 1e-6', () => {
    const r = lcg(7);
    let worst = 0;
    for (let i = 0; i < 500_000; i++) {
      const a = (r() - 0.5) * 2e4;
      worst = Math.max(worst, Math.abs(dsin(a) - Math.sin(a)), Math.abs(dcos(a) - Math.cos(a)));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('dsin/dcos near the PI/4 kernel boundary and the reduction second-round threshold', () => {
    const pts = [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 0.7853981633974483, 0.7853981633974484];
    for (const p of pts) {
      for (let u = -50; u <= 50; u++) {
        const a = nextUp(p, u);
        expect(Math.abs(dsin(a) - Math.sin(a))).toBeLessThan(1e-15);
        expect(Math.abs(dcos(a) - Math.cos(a))).toBeLessThan(1e-15);
      }
    }
  });

  it('dtan relative error stays tiny including next to the poles', () => {
    const r = lcg(11);
    let worst = 0;
    for (let i = 0; i < 200_000; i++) {
      const a = (r() - 0.5) * 2e4;
      const t = Math.tan(a);
      worst = Math.max(worst, Math.abs(dtan(a) - t) / Math.max(1, Math.abs(t)));
    }
    for (let k = -100; k <= 100; k++) {
      const pole = (k + 0.5) * Math.PI;
      for (let u = -2; u <= 2; u++) {
        const a = nextUp(pole, u);
        const t = Math.tan(a);
        worst = Math.max(worst, Math.abs(dtan(a) - t) / Math.max(1, Math.abs(t)));
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('datan2 at extreme ratios, near axes and diagonals, all quadrants (< 1e-6 rad, spec)', () => {
    const mags = [5e-324, 1e-310, 1e-300, 1e-20, 1e-8, 0.5, 1, 2, 1e8, 1e20, 1e300, 1.7976931348623157e308];
    let worst = 0;
    for (const ya of mags) {
      for (const xa of mags) {
        for (const sy of [1, -1]) {
          for (const sx of [1, -1]) {
            const y = ya * sy;
            const x = xa * sx;
            const d = datan2(y, x);
            expect(d > -PI && d <= PI).toBe(true);
            let e = Math.abs(d - Math.atan2(y, x));
            if (Math.abs(Math.atan2(y, x)) > 3.14) e = Math.min(e, Math.abs(Math.abs(d) - Math.abs(Math.atan2(y, x))));
            worst = Math.max(worst, e);
          }
        }
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('datan matches Math.atan (incl. huge, tiny, +-Infinity)', () => {
    const r = lcg(3);
    for (let i = 0; i < 100_000; i++) {
      const x = (r() - 0.5) * Math.pow(10, Math.floor(r() * 40) - 20);
      expect(Math.abs(datan(x) - Math.atan(x))).toBeLessThan(1e-15);
    }
    expect(datan(Infinity)).toBe(HALF_PI);
    expect(datan(-Infinity)).toBe(-HALF_PI);
  });

  it('dasin/dacos at the clamped ends and just inside', () => {
    for (const x of [1, nextUp(1, -1), nextUp(1, -2), -1, nextUp(-1, 1), nextUp(-1, 2), 1e-300, -1e-300, 0.5, -0.5]) {
      expect(Math.abs(dasin(x) - Math.asin(x))).toBeLessThan(1e-14);
      expect(Math.abs(dacos(x) - Math.acos(x))).toBeLessThan(1e-14);
    }
    expect(dasin(2)).toBe(HALF_PI);
    expect(dacos(-7)).toBe(PI);
  });

  it('dexp relative error < 1e-9 (spec) on a dense sweep of [-700, 700] plus the overflow / underflow edges', () => {
    const r = lcg(5);
    let worst = 0;
    for (let i = 0; i < 300_000; i++) {
      const x = (r() - 0.5) * 1400;
      worst = Math.max(worst, Math.abs(dexp(x) - Math.exp(x)) / Math.exp(x));
    }
    for (const x of [709.782712893384, 709.78, 709, -708.39, -708.4, 0.5 * 0.6931471805599453, 0.6931471805599453, -1e-9, 1e-9]) {
      worst = Math.max(worst, Math.abs(dexp(x) - Math.exp(x)) / Math.exp(x));
    }
    expect(worst).toBeLessThan(1e-9);
    expect(dexp(709.79)).toBe(Infinity);
    expect(dexp(-746)).toBe(0);
  });

  it('dlog relative error < 1e-9 (spec) over 1e-300..1e300 and densely around 1', () => {
    const r = lcg(9);
    let worst = 0;
    for (let i = 0; i < 300_000; i++) {
      const x = Math.pow(10, (r() - 0.5) * 600) * (1 + r());
      const l = Math.log(x);
      worst = Math.max(worst, Math.abs(dlog(x) - l) / Math.max(1e-300, Math.abs(l)));
    }
    for (let u = -2000; u <= 2000; u++) {
      if (u === 0) continue;
      const x = nextUp(1, u);
      worst = Math.max(worst, Math.abs(dlog(x) - Math.log(x)) / Math.abs(Math.log(x)));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('dpow relative error < 1e-9 on game ranges (positive bases, fractional and integer exponents)', () => {
    const r = lcg(13);
    let worst = 0;
    for (let i = 0; i < 200_000; i++) {
      const x = r() * 20;
      const y = (r() - 0.5) * 20;
      const yi = Math.round(y);
      const p = Math.pow(x, y);
      if (p !== 0 && Number.isFinite(p)) worst = Math.max(worst, Math.abs(dpow(x, y) - p) / p);
      const pi = Math.pow(x, yi);
      if (pi !== 0 && Number.isFinite(pi)) worst = Math.max(worst, Math.abs(dpow(x, yi) - pi) / pi);
    }
    expect(worst).toBeLessThan(1e-9);
    // integer path near the 1024 switch-over is consistent with the dexp path
    expect(Math.abs(dpow(1.0001, 1024) / dpow(1.0001, 1024.000001) - 1)).toBeLessThan(1e-9);
    expect(dpow(-2, 3)).toBe(-8);
    expect(dpow(-2, 1025)).toBe(-Infinity);
    expect(dpow(-8, 1 / 3)).toBeNaN();
  });

  it('results do not depend on call history (module scratch redN / bit views)', () => {
    const r = lcg(17);
    const xs: number[] = [];
    for (let i = 0; i < 2000; i++) xs.push((r() - 0.5) * 2e4);
    const ref = xs.map((x) => [dsin(x), dcos(x), dtan(x), dlog(Math.abs(x) + 1), dexp(x / 100)]);
    // Interleave with other calls that overwrite the module scratch.
    const again = xs.map((x, i) => {
      dtan(xs[(i + 7) % xs.length]!); dlog(i + 0.5);
      const s = dsin(x);
      dcos(-x * 3);
      const c = dcos(x);
      dsin(x * 0.5);
      return [s, c, dtan(x), dlog(Math.abs(x) + 1), dexp(x / 100)];
    });
    expect(again).toEqual(ref);
  });
});

describe('review FND-03 dmath: contract outside the accuracy range (robustness)', () => {
  // DEFECT (minor): reduce() has no large-argument path (no Payne-Hanek), so dsin/dcos stop being bounded for
  // |a| >~ 1e17: dsin(1e18) = -3.47e18, dsin(1e22) = -4.0e71, dsin(1e300) = -Infinity, dcos(1e300) = NaN.
  // Expected: any finite input gives a value in [-1, 1] (inaccurate is acceptable, unbounded is not).
  it('dsin/dcos stay within [-1, 1] for every finite input', () => {
    const bad: string[] = [];
    for (const a of [1e15, 1e16, 1e17, 1e18, 1e20, 1e22, 1e100, 1e300, 1.7976931348623157e308]) {
      for (const v of [a, -a]) {
        const s = dsin(v);
        const c = dcos(v);
        if (!(Math.abs(s) <= 1) || !(Math.abs(c) <= 1)) bad.push(`${v}: sin=${s} cos=${c}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // DEFECT (minor): wrapAngle(1e18) = -121.7 (outside (-PI, PI]): TWO_PI * round(a / TWO_PI) is inexact and a
  // single correction step is not enough. Expected: (-PI, PI] for every finite input.
  it('wrapAngle returns a value in (-PI, PI] for every finite input', () => {
    const bad: string[] = [];
    const r = lcg(21);
    const pts: number[] = [];
    for (let e = 0; e <= 308; e++) pts.push(Math.pow(10, e), -Math.pow(10, e), 1.234567 * Math.pow(10, e));
    for (let i = 0; i < 20_000; i++) pts.push((r() - 0.5) * Math.pow(10, Math.floor(r() * 30)));
    for (const a of pts) {
      const w = wrapAngle(a);
      if (!(w > -PI && w <= PI)) bad.push(`${a} -> ${w}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('wrapAngle / angleDiff contract on ordinary inputs (boundaries, idempotence, 2PI periodicity)', () => {
    expect(wrapAngle(PI)).toBe(PI);
    expect(wrapAngle(-PI)).toBe(PI);
    expect(wrapAngle(TWO_PI)).toBe(0);
    expect(wrapAngle(nextUp(PI))).toBeLessThan(-3.14);
    const r = lcg(23);
    for (let i = 0; i < 100_000; i++) {
      const a = (r() - 0.5) * 2e4;
      const w = wrapAngle(a);
      expect(w > -PI && w <= PI).toBe(true);
      expect(wrapAngle(w)).toBe(w);
      expect(Math.abs(Math.sin(w) - Math.sin(a))).toBeLessThan(1e-11);
      const d = angleDiff(a, a + (r() - 0.5) * 20);
      expect(d > -PI && d <= PI).toBe(true);
    }
  });

  // DEFECT (minor): datan2 with two infinite arguments returns NaN (atanPos(Inf/Inf)); Math.atan2 and IEEE give
  // +-PI/4, +-3PI/4. Expected: finite angle in (-PI, PI].
  it('datan2 with infinite arguments returns the IEEE angles', () => {
    expect(datan2(Infinity, Infinity)).toBeCloseTo(PI / 4, 15);
    expect(datan2(-Infinity, Infinity)).toBeCloseTo(-PI / 4, 15);
    expect(datan2(Infinity, -Infinity)).toBeCloseTo(3 * PI / 4, 15);
    expect(datan2(-Infinity, -Infinity)).toBeCloseTo(-3 * PI / 4, 15);
    expect(datan2(1, Infinity)).toBe(0);
    expect(datan2(Infinity, 1)).toBe(HALF_PI);
  });

  // DEFECT (minor): integer-exponent path computes 1 / x^n, so when x^n overflows the (representable, subnormal)
  // result collapses to 0: dpow(10, -310) = 0 but 10^-310 = 1e-310. Expected: relative error consistent with the
  // rest of dpow (or at least non-zero) whenever Math.pow is non-zero.
  it('dpow with a negative integer exponent does not flush representable subnormal results to 0', () => {
    expect(dpow(10, -310)).not.toBe(0);
    expect(Math.abs(dpow(10, -310) / Math.pow(10, -310) - 1)).toBeLessThan(1e-6);
    expect(dpow(1e5, -62)).not.toBe(0);
  });
});
