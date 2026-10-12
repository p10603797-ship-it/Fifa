/**
 * REVIEW of FND-03 (independent reviewer): determinism beyond "same process, run twice".
 *  1. Cross-engine: the same probe (dmath sweep, rng streams, hashState over a played match, snapshot text, packed
 *     inputs) run in a fresh Node (V8) process, in Bun (JavaScriptCore = Safari's engine) and in this already
 *     warmed-up test worker must produce identical bits. Bun is optional: the engine comparison is skipped
 *     when it is not installed (set BUN_BIN to point at it).
 *  2. No hidden module-level state: two matches stepped interleaved tick-by-tick hash exactly like the same matches
 *     run one after another.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { createInputFrame, type InputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const src = (p: string): string => JSON.stringify(join(ROOT, 'src', p));

/** Probe module: pure function of the code under test, prints one JSON line when run as a script. */
const PROBE = `
import { dsin, dcos, dtan, datan2, dasin, dacos, dexp, dlog, dpow, wrapAngle } from ${src('sim/core/dmath.ts')};
import { rngSeed, rngNext, rngGauss, rngFloat } from ${src('sim/core/rng.ts')};
import { rotateToward2, createV2 } from ${src('sim/core/vec.ts')};
import { hashState, hashValue } from ${src('sim/core/hash.ts')};
import { serializeState, packFrames, PACKED_FRAME_INTS } from ${src('sim/core/serialize.ts')};
import { createMatchConfig } from ${src('contracts/state.ts')};
import { createInputFrame } from ${src('contracts/input.ts')};
import { MatchPhase, ControllerKind, AssistLevel, AutoSwitch } from ${src('contracts/enums.ts')};
import { initMatch } from ${src('sim/init.ts')};
import { step } from ${src('sim/step.ts')};
import { createEventBuffer } from ${src('sim/core/events.ts')};

export function probe(): Record<string, number> {
  const out: Record<string, number> = {};
  let x = 12345 >>> 0;
  const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
  const vals: number[] = [];
  const o = createV2();
  for (let i = 0; i < 100000; i++) {
    const a = (rnd() - 0.5) * 2e4;
    vals.push(dsin(a), dcos(a), dtan(a), wrapAngle(a * 100));
    const y = (rnd() - 0.5) * 200, z = (rnd() - 0.5) * 200;
    vals.push(datan2(y, z), dasin(rnd() * 2 - 1), dacos(rnd() * 2 - 1));
    vals.push(dexp((rnd() - 0.5) * 1400), dlog(rnd() * 1e6 + 1e-300), dpow(rnd() * 10, (rnd() - 0.5) * 40),
      dpow(rnd() * 3, Math.floor(rnd() * 60) - 30));
    rotateToward2(o, y, z, z, -y + 1, rnd() * 0.3);
    vals.push(o.x, o.z);
  }
  out.dmath = hashValue(vals);
  const r = { a: 0, b: 0, c: 0, d: 0 };
  const rs: number[] = [];
  for (let seed = 0; seed < 50; seed++) { rngSeed(r, seed * 2654435761); for (let i = 0; i < 200; i++) rs.push(rngNext(r), rngGauss(r), rngFloat(r)); }
  out.rng = hashValue(rs);
  const c = createMatchConfig();
  c.seed = 0xdecafbad;
  c.humans = [
    { kind: ControllerKind.HUMAN, side: 0, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 },
    { kind: ControllerKind.HUMAN, side: 1, assist: AssistLevel.MANUAL, autoSwitch: AutoSwitch.AUTO, fastPower: 1 },
  ];
  const s = initMatch(c);
  s.match.phase = MatchPhase.IN_PLAY;
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const hs: number[] = [];
  const packed = new Int16Array(PACKED_FRAME_INTS * 1200);
  for (let t = 0; t < 1200; t++) {
    for (const f of frames) {
      if (rnd() < 0.05) { f.mx = Math.floor(rnd() * 255) - 127; f.mz = Math.floor(rnd() * 255) - 127; }
      if (rnd() < 0.08) f.buttons ^= 1 << Math.floor(rnd() * 8);
    }
    packFrames(frames, packed, t * PACKED_FRAME_INTS);
    step(s, frames, ev);
    hs.push(hashState(s));
  }
  out.sim = hashValue(hs);
  out.final = hashState(s);
  out.snapshot = hashValue(serializeState(s));
  out.packed = hashValue(packed);
  return out;
}

if ((globalThis as { process?: { argv?: string[] } }).process?.argv?.includes('--print')) console.log(JSON.stringify(probe()));
`;

