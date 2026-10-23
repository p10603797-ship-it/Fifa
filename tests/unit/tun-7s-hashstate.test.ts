/**
 * [TUN-7S] QA-36: hashState's specialised (generated) hasher must give exactly the generic walk's hash on every state:
 * live states, scrambled values (fractions, negatives, -0, NaN, huge / tiny magnitudes), after copyState, and fall back
 * to the generic walk for states it cannot take (an own "__proto__" key, a null or string value, a missing key).
 * The replay recorder and net desync checks hash live states every 30-60 ticks; the generic walk boxed ~10 KB of
 * doubles per call in V8.
 */
import { describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, createSimState, type SimState } from '../../src/contracts/state';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState, hashStateGeneric, hashStateIsSpecialised, resetHashStateCache } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

type Rec = Record<string, unknown>;

function live(seed: number, ticks: number): SimState {
  const c = createMatchConfig();
  c.seed = seed;
  c.humans = c.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
  const s = initMatch(c);
  const fr = [createInputFrame(), createInputFrame()];
  const ev = createEventBuffer();
  for (let i = 0; i < ticks; i++) step(s, fr, ev);
  return s;
}

const SPECIAL = [-0, Number.NaN, 1e300, -1e-300, 5e-324, 0.1 + 0.2, -7.25, 2 ** 53, Infinity, -Infinity];

function scramble(v: unknown, seed: { x: number }, root = true): void {
  if (typeof v !== 'object' || v === null) return;
  const o = v as Rec;
  for (const k in o) {
    if (root && (k === 'config' || k === 'squads')) continue;
    const e = o[k];
    if (typeof e === 'number') {
      seed.x = (Math.imul(seed.x, 1103515245) + 12345) >>> 0;
      const r = seed.x % 9;
      o[k] = r < SPECIAL.length - 1 && seed.x % 4 === 0 ? SPECIAL[r]! : (seed.x % 2001) / 13 - 70;
    } else scramble(e, seed, false);
  }
}

describe('TUN-7S hashState specialised hasher', () => {
  it('hashes live states exactly like the generic walk, over a match', () => {
    const c = createMatchConfig();
    c.seed = 4242;
    c.humans = c.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
    const s = initMatch(c);
    expect(hashStateIsSpecialised(s)).toBe(true);
    const fr = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    for (let i = 0; i < 3000; i++) {
      step(s, fr, ev);
      if (i % 97 === 0) expect(hashState(s), `tick ${s.tick}`).toBe(hashStateGeneric(s));
    }
  });

  it('matches the generic walk on scrambled values (-0, NaN, extremes) and after copyState', () => {
    const s = live(9, 200);
    const seed = { x: 777 };
    const d = createSimState(s.config, s.squads);
    for (let round = 0; round < 30; round++) {
      scramble(s, seed);
      expect(hashState(s)).toBe(hashStateGeneric(s));
      copyState(d, s);
      expect(hashState(d)).toBe(hashState(s));
    }
    // -0 hashes as +0 and every NaN as one NaN, as before.
    const a = cloneState(s), b = cloneState(s);
    a.ball.x = -0; b.ball.x = 0;
    a.ball.z = Number.NaN; b.ball.z = -Number.NaN;
    expect(hashState(a)).toBe(hashState(b));
  });

  it('falls back to the generic walk for states it cannot take', () => {
    const s = live(3, 50);
    const withNull = cloneState(s);
    (withNull.ball as unknown as Rec).sx = null;
    expect(hashStateIsSpecialised(withNull)).toBe(false);
    expect(hashState(withNull)).toBe(hashStateGeneric(withNull));
    const missing = cloneState(s);
    delete (missing.match as unknown as Rec).phaseT;
    expect(hashState(missing)).toBe(hashStateGeneric(missing));
    expect(hashState(missing)).not.toBe(hashState(s));
    const proto = JSON.parse(JSON.stringify({ ...s, config: undefined, squads: undefined }).replace('"ball":{', '"ball":{"__proto__":{"p":1},')) as SimState;
    proto.config = s.config; proto.squads = s.squads;
    expect(hashStateIsSpecialised(proto)).toBe(false);
    expect(hashState(proto)).toBe(hashStateGeneric(proto));
    resetHashStateCache();
  });

  it('an array that changes length after validation still hashes like the generic walk', () => {
    const s = live(5, 50);
    expect(hashState(s)).toBe(hashStateGeneric(s));
    s.match.restart.wall.length = 2;
    expect(hashState(s)).toBe(hashStateGeneric(s));
    resetHashStateCache();
  });
});
