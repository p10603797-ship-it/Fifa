import { it, vi } from 'vitest';
import { CPU_CONTROLLER_BASE } from '../../src/contracts/constants';
import { Difficulty, MatchPhase } from '../../src/contracts/enums';
import type { EventSink } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { makeScenario, runTicks, type ScenarioPlayer } from '../harness/scenario';
import { CTL, resetCtl } from './tai-08-helpers';
vi.mock('../../src/ai/cpu/passing', async (orig) => {
  const h = await import('./tai-08-helpers');
  return { ...(await orig<typeof import('../../src/ai/cpu/passing')>()), scorePassOptions: h.scorePassDouble };
});
vi.mock('../../src/ai/cpu/shooting', async () => {
  const h = await import('./tai-08-helpers');
  return { estimateXg: h.xgDouble, bestDribble: h.dribbleDouble, chooseSkill: h.skillDouble };
});
const BASE: [number, number][] = [
  [-51, 0], [-35, -25], [-38, -8], [-38, 8], [-35, 25], [-25, -15], [-25, 0], [-25, 15], [-15, -20], [-15, 0], [-15, 20],
  [51, 0], [35, -25], [38, -8], [38, 8], [35, 25], [25, -15], [25, 0], [25, 15], [15, -20], [15, 0], [15, 20],
];
it('debug', () => {
  resetCtl(); CTL.passes = 'none';
  const players: ScenarioPlayer[] = [];
  for (let i = 0; i < 22; i++) { const [x, z] = i === 6 ? [-20, 0] : BASE[i]!; players.push({ slot: i, x, z, vx: 0, vz: 0, fx: i < 11 ? 1 : -1, fz: 0, homeX: x, homeZ: z }); }
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 7, config: { difficulty: Difficulty.LEGEND }, players,
    ball: { x: -19.4, y: 0.11, z: 0, owner: 6, ownerT: 120, lastTouch: 6, lastTouchTeam: 0 } });
  s.ctrl[CPU_CONTROLLER_BASE]!.slot = 6; s.players[6]!.ctrl = CPU_CONTROLLER_BASE;
  runTicks(s, 150, undefined, { until: (st, evs) => {
    const p = st.players[6]!; const b = st.ball; const f = st.teams[0]!.cpu.out;
    let near = 1e9, ni = -1; for (let i = 11; i < 22; i++) { const q = st.players[i]!; const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < near) { near = d; ni = i; } }
    if (st.tick % 5 === 0 || b.owner !== 6 || evs.length) console.log(st.tick, 'p', p.x.toFixed(2), p.z.toFixed(2), 'v', p.vx.toFixed(2), 'b', b.x.toFixed(2), b.z.toFixed(2), 'own', b.owner, 'act', p.act, 'plan', st.teams[0]!.cpu.plan, 'f', f.mx, f.mz, f.buttons, 'near', ni, near.toFixed(2), 'ctrl', st.ctrl[2]!.slot, evs.map(e => `${e.type}:${e.a},${e.b}`).join(' '));
    return false; } });
});
