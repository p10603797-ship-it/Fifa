/**
 * FND-03 hardening (fixes for the independent review): hostile snapshots, undefined round trips, frame codec
 * offsets, large-argument trig reduction, wrapAngle / datan2 / dpow edge cases and rngRange's open bound.
 * Math.* is allowed here (tests are outside src/sim).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NUM_SLOTS, SIM_VERSION } from '../../src/contracts/constants';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type RngState, type SimState } from '../../src/contracts/state';
import { cloneState, copyState, diffState } from '../../src/sim/core/clone';
import { HALF_PI, PI, datan2, dcos, dpow, dsin, dtan, wrapAngle } from '../../src/sim/core/dmath';
import { hashState, hashValue } from '../../src/sim/core/hash';
import { rngFloat, rngRange } from '../../src/sim/core/rng';
import { deserializeState, PACKED_FRAME_INTS, packFrames, serializeState, unpackFrames } from '../../src/sim/core/serialize';
import { initMatch } from '../../src/sim/init';

type Rec = Record<string, unknown>;
const fresh = (): SimState => initMatch(createMatchConfig());

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

afterEach(() => {
  delete (Object.prototype as Rec).polluted;
});

describe('deserializeState: hostile and malformed snapshots', () => {
  it('rejects "__proto__" at the top level, nested, and inside arrays with a SyntaxError', () => {
    const json = serializeState(fresh());
    const variants = [
      json.replace(/^\{/, '{"__proto__":{"polluted":1},'),
      json.replace('"ball":{', '"ball":{"__proto__":{"polluted":1},'),
      json.replace('"players":[{', '"players":[{"__proto__":{"polluted":1},'),
      json.replace('"config":{', '"config":{"__proto__":{"polluted":1},'),
    ];
    for (const v of variants) {
      expect(v).not.toBe(json);
      expect(() => deserializeState(v)).toThrow(SyntaxError);
    }
    expect((({}) as Rec).polluted).toBeUndefined();
  });

  it('rejects null / missing / mistyped top-level members, wrong lengths and a wrong version', () => {
    const base = JSON.parse(serializeState(fresh())) as Rec;
    const drop = (k: string): Rec => { const v = { ...base }; delete v[k]; return v; };
    const variants: Rec[] = [
      { ...base, version: SIM_VERSION + 1 }, drop('version'), { ...base, tick: '1' }, drop('tick'),
      { ...base, rng: null }, { ...base, rng: { a: 1, b: 2, c: 3 } }, drop('match'), { ...base, match: [] },
      { ...base, ball: null }, { ...base, players: (base.players as unknown[]).slice(1) },
      { ...base, players: [...(base.players as unknown[]).slice(1), null] }, drop('attrs'), { ...base, teams: 'x' },
      { ...base, ctrl: [] }, { ...base, config: null }, { ...base, squads: [[], 3] }, drop('squads'),
    ];
    variants.forEach((v, i) => {
      expect(() => deserializeState(JSON.stringify(v)), `variant ${i}`).toThrow(SyntaxError);
    });
    expect(() => deserializeState('null')).toThrow(SyntaxError);
    expect(() => deserializeState('[]')).toThrow(SyntaxError);
    expect(() => deserializeState('{"$undef":1}')).toThrow(SyntaxError);
  });

  it('still accepts a valid snapshot with extra keys and any numeric values', () => {
    const s = fresh();
    (s as unknown as Rec).extra = { note: 'x', n: -0 };
    s.rng.a = 1.5; // not a uint32: rng tolerates it (>>> 0), and the snapshot must reproduce it exactly
    s.tick = 77;
    const r = deserializeState(serializeState(s));
    expect(hashState(r)).toBe(hashState(s));
    expect(r.players.length).toBe(NUM_SLOTS);
    expect(r.rng.a).toBe(1.5);
  });
});

describe('clone / hash walkers ignore own "__proto__" keys (objects built by JSON.parse elsewhere)', () => {
  /** A state with an own "__proto__" key on ball, bypassing deserializeState's check. */
  function hostile(): SimState {
    const json = serializeState(fresh()).replace('"ball":{', '"ball":{"__proto__":{"polluted":1,"x":5},');
    const raw = JSON.parse(json) as Rec;
    const real = deserializeState(serializeState(fresh())) as unknown as Rec;
    real.ball = raw.ball; // only plain numbers in ball, so no tags to revive
    expect(Object.prototype.hasOwnProperty.call(real.ball, '__proto__')).toBe(true);
    return real as unknown as SimState;
  }

  it('copyState never assigns through __proto__ (no pollution) and ends equal', () => {
    const src = hostile();
    const dst = cloneState(fresh());
    copyState(dst, src);
    expect((({}) as Rec).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(dst.ball)).toBe(Object.prototype);
    expect(hashState(dst)).toBe(hashState(src));
    expect(diffState(dst, src)).toBeNull();
  });

  it('cloneState keeps Object.prototype and the hash; hashValue ignores the key too', () => {
    const src = hostile();
    const c = cloneState(src);
    expect(Object.getPrototypeOf(c.ball)).toBe(Object.prototype);
    expect(hashState(c)).toBe(hashState(src));
    expect(hashValue(c.ball)).toBe(hashValue(src.ball));
    expect(diffState(src, c)).toBeNull();
    expect((({}) as Rec).polluted).toBeUndefined();
  });
});

