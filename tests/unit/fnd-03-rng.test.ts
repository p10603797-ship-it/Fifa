/** FND-03: sfc32 RNG determinism and distribution sanity. */
import { describe, expect, it } from 'vitest';
import type { RngState } from '../../src/contracts/state';
import { rngChance, rngFloat, rngGauss, rngInt, rngNext, rngRange, rngSeed } from '../../src/sim/core/rng';

function seeded(seed: number): RngState {
  const r: RngState = { a: 0, b: 0, c: 0, d: 0 };
  rngSeed(r, seed);
  return r;
}

/** Independent BigInt reference implementation of sfc32 (PractRand definition). */
function refSfc32(seed: number, n: number): number[] {
  const M = 0xffffffffn;
  let a = 0x9e3779b9n, b = BigInt(seed >>> 0), c = 0x85ebca6bn, d = 1n;
  const next = (): bigint => {
    const t = (a + b + d) & M;
    d = (d + 1n) & M;
    a = b ^ (b >> 9n);
    b = (c + (c << 3n)) & M;
    c = ((((c << 21n) | (c >> 11n)) & M) + t) & M;
    return t;
  };
  for (let i = 0; i < 12; i++) next();
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Number(next()));
  return out;
}

describe('rng (sfc32)', () => {
  it('matches an independent BigInt reference for several seeds', () => {
    for (const seed of [0, 1, 2, 42, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff]) {
      const r = seeded(seed);
      const got: number[] = [];
      for (let i = 0; i < 2000; i++) got.push(rngNext(r));
      expect(got).toEqual(refSfc32(seed, 2000));
    }
  });

  it('pins the stream for seed 1 (replay compatibility)', () => {
    const r = seeded(1);
    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push(rngNext(r));
    expect(out).toEqual([862758134, 2876208834, 678522992, 3193800590, 3658378294, 1034694577]);
    expect(r).toEqual({ a: 1223439108, b: 2439702253, c: 1448431917, d: 19 });
  });

  it('same seed => same stream; different seeds => different streams', () => {
    const a = seeded(1234), b = seeded(1234), c = seeded(1235);
    let same = 0;
    for (let i = 0; i < 1000; i++) {
      const x = rngNext(a);
      expect(rngNext(b)).toBe(x);
      if (rngNext(c) === x) same++;
    }
    expect(same).toBeLessThan(3);
  });

  it('keeps every state word a uint32 and returns uint32 values', () => {
    const r = seeded(0xffffffff);
    for (let i = 0; i < 10000; i++) {
      const v = rngNext(r);
      expect(Number.isInteger(v) && v >= 0 && v < 2 ** 32).toBe(true);
    }
    for (const w of [r.a, r.b, r.c, r.d]) expect(Number.isInteger(w) && w >= 0 && w < 2 ** 32).toBe(true);
  });

  it('truncates seeds to uint32 (negative / fractional seeds are deterministic)', () => {
    const a = seeded(-1), b = seeded(0xffffffff);
    expect(rngNext(a)).toBe(rngNext(b));
    const c = seeded(7.9), d = seeded(7);
    expect(rngNext(c)).toBe(rngNext(d));
  });

  it('rngFloat is uniform in [0,1)', () => {
    const r = seeded(99);
    const N = 200000;
    const buckets = new Array<number>(20).fill(0);
    let sum = 0, sum2 = 0;
    for (let i = 0; i < N; i++) {
      const f = rngFloat(r);
      expect(f >= 0 && f < 1).toBe(true);
      sum += f; sum2 += f * f;
      buckets[Math.floor(f * 20)]!++;
    }
    const mean = sum / N;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.005);
    expect(Math.abs(sum2 / N - mean * mean - 1 / 12)).toBeLessThan(0.002);
    // Chi-square with 19 dof: 99.9th percentile ~ 43.8.
    const exp = N / 20;
    let chi = 0;
    for (const b of buckets) chi += ((b - exp) * (b - exp)) / exp;
    expect(chi).toBeLessThan(43.8);
  });

  it('rngFloat equals rngNext / 2^32', () => {
    const a = seeded(5), b = seeded(5);
    for (let i = 0; i < 100; i++) expect(rngFloat(a)).toBe(rngNext(b) / 4294967296);
  });

  it('rngRange and rngInt stay in range and cover it', () => {
    const r = seeded(3);
    const seen = new Array<number>(7).fill(0);
    for (let i = 0; i < 20000; i++) {
      const v = rngRange(r, -2, 5);
      expect(v >= -2 && v < 5).toBe(true);
      const k = rngInt(r, 7);
      expect(Number.isInteger(k) && k >= 0 && k < 7).toBe(true);
      seen[k]!++;
    }
    for (const n of seen) expect(n).toBeGreaterThan(20000 / 7 * 0.9);
    expect(rngInt(r, 1)).toBe(0);
    expect(rngInt(r, 0)).toBe(0);
    expect(rngInt(r, -5)).toBe(0);
  });

  it('every helper consumes a fixed number of draws regardless of arguments', () => {
    const a = seeded(11), b = seeded(11);
    rngInt(a, 0); rngInt(a, 1000); rngChance(a, 0); rngChance(a, 1); rngRange(a, 3, 3); rngFloat(a);
    for (let i = 0; i < 6; i++) rngNext(b);
    expect(a).toEqual(b);
    rngGauss(a);
    for (let i = 0; i < 4; i++) rngNext(b);
    expect(a).toEqual(b);
  });

  it('rngGauss is approximately standard normal and bounded', () => {
    const r = seeded(2024);
    const N = 200000;
    let sum = 0, sum2 = 0, within1 = 0;
    const bound = 2 * Math.sqrt(3);
    for (let i = 0; i < N; i++) {
      const g = rngGauss(r);
      expect(Math.abs(g)).toBeLessThanOrEqual(bound + 1e-12);
      sum += g; sum2 += g * g;
      if (Math.abs(g) < 1) within1++;
    }
    const mean = sum / N;
    const sd = Math.sqrt(sum2 / N - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.abs(sd - 1)).toBeLessThan(0.01);
    // Irwin-Hall(4) rescaled: P(|g| < 1) ~ 0.6748 (normal 0.6827).
    expect(Math.abs(within1 / N - 0.675)).toBeLessThan(0.01);
  });

  it('rngChance has the requested frequency', () => {
    const r = seeded(77);
    let n = 0;
    for (let i = 0; i < 100000; i++) if (rngChance(r, 0.3)) n++;
    expect(Math.abs(n / 100000 - 0.3)).toBeLessThan(0.01);
    for (let i = 0; i < 1000; i++) {
      expect(rngChance(r, 0)).toBe(false);
      expect(rngChance(r, 1)).toBe(true);
    }
  });
});
