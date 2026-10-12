/**
 * FND-03: determinism smoke tests over the real step() pipeline (brief section 4 rule 1).
 * Same seed + same input stream => identical hashState every tick, also across snapshot/restore and with the
 * copyState interpolation pattern of the app loop. Many sim modules are still Wave 0 baselines; the pipeline
 * must run without throwing regardless.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_HUMANS } from '../../src/contracts/constants';
import { AssistLevel, AutoSwitch, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { Btn, createInputFrame, INPUT_FIELDS, type InputFrame } from '../../src/contracts/input';
import { createMatchConfig, type MatchConfig, type SimState } from '../../src/contracts/state';
import { cloneState, copyState, diffState } from '../../src/sim/core/clone';
import { createEventBuffer, type EventBufferImpl } from '../../src/sim/core/events';
import { hashState, hashValue } from '../../src/sim/core/hash';
import { deserializeState, packFrames, PACKED_FRAME_INTS, serializeState, unpackFrames } from '../../src/sim/core/serialize';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

const TICKS = 1200;

/** Deterministic scripted input stream: stick held for runs of ticks, button taps and holds, occasional skills. */
function scriptedFrames(seed: number, ticks: number): InputFrame[][] {
  let x = seed >>> 0;
  const rnd = (): number => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
  const out: InputFrame[][] = [];
  const cur = [createInputFrame(), createInputFrame()];
  for (let t = 0; t < ticks; t++) {
    const frames: InputFrame[] = [];
    for (let h = 0; h < MAX_HUMANS; h++) {
      const c = cur[h]!;
      if (rnd() < 0.05) {
        const a = rnd() * 2 * Math.PI;
        const m = rnd() < 0.2 ? 0 : 127;
        c.mx = Math.round(Math.cos(a) * m);
        c.mz = Math.round(Math.sin(a) * m);
      }
      if (rnd() < 0.08) c.buttons ^= 1 << Math.floor(rnd() * 8); // toggle a pad button (press or release)
      const f = createInputFrame();
      Object.assign(f, c);
      f.buttons = c.buttons | (rnd() < 0.01 ? Btn.RS_FLICK : 0);
      if (rnd() < 0.01) { f.ax = Math.floor(rnd() * 255) - 127; f.az = Math.floor(rnd() * 255) - 127; }
      if (rnd() < 0.005) f.skill = 1 + Math.floor(rnd() * 5);
      if (rnd() < 0.003) f.power = Math.floor(rnd() * 128);
      frames.push(f);
    }
    out.push(frames);
  }
  return out;
}

const NEUTRAL = [createInputFrame(), createInputFrame()];

interface RunResult { hashes: number[]; eventHashes: number[]; final: SimState }

/** Hash of this tick's events (type, tick and payload in emit order). */
function eventsHash(ev: EventBufferImpl): number {
  return hashValue(ev.toArray());
}

function run(config: MatchConfig, inputs: InputFrame[][] | null, ticks: number, prep?: (s: SimState) => void): RunResult {
  const s = initMatch(config);
  prep?.(s);
  const ev = createEventBuffer();
  const hashes: number[] = [];
  const eventHashes: number[] = [];
  for (let t = 0; t < ticks; t++) {
    step(s, inputs ? inputs[t]! : NEUTRAL, ev);
    hashes.push(hashState(s));
    eventHashes.push(eventsHash(ev));
  }
  return { hashes, eventHashes, final: s };
}

function twoHumans(): MatchConfig {
  const c = createMatchConfig();
  c.seed = 0xc0ffee;
  c.humans = [
    { kind: ControllerKind.HUMAN, side: 0, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 },
    { kind: ControllerKind.HUMAN, side: 1, assist: AssistLevel.MANUAL, autoSwitch: AutoSwitch.AUTO, fastPower: 1 },
  ];
  return c;
}

const forceInPlay = (s: SimState): void => { s.match.phase = MatchPhase.IN_PLAY; };

