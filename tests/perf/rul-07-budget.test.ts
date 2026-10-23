/**
 * RUL-07 budget: the per-tick work of the shoot-out (shootoutTick, which RUL-01 calls every SHOOT_OUT tick, plus
 * shootoutInput for all four controllers, which SIM-15 calls) costs well under 3 us averaged over whole kicks (setup,
 * aim with the timeouts and the forced kick, flight, result, next kick / new shoot-out); the steady per-tick paths
 * allocate nothing; the once-per-kick transitions stay within a small bound (rarely run code is not optimised by the
 * engine, which boxes its doubles).
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker (Vitest's SSR transform
 * turns imported bindings into getters and would measure the test runner). Best of many short batches.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const imp = (p: string): string => JSON.stringify(join(ROOT, p));

const PROBE = `
  await import(${imp('tools/lib/env.ts')});
  await import(${imp('src/sim/actions/dispatch.ts')});
  const { makeScenario, runUntil } = await import(${imp('tests/harness/scenario.ts')});
  const { shootoutStart, shootoutTick, shootoutInput, ShootoutSub } = await import(${imp('src/sim/rules/shootout.ts')});
  const { createInputFrame } = await import(${imp('src/contracts/input.ts')});
  const ev = { emit() {} };
  const f = createInputFrame();
  const s = makeScenario({ seed: 3, config: { mode: 4, startPhase: 14 } });
  runUntil(s, (st) => st.match.phase === 14, 400);
  const so = s.match.shootout;
  const out = { started: s.match.phase === 14 ? 1 : 0, us: 0, kicks: 0, restarts: 0, bytesPerKick: 0, allocAim: 0,
    allocFlight: 0, allocResult: 0 };
  // Whole flow: setup, aim (CPU timeout, Default, forced kick), flight, result, next kick; a new shoot-out at the end.
  const tick = () => {
    s.tick++;
    s.match.phaseT++;
    for (let c = 0; c < 4; c++) shootoutInput(s, c, f, ev);
    shootoutTick(s, ev);
    if (s.match.phase !== 14) { s.match.phase = 14; s.match.finished = 0; shootoutStart(s, ev); out.restarts++; }
  };
  for (let i = 0; i < 300000; i++) tick();
  let best = Infinity;
  for (let r = 0; r < 30; r++) {
    const t0 = performance.now();
    for (let i = 0; i < 5000; i++) tick();
    best = Math.min(best, (performance.now() - t0) / 5000);
  }
  out.us = best * 1000;
  let kicks = 0;
  const countKicks = () => { const t = so.taken[0] + so.taken[1]; return t; };
  let k0 = countKicks();
  globalThis.gc();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200000; i++) {
    tick();
    const k = countKicks();
    if (k !== k0) { kicks += k > k0 ? k - k0 : 1; k0 = k; }
  }
  out.kicks = kicks;
  out.bytesPerKick = (process.memoryUsage().heapUsed - h0) / kicks;
  // Steady state of each sub-state (per tick, no transitions): hold the sub-state by resetting its timer.
  const hold = (sub, n) => {
    for (let i = 0; i < 2000 && so.sub !== sub; i++) tick();
    const steady = () => { s.tick++; for (let c = 0; c < 4; c++) shootoutInput(s, c, f, ev); so.subT = 1; shootoutTick(s, ev); };
    if (sub === ShootoutSub.FLIGHT) { s.ball.y = 1.5; s.ball.vx = 0; s.ball.vy = 0; s.ball.vz = 0.01; s.ball.x = 0; s.ball.lastTouchTick = -1; }
    for (let i = 0; i < 20000; i++) steady();
    globalThis.gc();
    const g0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) steady();
    const a = (process.memoryUsage().heapUsed - g0) / n;
    return so.sub === sub ? a : -1;
  };
  out.allocAim = hold(ShootoutSub.AIM, 100000);
  out.allocFlight = hold(ShootoutSub.FLIGHT, 100000);
  out.allocResult = hold(ShootoutSub.RESULT, 100000);
  console.log(JSON.stringify(out));
`;

describe('RUL-07 budget', () => {
  // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok ? JSON.parse(r.stdout.trim().split('\n').pop()!) as {
    started: number; us: number; kicks: number; restarts: number; bytesPerKick: number; allocAim: number;
    allocFlight: number; allocResult: number;
  } : null;
  if (res) console.log(`RUL-07 probe: ${JSON.stringify(res)}`);

  it('probe ran through whole kicks and shoot-outs', () => {
    expect(r.status, r.stderr).toBe(0);
    expect(res!.started).toBe(1);
    expect(res!.restarts).toBeGreaterThan(0);
    expect(res!.kicks).toBeGreaterThan(100);
  });

  it('shootoutTick + shootoutInput x4 < 3 us per tick (whole flow)', () => {
    expect(res).not.toBeNull();
    expect(res!.us).toBeLessThan(3);
  });

  it('per-tick paths (aim, flight, result) allocate nothing', () => {
    expect(res).not.toBeNull();
    expect(res!.allocAim).toBeGreaterThanOrEqual(0);
    expect(res!.allocAim).toBeLessThan(2);
    expect(res!.allocFlight).toBeGreaterThanOrEqual(0);
    expect(res!.allocFlight).toBeLessThan(2);
    expect(res!.allocResult).toBeGreaterThanOrEqual(0);
    expect(res!.allocResult).toBeLessThan(2);
  });

  it('once-per-kick work (setup, safety-net kick, result) stays small (< 4 KB per kick incl. engine boxing)', () => {
    expect(res).not.toBeNull();
    expect(res!.bytesPerKick).toBeLessThan(4096);
  });
});
