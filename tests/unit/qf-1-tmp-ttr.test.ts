import { it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind } from '../../src/contracts/enums';
import { createMatchConfig, MoveMode, type SimState, type PlayerAttrs, type PlayerState } from '../../src/contracts/state';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { accelFor, locomotionTick, LOCAL_TUNING, ticksToReach, topSpeedFor } from '../../src/sim/players/locomotion';
const ev = createEventBuffer();
const BASE = initMatch(createMatchConfig());
function solo(opts: { attrs?: Partial<PlayerAttrs>; slot?: number } = {}) {
  const s = cloneState(BASE);
  for (let i = 0; i < NUM_SLOTS; i++) s.players[i]!.active = 0;
  const slot = opts.slot ?? 5; const p = s.players[slot]!; const a = s.attrs[slot]!;
  Object.assign(a, { acceleration: 50, sprintSpeed: 50, agility: 50, stamina: 50 }, opts.attrs ?? {});
  a.topSpeed = topSpeedFor(a); a.accel = accelFor(a);
  Object.assign(p, { active: 1, x: 0, z: 0, vx: 0, vz: 0, fx: 1, fz: 0, moveMode: MoveMode.STOP, ix: 0, iz: 0, wantSprint: 0, lookAt: 0, stamina: 1, act: ActionKind.NONE });
  return { s, p, a };
}
function lcg(seed: number) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }
function simulate(s: SimState, slot: number, tx: number, tz: number, sprint: number): number {
  const p = s.players[slot]!; p.moveMode = MoveMode.DIRECT; p.wantSprint = sprint; let t = 0;
  for (; t < 3000; t++) { const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz); if (d <= LOCAL_TUNING.reachRadius) break; p.ix = dx / d; p.iz = dz / d; locomotionTick(s, ev); }
  return t;
}
it('probe', () => {
  const rnd = lcg(2024);
  const rows: string[] = [];
  for (let n = 0; n < 400; n++) {
    const slot = 1 + Math.floor(rnd() * 10);
    const { s, p, a } = solo({ slot, attrs: { acceleration: 1 + rnd() * 98, sprintSpeed: 1 + rnd() * 98, agility: 1 + rnd() * 98 } });
    const moving = rnd() < 0.6; const hd = rnd() * Math.PI * 2; const sp = moving ? 0.5 + rnd() * (a.topSpeed - 0.5) : 0;
    p.vx = Math.cos(hd) * sp; p.vz = Math.sin(hd) * sp; const fd = moving ? hd : rnd() * Math.PI * 2; p.fx = Math.cos(fd); p.fz = Math.sin(fd);
    p.stamina = rnd() < 0.3 ? rnd() * 0.45 : 1;
    const dist = 3 + rnd() * 27, td = rnd() * Math.PI * 2; const tx = Math.cos(td) * dist, tz = Math.sin(td) * dist;
    const c = (p.vx * tx + p.vz * tz) / (sp * dist || 1);
    const est = ticksToReach(s, slot, tx, tz); const sim = simulate(s, slot, tx, tz, 1);
    const err = Math.abs(est - sim) / sim;
    if (err > 0.12) rows.push(`n=${n} sp=${sp.toFixed(2)} c=${c.toFixed(2)} dist=${dist.toFixed(1)} est=${est} sim=${sim} err=${err.toFixed(2)}`);
  }
  console.log(rows.join('\n'));
});