describe('serializeState: undefined and non-data values', () => {
  it('undefined object values and array elements (incl. holes) round-trip with the same hash', () => {
    const s = fresh();
    (s.ball as unknown as Rec).owner = undefined;
    (s.teams[0]!.roster as unknown[])[3] = undefined;
    const r = deserializeState(serializeState(s));
    expect('owner' in r.ball).toBe(true);
    expect((r.ball as unknown as Rec).owner).toBeUndefined();
    expect(Object.keys(r.ball)).toEqual(Object.keys(s.ball));
    expect(r.teams[0]!.roster.length).toBe(s.teams[0]!.roster.length);
    expect((r.teams[0]!.roster as unknown[])[3]).toBeUndefined();
    expect(hashState(r)).toBe(hashState(s));
    expect(diffState(s, r)).toBeNull();
    expect(serializeState(r)).toBe(serializeState(s));

    const h = fresh();
    const roster = h.teams[1]!.roster as unknown[];
    delete roster[2]; // hole
    const rh = deserializeState(serializeState(h));
    expect(hashState(rh)).toBe(hashState(h));
  });

  it('functions and symbols make serializeState throw a TypeError instead of silently vanishing', () => {
    const a = fresh();
    (a.ball as unknown as Rec).fn = (): number => 1;
    expect(() => serializeState(a)).toThrow(TypeError);
    const b = fresh();
    (b.match as unknown as Rec).sym = Symbol('x');
    expect(() => serializeState(b)).toThrow(TypeError);
  });
});

describe('packFrames / unpackFrames offsets', () => {
  it('reject any offset that is not a non-negative integer, accept integer offsets', () => {
    const f = createInputFrame();
    f.mx = 100;
    const buf = new Int16Array(PACKED_FRAME_INTS * 2);
    for (const off of [0.5, NaN, -1, Infinity, -Infinity, PACKED_FRAME_INTS + 1]) {
      expect(() => packFrames([f, f], buf, off), `pack ${off}`).toThrow(RangeError);
      expect(() => unpackFrames(buf, off, []), `unpack ${off}`).toThrow(RangeError);
    }
    expect(packFrames([f, f], buf, PACKED_FRAME_INTS)).toBe(PACKED_FRAME_INTS);
    const out = [createInputFrame(), createInputFrame()];
    expect(unpackFrames(buf, PACKED_FRAME_INTS, out)).toBe(PACKED_FRAME_INTS);
    expect(out[1]!.mx).toBe(100);
  });
});

