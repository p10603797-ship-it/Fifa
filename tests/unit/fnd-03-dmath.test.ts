/** FND-03: deterministic maths accuracy sweeps against Math.* (allowed in tests) and exact-repeatability pins. */
import { describe, expect, it } from 'vitest';
import {
  HALF_PI, PI, TWO_PI, angleDiff, angleOf, dacos, dasin, datan, datan2, dcos, dexp, dlog, dpow, dsin, dtan, wrapAngle,
} from '../../src/sim/core/dmath';
import { hashHex, hashValue } from '../../src/sim/core/hash';

/** Deterministic test sample generator (LCG), independent of the code under test. */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

describe('dmath trig', () => {
  it('dsin/dcos |error| < 1e-6 (actually < 1e-14) over [-1e4, 1e4]', () => {
    let maxS = 0, maxC = 0;
    const N = 400000;
    for (let i = 0; i <= N; i++) {
      const a = -1e4 + (2e4 * i) / N + (i % 13) * 1.37e-5;
      maxS = Math.max(maxS, Math.abs(dsin(a) - Math.sin(a)));
      maxC = Math.max(maxC, Math.abs(dcos(a) - Math.cos(a)));
    }
    const rnd = lcg(1);
    for (let i = 0; i < 100000; i++) {
      const a = (rnd() * 2 - 1) * 1e4;
      maxS = Math.max(maxS, Math.abs(dsin(a) - Math.sin(a)));
      maxC = Math.max(maxC, Math.abs(dcos(a) - Math.cos(a)));
    }
    expect(maxS).toBeLessThan(1e-14);
    expect(maxC).toBeLessThan(1e-14);
  });

  it('dsin/dcos are exact at the special points and near multiples of PI/2', () => {
    expect(dsin(0)).toBe(0);
    expect(dcos(0)).toBe(1);
    expect(Object.is(dsin(-0), -0)).toBe(true);
    for (let k = -2000; k <= 2000; k++) {
      const a = k * HALF_PI;
      expect(Math.abs(dsin(a) - Math.sin(a))).toBeLessThan(1e-15 * Math.max(1, Math.abs(k)));
      expect(Math.abs(dcos(a) - Math.cos(a))).toBeLessThan(1e-15 * Math.max(1, Math.abs(k)));
    }
    // Tiny arguments keep relative accuracy.
    for (const a of [1e-300, 1e-20, 1e-9, 3e-5]) {
      expect(Math.abs(dsin(a) / Math.sin(a) - 1)).toBeLessThan(1e-15);
      expect(dcos(a)).toBe(Math.cos(a));
    }
  });

  it('symmetry: dsin odd, dcos even, dtan odd (bit-exact)', () => {
    const rnd = lcg(2);
    for (let i = 0; i < 20000; i++) {
      const a = (rnd() * 2 - 1) * 5000;
      expect(dsin(-a)).toBe(-dsin(a));
      expect(dcos(-a)).toBe(dcos(a));
      expect(dtan(-a)).toBe(-dtan(a));
    }
  });

  it('sin^2 + cos^2 = 1', () => {
    const rnd = lcg(3);
    for (let i = 0; i < 10000; i++) {
      const a = (rnd() * 2 - 1) * 1e4;
      const s = dsin(a), c = dcos(a);
      expect(Math.abs(s * s + c * c - 1)).toBeLessThan(1e-15);
    }
  });

  it('dtan matches Math.tan (relative where |tan| large)', () => {
    let maxErr = 0;
    for (let i = 0; i <= 200000; i++) {
      const a = -1000 + i * 0.01 + 0.0037;
      const t = Math.tan(a);
      maxErr = Math.max(maxErr, Math.abs(dtan(a) - t) / Math.max(1, Math.abs(t)));
    }
    expect(maxErr).toBeLessThan(1e-14);
  });

  it('NaN and Infinity propagate to NaN', () => {
    expect(dsin(NaN)).toBeNaN();
    expect(dcos(Infinity)).toBeNaN();
    expect(dtan(-Infinity)).toBeNaN();
  });
});

