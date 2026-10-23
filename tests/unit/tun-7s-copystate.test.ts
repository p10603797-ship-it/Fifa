/**
 * [TUN-7S] QF-7S (a): copyState's specialised (generated) copier must give exactly the generic walk's result: same
 * values, same key order, no shared nested references, immutable keys by reference, and the generic fallback for any
 * shape mismatch (missing key, extra key, array length, "__proto__" own key).
 */
import { describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, createSimState, type SimState } from '../../src/contracts/state';
import {
  cloneState, copyState, copyStateGeneric, copyStateIsSpecialised, diffState, resetCopyStateCache,
} from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

type Rec = Record<string, unknown>;

function liveState(seed: number, ticks: number): SimState {
  const c = createMatchConfig();
  c.seed = seed;
  c.humans = c.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
  const s = initMatch(c);
  const frames = [createInputFrame(), createInputFrame()];
  const ev = createEventBuffer();
  for (let i = 0; i < ticks; i++) step(s, frames, ev);
  return s;
}

/** Deterministic pseudo-random fill of every number field (walk order), including -0 and fractional values. */
function scramble(v: unknown, seed: { x: number }): void {
  if (typeof v !== 'object' || v === null) return;
  const o = v as Rec;
  for (const k in o) {
    if (k === 'config' || k === 'squads') continue;
    const e = o[k];
    if (typeof e === 'number') {
      seed.x = (Math.imul(seed.x, 1103515245) + 12345) >>> 0;
      const r = seed.x % 7;
      o[k] = r === 0 ? -0 : r === 1 ? (seed.x % 1000) / 7 : r === 2 ? -(seed.x % 97) : seed.x % 13;
    } else scramble(e, seed);
  }
}

/** Every nested object / array of a must be a different object from b's (no aliasing). */
function expectNoSharedRefs(a: unknown, b: unknown, path: string): void {
  if (typeof a !== 'object' || a === null) return;
  expect(a === b, `shared reference at ${path}`).toBe(false);
  const o = a as Rec;
  for (const k in o) {
    if (path === '' && (k === 'config' || k === 'squads')) continue;
    expectNoSharedRefs(o[k], (b as Rec)[k], `${path}.${k}`);
  }
}

describe('TUN-7S copyState specialised copier', () => {
  it('copies a live mid-match state exactly (diffState null, hash equal, key order kept, no aliasing)', () => {
    const src = liveState(20261023, 900);
    const dst = createSimState(src.config, src.squads);
    expect(copyStateIsSpecialised(dst, src)).toBe(true);
    copyState(dst, src);
    expect(diffState(dst, src)).toBeNull();
    expect(hashState(dst)).toBe(hashState(src));
    expect(JSON.stringify(dst)).toBe(JSON.stringify(src));
    expect(dst.config).toBe(src.config);
    expect(dst.squads).toBe(src.squads);
    expectNoSharedRefs(dst, src, '');
  });

  it('matches the generic walk on scrambled states over many copies of the same pair', () => {
    const src = liveState(7, 300);
    const a = createSimState(src.config, src.squads);
    const b = createSimState(src.config, src.squads);
    const seed = { x: 12345 };
    for (let round = 0; round < 25; round++) {
      scramble(src, seed);
      copyState(a, src);
      copyStateGeneric(b, src);
      expect(diffState(a, b)).toBeNull();
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      // -0 is copied as -0 (same bits as the generic walk).
      expect(Object.is(a.ball.x, src.ball.x)).toBe(true);
    }
  });

  it('a pair of states that share their shape but not their key insertion source still copies exactly (cloneState prev)', () => {
    const src = liveState(99, 200);
    const prev = cloneState(src);
    step(src, [createInputFrame(), createInputFrame()], createEventBuffer());
    copyState(prev, src);
    expect(diffState(prev, src)).toBeNull();
  });

  it('falls back to the generic walk when shapes differ (missing key, extra key, array length)', () => {
    const src = liveState(3, 100);
    // dst missing a nested key: the generic walk adds it.
    const d1 = cloneState(src);
    delete (d1.ball as unknown as Rec).sy;
    expect(copyStateIsSpecialised(d1, src)).toBe(false);
    copyState(d1, src);
    expect(diffState(d1, src)).toBeNull();
    // dst with an extra key: left untouched (generic contract).
    const d2 = cloneState(src);
    (d2.ball as unknown as Rec).extra = 5;
    copyState(d2, src);
    expect((d2.ball as unknown as Rec).extra).toBe(5);
    expect(d2.ball.x).toBe(src.ball.x);
    // array length differs: copied generically to src's length.
    const d3 = cloneState(src);
    d3.match.restart.wall.length = 2;
    copyState(d3, src);
    expect(diffState(d3, src)).toBeNull();
  });

  it('a validated pair whose array length changes later still copies that array exactly (length guard)', () => {
    const src = liveState(5, 100);
    const dst = createSimState(src.config, src.squads);
    copyState(dst, src);
    dst.match.shootout.kicks.length = 3; // reshaped behind the cache's back
    copyState(dst, src);
    expect(diffState(dst, src)).toBeNull();
    resetCopyStateCache();
  });

  it('an own "__proto__" key in src (JSON.parse) never re-parents dst', () => {
    const src = liveState(11, 50);
    const evil = JSON.parse(JSON.stringify({ ...src, config: undefined, squads: undefined }).replace('"ball":{', '"ball":{"__proto__":{"polluted":1},')) as SimState;
    evil.config = src.config;
    evil.squads = src.squads;
    const dst = createSimState(src.config, src.squads);
    expect(copyStateIsSpecialised(dst, evil)).toBe(false);
    copyState(dst, evil);
    expect(Object.getPrototypeOf(dst.ball)).toBe(Object.prototype);
    expect(({} as Rec).polluted).toBeUndefined();
  });

  it('copyState(s, s) is a no-op', () => {
    const src = liveState(13, 60);
    const h = hashState(src);
    copyState(src, src);
    expect(hashState(src)).toBe(h);
  });
});
