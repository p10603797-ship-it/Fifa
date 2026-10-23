/**
 * [GKP-03] Budget: the come-out brain (keeperComeOut) for one keeper, in its most expensive situations (a loose ball
 * racing into the box with players around it; a rush in progress; a cross being planned; a one-on-one), plus the
 * GK_RUSH handler, stays far below the sim budget (2.5 ms per tick for everything), and allocates nothing of its own
 * per tick. The cross case is dominated by SIM-01 predictBall (90 ticks of ball physics) and only runs while an
 * airborne ball heads for his claim zone and he is free.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker (whose module transform
 * makes hot loops several times slower than the shipped bundle). Best of many short batches so a busy machine does
 * not make the check flaky.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const imp = (p: string): string => JSON.stringify(join(ROOT, p));

const PROBE = `
  await import(${imp('tools/lib/env.ts')});
  await import(${imp('src/sim/actions/dispatch.ts')});
  const { scene } = await import(${imp('tests/scenario/gkp-03-helpers.ts')});
  const { keeperComeOut } = await import(${imp('src/sim/keeper/sweeper.ts')});
  const { clearAction } = await import(${imp('src/sim/actions/dispatch.ts')});
  const { assignChaser } = await import(${imp('src/ai/steer.ts')});
  const { actionsTick } = await import(${imp('src/sim/actions/dispatch.ts')});
  const ev = { emit() {} };
  const out = { us: {}, alloc: {} };
  const builds = {
    // Loose ball running into the box, 4 defenders and 4 attackers around it: full race with pruned estimates.
    race: () => {
      const sc = scene({ seed: 3 });
      sc.loose(15, 3, -6, -0.5);
      for (let n = 2; n <= 5; n++) sc.place(sc.mate(n), 6 + n * 3, -8 + n * 3);
      for (let n = 6; n <= 9; n++) sc.place(sc.att(n), 20 + n, -8 + (n - 5) * 4, -5, 0);
      return { sc, reset: true };
    },
    // The same with the AI rush in progress (keep re-assessment + the GK_RUSH handler each tick).
    rushing: () => {
      const sc = scene({ seed: 3 });
      sc.loose(16, 3, -6, -0.5);
      for (let n = 2; n <= 5; n++) sc.place(sc.mate(n), 14 + n * 3, -8 + n * 3);
      for (let n = 6; n <= 9; n++) sc.place(sc.att(n), 20 + n, -8 + (n - 5) * 4, -5, 0);
      return { sc, reset: false, handler: true };
    },
    // A cross on its way into the box from the wing: claim planning (90-tick prediction) when no claim is possible.
    cross: () => {
      const sc = scene({ seed: 3, ku: 1 });
      sc.loose(14, 30, -1, -14, { y: 0.5, vy: 14, kind: 7 });
      return { sc, reset: true };
    },
    oneOnOne: () => {
      const sc = scene({ seed: 3 });
      sc.place(20, 15, 2, -5, 0);
      sc.owned(20, -0.8, 0, -5, 0);
      for (let n = 2; n <= 5; n++) sc.place(sc.mate(n), 22 + n * 3, -8 + n * 3);
      return { sc, reset: true };
    },
    far: () => {
      const sc = scene({ seed: 3 });
      sc.loose(70, 3, 2, 0);
      return { sc, reset: true };
    },
  };
  for (const [name, build] of Object.entries(builds)) {
    const { sc, reset, handler } = build();
    const s = sc.s;
    const k = s.players[sc.keeper];
    // Freeze the situation: the ball and players do not move between calls (worst case repeats every tick).
    const tick = () => {
      if (reset && k.act !== 0) clearAction(k);
      s.tick++;
      assignChaser(s, sc.team, ev);
      keeperComeOut(s, sc.team, ev);
      if (handler) { actionsTick(s, ev); if (k.act !== 20) throw new Error('rush ended in ' + name); k.actT = 1; }
    };
    for (let i = 0; i < 3000; i++) tick();
    let best = Infinity;
    for (let b = 0; b < 30; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 300; i++) tick();
      best = Math.min(best, (performance.now() - t0) / 300);
    }
    // Subtract the chaser assignment (TAI-07's own cost, measured alone).
    const chaserOnly = () => { s.tick++; assignChaser(s, sc.team, ev); };
    for (let i = 0; i < 2000; i++) chaserOnly();
    let bestC = Infinity;
    for (let b = 0; b < 30; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 300; i++) chaserOnly();
      bestC = Math.min(bestC, (performance.now() - t0) / 300);
    }
    out.us[name] = Math.max(0, best - bestC) * 1000;
    // Allocation of GKP-03's own code (no TAI-07 chaser pass; long warm-up so JIT compilation is not counted).
    const own = () => {
      if (reset && k.act !== 0) clearAction(k);
      s.tick++;
      keeperComeOut(s, sc.team, ev);
      if (handler) { actionsTick(s, ev); k.actT = 1; }
    };
    for (let i = 0; i < 30000; i++) own();
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 60000; i++) own();
    out.alloc[name] = (process.memoryUsage().heapUsed - h0) / 60000;
  }
  console.log(JSON.stringify(out));
`;

describe('GKP-03 budget', () => {
  // [TUN-7S] --single-threaded (tests/perf/qf-7r-alloc-flags.ts): compiles synchronously, so the measured bytes do not
  // depend on CPU load (under load the optimised code arrived later and the window ran boxing baseline code).
  const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { us: Record<string, number>; alloc: Record<string, number> } : null;
  if (res) console.log(`GKP-03 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  for (const name of ['race', 'rushing', 'oneOnOne', 'far']) {
    it(`keeperComeOut (+ GK_RUSH handler) < 0.06 ms per keeper per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(60);
    });
  }

  it('claim planning for a cross (one 90-tick SIM-01 prediction per tick while it flies) < 0.1 ms', () => {
    expect(res).not.toBeNull();
    expect(res!.us.cross!).toBeLessThan(100);
  });

  it('allocates nothing of its own per tick; only V8 number boxing inside its dependency calls', () => {
    expect(res).not.toBeNull();
    // No dependency calls on these paths: nothing at all.
    expect(res!.alloc.oneOnOne!).toBeLessThan(2);
    expect(res!.alloc.far!).toBeLessThan(2);
    // SIM-04 ticksToReach and TAI-07 estimateIntercept return doubles that V8 boxes (tens of bytes per call); any
    // source-level allocation per candidate (an object literal, closure or array) would blow well past this.
    for (const name of ['race', 'rushing', 'cross']) expect(res!.alloc[name]!, name).toBeLessThan(1024);
  });
});
