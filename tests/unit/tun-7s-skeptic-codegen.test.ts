/**
 * [TUN-7S skeptic] QF-7S (a) / QA-36: the generated copyState copier and hashState hasher run on a (dst, src) pair /
 * state once its shape was validated, and the validation is remembered by object identity. Their generated loads were
 * unguarded, so a value that changed kind after validation broke the "exactly the generic walk's result" contract:
 *  - copyState: a number slot later holding an object copied the reference (prev shared a nested object with curr);
 *    an object slot later holding null threw a TypeError (the app loop's copyState(prev, curr) would kill the frame);
 *  - hashState: a number slot later holding true / false / undefined / null / a string / an object was coerced to a
 *    double (true hashed as 1, false and null as 0: a different hash from the generic walk, and two different states
 *    hashing alike), and an object slot later holding null threw ("hashing never throws mid-match");
 *  - an array whose first element is a number and the rest objects of one shape was taken as a uniform object list
 *    (strict-mode TypeError writing fields of the number).
 * Every generated access is now guarded by the validated kind and falls back to the generic path for that value.
 */
import { describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, createSimState, type SimState } from '../../src/contracts/state';
import {
  cloneState, copyState, copyStateGeneric, copyStateIsSpecialised, diffState,
} from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState, hashStateGeneric, hashStateIsSpecialised } from '../../src/sim/core/hash';
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

/** No nested object / array of a is the same object as b's (immutable root keys excepted). */
function sharedRef(a: unknown, b: unknown, path: string, root = true): string | null {
  if (typeof a !== 'object' || a === null) return null;
  if (a === b) return path;
  for (const k in a as Rec) {
    if (root && (k === 'config' || k === 'squads')) continue;
    const r = sharedRef((a as Rec)[k], (b as Rec | null)?.[k], `${path}.${k}`, false);
    if (r) return r;
  }
  return null;
}

/** A private copy of an odd value (so src and the reference never share it). */
function fresh(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v;
  return ArrayBuffer.isView(v) ? (v as Float64Array).slice() : JSON.parse(JSON.stringify(v)) as unknown;
}

/**
 * Values of another kind than the slot had when validated: primitives of every type, a number, an array (another length),
 * a typed array, and a plain object: any keys for a primitive slot, the same keys (a JSON copy, numbers shifted) for an
 * object slot. A nested plain object whose key set changed is outside the contract (the state types fix every key set and
 * nothing deletes a field); that is the generated code's one remaining assumption.
 */
function oddValues(current: unknown): unknown[] {
  const plain = current !== null && typeof current === 'object' && !Array.isArray(current)
    ? JSON.parse(JSON.stringify(current), (_k, v: unknown) => (typeof v === 'number' ? v + 0.5 : v)) as unknown
    : { x: 1, y: [2, 3] };
  return [true, false, undefined, null, '3', 7.5, [1, 2], new Float64Array([4, 5]), plain];
}

interface Slot { name: string; get: (s: SimState) => unknown; set: (s: SimState, v: unknown) => void }
const SLOTS: readonly Slot[] = [
  { name: 'tick (root number)', get: (s) => s.tick, set: (s, v) => { (s as unknown as Rec).tick = v; } },
  { name: 'ball.x (nested number)', get: (s) => s.ball.x, set: (s, v) => { (s.ball as unknown as Rec).x = v; } },
  { name: 'players[7].vx (number in an object list)', get: (s) => s.players[7]!.vx, set: (s, v) => { (s.players[7] as unknown as Rec).vx = v; } },
  { name: 'match.advantage (nested object)', get: (s) => s.match.advantage, set: (s, v) => { (s.match as unknown as Rec).advantage = v; } },
  { name: 'ball (root object)', get: (s) => s.ball, set: (s, v) => { (s as unknown as Rec).ball = v; } },
  { name: 'match.restart.wall (number array)', get: (s) => s.match.restart.wall, set: (s, v) => { (s.match.restart as unknown as Rec).wall = v; } },
  { name: 'match.restart.wall[2] (array element)', get: (s) => s.match.restart.wall[2], set: (s, v) => { (s.match.restart.wall as unknown[])[2] = v; } },
  { name: 'players[3] (object list element)', get: (s) => s.players[3], set: (s, v) => { (s.players as unknown[])[3] = v; } },
  { name: 'players (object list)', get: (s) => s.players, set: (s, v) => { (s as unknown as Rec).players = v; } },
];

