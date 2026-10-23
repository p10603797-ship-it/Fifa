/**
 * RUL-09 budget: foulsTick / classifyChallenge cost and allocation per tick, measured in a plain Node child process
 * (node --import tsx), not inside the Vitest worker (its SSR transform turns imported bindings into getters).
 * Cases: idle tick (no records), four clean ball-first records, four man-first records classified with RNG rolls and
 * DOGSO checks (classifyChallenge x 4), and a tick with an advantage running (possession checks, cancel input).
 * fillOnly (the probe's own record writes) is reported for diagnosis only.
 * Allocation per case is the best of three rounds after a long warm-up (JIT tier-ups land in the warm-up).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const imp = (p: string): string => JSON.stringify(join(ROOT, p));

const PROBE = `
  await import(${imp('tools/lib/env.ts')});
  await import(${imp('src/sim/actions/dispatch.ts')});
  const { makeScenario } = await import(${imp('tests/harness/scenario.ts')});
  const { foulsTick, classifyChallenge } = await import(${imp('src/sim/rules/fouls.ts')});
  const ev = { emit() {} };
  const s = makeScenario({ phase: 2, humans: 1 });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i];
    p.x = -45 + ((i * 37) % 90); p.z = -30 + ((i * 23) % 60);
  }
  s.players[3].x = 30; s.players[3].z = 0;
  const b = s.ball;
  b.owner = 3; b.x = 30.4; b.z = 0; b.lastTouch = 3; b.lastTouchTeam = 0;
  const recs = s.match.challenges;
  const fill = (bf) => {
    for (let i = 0; i < 4; i++) {
      const r = recs[i];
      r.active = 1; r.tackler = 12 + i; r.victim = 3; r.kind = i; r.ballFirst = bf; r.fromBehind = (i - 1.5) / 1.5;
      r.closingSpeed = 1 + 0.5 * i; r.x = 30; r.z = 0; r.tick = s.tick; // [QF-1] never reckless (clean case stays clean)
    }
  };
  const idle = () => { s.tick++; foulsTick(s, ev); };
  const clean = () => { s.tick++; fill(1); foulsTick(s, ev); };
  // classifyChallenge does not modify the records: fill them once (record writes are the probe's, not RUL-09's).
  const classify = () => { s.tick++; let n = 0; for (let i = 0; i < 4; i++) n += classifyChallenge(s, recs[i]); return n; };
  const a = s.match.advantage;
  const adv = () => {
    s.tick++;
    a.active = 1; a.team = 0; a.offender = 13; a.victim = 3; a.x = 30; a.z = 0; a.startTick = s.tick - 10; a.card = 0; a.penalty = 0;
    foulsTick(s, ev);
  };
  const fillOnly = () => { s.tick++; fill(0); for (let i = 0; i < 4; i++) recs[i].active = 0; };
  const cases = { idle, clean, fillOnly, adv };
  const cases2 = { classify };
  const out = {};
  const runCase = (name, fn) => {
    for (let i = 0; i < 100000; i++) fn();
    let best = Infinity;
    for (let r = 0; r < 30; r++) {
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) fn();
      best = Math.min(best, (performance.now() - t0) / 2000);
    }
    // Allocation: best of three rounds (a round can catch a late JIT tier-up / field-representation change).
    let alloc = Infinity;
    for (let r = 0; r < 3; r++) {
      globalThis.gc();
      const h0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < 50000; i++) fn();
      alloc = Math.min(alloc, (process.memoryUsage().heapUsed - h0) / 50000);
    }
    out[name] = { us: best * 1000, alloc };
  };
  for (const [name, fn] of Object.entries(cases)) runCase(name, fn);
  fill(0);
  for (const [name, fn] of Object.entries(cases2)) runCase(name, fn);
  out.phase = s.match.phase; out.advActive = a.active;
  console.log(JSON.stringify(out));
`;

describe('RUL-09 budget', () => {
  // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  type Case = { us: number; alloc: number };
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { idle: Case; clean: Case; classify: Case; adv: Case; phase: number; advActive: number }
    : null;
  if (res) console.log(`RUL-09 probe: ${JSON.stringify(res)}`);

  it('probe ran; play stayed live and the advantage case kept the advantage running', () => {
    expect(r.status, r.stderr).toBe(0);
    expect(res!.phase).toBe(2);
    expect(res!.advActive).toBe(1);
  });

  it('foulsTick / classifyChallenge cost well under 5 us per tick', () => {
    for (const k of ['idle', 'clean', 'classify', 'adv'] as const) expect(res![k].us, k).toBeLessThan(5);
  });

  it('allocates nothing on the every-tick paths (idle, clean records, advantage running)', () => {
    for (const k of ['idle', 'clean', 'adv'] as const) expect(res![k].alloc, k).toBeLessThan(2);
  });

  it('classification ticks allocate at most one boxed RNG float per roll (4 rolls here)', () => {
    // RUL-09 code itself allocates nothing (no double crosses its own calls). The shared RNG (FND-03 rngInt -> rngFloat)
    // returns a float internally; when V8 inlines rngInt into a large caller but runs out of inlining budget for
    // rngFloat, that float is boxed (16 bytes) — seen in about one run in four (--trace-turbo-inlining). Bounded here.
    expect(res!.classify.alloc).toBeLessThan(4 * 16 + 2);
  });
});
