/**
 * RUL-08 budget: offsideTick costs well under a microsecond-scale budget per tick and allocates nothing, both on
 * a kick tick (snapshot over 22 players) and on an idle tick with flags set (challenge records + receiver check).
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
  const { makeScenario } = await import(${imp('tests/harness/scenario.ts')});
  const { offsideTick } = await import(${imp('src/sim/rules/offside.ts')});
  const ev = { emit() {} };
  const s = makeScenario({ phase: 2 });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i];
    p.x = -45 + ((i * 37) % 90); p.z = -30 + ((i * 23) % 60);
    p.vx = ((i % 5) - 2) * 1.5; p.vz = ((i % 3) - 1) * 2;
  }
  // Team 0 attacks +x; a few attackers deep in the opponents' half so the snapshot flags someone.
  s.players[9].x = 48; s.players[10].x = 46;
  const b = s.ball;
  b.x = 0; b.z = 0; b.px = 0; b.owner = -1; b.passTarget = -1;
  for (let i = 0; i < 4; i++) { const c = s.match.challenges[i]; c.active = 1; c.tackler = 12 + i; c.victim = 3; c.tick = 1; }
  const kickTick = () => {
    s.tick++;
    b.lastKickTick = s.tick; b.lastKickBy = 5; b.lastKickTeam = 0; b.lastKickKind = 1;
    b.lastTouch = 5; b.lastTouchTeam = 0; b.lastTouchTick = s.tick;
    offsideTick(s, ev);
  };
  const idleTick = () => { s.tick++; offsideTick(s, ev); };
  const out = { usKick: 0, usIdle: 0, allocKick: 0, allocIdle: 0, flags: 0 };
  for (let i = 0; i < 20000; i++) { kickTick(); idleTick(); }
  out.flags = s.match.offside.flags;
  let bestK = Infinity, bestI = Infinity;
  for (let r = 0; r < 40; r++) {
    let t0 = performance.now();
    for (let i = 0; i < 2000; i++) kickTick();
    bestK = Math.min(bestK, (performance.now() - t0) / 2000);
    kickTick();
    t0 = performance.now();
    for (let i = 0; i < 2000; i++) idleTick();
    bestI = Math.min(bestI, (performance.now() - t0) / 2000);
  }
  out.usKick = bestK * 1000; out.usIdle = bestI * 1000;
  globalThis.gc();
  let h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100000; i++) kickTick();
  out.allocKick = (process.memoryUsage().heapUsed - h0) / 100000;
  kickTick();
  globalThis.gc();
  h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100000; i++) idleTick();
  out.allocIdle = (process.memoryUsage().heapUsed - h0) / 100000;
  out.flags = s.match.offside.flags;
  console.log(JSON.stringify(out));
`;

describe('RUL-08 budget', () => {
  const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { usKick: number; usIdle: number; allocKick: number; allocIdle: number; flags: number }
    : null;
  if (res) console.log(`RUL-08 probe: ${JSON.stringify(res)}`);

  it('probe ran and the snapshot flagged the advanced attackers', () => {
    expect(r.status, r.stderr).toBe(0);
    expect(res!.flags & ((1 << 9) | (1 << 10))).toBe((1 << 9) | (1 << 10));
  });

  it('offsideTick < 5 us per tick on a kick tick and with flags set', () => {
    expect(res).not.toBeNull();
    expect(res!.usKick).toBeLessThan(5);
    expect(res!.usIdle).toBeLessThan(5);
  });

  it('offsideTick allocates nothing per tick', () => {
    expect(res).not.toBeNull();
    expect(res!.allocKick).toBeLessThan(2);
    expect(res!.allocIdle).toBeLessThan(2);
  });
});
