/**
 * REVIEW of FND-03 (independent reviewer): adversarial tests for src/sim/core/{serialize,clone,hash}.ts.
 * Failing tests in this file are confirmed defects and stay in place as regression tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { Btn, createInputFrame, INPUT_FIELDS, type InputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { cloneState, copyState, diffState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashInputFrame, hashState, hashValue } from '../../src/sim/core/hash';
import { deserializeState, PACKED_FRAME_INTS, packFrames, serializeState, unpackFrames } from '../../src/sim/core/serialize';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

type Rec = Record<string, unknown>;

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/** A state after real ticks in IN_PLAY with scripted stick/button input (non-trivial floats everywhere). */
function playedState(ticks = 600): SimState {
  const s = initMatch(createMatchConfig());
  s.match.phase = MatchPhase.IN_PLAY;
  const ev = createEventBuffer();
  const r = lcg(2024);
  const f = [createInputFrame(), createInputFrame()];
  for (let t = 0; t < ticks; t++) {
    if (r() < 0.05) { f[0]!.mx = Math.floor(r() * 255) - 127; f[0]!.mz = Math.floor(r() * 255) - 127; }
    if (r() < 0.08) f[0]!.buttons ^= 1 << Math.floor(r() * 8);
    step(s, f, ev);
  }
  return s;
}

/** Every numeric leaf of the mutable state as [holder, key] (arrays and objects). */
function numericLeaves(s: SimState): [Rec, string][] {
  const out: [Rec, string][] = [];
  const visit = (v: unknown): void => {
    if (typeof v !== 'object' || v === null) return;
    const o = v as Rec;
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'number') out.push([o, k]);
      else visit(o[k]);
    }
  };
  for (const k of Object.keys(s)) if (k !== 'config' && k !== 'squads') visit((s as unknown as Rec)[k]);
  return out;
}

/** Every object/array reachable from the mutable part of the state. */
function nestedObjects(s: SimState): Set<object> {
  const out = new Set<object>();
  const visit = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || out.has(v)) return;
    out.add(v);
    for (const k of Object.keys(v)) visit((v as Rec)[k]);
  };
  for (const k of Object.keys(s)) if (k !== 'config' && k !== 'squads') visit((s as unknown as Rec)[k]);
  return out;
}

/** deserializeState, or null when it (correctly) rejects the input. */
function tryDeserialize(json: string): SimState | null {
  try {
    return deserializeState(json);
  } catch {
    return null;
  }
}

afterEach(() => {
  // Never leave a polluted prototype behind for other tests in this worker.
  delete (Object.prototype as Rec).polluted;
  delete (Object.prototype as Rec).pollutedTop;
});

