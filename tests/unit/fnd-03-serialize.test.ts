/** FND-03: snapshots (serializeState / deserializeState) and the input frame codec (packFrames / unpackFrames). */
import { describe, expect, it } from 'vitest';
import { MAX_HUMANS } from '../../src/contracts/constants';
import { Btn, createInputFrame, INPUT_FIELDS, type InputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { cloneState, diffState } from '../../src/sim/core/clone';
import { hashInputFrame, hashState, hashValue } from '../../src/sim/core/hash';
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

/** Bit pattern of a double as a hex string. */
function bits(v: number): string {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, v);
  return b.getBigUint64(0).toString(16);
}

describe('serializeState / deserializeState', () => {
  it('round-trips with equal hash, no diff and the same key order', () => {
    const s = fresh();
    const r = deserializeState(serializeState(s));
    expect(hashState(r)).toBe(hashState(s));
    expect(diffState(s, r)).toBeNull();
    expect(Object.keys(r)).toEqual(Object.keys(s));
    expect(Object.keys(r.players[7]!)).toEqual(Object.keys(s.players[7]!));
  });

  it('includes config and squads (deep equal, not shared)', () => {
    const s = fresh();
    const r = deserializeState(serializeState(s));
    expect(r.config).toEqual(s.config);
    expect(r.config).not.toBe(s.config);
    expect(r.squads).toEqual(s.squads);
    expect(hashValue(r.squads)).toBe(hashValue(s.squads));
    expect(hashValue(r.config)).toBe(hashValue(s.config));
  });

  it('is bit-exact for every float, including -0, subnormals, extremes and NaN/Infinity', () => {
    const s = fresh();
    const rnd = lcg(1);
    const specials = [-0, 0, 5e-324, -5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, -1.7976931348623157e308,
      0.1 + 0.2, 1 / 3, Math.PI, 1e21, 1e-7, 123456789.12345679, NaN, Infinity, -Infinity];
    const fields = Object.keys(s.ball) as (keyof SimState['ball'])[];
    specials.forEach((v, i) => { (s.ball as unknown as Rec)[fields[i]!] = v; });
    for (const p of s.players) {
      p.x = (rnd() - 0.5) * 105; p.z = (rnd() - 0.5) * 68; p.vx = rnd() * 1e-10; p.fz = -rnd();
    }
    const r = deserializeState(serializeState(s));
    specials.forEach((v, i) => expect(bits((r.ball as unknown as Rec)[fields[i]!] as number)).toBe(bits(v)));
    for (let i = 0; i < s.players.length; i++) {
      for (const k of ['x', 'z', 'vx', 'fz'] as const) expect(bits(r.players[i]![k])).toBe(bits(s.players[i]![k]));
    }
    expect(Object.is(r.ball.x, -0)).toBe(true);
  });

  it('round-trips typed arrays with their type', () => {
    const s = fresh();
    (s as unknown as Rec).buf = new Float64Array([1.5, -0, NaN]);
    (s as unknown as Rec).ints = new Int16Array([-3, 4]);
    const r = deserializeState(serializeState(s)) as unknown as Rec;
    expect(r.buf).toBeInstanceOf(Float64Array);
    expect(Object.is((r.buf as Float64Array)[1], -0)).toBe(true);
    expect((r.buf as Float64Array)[2]).toBeNaN();
    expect(r.ints).toBeInstanceOf(Int16Array);
    expect(Array.from(r.ints as Int16Array)).toEqual([-3, 4]);
  });

  it('round-trips a cloned, scrambled state', () => {
    const s = cloneState(fresh());
    s.tick = 12345;
    s.match.phase = 3;
    s.teams[1]!.roster[4] = 2;
    s.ctrl[0]!.holdT[3] = 17;
    s.teams[0]!.cpu.out.buttons = Btn.SHOOT | Btn.SPRINT;
    const j = serializeState(s);
    expect(typeof j).toBe('string');
    expect(() => JSON.parse(j)).not.toThrow();
    const r = deserializeState(j);
    expect(diffState(s, r)).toBeNull();
    expect(hashState(r)).toBe(hashState(s));
    expect(serializeState(r)).toBe(j);
  });

  it('rejects malformed input', () => {
    expect(() => deserializeState('nope')).toThrow();
    expect(() => deserializeState('42')).toThrow();
    expect(() => deserializeState('{"tick":1}')).toThrow();
    expect(() => deserializeState('{"$num":"bogus"}')).toThrow();
  });
});