describe('determinism smoke: step() pipeline', () => {
  it('neutral frames: two runs from scratch give identical hashes every tick', () => {
    const a = run(createMatchConfig(), null, TICKS);
    const b = run(createMatchConfig(), null, TICKS);
    expect(a.final.tick).toBe(TICKS);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.eventHashes).toEqual(a.eventHashes);
    expect(diffState(a.final, b.final)).toBeNull();
  });

  it('scripted input stream: two runs give identical hashes every tick', () => {
    const inputs = scriptedFrames(12345, TICKS);
    const a = run(createMatchConfig(), inputs, TICKS);
    const b = run(createMatchConfig(), scriptedFrames(12345, TICKS), TICKS);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.eventHashes).toEqual(a.eventHashes);
    // The inputs actually reach the sim (otherwise the test proves nothing).
    const neutral = run(createMatchConfig(), null, TICKS);
    expect(a.hashes[TICKS - 1]).not.toBe(neutral.hashes[TICKS - 1]);
  });

  it('two humans, forced IN_PLAY, scripted inputs: identical runs', () => {
    const inputs = scriptedFrames(777, TICKS);
    const a = run(twoHumans(), inputs, TICKS, forceInPlay);
    const b = run(twoHumans(), inputs, TICKS, forceInPlay);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.eventHashes).toEqual(a.eventHashes);
  });

  it('different seeds give different states', () => {
    const c1 = createMatchConfig();
    const c2 = createMatchConfig();
    c2.seed = 2;
    expect(hashState(initMatch(c1))).not.toBe(hashState(initMatch(c2)));
  });

  it('snapshot / restore mid-match (serialize and clone) continues bit-identically', () => {
    const inputs = scriptedFrames(99, TICKS);
    const full = run(createMatchConfig(), inputs, TICKS);
    const half = TICKS / 2;
    const s = initMatch(createMatchConfig());
    const ev = createEventBuffer();
    for (let t = 0; t < half; t++) step(s, inputs[t]!, ev);
    const restored = deserializeState(serializeState(s));
    const cloned = cloneState(s);
    expect(hashState(restored)).toBe(full.hashes[half - 1]);
    for (let t = half; t < TICKS; t++) {
      step(restored, inputs[t]!, ev);
      expect(hashState(restored)).toBe(full.hashes[t]);
      step(cloned, inputs[t]!, ev);
      expect(hashState(cloned)).toBe(full.hashes[t]);
    }
    // The snapshot was not mutated by the continuation of the original (no shared references).
    for (let t = half; t < TICKS; t++) step(s, inputs[t]!, ev);
    expect(hashState(s)).toBe(full.hashes[TICKS - 1]);
  });

  it('app-loop pattern (copyState into prev before each tick) does not disturb determinism', () => {
    const inputs = scriptedFrames(4242, TICKS);
    const ref = run(createMatchConfig(), inputs, TICKS);
    const s = initMatch(createMatchConfig());
    const prev = cloneState(s);
    const ev = createEventBuffer();
    let prevHash = hashState(s);
    for (let t = 0; t < TICKS; t++) {
      copyState(prev, s);
      expect(hashState(prev)).toBe(prevHash);
      step(s, inputs[t]!, ev);
      prevHash = hashState(s);
      expect(prevHash).toBe(ref.hashes[t]);
    }
  });

  it('inputs replayed through packFrames/unpackFrames reproduce the run (replay / network path)', () => {
    const inputs = scriptedFrames(31337, TICKS);
    const ref = run(createMatchConfig(), inputs, TICKS);
    const buf = new Int16Array(PACKED_FRAME_INTS * TICKS);
    let off = 0;
    for (let t = 0; t < TICKS; t++) off += packFrames(inputs[t]!, buf, off);
    const s = initMatch(createMatchConfig());
    const ev = createEventBuffer();
    const frames: InputFrame[] = [];
    off = 0;
    for (let t = 0; t < TICKS; t++) {
      off += unpackFrames(buf, off, frames);
      step(s, frames, ev);
      expect(hashState(s)).toBe(ref.hashes[t]);
    }
    expect(INPUT_FIELDS.length * MAX_HUMANS).toBe(PACKED_FRAME_INTS);
  });
});

describe('determinism rules in FND-03 sources', () => {
  it('core modules use no non-deterministic Math, clocks, Map/Set or randomness', () => {
    const files = ['rng', 'dmath', 'vec', 'hash', 'clone', 'serialize'].map((f) => `src/sim/core/${f}.ts`);
    const banned = /Math\.(random|sin|cos|tan|asin|acos|atan|atan2|pow|exp|expm1|log|log2|log10|log1p|sinh|cosh|tanh|cbrt|hypot)\b|Date\.now|new Date|performance\.|new Map|new Set/;
    for (const f of files) {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(banned.exec(src)?.[0] ?? null, f).toBeNull();
    }
  });
});