describe('review FND-03 serialize: hostile / malformed snapshots (online resync path)', () => {
  // DEFECT (major, security): JSON.parse keeps "__proto__" as an own key; deserializeState passes it through and
  // copyState's generic walk then does `dobj['__proto__'] = copyInto(dobj['__proto__'], e)`, i.e. copyInto(Object.prototype, e):
  // a peer-supplied snapshot pollutes Object.prototype for the whole app (and every later for-in walk in
  // hashState/copyState/cloneState/diffState then sees the injected keys). cloneState instead re-parents the clone.
  // Expected: deserializeState rejects (or drops) "__proto__" keys, and the clone/copy walkers never assign
  // through the __proto__ accessor (skip the key or use Object.hasOwn + defineProperty).
  it('a snapshot with a nested "__proto__" key cannot pollute Object.prototype through copyState', () => {
    const s = initMatch(createMatchConfig());
    const json = serializeState(s).replace('"ball":{', '"ball":{"__proto__":{"polluted":1},');
    const snap = tryDeserialize(json);
    if (snap !== null) {
      const prev = cloneState(s);
      copyState(prev, snap); // app loop: copyState(prev, state) before each tick
    }
    expect((({}) as Rec).polluted).toBeUndefined();
  });

  it('a snapshot with a top-level "__proto__" key cannot pollute Object.prototype through copyState', () => {
    const s = initMatch(createMatchConfig());
    const json = serializeState(s).replace(/^\{/, '{"__proto__":{"pollutedTop":1},');
    const snap = tryDeserialize(json);
    if (snap !== null) copyState(cloneState(s), snap);
    expect((({}) as Rec).pollutedTop).toBeUndefined();
  });

  it('cloneState of a deserialized snapshot keeps its hash (no prototype re-parenting via "__proto__")', () => {
    const s = initMatch(createMatchConfig());
    const json = serializeState(s).replace('"ball":{', '"ball":{"__proto__":{"x":5},');
    const snap = tryDeserialize(json);
    if (snap !== null) {
      const c = cloneState(snap);
      expect(hashState(c)).toBe(hashState(snap));
      expect(Object.getPrototypeOf(c.ball)).toBe(Object.prototype);
    }
  });

  // DEFECT (minor): the snapshot check is shallow; `typeof null === 'object'` lets ball/config = null through and
  // there is no check of rng/match/teams/ctrl/attrs. The broken state is only discovered later inside step().
  // Expected: deserializeState throws SyntaxError for these (builder report claims "throws on malformed input").
  it('deserializeState rejects snapshots with null / missing top-level members', () => {
    const base = JSON.parse(serializeState(initMatch(createMatchConfig()))) as Rec;
    const variants: Rec[] = [
      { ...base, ball: null },
      { ...base, config: null },
      (() => { const v = { ...base }; delete v.rng; return v; })(),
      (() => { const v = { ...base }; delete v.match; return v; })(),
      { ...base, teams: 'x' },
    ];
    const accepted: number[] = [];
    variants.forEach((v, i) => {
      try { deserializeState(JSON.stringify(v)); accepted.push(i); } catch { /* rejected: good */ }
    });
    expect(accepted).toEqual([]);
  });

  // DEFECT (minor): `undefined` in state (contract-forbidden, but one out-of-range array read elsewhere produces it)
  // is silently dropped from objects / turned into null in arrays by JSON, so the restored snapshot hashes
  // differently from the live state (online resync then desyncs immediately). -0/NaN/Infinity are handled, undefined
  // is not. Expected: either a bit-exact round trip or a loud failure in serializeState.
  it('a state containing undefined either round-trips with the same hash or serializeState throws', () => {
    const cases: ((s: SimState) => void)[] = [
      (s) => { (s.ball as unknown as Rec).owner = undefined; },
      (s) => { (s.teams[0]!.roster as unknown[])[3] = undefined; },
    ];
    for (const mutate of cases) {
      const s = initMatch(createMatchConfig());
      mutate(s);
      let ok: boolean;
      try {
        ok = hashState(deserializeState(serializeState(s))) === hashState(s);
      } catch {
        ok = true; // loud failure is acceptable
      }
      expect(ok).toBe(true);
    }
  });
});

describe('review FND-03 serialize: round trips after real play', () => {
  it('played IN_PLAY state: equal hash, null diff, identical re-serialisation, config/squads deep-equal', () => {
    const s = playedState();
    const json = serializeState(s);
    const r = deserializeState(json);
    expect(hashState(r)).toBe(hashState(s));
    expect(diffState(s, r)).toBeNull();
    expect(serializeState(r)).toBe(json);
    expect(hashValue(r.config)).toBe(hashValue(s.config));
    expect(hashValue(r.squads)).toBe(hashValue(s.squads));
  });

  it('every numeric leaf survives special values bit-exactly (-0, subnormal, max, eps steps)', () => {
    const s = playedState(120);
    const leaves = numericLeaves(s);
    const specials = [-0, 5e-324, -5e-324, 1.7976931348623157e308, 0.1 + 0.2, 1 / 3, -2.2250738585072014e-308, 2 ** 53 + 2];
    leaves.forEach(([o, k], i) => { o[k] = specials[i % specials.length]!; });
    const r = deserializeState(serializeState(s));
    const rl = numericLeaves(r);
    expect(rl.length).toBe(leaves.length);
    rl.forEach(([o, k], i) => { expect(Object.is(o[k], specials[i % specials.length])).toBe(true); });
  });
});

describe('review FND-03 serialize: packFrames / unpackFrames', () => {
  it('round-trips every field at its contract extremes for both humans', () => {
    const lo = createInputFrame();
    const hi = createInputFrame();
    const r = lo as unknown as Record<string, number>;
    const h = hi as unknown as Record<string, number>;
    for (const k of INPUT_FIELDS) { r[k] = -127; h[k] = 127; }
    lo.buttons = 0; hi.buttons = 0x7ff | Btn.RS_HOLD; lo.gFlags = 0; hi.gFlags = 7;
    lo.gx = -1050; hi.gx = 1050; lo.gz = -680; hi.gz = 680; lo.gSlot = -1; hi.gSlot = 21;
    lo.power = 0; lo.gPower = 0;
    const buf = new Int16Array(PACKED_FRAME_INTS * 3);
    expect(packFrames([lo, hi], buf, PACKED_FRAME_INTS)).toBe(PACKED_FRAME_INTS);
    expect(buf.subarray(0, PACKED_FRAME_INTS).every((v) => v === 0)).toBe(true);
    const out: InputFrame[] = [];
    expect(unpackFrames(buf, PACKED_FRAME_INTS, out)).toBe(PACKED_FRAME_INTS);
    expect(out[0]).toEqual(lo);
    expect(out[1]).toEqual(hi);
    expect(hashInputFrame(out[1]!)).toBe(hashInputFrame(hi));
  });

  // DEFECT (minor): the bounds check only compares offset + N against the length. A fractional or NaN offset
  // passes, every `out[o++] = v` is then a silent no-op on the typed array (non-integer index), and the function
  // still reports PACKED_FRAME_INTS written: a replay/network buffer is silently left blank.
  // Expected: RangeError for any offset that is not a non-negative integer (same for unpackFrames).
  it('packFrames / unpackFrames reject non-integer offsets instead of silently writing nothing', () => {
    const f = createInputFrame();
    f.mx = 100;
    const buf = new Int16Array(PACKED_FRAME_INTS * 2);
    expect(() => packFrames([f, f], buf, 0.5)).toThrow(RangeError);
    expect(() => packFrames([f, f], buf, NaN)).toThrow(RangeError);
    expect(() => unpackFrames(buf, 0.5, [])).toThrow(RangeError);
  });
});

describe('review FND-03 clone / hash', () => {
  it('diffState === null exactly when hashState is equal, for 3000 random single-leaf mutations', () => {
    const base = playedState(240);
    const r = lcg(77);
    const work = cloneState(base);
    const leaves = numericLeaves(work);
    const baseHash = hashState(base);
    for (let i = 0; i < 3000; i++) {
      const [o, k] = leaves[Math.floor(r() * leaves.length)]!;
      const old = o[k] as number;
      const pick = r();
      o[k] = pick < 0.2 ? (old === 0 ? -0 : -old) : pick < 0.4 ? old + 1e-12 : pick < 0.5 ? old : Math.floor(r() * 100);
      const same = diffState(base, work) === null;
      expect(hashState(work) === baseHash).toBe(same);
      o[k] = old;
    }
  });

  it('copyState leaves dst sharing no mutable object with src, so later ticks never leak into the snapshot', () => {
    const s = playedState(60);
    const prev = initMatch(createMatchConfig());
    copyState(prev, s);
    const a = nestedObjects(s);
    for (const o of nestedObjects(prev)) expect(a.has(o)).toBe(false);
    const h = hashState(prev);
    const ev = createEventBuffer();
    for (let t = 0; t < 60; t++) step(s, [createInputFrame(), createInputFrame()], ev);
    expect(hashState(prev)).toBe(h);
  });

  it('copyState repairs shape changes in both directions and ends equal (hash + diff)', () => {
    const s = playedState(30);
    const dst = cloneState(s);
    const srcR = s as unknown as Rec;
    s.teams[0]!.subOut.push(9, 9, 9);
    s.match.challenges.length = 1;
    (srcR.match as Rec).advantage = null;
    (s.teams[1] as unknown as Rec).homeX = new Float64Array([1, -0, 3]);
    copyState(dst, s);
    expect(diffState(dst, s)).toBeNull();
    expect(hashState(dst)).toBe(hashState(s));
    const back = playedState(30);
    copyState(dst, back);
    expect(diffState(dst, back)).toBeNull();
    expect(hashState(dst)).toBe(hashState(back));
  });

  it('hashState is not disturbed by earlier hashValue / hashInputFrame calls, even ones that threw', () => {
    const s = playedState(60);
    const h = hashState(s);
    hashValue({ a: [1, 2, { b: 'x' }] });
    hashInputFrame(createInputFrame(), 123);
    const cyclic: Rec = { a: 1 };
    cyclic.self = cyclic;
    expect(() => hashValue(cyclic)).toThrow(RangeError);
    expect(hashState(s)).toBe(h);
    expect(hashState(cloneState(s))).toBe(h);
  });

  it('hashInputFrame ignores key order and extra keys; any single field change alters it', () => {
    const f = createInputFrame();
    const reordered = {} as Record<string, number>;
    for (let i = INPUT_FIELDS.length - 1; i >= 0; i--) reordered[INPUT_FIELDS[i]!] = (f as unknown as Record<string, number>)[INPUT_FIELDS[i]!]!;
    reordered.extra = 5;
    expect(hashInputFrame(reordered as unknown as InputFrame)).toBe(hashInputFrame(f));
    const seen = new Set<number>([hashInputFrame(f)]);
    for (const k of INPUT_FIELDS) {
      const g = createInputFrame();
      (g as unknown as Record<string, number>)[k] = 1;
      seen.add(hashInputFrame(g));
    }
    expect(seen.size).toBe(INPUT_FIELDS.length + 1);
  });
});
