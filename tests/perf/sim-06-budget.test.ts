/**
 * SIM-06 budget: dribbleTick < 0.05 ms per tick in every path (free dribble at a jog / sprint, a touch with the push
 * solver on every tick, the wind-up hold, a loose-ball scan, a pick-up, the stuck-ball squirt), and no allocation
 * except boxed doubles of the shared RNG / event calls on touch ticks.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker: Vitest's SSR transform
 * makes every imported binding a getter, which would measure the test runner instead of the module. Best of many short
 * batches so a busy machine does not make the check flaky. Allocation: min of four rounds after a long warm-up.
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
  const { dribbleTick } = await import(${imp('src/sim/players/possession.ts')});
  const { locomotionTick } = await import(${imp('src/sim/players/locomotion.ts')});
  const { ballTick } = await import(${imp('src/sim/ball/contact.ts')});
  const { createEventBuffer } = await import(${imp('src/sim/core/events.ts')});
  const ev = createEventBuffer();
  function world(seed) {
    const s = makeScenario({ seed, phase: 2 });
    for (let i = 0; i < 22; i++) { const p = s.players[i]; p.x = 48; p.z = -32 + i * 3; p.vx = 0; p.vz = 0; p.moveMode = 0; }
    const p = s.players[9]; p.x = -30; p.z = 0; p.fx = 1; p.fz = 0;
    Object.assign(s.ball, { x: -29.5, y: 0.11, z: 0, px: -29.5, py: 0.11, pz: 0, vx: 0, vy: 0, vz: 0, grounded: 1, owner: 9, heldBy: -1 });
    return s;
  }
  const out = { us: {}, alloc: {}, touches: {} };
  // advance = 1: the world moves (SIM-04 locomotion + SIM-02 ball) between the timed dribbleTick calls; 0: a static
  // state that the prep puts back each tick (the same path every tick). Allocation is measured on a static loop
  // (prep + dribbleTick only), so it is SIM-06's own; for the advancing cases it is informational.
  function measure(name, s, prep, advance) {
    let touches = 0;
    const step = () => { s.tick++; ev.begin(s.tick); if (advance) { locomotionTick(s, ev); ballTick(s, ev); } prep(s); };
    for (let i = 0; i < 6000; i++) { step(); dribbleTick(s, ev); }
    let best = Infinity;
    for (let b = 0; b < 30; b++) {
      let acc = 0;
      for (let i = 0; i < 300; i++) {
        step();
        const t0 = performance.now(); dribbleTick(s, ev); acc += performance.now() - t0;
        for (let k = 0; k < ev.count; k++) if (ev.get(k).type === 0) touches++;
      }
      best = Math.min(best, acc / 300);
    }
    out.us[name] = best * 1000;
    out.touches[name] = touches / 9000;
    const st = () => { s.tick++; ev.begin(s.tick); prep(s); dribbleTick(s, ev); };
    for (let i = 0; i < 20000; i++) st();
    let bestA = Infinity;
    for (let r = 0; r < 4; r++) {
      globalThis.gc();
      const h0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < 40000; i++) st();
      bestA = Math.min(bestA, (process.memoryUsage().heapUsed - h0) / 40000);
    }
    out.alloc[name] = bestA;
  }
  const lap = (s) => { const p = s.players[9]; if (p.x > 40) { p.x = -40; s.ball.x = -39.5; s.ball.z = p.z; s.ball.owner = 9; } };
  { const s = world(1); measure('jog', s, (s) => { const p = s.players[9]; p.moveMode = 1; p.ix = 1; p.iz = 0; p.wantSprint = 0; lap(s); }, 1); }
  { const s = world(2); measure('sprint', s, (s) => { const p = s.players[9]; p.moveMode = 1; p.ix = 1; p.iz = 0; p.wantSprint = 1; lap(s); }, 1); }
  { const s = world(8); measure('ownerNoTouch', s, (s) => {
      const p = s.players[9]; p.moveMode = 1; p.ix = 1; p.iz = 0; p.wantSprint = 0; p.vx = 5; p.vz = 0; p.touchCd = 5;
      s.ball.owner = 9; s.ball.x = p.x + 0.6; s.ball.z = p.z; s.ball.vx = 5; s.ball.vz = 0; }, 0); }
  { const s = world(9); measure('ownerOutOfReach', s, (s) => {
      const p = s.players[9]; p.moveMode = 1; p.ix = 1; p.iz = 0; p.wantSprint = 1; p.vx = 8; p.vz = 0;
      s.ball.owner = 9; s.ball.x = p.x + 2.2; s.ball.z = p.z; s.ball.vx = 9; s.ball.vz = 0; }, 0); }
  { const s = world(3); measure('touchEveryTick', s, (s) => {
      const p = s.players[9]; p.moveMode = 1; p.ix = 1; p.iz = 0.3; p.wantSprint = 1; p.touchCd = 0; p.vx = 6; p.vz = 0;
      s.ball.x = p.x + 0.6; s.ball.z = p.z + 0.1; s.ball.vx = 4; s.ball.vz = 0; s.ball.owner = 9; }, 0); }
  { const s = world(4); measure('windupHold', s, (s) => {
      const p = s.players[9]; p.act = 1; p.actDur = 1e6; p.actContact = 1e6; p.actDone = 0; s.ball.owner = 9; s.ball.x = p.x + 1; s.ball.z = p.z; }, 0); }
  { const s = world(5); s.ball.owner = -1;
    for (let i = 0; i < 22; i++) { const q = s.players[i]; q.x = -40 + (i * 37) % 80; q.z = -30 + (i * 23) % 60; }
    measure('looseScan', s, (s) => { s.ball.owner = -1; s.ball.x = 0.3; s.ball.z = 0.2; s.ball.vx = 2; s.ball.vz = 0; s.ball.idleT = 0; }, 0); }
  { const s = world(6); s.ball.owner = -1; const o = s.players[15]; o.x = 0; o.z = 0;
    measure('pickUp', s, (s) => { s.ball.owner = -1; s.ball.x = 0.5; s.ball.z = 0; s.ball.vx = -2; s.ball.vz = 0; s.ball.lastKickTick = -100; o.noTouchT = 0; }, 0); }
  { const s = world(7); s.ball.owner = -1; const a = s.players[7], b = s.players[16];
    a.x = -0.45; a.z = 0; a.stunT = 1e9; b.x = 0.45; b.z = 0; b.stunT = 1e9; s.players[9].x = -20;
    measure('squirt', s, (s) => { s.ball.owner = -1; s.ball.x = 0; s.ball.z = 0; s.ball.vx = 0; s.ball.vz = 0; s.ball.idleT = 100; }, 0); }
  console.log(JSON.stringify(out));
`;

const CASES = ['jog', 'sprint', 'ownerNoTouch', 'ownerOutOfReach', 'touchEveryTick', 'windupHold', 'looseScan', 'pickUp', 'squirt'] as const;

describe('SIM-06 budget', () => {
  const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { us: Record<string, number>; alloc: Record<string, number>; touches: Record<string, number> }
    : null;
  if (res) console.log(`SIM-06 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  for (const name of CASES) {
    it(`dribbleTick < 0.05 ms per tick: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(50);
    });
  }

  it('the measured paths really run (touches on touch ticks, none in the scans)', () => {
    expect(res!.touches.touchEveryTick).toBeGreaterThan(0.99);
    expect(res!.touches.jog).toBeGreaterThan(0.02);
    expect(res!.touches.looseScan).toBe(0);
  });

  it('no allocation per tick off touch ticks; a touch allocates only boxed doubles of the shared RNG / event calls', () => {
    for (const name of ['ownerNoTouch', 'ownerOutOfReach', 'windupHold', 'looseScan', 'squirt'] as const) {
      expect(res!.alloc[name]!, name).toBeLessThan(1);
    }
    // A touch: rngRange's double result and the KICK event's double arguments may be boxed by V8 when it does not inline
    // those calls (FND-03 interfaces): bounded per touch (a jog touches about once per touchIntervalJog ticks).
    expect(res!.alloc.touchEveryTick!).toBeLessThan(128);
    expect(res!.alloc.pickUp!).toBeLessThan(128);
  });
});
