/** FND-03: state / value / input-frame hashing. */
import { describe, expect, it } from 'vitest';
import { createInputFrame, INPUT_FIELDS, type InputFrame } from '../../src/contracts/input';
import { createMatchConfig, IMMUTABLE_STATE_KEYS, type SimState } from '../../src/contracts/state';
import { cloneState } from '../../src/sim/core/clone';
import { HASH_SEED, hashHex, hashInputFrame, hashState, hashValue } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';

type Rec = Record<string, unknown>;

/** Every numeric leaf of the mutable state as [container, key, path]. */
function numericLeaves(s: SimState): [Rec, string, string][] {
  const out: [Rec, string, string][] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      v.forEach((e, i) => (typeof e === 'number' ? out.push([v as unknown as Rec, String(i), `${path}[${i}]`]) : walk(e, `${path}[${i}]`)));
    } else if (typeof v === 'object' && v !== null) {
      for (const k of Object.keys(v)) {
        const e = (v as Rec)[k];
        if (typeof e === 'number') out.push([v as Rec, k, `${path}.${k}`]);
        else walk(e, `${path}.${k}`);
      }
    }
  };
  for (const k of Object.keys(s)) {
    if ((IMMUTABLE_STATE_KEYS as readonly string[]).includes(k)) continue;
    const e = (s as unknown as Rec)[k];
    if (typeof e === 'number') out.push([s as unknown as Rec, k, k]);
    else walk(e, k);
  }
  return out;
}

const fresh = (): SimState => initMatch(createMatchConfig());

describe('hashState', () => {
  it('is stable: same state, clone and freshly built equal states hash the same', () => {
    const a = fresh();
    const h = hashState(a);
    expect(hashState(a)).toBe(h);
    expect(hashState(cloneState(a))).toBe(h);
    expect(hashState(fresh())).toBe(h);
    expect(h).toBe(h >>> 0);
  });

  it('changes when any single numeric field changes (every leaf of the mutable state)', () => {
    const s = fresh();
    const base = hashState(s);
    const leaves = numericLeaves(s);
    expect(leaves.length).toBeGreaterThan(2000);
    const seen = new Set<number>();
    for (const [obj, key, path] of leaves) {
      const old = obj[key] as number;
      obj[key] = old + 1;
      const h1 = hashState(s);
      obj[key] = old === 0 ? 1e-9 : old * (1 + 1e-12); // tiny float change
      const h2 = hashState(s);
      obj[key] = old;
      if (h1 === base || h2 === base) throw new Error(`hash insensitive to ${path}`);
      seen.add(h1);
    }
    expect(hashState(s)).toBe(base);
    // Distinct fields give distinct hashes (no accidental symmetric collisions).
    expect(seen.size).toBe(leaves.length);
  });

  it('distinguishes values by their float64 bits', () => {
    const s = fresh();
    s.ball.vx = 0.1 + 0.2;
    const h1 = hashState(s);
    s.ball.vx = 0.3;
    expect(hashState(s)).not.toBe(h1);
    s.ball.vx = 5e-324;
    const h3 = hashState(s);
    s.ball.vx = 0;
    expect(hashState(s)).not.toBe(h3);
  });

  it('normalises -0 to 0', () => {
    const s = fresh();
    s.players[3]!.fz = 0;
    s.ball.vx = 0;
    const h = hashState(s);
    s.players[3]!.fz = -0;
    s.ball.vx = -0;
    expect(hashState(s)).toBe(h);
  });

  it('hashes NaN canonically (deterministic even if a bug writes NaN)', () => {
    const s = fresh();
    s.ball.vx = NaN;
    const h = hashState(s);
    s.ball.vx = -NaN;
    expect(hashState(s)).toBe(h);
    s.ball.vx = 0;
    expect(hashState(s)).not.toBe(h);
  });

  it('skips the immutable keys (config, squads)', () => {
    const s = fresh();
    const h = hashState(s);
    s.config = { ...s.config, seed: 999, halfMinutes: 9 };
    s.squads = [[], []];
    expect(hashState(s)).toBe(h);
  });

  it('is sensitive to swapping two values and to array structure', () => {
    const s = fresh();
    s.players[0]!.x = 1; s.players[0]!.z = 2;
    const h = hashState(s);
    s.players[0]!.x = 2; s.players[0]!.z = 1;
    expect(hashState(s)).not.toBe(h);
    s.players[0]!.x = 1; s.players[0]!.z = 2;
    s.teams[0]!.roster.push(0);
    expect(hashState(s)).not.toBe(h);
    s.teams[0]!.roster.pop();
    expect(hashState(s)).toBe(h);
  });
});

