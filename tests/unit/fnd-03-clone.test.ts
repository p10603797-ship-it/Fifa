/** FND-03: cloneState / copyState / diffState. */
import { describe, expect, it } from 'vitest';
import { createMatchConfig, IMMUTABLE_STATE_KEYS, type SimState } from '../../src/contracts/state';
import { cloneState, copyState, diffState } from '../../src/sim/core/clone';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';

type Rec = Record<string, unknown>;

const fresh = (): SimState => initMatch(createMatchConfig());

/** Collect every object/array reference in the mutable part (identity checks for in-place copies). */
function references(s: SimState): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown): void => {
    if (typeof v !== 'object' || v === null) return;
    out.push(v);
    if (Array.isArray(v)) v.forEach(walk);
    else for (const k of Object.keys(v)) walk((v as Rec)[k]);
  };
  for (const k of Object.keys(s)) if (!(IMMUTABLE_STATE_KEYS as readonly string[]).includes(k)) walk((s as unknown as Rec)[k]);
  return out;
}

/** Deterministically scramble every numeric leaf of the mutable state. */
function scramble(s: SimState, salt: number): void {
  let n = salt;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (typeof v[i] === 'number') v[i] = (n = (n * 31 + 7) % 1000) / 10 - 50; else walk(v[i]);
    } else if (typeof v === 'object' && v !== null) {
      const o = v as Rec;
      for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = (n = (n * 31 + 7) % 1000) / 10 - 50; else walk(o[k]);
    }
  };
  for (const k of Object.keys(s)) if (!(IMMUTABLE_STATE_KEYS as readonly string[]).includes(k)) walk((s as unknown as Rec)[k]);
}

describe('cloneState', () => {
  it('returns an equal state with the same hash and key order', () => {
    const s = fresh();
    const c = cloneState(s);
    expect(c).not.toBe(s);
    expect(diffState(s, c)).toBeNull();
    expect(hashState(c)).toBe(hashState(s));
    expect(Object.keys(c)).toEqual(Object.keys(s));
    expect(Object.keys(c.players[5]!)).toEqual(Object.keys(s.players[5]!));
    expect(Object.keys(c.teams[1]!.cpu.out)).toEqual(Object.keys(s.teams[1]!.cpu.out));
  });

  it('is deep for the mutable part and shares config/squads by reference', () => {
    const s = fresh();
    const c = cloneState(s);
    expect(c.config).toBe(s.config);
    expect(c.squads).toBe(s.squads);
    const sRefs = references(s);
    const cRefs = new Set(references(c));
    for (const r of sRefs) expect(cRefs.has(r)).toBe(false);
    c.players[3]!.x = 42;
    c.teams[0]!.roster[2] = 3;
    c.match.restart.wall[1] = 9;
    c.teams[1]!.cpu.out.mx = 100;
    expect(s.players[3]!.x).not.toBe(42);
    expect(s.teams[0]!.roster[2]).not.toBe(3);
    expect(s.match.restart.wall[1]).toBe(-1);
    expect(s.teams[1]!.cpu.out.mx).toBe(0);
  });

  it('preserves -0 and typed arrays', () => {
    const s = fresh();
    s.players[1]!.fz = -0;
    (s as unknown as Rec).extra = new Float64Array([1, -0, 3]);
    const c = cloneState(s);
    expect(Object.is(c.players[1]!.fz, -0)).toBe(true);
    const e = (c as unknown as Rec).extra as Float64Array;
    expect(e).toBeInstanceOf(Float64Array);
    expect(e).not.toBe((s as unknown as Rec).extra);
    expect(Array.from(e)).toEqual([1, -0, 3]);
  });
});

