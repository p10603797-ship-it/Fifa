/**
 * REVIEW of FND-03 (independent reviewer): adversarial tests for src/sim/core/rng.ts and src/sim/core/vec.ts.
 * Failing tests in this file are confirmed defects and stay in place as regression tests.
 */
import { describe, expect, it } from 'vitest';
import type { RngState } from '../../src/contracts/state';
import { rngChance, rngFloat, rngGauss, rngInt, rngNext, rngRange, rngSeed } from '../../src/sim/core/rng';
import { closestOnSegment2, createV2, normalize2, rotate2, rotateToward2 } from '../../src/sim/core/vec';

const st = (a = 0, b = 0, c = 0, d = 0): RngState => ({ a, b, c, d });

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function popcount(v: number): number {
  let n = 0;
  for (let x = v >>> 0; x !== 0; x >>>= 1) n += x & 1;
  return n;
}

describe('review FND-03 rng', () => {
  it('rngSeed fully resets whatever the previous (even corrupt, non-uint32) state was', () => {
    const ref = st();
    rngSeed(ref, 42);
    const want: number[] = [];
    for (let i = 0; i < 50; i++) want.push(rngNext(ref));
    for (const junk of [st(-1, 2 ** 40, 0.5, NaN), st(1, 2, 3, 4), st(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff)]) {
      rngSeed(junk, 42);
      const got: number[] = [];
      for (let i = 0; i < 50; i++) got.push(rngNext(junk));
      expect(got).toEqual(want);
    }
  });

  it('corrupt non-uint32 words (e.g. from a bad snapshot) still yield uint32 outputs and uint32 words', () => {
    const r = st(-5, 1.5, 2 ** 33 + 7, -0);
    for (let i = 0; i < 1000; i++) {
      const v = rngNext(r);
      expect(Number.isInteger(v) && v >= 0 && v <= 0xffffffff).toBe(true);
      for (const w of [r.a, r.b, r.c, r.d]) expect(Number.isInteger(w) && w >= 0 && w <= 0xffffffff).toBe(true);
    }
  });

  it('seeding avalanche: flipping one seed bit flips ~16 of the first output bits (no correlated streams)', () => {
    let tot = 0;
    let n = 0;
    let min = 32;
    for (let seed = 0; seed < 1000; seed++) {
      const r = st();
      rngSeed(r, seed);
      const x = rngNext(r);
      for (let j = 0; j < 32; j++) {
        const r2 = st();
        rngSeed(r2, (seed ^ (1 << j)) >>> 0);
        const hd = popcount((x ^ rngNext(r2)) >>> 0);
        tot += hd;
        n++;
        min = Math.min(min, hd);
      }
    }
    expect(tot / n).toBeGreaterThan(15.5);
    expect(tot / n).toBeLessThan(16.5);
    expect(min).toBeGreaterThan(0);
  });

  it('sequential seeds 0..9999: first rngFloat is uniform (chi-square, 20 bins)', () => {
    const bins = new Array<number>(20).fill(0);
    for (let seed = 0; seed < 10_000; seed++) {
      const r = st();
      rngSeed(r, seed);
      bins[Math.floor(rngFloat(r) * 20)]!++;
    }
    let chi = 0;
    for (const b of bins) chi += (b - 500) ** 2 / 500;
    expect(chi).toBeLessThan(43.8); // p = 0.001 for 19 dof
  });

  it('rngFloat extreme draw is < 1; rngInt never reaches n even for n up to 2^53', () => {
    // Force the maximal uint32 output: t = a + b + d = 0xffffffff.
    expect(rngFloat(st(0xffffffff, 0, 0, 0))).toBeLessThan(1);
    for (const n of [2, 3, 1000, 2 ** 31, 2 ** 32, 2 ** 40, 2 ** 53]) {
      expect(rngInt(st(0xffffffff, 0, 0, 0), n)).toBeLessThan(n);
      expect(rngInt(st(0, 0, 0, 0), n)).toBe(0);
    }
  });

  it('rngRange with ordinary gameplay bounds never returns hi even for the maximal draw', () => {
    for (const [lo, hi] of [[0, 1], [-1, 1], [-0.1, 0.1], [0.9, 1.1], [-52.5, 52.5], [0, 105], [1000, 1001]] as const) {
      const v = rngRange(st(0xffffffff, 0, 0, 0), lo, hi);
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThan(hi);
    }
  });

  // DEFECT (minor): rngRange is documented as [lo, hi) but lo + (hi - lo) * f rounds up to hi when |lo| is large
  // relative to (hi - lo) (ulp(lo) > (hi - lo) * 2^-32). Here rngRange(2^33, 2^33 + 1) returns 2^33 + 1.
  // Expected: result < hi (e.g. clamp: `v < hi ? v : prevDouble(hi)`, or document the closed bound).
  it('rngRange respects the open upper bound for large-magnitude bounds', () => {
    const lo = 2 ** 33;
    const hi = lo + 1;
    expect(rngRange(st(0xffffffff, 0, 0, 0), lo, hi)).toBeLessThan(hi);
  });

  it('rngGauss: bounded, symmetric, and draw-count independent of values', () => {
    const r = st();
    rngSeed(r, 99);
    let s = 0;
    let s2 = 0;
    let s4 = 0;
    const N = 200_000;
    for (let i = 0; i < N; i++) {
      const g = rngGauss(r);
      expect(Math.abs(g)).toBeLessThanOrEqual(2 * Math.sqrt(3));
      s += g; s2 += g * g; s4 += g ** 4;
    }
    expect(Math.abs(s / N)).toBeLessThan(0.01);
    expect(Math.abs(s2 / N - 1)).toBeLessThan(0.01);
    // Irwin-Hall(4) kurtosis = 3 - 6/(5*4) = 2.7 (a true normal would be 3): documents the approximation.
    expect(Math.abs(s4 / N - 2.7)).toBeLessThan(0.05);
    const a = st(); rngSeed(a, 5);
    const b = st(); rngSeed(b, 5);
    rngGauss(a); rngChance(a, 2); rngInt(a, -3); rngRange(a, 5, 5);
    for (let i = 0; i < 7; i++) rngNext(b);
    expect(a).toEqual(b);
  });
});