describe('hashValue', () => {
  it('pins known values (cross-version stability)', () => {
    expect(hashHex(hashValue({ a: 1, b: [1, 2, 3], c: 'x' }))).toBe('da5d6301');
    expect(hashHex(hashValue(0))).toBe('35a43f50');
  });

  it('includes key names, order and structure', () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ b: 1 }));
    expect(hashValue({ a: 1, b: 2 })).not.toBe(hashValue({ b: 2, a: 1 }));
    expect(hashValue([[1], 2])).not.toBe(hashValue([1, [2]]));
    expect(hashValue([1, 2])).not.toBe(hashValue(new Float64Array([1, 2])));
    expect(hashValue({ a: { b: 1 }, c: 2 })).not.toBe(hashValue({ a: { b: 1, c: 2 } }));
  });

  it('handles strings, booleans, null, undefined, typed arrays and seeds', () => {
    expect(hashValue('abc')).not.toBe(hashValue('abd'));
    expect(hashValue(true)).not.toBe(hashValue(false));
    expect(hashValue(null)).not.toBe(hashValue(undefined));
    expect(hashValue(1)).toBe(hashValue(1));
    expect(hashValue(-0)).toBe(hashValue(0));
    expect(hashValue(new Int16Array([1, 2, 3]))).toBe(hashValue(new Int16Array([1, 2, 3])));
    expect(hashValue(new Int16Array([1, 2, 3]))).not.toBe(hashValue(new Int16Array([1, 2, 4])));
    expect(hashValue({ x: 1 }, 1)).not.toBe(hashValue({ x: 1 }, 2));
    expect(hashValue({ x: 1 })).toBe(hashValue({ x: 1 }, HASH_SEED));
  });

  it('hashes squads (plain data with strings) deterministically', () => {
    const s = fresh();
    const h = hashValue(s.squads);
    expect(hashValue(JSON.parse(JSON.stringify(s.squads)))).toBe(h);
    const copy = JSON.parse(JSON.stringify(s.squads)) as { name: string }[][];
    copy[1]![5]!.name += 'x';
    expect(hashValue(copy)).not.toBe(h);
  });

  it('a hashValue call in between does not disturb hashState', () => {
    const s = fresh();
    const h = hashState(s);
    hashValue({ a: [1, 2, { b: 'c' }] });
    expect(hashState(s)).toBe(h);
  });
});

describe('hashInputFrame', () => {
  it('follows INPUT_FIELDS order, not key insertion order', () => {
    const f = createInputFrame();
    f.mx = 50; f.buttons = 3; f.gSlot = 7;
    const reversed = {} as Record<string, number>;
    for (const k of [...INPUT_FIELDS].reverse()) reversed[k] = (f as unknown as Record<string, number>)[k]!;
    expect(hashInputFrame(reversed as unknown as InputFrame)).toBe(hashInputFrame(f));
  });

  it('changes with every field', () => {
    const f = createInputFrame();
    const base = hashInputFrame(f);
    const seen = new Set<number>([base]);
    for (const k of INPUT_FIELDS) {
      const r = f as unknown as Record<string, number>;
      const old = r[k]!;
      r[k] = old + 1;
      const h = hashInputFrame(f);
      expect(seen.has(h)).toBe(false);
      seen.add(h);
      r[k] = old;
    }
    expect(hashInputFrame(f)).toBe(base);
    expect(hashInputFrame(f, 1)).not.toBe(hashInputFrame(f, 2));
  });
});

describe('hashHex', () => {
  it('formats uint32 as 8 hex digits', () => {
    expect(hashHex(0)).toBe('00000000');
    expect(hashHex(0xdeadbeef)).toBe('deadbeef');
    expect(hashHex(-1)).toBe('ffffffff');
  });
});
