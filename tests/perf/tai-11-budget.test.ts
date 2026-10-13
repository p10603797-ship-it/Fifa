/**
 * TAI-11 budget: cpuDefend < 0.03 ms per call and no source-level allocation per call.
 *
 * Measured in a plain Node child process (node --import tsx), not inside the Vitest worker (Vitest's SSR transform
 * turns every imported binding into a getter and would measure the test runner). Best of many short batches so a
 * busy machine does not make the check flaky. Scenarios cover the expensive paths: a carrier dribbling at the
 * defender with the ball exposed (tackle timing, careful prediction, slide checks, keeper-rush channel scan), the
 * player-choice evaluation on every call (10 SIM-04 ticksToReach estimates), an opponent pass in flight (two TAI-07
 * interception estimates) and a loose ball in our third (interception + clearance checks). Positions drift every call
 * so nothing is cached between calls.
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
  const { cpuDefend } = await import(${imp('src/ai/cpu/defending.ts')});
  const { clearInputFrame } = await import(${imp('src/contracts/input.ts')});
  const ev = { emit() {} };
  const D = 15, C = 9;
  const base = () => {
    const s = makeScenario({ phase: 2, humans: [{ side: 0, slot: C }], seed: 4 });
    for (let i = 0; i < 22; i++) { const p = s.players[i]; const k = i % 11; p.x = k === 0 ? (i < 11 ? -51 : 51) : (i < 11 ? -30 : 30) + (k % 4) * 4; p.z = -25 + k * 5; p.vx = 0; p.vz = 0; }
    s.ctrl[3].slot = D; s.players[D].ctrl = 3;
    return s;
  };
  const CASES = {
    carrierExposed: (s, k) => {
      const q = s.players[C], p = s.players[D], b = s.ball;
      q.x = 30 + (k % 50) * 0.01; q.z = 1; q.vx = 6; q.vz = 0.5; q.fx = 1; q.fz = 0;
      p.x = q.x + 2.6; p.z = 0.5; p.vx = -1; p.vz = 0; p.act = 0;
      b.owner = C; b.heldBy = -1; b.x = q.x + 1.1; b.z = q.z; b.vx = 7; b.vz = 0; b.y = 0.11; b.grounded = 1;
      q.lastTouchTick = s.tick - 6; b.lastTouchTick = s.tick - 6;
      s.teams[1].cpu.seenOwner = C; s.teams[1].cpu.reactT = 0; s.teams[1].cpu.tackleCd = 0;
    },
    switchEval: (s, k) => {
      const q = s.players[C], p = s.players[D], b = s.ball;
      q.x = 5 + (k % 50) * 0.01; q.z = 0; q.vx = 4; q.vz = 0; q.fx = 1; q.fz = 0;
      p.x = -5; p.z = 8; p.vx = 0; p.vz = 0;
      b.owner = C; b.heldBy = -1; b.x = q.x + 0.4; b.z = 0; b.vx = 4; b.vz = 0;
      s.teams[1].cpu.seenOwner = C; s.teams[1].cpu.reactT = 0;
      const t = s.players[16]; t.x = 12; t.z = 2; t.vx = 0; t.vz = 0; // well placed goal-side: a switch is due
      s.ctrl[3].switchLockT = 0; s.ctrl[3].nextSwitch = -1; s.ctrl[3].slot = D; s.players[D].ctrl = 3; t.ctrl = -1;
      s.tick += (6 - ((s.tick + 3) % 6)) % 6; // land on team 1's evaluation tick
    },
    opponentPass: (s, k) => {
      const b = s.ball;
      b.owner = -1; b.heldBy = -1; b.x = 10 + (k % 50) * 0.01; b.z = -6; b.vx = 1; b.vz = 13; b.y = 0.11; b.grounded = 1;
      b.lastTouch = 7; b.lastTouchTeam = 0; b.passTarget = 8; b.passX = 12; b.passZ = 15;
      s.players[8].x = 12; s.players[8].z = 15;
      s.players[D].x = 14; s.players[D].z = 3;
      s.teams[1].cpu.seenOwner = -1; s.teams[1].cpu.reactT = 0;
    },
    looseOwnThird: (s, k) => {
      const b = s.ball;
      b.owner = -1; b.heldBy = -1; b.x = 42.2 + (k % 50) * 0.01; b.z = 0.5; b.vx = 10; b.vz = 0; b.y = 0.11; b.grounded = 1;
      b.lastTouchTeam = 0; b.passTarget = -1;
      s.players[D].x = 44; s.players[D].z = 0; s.players[D].act = 0;
      s.players[C].x = 40; s.players[C].z = 3;
      s.teams[1].cpu.seenOwner = -1; s.teams[1].cpu.reactT = 0; s.teams[1].cpu.tackleCd = 0;
    },
  };
  const out = { us: {}, alloc: {}, buttons: {} };
  for (const [name, setup] of Object.entries(CASES)) {
    const s = base();
    const f = s.teams[1].cpu.out;
    let k = 0;
    let seen = 0;
    const call = () => {
      s.tick++;
      k++;
      setup(s, k);
      clearInputFrame(f);
      cpuDefend(s, 1, f, ev);
      seen |= f.buttons | (f.gesture ? 1 << 16 : 0);
    };
    for (let i = 0; i < 4000; i++) call();
    let best = Infinity;
    for (let b = 0; b < 40; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 400; i++) call();
      best = Math.min(best, (performance.now() - t0) / 400);
    }
    out.us[name] = best * 1000;
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 40000; i++) call();
    out.alloc[name] = (process.memoryUsage().heapUsed - h0) / 40000;
    out.buttons[name] = seen;
  }
  console.log(JSON.stringify(out));
`;

describe('TAI-11 budget', () => {
  const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000,
  });
  const ok = r.status === 0;
  const res = ok
    ? JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      us: Record<string, number>; alloc: Record<string, number>; buttons: Record<string, number>;
    }
    : null;
  if (res) console.log(`TAI-11 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  it('the scenarios exercise the paths they are meant to (tackle, switch, intercept, clearance)', () => {
    expect(res).not.toBeNull();
    const b = res!.buttons;
    expect(b.carrierExposed! & (1 << 1)).not.toBe(0); // SHOOT: standing tackle
    expect(b.switchEval! & ((1 << 16) | (1 << 4))).not.toBe(0); // TAP gesture or MOD_L
    expect(b.opponentPass! & (1 << 7)).not.toBe(0); // SPRINT toward the lane
    expect(b.looseOwnThird! & (1 << 1)).not.toBe(0); // SHOOT: clearance
  });

  for (const name of ['carrierExposed', 'switchEval', 'opponentPass', 'looseOwnThird']) {
    it(`cpuDefend < 0.03 ms per call: ${name}`, () => {
      expect(res).not.toBeNull();
      expect(res!.us[name]!).toBeLessThan(30);
    });
    it(`no source-level allocation per call: ${name}`, () => {
      expect(res).not.toBeNull();
      // SIM-04 ticksToReach / TAI-07 estimateIntercept may box double arguments in V8 (16 bytes each); an object
      // literal, closure or array per call or per candidate would blow well past this.
      expect(res!.alloc[name]!).toBeLessThan(256);
    });
  }
});