describe('dmath: large arguments and IEEE edge cases', () => {
  it('dsin/dcos/dtan match Math.* for random inputs across every binary exponent (Payne-Hanek path)', () => {
    const r = lcg(97);
    let worst = 0;
    let worstTan = 0;
    for (let i = 0; i < 100_000; i++) {
      const a = (r() + 0.5) * 2 ** (Math.floor(r() * 1030) - 3) * (r() < 0.5 ? -1 : 1);
      const e = Math.max(Math.abs(dsin(a) - Math.sin(a)), Math.abs(dcos(a) - Math.cos(a)));
      if (e > worst) worst = e;
      const t = Math.tan(a);
      const et = Math.abs(dtan(a) - t) / Math.max(1, Math.abs(t));
      if (et > worstTan) worstTan = et;
    }
    expect(worst).toBeLessThan(1e-15);
    expect(worstTan).toBeLessThan(1e-14);
  });

  it('is accurate next to multiples of PI/2 at huge magnitudes and at the reduction switch-over', () => {
    // 6381956970095103 * 2^797 is the double closest to a multiple of PI/2 (cos ~ -4.69e-19).
    const hard = 6381956970095103 * 2 ** 797;
    expect(Math.abs(dcos(hard) / Math.cos(hard) - 1)).toBeLessThan(1e-12);
    expect(dsin(hard)).toBe(1);
    for (const a of [1647099.3291652855, 1647099.329165286, 1647100, 2 ** 21, 2 ** 30, 1e9, 1e12]) {
      expect(Math.abs(dsin(a) - Math.sin(a)), `sin ${a}`).toBeLessThan(1e-15);
      expect(Math.abs(dcos(a) - Math.cos(a)), `cos ${a}`).toBeLessThan(1e-15);
    }
    const M = 1.7976931348623157e308;
    expect(Math.abs(dsin(M) - Math.sin(M))).toBeLessThan(1e-15);
    expect(Math.abs(dcos(-M) - Math.cos(-M))).toBeLessThan(1e-15);
    expect(dsin(-1e300)).toBe(-dsin(1e300));
    expect(dcos(-1e300)).toBe(dcos(1e300));
  });

  it('non-finite trig inputs give NaN', () => {
    for (const a of [Infinity, -Infinity, NaN]) {
      expect(dsin(a)).toBeNaN();
      expect(dcos(a)).toBeNaN();
      expect(dtan(a)).toBeNaN();
      expect(wrapAngle(a)).toBeNaN();
    }
  });

  it('wrapAngle lands in (-PI, PI] for huge inputs incl. +-MAX and stays consistent with dsin', () => {
    const M = 1.7976931348623157e308;
    const r = lcg(5);
    const pts = [M, -M, 1e308, -1e308, 2 ** 1023, 1e18, -1e18, 1e31];
    for (let i = 0; i < 50_000; i++) pts.push((r() - 0.5) * 10 ** Math.floor(r() * 309));
    for (const a of pts) {
      const w = wrapAngle(a);
      expect(w > -PI && w <= PI, `${a} -> ${w}`).toBe(true);
      expect(wrapAngle(w)).toBe(w);
    }
    // Ordinary inputs keep their exact single-subtraction results.
    expect(wrapAngle(7)).toBe(7 - 6.283185307179586);
    expect(wrapAngle(-7)).toBe(-7 + 6.283185307179586);
    for (const a of [3 * PI, -3 * PI, 5 * PI, -5 * PI]) {
      const w = wrapAngle(a);
      expect(w > -PI && w <= PI && Math.abs(Math.abs(w) - PI) < 1e-14, `${a} -> ${w}`).toBe(true);
    }
  });

  it('datan2 of infinities equals Math.atan2 exactly in every combination', () => {
    const vals = [Infinity, -Infinity, 1, -1, 0];
    for (const y of vals) {
      for (const x of vals) {
        const want = Math.atan2(y, x);
        // y = +-0 is documented as +0, and -PI is returned as -PI + 1 ulp (contract (-PI, PI]).
        if (y === 0 || want === -PI) continue;
        expect(datan2(y, x), `datan2(${y}, ${x})`).toBe(want);
      }
    }
    expect(datan2(Infinity, Infinity)).toBe(PI / 4);
    expect(datan2(-Infinity, -Infinity)).toBe(-3 * PI / 4);
    expect(datan2(Infinity, 0)).toBe(HALF_PI);
  });

  it('dpow with negative integer exponents: subnormal results survive overflow of x^|y|, IEEE cases unchanged', () => {
    const cases: [number, number][] = [[10, -310], [1e5, -62], [-10, -309], [-10, -310], [2, -1024], [-2, -1023], [3, -650]];
    for (const [x, y] of cases) {
      const want = Math.pow(x, y);
      expect(want).not.toBe(0);
      expect(Math.abs(dpow(x, y) / want - 1), `dpow(${x}, ${y})`).toBeLessThan(1e-6);
      expect(Math.sign(dpow(x, y))).toBe(Math.sign(want));
    }
    expect(dpow(2, -1075)).toBe(0); // true result rounds to 0
    expect(dpow(10, -400)).toBe(0);
    expect(dpow(0, -3)).toBe(Infinity);
    expect(dpow(-0, -3)).toBe(-Infinity);
    expect(Object.is(dpow(-Infinity, -3), -0)).toBe(true);
    expect(Object.is(dpow(Infinity, -2), 0)).toBe(true);
    // The exact reciprocal path is kept whenever x^|y| is finite.
    expect(dpow(10, -2)).toBe(0.01);
    expect(dpow(2, -10)).toBe(1 / 1024);
    expect(dpow(-2, -3)).toBe(-0.125);
  });
});

describe('rngRange open upper bound', () => {
  const st = (a = 0, b = 0, c = 0, d = 0): RngState => ({ a, b, c, d });

  it('a draw that rounds up to hi wraps to lo; reversed and equal bounds behave', () => {
    const lo = 2 ** 33;
    expect(rngRange(st(0xffffffff), lo, lo + 1)).toBe(lo);
    expect(rngRange(st(0xffffffff), 1e17, 1e17 + 16)).toBeLessThan(1e17 + 16);
    expect(rngRange(st(0xffffffff), 5, 5)).toBe(5);
    const rev = rngRange(st(0xffffffff), 1, -1);
    expect(rev).toBeGreaterThan(-1);
    expect(rev).toBeLessThanOrEqual(1);
  });

  it('ordinary ranges give exactly lo + (hi - lo) * f and consume one draw', () => {
    const a = st(1, 2, 3, 4);
    const b = st(1, 2, 3, 4);
    for (let i = 0; i < 10_000; i++) {
      const v = rngRange(a, -52.5, 52.5);
      expect(v).toBe(-52.5 + 105 * rngFloat(b));
    }
    expect(a).toEqual(b);
  });
});