describe('TUN-7S skeptic: generated copier / hasher stay exact when a validated value changes kind', () => {
  it('copyState: same result as the generic walk, no shared reference, never throws (every slot x every odd value)', () => {
    const base = live(20261024, 400);
    for (const slot of SLOTS) {
      for (const v of oddValues(slot.get(base))) {
        const src = cloneState(base);
        const dst = createSimState(src.config, src.squads);
        expect(copyStateIsSpecialised(dst, src)).toBe(true);
        copyState(dst, src); // validates and caches the pair
        const keep = slot.get(src);
        slot.set(src, fresh(v));
        const ref = createSimState(src.config, src.squads);
        copyStateGeneric(ref, base);
        copyStateGeneric(ref, src);
        const label = `${slot.name} = ${String(v)}`;
        expect(() => copyState(dst, src), label).not.toThrow();
        expect(diffState(dst, ref), label).toBeNull();
        expect(sharedRef(dst, src, 'state'), label).toBeNull();
        // ...and back: the slot regains its kind and the copy follows.
        slot.set(src, keep);
        copyState(dst, src);
        expect(diffState(dst, src), `${label} (restored)`).toBeNull();
        expect(sharedRef(dst, src, 'state'), `${label} (restored)`).toBeNull();
      }
    }
  });

  it('copyState: a dst value that changed kind (null nested object, number in an object slot) is rebuilt, not dereferenced', () => {
    const src = live(7, 200);
    const dst = createSimState(src.config, src.squads);
    copyState(dst, src);
    (dst.match as unknown as Rec).advantage = null;
    (dst.players as unknown[])[5] = 0;
    (dst.match.restart as unknown as Rec).wall = 'x';
    expect(() => copyState(dst, src)).not.toThrow();
    expect(diffState(dst, src)).toBeNull();
    expect(sharedRef(dst, src, 'state')).toBeNull();
  });

  it('hashState: same hash as the generic walk and never throws (every slot x every odd value)', () => {
    const base = live(20261025, 400);
    for (const slot of SLOTS) {
      for (const v of oddValues(slot.get(base))) {
        const s = cloneState(base);
        expect(hashStateIsSpecialised(s)).toBe(true);
        const h0 = hashState(s); // validates and caches the state
        expect(h0).toBe(hashStateGeneric(s));
        const keep = slot.get(s);
        slot.set(s, fresh(v));
        const label = `${slot.name} = ${String(v)}`;
        let h = 0;
        expect(() => { h = hashState(s); }, label).not.toThrow();
        expect(h, label).toBe(hashStateGeneric(s));
        slot.set(s, keep);
        expect(hashState(s), `${label} (restored)`).toBe(h0);
      }
    }
  });

  it('hashState tells a boolean / null / undefined from the number it would coerce to (as the generic walk does)', () => {
    const s = live(11, 120);
    hashState(s);
    const ball = s.ball as unknown as Rec;
    const keep = ball.grounded;
    const seen = new Set<number>();
    for (const v of [1, true, 0, false, null, undefined, Number.NaN]) {
      ball.grounded = v;
      seen.add(hashState(s));
    }
    ball.grounded = keep;
    expect(seen.size).toBe(7);
  });

  it('an array of a number followed by objects of one shape is copied and hashed per element (not as an object list)', () => {
    const src = live(5, 60);
    const dst = createSimState(src.config, src.squads);
    (src as unknown as Rec).extra = [5, { a: 1, b: 2 }, { a: 3, b: 4 }];
    (dst as unknown as Rec).extra = [0, { a: 0, b: 0 }, { a: 0, b: 0 }];
    expect(copyStateIsSpecialised(dst, src)).toBe(true);
    expect(() => copyState(dst, src)).not.toThrow();
    expect((dst as unknown as Rec).extra).toEqual([5, { a: 1, b: 2 }, { a: 3, b: 4 }]);
    expect(sharedRef(dst, src, 'state')).toBeNull();
    expect(hashStateIsSpecialised(src)).toBe(true);
    expect(hashState(src)).toBe(hashStateGeneric(src));
  });
});
