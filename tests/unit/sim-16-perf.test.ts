/**
 * SIM-16 switching budget: per-tick cost of switchTick for two controllers in the expensive situations (opponent
 * carrier with path sampling, loose ground ball, air ball, a long high ball followed for ~4 s of flight and a
 * fresh one every tick, i.e. no memo reuse across ticks), with the real SIM-04 ticksToReach. Timed in a tsx child
 * process (plain ESM, like the shipped bundle; vitest's module transform adds getter overhead to every import) and
 * as the minimum over repetitions, so load from parallel test workers does not make it flaky. The allocation check
 * is in sim-16-alloc.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url).pathname;
const imp = (p: string): string => JSON.stringify(ROOT + p);

const PROBE = `
const { createMatchConfig } = await import(${imp('src/contracts/state.ts')});
const E = await import(${imp('src/contracts/enums.ts')});
const { Btn } = await import(${imp('src/contracts/input.ts')});
const { initMatch } = await import(${imp('src/sim/init.ts')});
const { createEventBuffer } = await import(${imp('src/sim/core/events.ts')});
const { switchTick } = await import(${imp('src/sim/control/switching.ts')});
const cfg = createMatchConfig();
cfg.humans = [
  { kind: E.ControllerKind.HUMAN, side: 0, assist: 0, autoSwitch: E.AutoSwitch.AUTO, fastPower: 0 },
  { kind: E.ControllerKind.HUMAN, side: 1, assist: 0, autoSwitch: E.AutoSwitch.AIR_AND_LOOSE, fastPower: 0 },
];
const s = initMatch(cfg);
s.match.phase = E.MatchPhase.IN_PLAY;
for (let i = 0; i < 22; i++) {
  const p = s.players[i];
  p.x = -45 + (i % 11) * 9; p.z = (i < 11 ? -1 : 1) * (4 + (i % 5) * 5); p.vx = (i % 3) - 1; p.vz = (i % 2) - 0.5;
}
const b = s.ball;
const ev = createEventBuffer();
function situation(k) {
  if (k === 0) { const p = s.players[19]; p.vx = -6; p.vz = 1; b.owner = 19; b.heldBy = -1; b.x = p.x; b.z = p.z; }
  else if (k === 1) { b.owner = -1; b.x = 5; b.z = 3; b.y = 0.11; b.vx = -9; b.vz = 2; b.vy = 0; b.grounded = 1; b.lastTouchTeam = 1; }
  else if (k === 2) { b.owner = -1; b.x = 30; b.z = -5; b.y = 1.2; b.vx = -20; b.vz = 3; b.vy = 9; b.grounded = 0; b.lastTouchTeam = 1; }
  else { b.owner = -1; b.x = 30 + (s.tick % 7) * 0.01; b.z = -5; b.y = 0.5; b.vx = -15; b.vz = 2; b.vy = 20; b.sx = 0; b.sy = 1; b.sz = -4; b.grounded = 0; b.lastTouchTeam = 1; }
  b.passTarget = -1; b.shotBy = -1; b.lastTouchTick = s.tick;
}
function run(n, k) {
  for (let i = 0; i < n; i++) {
    s.tick++; situation(k); ev.begin(s.tick);
    for (let c = 0; c < 2; c++) {
      const ctl = s.ctrl[c];
      ctl.prevButtons = ctl.buttons; ctl.buttons = i % 40 === 0 ? Btn.MOD_L : 0;
      switchTick(s, c, ev);
    }
  }
}
const out = {};
for (const k of [0, 1, 2, 3]) {
  run(4000, k);
  let best = 1e9;
  for (let r = 0; r < 7; r++) {
    const t0 = process.hrtime.bigint();
    run(3000, k);
    const us = Number(process.hrtime.bigint() - t0) / 1000 / 3000;
    if (us < best) best = us;
  }
  out['situation ' + k] = best;
}
console.log('RESULT ' + JSON.stringify(out));
`;

describe('SIM-16 budget', () => {
  it('switchTick for two controllers costs a small share of the 2.5 ms sim+AI tick budget', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', PROBE], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `probe failed: ${r.stderr}`).toBeTruthy();
    const res = JSON.parse(line!.slice(7)) as Record<string, number>;
    for (const [k, us] of Object.entries(res)) {
      // Measured ~5-15 us per tick (both controllers) on desktop Node; an iPad is ~3-5x slower. The bound keeps
      // CI headroom and still fails on a regression to the unpruned estimate (~140 us).
      expect(us, `${k}: ${us.toFixed(1)} us/tick`).toBeLessThan(60);
    }
  }, 150_000);
});