describe('copyState', () => {
  it('copies every mutable field in place so diff is null and hashes match', () => {
    const src = fresh();
    const dst = fresh();
    scramble(src, 1);
    expect(diffState(dst, src)).not.toBeNull();
    copyState(dst, src);
    expect(diffState(dst, src)).toBeNull();
    expect(hashState(dst)).toBe(hashState(src));
  });

  it('does not allocate when shapes match (every nested object/array keeps its identity)', () => {
    const src = fresh();
    const dst = cloneState(src);
    const before = references(dst);
    scramble(src, 2);
    copyState(dst, src);
    const after = references(dst);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    // And dst never aliases src.
    const srcRefs = new Set(references(src));
    for (const r of after) expect(srcRefs.has(r)).toBe(false);
  });

  it('assigns the immutable keys by reference', () => {
    const src = fresh();
    const dst = fresh();
    src.config = { ...src.config, seed: 77 };
    copyState(dst, src);
    expect(dst.config).toBe(src.config);
    expect(dst.squads).toBe(src.squads);
  });

  it('later changes to src do not leak into dst', () => {
    const src = fresh();
    const dst = cloneState(src);
    copyState(dst, src);
    src.players[0]!.x = 12.5;
    src.teams[0]!.homeX[3] = 7;
    expect(dst.players[0]!.x).not.toBe(12.5);
    expect(dst.teams[0]!.homeX[3]).not.toBe(7);
  });

  it('repairs shape mismatches by allocating (array length, missing object, typed arrays)', () => {
    const src = fresh();
    const dst = cloneState(src);
    src.teams[0]!.roster.push(1, 2);
    (dst.match as unknown as Rec).restart = 5;
    (src as unknown as Rec).buf = new Int16Array([1, 2, 3]);
    (dst as unknown as Rec).buf = new Int16Array([0, 0, 0]);
    const keep = (dst as unknown as Rec).buf;
    copyState(dst, src);
    expect(diffState(dst, src)).toBeNull();
    expect(hashState(dst)).toBe(hashState(src));
    expect((dst as unknown as Rec).buf).toBe(keep); // same-type same-length typed array copied in place
    expect(dst.teams[0]!.roster.length).toBe(src.teams[0]!.roster.length);
    expect(dst.match.restart).not.toBe(src.match.restart);
  });

  it('copies -0 bit-exactly', () => {
    const src = fresh();
    const dst = fresh();
    src.ball.vz = -0;
    copyState(dst, src);
    expect(Object.is(dst.ball.vz, -0)).toBe(true);
  });
});

describe('diffState', () => {
  it('reports the first differing path in the documented format', () => {
    const a = fresh();
    const b = cloneState(a);
    a.players[3]!.x = 1.2;
    b.players[3]!.x = 1.3;
    expect(diffState(a, b)).toBe('players[3].x: 1.2 != 1.3');
  });

  it('formats root, nested object and nested array paths', () => {
    const a = fresh();
    let b = cloneState(a);
    b.tick = 5;
    expect(diffState(a, b)).toBe('tick: 0 != 5');
    b = cloneState(a);
    b.teams[1]!.cpu.out.mx = 5;
    expect(diffState(a, b)).toBe('teams[1].cpu.out.mx: 0 != 5');
    b = cloneState(a);
    b.match.restart.wall[2] = 4;
    expect(diffState(a, b)).toBe('match.restart.wall[2]: -1 != 4');
    b = cloneState(a);
    b.rng.d = a.rng.d + 1;
    expect(diffState(a, b)).toBe(`rng.d: ${a.rng.d} != ${a.rng.d + 1}`);
  });

  it('reports array length and missing keys', () => {
    const a = fresh();
    let b = cloneState(a);
    b.teams[0]!.subOut.push(1);
    expect(diffState(a, b)).toBe('teams[0].subOut.length: 5 != 6');
    b = cloneState(a);
    delete (b.ball as unknown as Rec).crossEnd;
    expect(diffState(a, b)).toBe('ball.crossEnd: present != missing');
    b = cloneState(a);
    (b.ball as unknown as Rec).extra = 1;
    expect(diffState(a, b)).toBe('ball.extra: missing != present');
    b = cloneState(a);
    (b.match as unknown as Rec).restart = 0;
    expect(diffState(a, b)).toBe('match.restart: object != 0');
  });

  it('treats -0 == 0 and NaN == NaN (like hashState) and shows -0 explicitly otherwise', () => {
    const a = fresh();
    const b = cloneState(a);
    a.ball.vx = 0; b.ball.vx = -0;
    expect(diffState(a, b)).toBeNull();
    a.ball.vx = NaN; b.ball.vx = NaN;
    expect(diffState(a, b)).toBeNull();
    a.ball.vx = -0; b.ball.vx = 1;
    expect(diffState(a, b)).toBe('ball.vx: -0 != 1');
  });

  it('ignores config and squads', () => {
    const a = fresh();
    const b = cloneState(a);
    b.config = { ...b.config, seed: 1234 };
    b.squads = [];
    expect(diffState(a, b)).toBeNull();
  });

  it('returns the FIRST difference in key order', () => {
    const a = fresh();
    const b = cloneState(a);
    b.ball.x = 3;
    b.players[0]!.x = 3;
    b.tick = 9;
    expect(diffState(a, b)).toBe('tick: 0 != 9');
  });
});