describe('dmath atan2 / asin / acos', () => {
  it('datan2 |error| < 1e-6 rad (actually < 1e-15) in all quadrants and radii', () => {
    let maxErr = 0;
    const N = 100000;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * TWO_PI - PI + 1e-7;
      for (const r of [1e-8, 1e-3, 0.7, 1, 52.5, 1e6]) {
        const x = r * Math.cos(ang), y = r * Math.sin(ang);
        maxErr = Math.max(maxErr, Math.abs(datan2(y, x) - Math.atan2(y, x)));
      }
    }
    const rnd = lcg(4);
    for (let i = 0; i < 100000; i++) {
      const x = (rnd() * 2 - 1) * 120, y = (rnd() * 2 - 1) * 80;
      maxErr = Math.max(maxErr, Math.abs(datan2(y, x) - Math.atan2(y, x)));
    }
    expect(maxErr).toBeLessThan(1e-15);
  });

  it('datan2 axes, origin and the (-PI, PI] range', () => {
    expect(datan2(0, 0)).toBe(0);
    expect(datan2(-0, 0)).toBe(0);
    expect(datan2(0, -0)).toBe(0);
    expect(datan2(0, 5)).toBe(0);
    expect(datan2(0, -5)).toBe(PI);
    expect(datan2(-0, -5)).toBe(PI); // never -PI
    expect(datan2(3, 0)).toBe(HALF_PI);
    expect(datan2(-3, 0)).toBe(-HALF_PI);
    expect(datan2(1, 1)).toBe(Math.atan2(1, 1));
    expect(datan2(-1, -1)).toBe(Math.atan2(-1, -1));
    expect(datan2(1e-300, -1)).toBeLessThanOrEqual(PI);
    expect(datan2(-1e-300, -1)).toBeGreaterThan(-PI);
    expect(datan2(NaN, 1)).toBeNaN();
    expect(datan2(1, NaN)).toBeNaN();
    expect(datan2(1, Infinity)).toBe(0);
    expect(datan2(Infinity, 1)).toBe(HALF_PI);
    const rnd = lcg(5);
    for (let i = 0; i < 10000; i++) {
      const y = rnd() * 2 - 1, x = rnd() * 2 - 1;
      const a = datan2(y, x);
      expect(a > -PI && a <= PI).toBe(true);
      expect(datan2(-y, x)).toBe(-a);
    }
  });

  it('datan matches Math.atan', () => {
    let maxErr = 0;
    for (let i = -100000; i <= 100000; i++) {
      const x = i * 1e-3 * (1 + (i % 3)) ;
      maxErr = Math.max(maxErr, Math.abs(datan(x) - Math.atan(x)));
    }
    expect(maxErr).toBeLessThan(1e-15);
    expect(datan(1e300)).toBe(HALF_PI);
    expect(datan(-Infinity)).toBe(-HALF_PI);
  });

  it('dasin / dacos match Math over [-1, 1] and clamp outside', () => {
    let maxS = 0, maxC = 0;
    const N = 200000;
    for (let i = 0; i <= N; i++) {
      const x = -1 + (2 * i) / N;
      maxS = Math.max(maxS, Math.abs(dasin(x) - Math.asin(x)));
      maxC = Math.max(maxC, Math.abs(dacos(x) - Math.acos(x)));
    }
    for (const x of [1 - 1e-16, 1 - 1e-12, -1 + 1e-12, 0.5, -0.5, 1e-10]) {
      maxS = Math.max(maxS, Math.abs(dasin(x) - Math.asin(x)));
      maxC = Math.max(maxC, Math.abs(dacos(x) - Math.acos(x)));
    }
    expect(maxS).toBeLessThan(1e-14);
    expect(maxC).toBeLessThan(1e-14);
    expect(dasin(1.0000001)).toBe(HALF_PI);
    expect(dasin(-2)).toBe(-HALF_PI);
    expect(dacos(1.5)).toBe(0);
    expect(dacos(-1)).toBe(PI);
    expect(dacos(0)).toBe(HALF_PI);
  });
});