describe('review FND-03 vec', () => {
  const o = createV2();

  it('rotateToward2: random sweep never turns more than maxAngle and never passes the target', () => {
    const r = lcg(31);
    for (let i = 0; i < 200_000; i++) {
      const fa = (r() - 0.5) * 2 * Math.PI;
      const ta = (r() - 0.5) * 2 * Math.PI;
      const fl = 0.01 + r() * 10;
      const tl = 0.01 + r() * 10;
      const max = r() < 0.1 ? r() * 4 : r() * 0.3;
      rotateToward2(o, Math.cos(fa) * fl, Math.sin(fa) * fl, Math.cos(ta) * tl, Math.sin(ta) * tl, max);
      expect(Math.abs(Math.hypot(o.x, o.z) - 1)).toBeLessThan(1e-12);
      const ra = Math.atan2(o.z, o.x);
      const turned = Math.abs(Math.atan2(Math.sin(ra - fa), Math.cos(ra - fa)));
      const before = Math.abs(Math.atan2(Math.sin(ta - fa), Math.cos(ta - fa)));
      const after = Math.abs(Math.atan2(Math.sin(ta - ra), Math.cos(ta - ra)));
      expect(turned).toBeLessThanOrEqual(Math.min(max, before) + 2e-8);
      expect(after).toBeLessThanOrEqual(before + 1e-9);
      // shortest direction: the turn and the gap have the same sign
      if (after > 1e-6 && before < Math.PI - 1e-6) {
        const sgnTurn = Math.sign(Math.atan2(Math.sin(ra - fa), Math.cos(ra - fa)));
        const sgnGap = Math.sign(Math.atan2(Math.sin(ta - fa), Math.cos(ta - fa)));
        expect(sgnTurn).toBe(sgnGap);
      }
    }
  });

  it('rotateToward2: nearly-opposite vectors pick the side the tiny cross product says, exactly opposite turns +', () => {
    rotateToward2(o, 1, 0, -1, 1e-12, 0.1);
    expect(o.z).toBeGreaterThan(0);
    rotateToward2(o, 1, 0, -1, -1e-12, 0.1);
    expect(o.z).toBeLessThan(0);
    rotateToward2(o, 0.6, 0.8, -0.6, -0.8, 0.1);
    const a = { x: o.x, z: o.z };
    rotateToward2(o, 0.6, 0.8, -0.6, -0.8, 0.1);
    expect(o).toEqual(a);
    expect(0.6 * a.z - 0.8 * a.x).toBeGreaterThan(0);
  });

  it('rotateToward2: repeated application converges from every start without oscillation', () => {
    const r = lcg(37);
    for (let i = 0; i < 2000; i++) {
      let fx = Math.cos(r() * 7);
      let fz = Math.sin(r() * 7);
      const tx = Math.cos(r() * 7) * 3;
      const tz = Math.sin(r() * 7) * 3;
      const max = 0.05 + r() * 0.2;
      const tl = Math.sqrt(tx * tx + tz * tz);
      const ux = tx / tl;
      const uz = tz / tl;
      let steps = 0;
      while (steps < 200) {
        rotateToward2(o, fx, fz, tx, tz, max);
        steps++;
        fx = o.x; fz = o.z;
        if (fx === ux && fz === uz) break; // snapped exactly onto the normalised target
      }
      expect(fx === ux && fz === uz).toBe(true);
      expect(steps).toBeLessThanOrEqual(Math.ceil(Math.PI / max) + 1);
    }
  });

  it('rotate2 composes: rotating by a then b equals rotating by a + b (within 1e-12)', () => {
    const r = lcg(41);
    for (let i = 0; i < 10_000; i++) {
      const a = (r() - 0.5) * 10;
      const b = (r() - 0.5) * 10;
      rotate2(o, 1, 0, a);
      rotate2(o, o.x, o.z, b);
      const x1 = o.x;
      const z1 = o.z;
      rotate2(o, 1, 0, a + b);
      expect(Math.abs(o.x - x1) + Math.abs(o.z - z1)).toBeLessThan(1e-12);
    }
  });

  it('normalize2 on ordinary pitch-scale vectors returns unit length and the true length', () => {
    const r = lcg(43);
    for (let i = 0; i < 10_000; i++) {
      const x = (r() - 0.5) * 200;
      const z = (r() - 0.5) * 200;
      const len = normalize2(o, x, z);
      expect(Math.abs(len - Math.hypot(x, z))).toBeLessThan(1e-12);
      expect(Math.abs(Math.hypot(o.x, o.z) - 1)).toBeLessThan(1e-15);
    }
  });

  it('closestOnSegment2 matches a brute-force minimum distance', () => {
    const r = lcg(47);
    for (let i = 0; i < 5000; i++) {
      const ax = (r() - 0.5) * 100, az = (r() - 0.5) * 70, bx = (r() - 0.5) * 100, bz = (r() - 0.5) * 70;
      const px = (r() - 0.5) * 120, pz = (r() - 0.5) * 90;
      const t = closestOnSegment2(o, ax, az, bx, bz, px, pz);
      expect(t >= 0 && t <= 1).toBe(true);
      const d = Math.hypot(o.x - px, o.z - pz);
      let best = Infinity;
      for (let k = 0; k <= 400; k++) {
        const u = k / 400;
        best = Math.min(best, Math.hypot(ax + (bx - ax) * u - px, az + (bz - az) * u - pz));
      }
      expect(d).toBeLessThanOrEqual(best + 1e-9);
    }
  });
});