describe('packFrames / unpackFrames', () => {
  function randomFrame(rnd: () => number): InputFrame {
    const f = createInputFrame();
    const r = f as unknown as Record<string, number>;
    for (const k of INPUT_FIELDS) r[k] = Math.floor(rnd() * 255) - 127;
    f.buttons = Math.floor(rnd() * 0x10000);
    f.gFlags = Math.floor(rnd() * 8);
    f.gx = Math.floor(rnd() * 1240) - 620;
    f.gz = Math.floor(rnd() * 880) - 440;
    f.gSlot = Math.floor(rnd() * 23) - 1;
    return f;
  }

  it('round-trips MAX_HUMANS frames and returns the int16 count', () => {
    expect(PACKED_FRAME_INTS).toBe(MAX_HUMANS * INPUT_FIELDS.length);
    const rnd = lcg(2);
    const buf = new Int16Array(PACKED_FRAME_INTS * 10 + 3);
    const ticks: InputFrame[][] = [];
    let off = 3;
    for (let t = 0; t < 10; t++) {
      const frames = [randomFrame(rnd), randomFrame(rnd)];
      ticks.push(frames);
      off += packFrames(frames, buf, off);
    }
    expect(off).toBe(buf.length);
    off = 3;
    const out: InputFrame[] = [];
    for (let t = 0; t < 10; t++) {
      const n = unpackFrames(buf, off, out);
      expect(n).toBe(PACKED_FRAME_INTS);
      off += n;
      for (let h = 0; h < MAX_HUMANS; h++) {
        expect(out[h]).toEqual(ticks[t]![h]);
        expect(hashInputFrame(out[h]!)).toBe(hashInputFrame(ticks[t]![h]!));
      }
    }
  });

  it('writes fields in INPUT_FIELDS order', () => {
    const f = createInputFrame();
    const r = f as unknown as Record<string, number>;
    INPUT_FIELDS.forEach((k, i) => { r[k] = i + 1; });
    const buf = new Int16Array(PACKED_FRAME_INTS);
    packFrames([f, f], buf, 0);
    for (let i = 0; i < INPUT_FIELDS.length; i++) {
      expect(buf[i]).toBe(i + 1);
      expect(buf[INPUT_FIELDS.length + i]).toBe(i + 1);
    }
  });

  it('missing frames are packed as neutral; unpack creates missing frame objects and reuses existing ones', () => {
    const f = createInputFrame();
    f.mx = 100; f.buttons = Btn.PASS;
    const buf = new Int16Array(PACKED_FRAME_INTS);
    packFrames([f], buf, 0);
    const keep = createInputFrame();
    const out: InputFrame[] = [keep];
    unpackFrames(buf, 0, out);
    expect(out[0]).toBe(keep);
    expect(out[0]).toEqual(f);
    expect(out.length).toBe(MAX_HUMANS);
    expect(out[1]).toEqual(createInputFrame());
  });

  it('keeps bitfields as uint16 (bit 15) and clamps signed fields to int16', () => {
    const f = createInputFrame();
    f.buttons = 0x8000 | Btn.RS_HOLD | Btn.SHOOT;
    f.gFlags = 0xffff;
    f.gx = 40000;
    f.gz = -40000;
    const buf = new Int16Array(PACKED_FRAME_INTS);
    packFrames([f, f], buf, 0);
    const out: InputFrame[] = [];
    unpackFrames(buf, 0, out);
    expect(out[0]!.buttons).toBe(0x8000 | Btn.RS_HOLD | Btn.SHOOT);
    expect(out[0]!.gFlags).toBe(0xffff);
    expect(out[0]!.gx).toBe(32767);
    expect(out[0]!.gz).toBe(-32768);
    expect(out[1]!.gSlot).toBe(-1);
  });

  it('throws on a short buffer instead of silently truncating', () => {
    const buf = new Int16Array(PACKED_FRAME_INTS - 1);
    expect(() => packFrames([createInputFrame()], buf, 0)).toThrow(RangeError);
    expect(() => unpackFrames(buf, 0, [])).toThrow(RangeError);
    const ok = new Int16Array(PACKED_FRAME_INTS + 5);
    expect(() => packFrames([], ok, 6)).toThrow(RangeError);
    expect(packFrames([], ok, 5)).toBe(PACKED_FRAME_INTS);
  });
});