describe('dmath exp / log / pow', () => {
  it('dexp relative error < 1e-9 (actually < 1e-15) on [-700, 700]', () => {
    let maxRel = 0;
    const N = 400000;
    for (let i = 0; i <= N; i++) {
      const x = -700 + (1400 * i) / N + (i % 7) * 1e-6;
      maxRel = Math.max(maxRel, Math.abs(dexp(x) / Math.exp(x) - 1));
    }
    for (let i = -20000; i <= 20000; i++) {
      const x = i * 1e-3;
      maxRel = Math.max(maxRel, Math.abs(dexp(x) / Math.exp(x) - 1));
    }
    expect(maxRel).toBeLessThan(1e-15);
  });

  it('dexp edge cases', () => {
    expect(dexp(0)).toBe(1);
    expect(dexp(-0)).toBe(1);
    expect(dexp(1)).toBe(Math.E);
    expect(dexp(1e-20)).toBe(1);
    expect(dexp(710)).toBe(Infinity);
    expect(dexp(-746)).toBe(0);
    expect(dexp(NaN)).toBeNaN();
    expect(dexp(-Infinity)).toBe(0);
    // Subnormal range still close.
    expect(Math.abs(dexp(-740) / Math.exp(-740) - 1)).toBeLessThan(1e-3);
    expect(Math.abs(dexp(709.7) / Math.exp(709.7) - 1)).toBeLessThan(1e-15);
  });

  it('dlog relative error < 1e-9 (actually < 1e-15) for x > 0', () => {
    let maxRel = 0;
    const N = 400000;
    for (let i = 0; i <= N; i++) {
      const x = Math.exp(-700 + (1400 * i) / N + 0.123);
      const l = Math.log(x);
      maxRel = Math.max(maxRel, Math.abs(dlog(x) - l) / Math.max(Math.abs(l), 1e-300));
    }
    for (let i = -50000; i <= 50000; i++) {
      if (i === 0) continue;
      const x = 1 + i * 1e-7;
      const l = Math.log(x);
      maxRel = Math.max(maxRel, Math.abs(dlog(x) - l) / Math.abs(l));
    }
    for (let i = 1; i <= 100000; i++) {
      const x = i * 0.01;
      if (x === 1) continue;
      const l = Math.log(x);
      maxRel = Math.max(maxRel, Math.abs(dlog(x) - l) / Math.abs(l));
    }
    expect(maxRel).toBeLessThan(1e-15);
  });

  it('dlog edge cases', () => {
    expect(dlog(1)).toBe(0);
    expect(dlog(Math.E)).toBe(1);
    expect(dlog(2)).toBe(Math.LN2);
    expect(dlog(0)).toBe(-Infinity);
    expect(dlog(-1)).toBeNaN();
    expect(dlog(NaN)).toBeNaN();
    expect(dlog(Infinity)).toBe(Infinity);
    expect(Math.abs(dlog(5e-324) / Math.log(5e-324) - 1)).toBeLessThan(1e-15);
    expect(Math.abs(dlog(1e-310) / Math.log(1e-310) - 1)).toBeLessThan(1e-15);
    expect(Math.abs(dlog(1.7976931348623157e308) / Math.log(1.7976931348623157e308) - 1)).toBeLessThan(1e-15);
  });

  it('dexp(dlog(x)) ~ x and dlog(dexp(x)) ~ x', () => {
    const rnd = lcg(6);
    for (let i = 0; i < 20000; i++) {
      const x = rnd() * 100 + 1e-6;
      expect(Math.abs(dexp(dlog(x)) / x - 1)).toBeLessThan(1e-13);
      const y = (rnd() * 2 - 1) * 50;
      expect(Math.abs(dlog(dexp(y)) - y)).toBeLessThan(1e-13);
    }
  });

  it('dpow: exact integer powers, consistent with Math.pow elsewhere', () => {
    expect(dpow(2, 10)).toBe(1024);
    expect(dpow(2, -2)).toBe(0.25);
    expect(dpow(-2, 3)).toBe(-8);
    expect(dpow(-2, 4)).toBe(16);
    expect(dpow(3, 0)).toBe(1);
    expect(dpow(NaN, 0)).toBe(1);
    expect(dpow(0, 3)).toBe(0);
    expect(dpow(0, -1)).toBe(Infinity);
    expect(dpow(0, 0.5)).toBe(0);
    expect(dpow(0, -0.5)).toBe(Infinity);
    expect(dpow(-8, 1 / 3)).toBeNaN();
    // Large integer exponents (beyond repeated squaring) of a negative base: sign from parity.
    expect(Math.abs(dpow(-1.0001, 2000) / Math.pow(1.0001, 2000) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(dpow(-1.0001, 2001) / -Math.pow(1.0001, 2001) - 1)).toBeLessThan(1e-12);
    expect(dpow(1.1, 2)).toBe(1.1 * 1.1);
    let maxRel = 0;
    const rnd = lcg(7);
    for (let i = 0; i < 100000; i++) {
      const x = rnd() * 50 + 1e-3;
      const y = (rnd() * 2 - 1) * 8;
      maxRel = Math.max(maxRel, Math.abs(dpow(x, y) / Math.pow(x, y) - 1));
      const n = Math.floor((rnd() * 2 - 1) * 30);
      const xi = (rnd() * 2 - 1) * 3;
      if (xi !== 0) maxRel = Math.max(maxRel, Math.abs(dpow(xi, n) / Math.pow(xi, n) - 1));
    }
    expect(maxRel).toBeLessThan(1e-13);
    expect(Math.abs(dpow(9, 0.5) - 3)).toBeLessThan(1e-15);
  });
});

describe('dmath angles', () => {
  it('wrapAngle maps into (-PI, PI] and preserves the angle', () => {
    expect(wrapAngle(PI)).toBe(PI);
    expect(wrapAngle(-PI)).toBe(PI);
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(TWO_PI)).toBe(0);
    expect(wrapAngle(1)).toBe(1);
    const rnd = lcg(8);
    for (let i = 0; i < 100000; i++) {
      const a = (rnd() * 2 - 1) * (i % 2 === 0 ? 10 : 1e4);
      const w = wrapAngle(a);
      expect(w > -PI && w <= PI).toBe(true);
      expect(Math.abs(Math.sin(w) - Math.sin(a))).toBeLessThan(1e-11);
      expect(Math.abs(Math.cos(w) - Math.cos(a))).toBeLessThan(1e-11);
    }
    for (let k = -50; k <= 50; k++) {
      const w = wrapAngle(PI + k * TWO_PI);
      expect(w > -PI && w <= PI).toBe(true);
      expect(Math.abs(Math.abs(w) - PI)).toBeLessThan(1e-12);
    }
    expect(wrapAngle(NaN)).toBeNaN();
  });

  it('angleOf / angleDiff', () => {
    expect(angleOf(1, 0)).toBe(0);
    expect(angleOf(0, 1)).toBe(HALF_PI);
    expect(angleOf(-1, 0)).toBe(PI);
    expect(angleDiff(PI - 0.1, -PI + 0.1)).toBeCloseTo(0.2, 12);
    expect(angleDiff(-PI + 0.1, PI - 0.1)).toBeCloseTo(-0.2, 12);
  });
});

describe('dmath exact repeatability', () => {
  /** Golden hash of a fixed sweep: any change of the bits produced by dmath (refactor, engine) fails here. */
  it('pins the bit pattern of a mixed sweep', () => {
    const vals: number[] = [];
    for (let i = 0; i < 4096; i++) {
      const a = -1e4 + i * 4.8828125 + 0.123;
      vals.push(dsin(a), dcos(a), dtan(a * 1e-3), datan2(dsin(a), dcos(a * 1.1)), dexp((i - 2048) / 10), dlog(1 + i * 0.37),
        dpow(1 + i * 0.01, 1.37), dasin((i - 2048) / 2048), dacos((i - 2048) / 2048), wrapAngle(a));
    }
    expect(hashHex(hashValue(vals))).toBe('f1b685d4');
  });

  it('repeated calls give identical bits (no hidden state)', () => {
    const rnd = lcg(9);
    for (let i = 0; i < 2000; i++) {
      const a = (rnd() * 2 - 1) * 1e3;
      const s1 = dsin(a);
      dcos(a * 3); dtan(a); dlog(Math.abs(a) + 1); dexp(a / 100); datan2(a, 1);
      expect(dsin(a)).toBe(s1);
    }
  });
});
