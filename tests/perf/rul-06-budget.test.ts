/**
 * RUL-06 budget: the per-tick work of a penalty (penaltyTick, which RUL-01 calls every PENALTY tick, plus penaltyInput
 * for all four controllers, which SIM-15 calls) costs well under 2 us per tick and allocates nothing in its steady
 * paths: the setup walk (before ready), and the wait with a taker aiming with the stick while the keeper moves along
 * his line and flicks a dive every tick.
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
  const { penaltyScenario, untilReady } = await import(${imp('tests/scenario/rul-06-helpers.ts')});
  const { penaltyTick, penaltyInput } = await import(${imp('src/sim/rules/penalty.ts')});
  const { createInputFrame } = await import(${imp('src/contracts/input.ts')});
  const ev = { emit() {} };
  const RS_FLICK = 1 << 8;
  const out = { ready: 0, usWait: 0, usSetup: 0, allocWait: 0, allocSetup: 0, phase: 0, walking: 0 };
  const { s } = penaltyScenario({ team: 0, dir: 1, seed: 5, humans: [{ side: 0 }, { side: 1 }] });
  untilReady(s);
  out.ready = s.match.restart.ready;
  const r = s.match.restart;
  const f = createInputFrame();
  f.mx = 110; f.mz = 30; f.ax = 40; f.az = -90; f.buttons = RS_FLICK;
  const c0 = s.ctrl[0], c1 = s.ctrl[1];
  let i = 0;
  const waitTick = () => {
    s.tick++;
    i++;
    c0.mx = 0.85; c0.mz = (i & 1) === 0 ? 0.2 : -0.25; c0.buttons = 0; c0.prevButtons = 0;
    c1.mx = 0; c1.mz = (i & 2) === 0 ? 0.9 : -0.9; c1.buttons = RS_FLICK; c1.prevButtons = 0;
    for (let c = 0; c < 4; c++) penaltyInput(s, c, f, ev);
    penaltyTick(s, ev);
  };
  const setupTick = () => {
    s.tick++;
    i++;
    const p = s.players[r.taker];
    p.x = 30 + (i & 7); p.z = 10; // far from his spot: he walks
    for (let c = 0; c < 4; c++) penaltyInput(s, c, f, ev);
    penaltyTick(s, ev);
  };
  const measure = (fn) => {
    for (let k = 0; k < 200000; k++) fn();
    let best = Infinity;
    for (let b = 0; b < 30; b++) {
      const t0 = performance.now();
      for (let k = 0; k < 5000; k++) fn();
      best = Math.min(best, (performance.now() - t0) / 5000);
    }
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    const n = 200000;
    for (let k = 0; k < n; k++) fn();
    return { us: best * 1000, alloc: (process.memoryUsage().heapUsed - h0) / n };
  };
  const w = measure(waitTick);
  out.usWait = w.us; out.allocWait = w.alloc;
  r.ready = 0;
  s.players[r.taker].act = 0; // ActionKind.NONE: free to walk (before ready he is not yet in SET_PIECE)
  const st = measure(setupTick);
  out.walking = s.players[r.taker].moveMode === 2 ? 1 : 0; // MoveMode.ARRIVE
  out.usSetup = st.us; out.allocSetup = st.alloc;
  out.phase = s.match.phase;
  console.log(JSON.stringify(out));
`;

describe('RUL-06 budget', () => {
  const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok ? JSON.parse(r.stdout.trim().split('\n').pop()!) as {
    ready: number; usWait: number; usSetup: number; allocWait: number; allocSetup: number; phase: number; walking: number;
  } : null;
  if (res) console.log(`RUL-06 probe: ${JSON.stringify(res)}`);

  it('probe ran a penalty to ready and stayed in it', () => {
    expect(r.status, r.stderr).toBe(0);
    expect(res!.ready).toBe(1);
    expect(res!.phase).toBe(7); // MatchPhase.PENALTY: nothing kicked
    expect(res!.walking).toBe(1); // the setup path really walked the taker
  });

  it('penaltyTick + penaltyInput x4 < 2 us per tick (wait with aiming / keeper input, and the setup walk)', () => {
    expect(res).not.toBeNull();
    expect(res!.usWait).toBeLessThan(2);
    expect(res!.usSetup).toBeLessThan(2);
  });

  it('per-tick paths allocate nothing', () => {
    expect(res).not.toBeNull();
    expect(res!.allocWait).toBeGreaterThanOrEqual(-1);
    expect(res!.allocWait).toBeLessThan(2);
    expect(res!.allocSetup).toBeGreaterThanOrEqual(-1);
    expect(res!.allocSetup).toBeLessThan(2);
  });
});