function findBun(): string | null {
  const candidates = [process.env.BUN_BIN, 'bun', join(homedir(), '.bun/bin/bun')].filter((c): c is string => !!c);
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

function writeProbe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-fnd-03-'));
  const file = join(dir, 'probe.ts');
  writeFileSync(file, PROBE);
  return file;
}

function runProbe(cmd: string, args: string[]): Record<string, number> {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
  const line = r.stdout.trim().split('\n').pop()!;
  return JSON.parse(line) as Record<string, number>;
}

const BUN = findBun();
const TSX = existsSync(join(ROOT, 'node_modules/tsx')) ? 'tsx' : null;

describe('review FND-03 determinism: across engines and processes', () => {
  it.skipIf(TSX === null)('fresh Node process == this warmed-up worker (no dependence on prior module state)', async () => {
    const file = writeProbe();
    const fresh = runProbe(process.execPath, ['--import', 'tsx', file, '--print']);
    const mod = (await import(/* @vite-ignore */ file)) as { probe: () => Record<string, number> };
    // Warm this worker with unrelated work first so JIT tiers / module scratch differ from the fresh process.
    for (let i = 0; i < 3; i++) mod.probe();
    expect(mod.probe()).toEqual(fresh);
  }, 180_000);

  it.skipIf(BUN === null || TSX === null)('V8 (Node) and JavaScriptCore (Bun, the Safari engine) agree bit-for-bit', () => {
    const file = writeProbe();
    const v8 = runProbe(process.execPath, ['--import', 'tsx', file, '--print']);
    const jsc = runProbe(BUN!, [file, '--print']);
    expect(jsc).toEqual(v8);
  }, 180_000);
});

describe('review FND-03 determinism: no hidden module-level state across matches', () => {
  function frames(seed: number, ticks: number): InputFrame[][] {
    let x = seed >>> 0;
    const rnd = (): number => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
    const out: InputFrame[][] = [];
    const cur = [createInputFrame(), createInputFrame()];
    for (let t = 0; t < ticks; t++) {
      const fr: InputFrame[] = [];
      for (const c of cur) {
        if (rnd() < 0.05) { c.mx = Math.floor(rnd() * 255) - 127; c.mz = Math.floor(rnd() * 255) - 127; }
        if (rnd() < 0.08) c.buttons ^= 1 << Math.floor(rnd() * 8);
        const f = createInputFrame();
        Object.assign(f, c);
        fr.push(f);
      }
      out.push(fr);
    }
    return out;
  }
  const T = 900;
  const mk = (seed: number): SimState => {
    const c = createMatchConfig();
    c.seed = seed;
    const s = initMatch(c);
    s.match.phase = MatchPhase.IN_PLAY;
    return s;
  };

  it('two matches stepped interleaved tick-by-tick hash exactly like sequential runs', () => {
    const inA = frames(1, T);
    const inB = frames(2, T);
    const seq = (seed: number, inp: InputFrame[][]): number[] => {
      const s = mk(seed);
      const ev = createEventBuffer();
      const h: number[] = [];
      for (let t = 0; t < T; t++) { step(s, inp[t]!, ev); h.push(hashState(s)); }
      return h;
    };
    const a1 = seq(1, inA);
    const b1 = seq(2, inB);
    const sa = mk(1);
    const sb = mk(2);
    const ea = createEventBuffer();
    const eb = createEventBuffer();
    const a2: number[] = [];
    const b2: number[] = [];
    for (let t = 0; t < T; t++) {
      step(sa, inA[t]!, ea); a2.push(hashState(sa));
      step(sb, inB[t]!, eb); b2.push(hashState(sb));
    }
    expect(a2).toEqual(a1);
    expect(b2).toEqual(b1);
    expect(a1[T - 1]).not.toBe(b1[T - 1]);
  });
});
