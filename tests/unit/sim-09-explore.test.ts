import { it } from 'vitest';
import { ActionKind, MatchPhase, KickKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { makeScenario, runTicks } from '../harness/scenario';
import { place, skill, giveBall, KICKER, MATE_A, MATE_B } from './sim-09-helpers';
import { throughLeadPoint } from '../../src/sim/kicks/through';

function live(seed = 3): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: KICKER }], seed });
  for (let i = 0; i < 22; i++) {
    if (i === 0 || i === 11 || i === KICKER) continue;
    place(s, i, (i < 11 ? -30 : 40) + (i % 3), -25 + (i % 11) * 5);
  }
  s.teams[0]!.dir = 1; s.teams[1]!.dir = -1;
  place(s, KICKER, 0, -5);
  s.players[KICKER]!.ctrl = 0;
  skill(s, KICKER, 85);
  giveBall(s, KICKER);
  return s;
}

function press(buttons: number, mx: number, mz: number, ticks: number) {
  let pressed = 0; let done = false;
  return (_t: number, st: SimState, out: { mx: number; mz: number; buttons: number }[]): void => {
    const f = out[0]!;
    if (st.ball.lastKickBy === KICKER) return;
    f.mx = mx; f.mz = mz;
    if (done) return;
    if (pressed === 0 && !(st.players[KICKER]!.act === ActionKind.NONE && st.ball.owner === KICKER)) return;
    f.buttons = buttons; pressed++; if (pressed >= ticks) done = true;
  };
}

it('explore pipeline through', () => {
  for (const [vx, ticks] of [[7, 3]] as const) {
    const s = live();
    place(s, MATE_A, 12, 6, 1, 0, vx, 0);
    const out = { x: 0, z: 0 };
    console.log('lead now', throughLeadPoint(s, KICKER, MATE_A, ticks / 42, 0, out), out);
    let kickTick = -1; const log: string[] = [];
    let minD = 1e9; let spAtMin = 0; let owner = -1; let ownTick = -1; let spOwn = 0;
    runTicks(s, 300, press(Btn.THROUGH, 127, 30, ticks), {
      until: (st, tev) => {
        for (const e of tev) if (e.type === EventType.KICK && e.a === KICKER) {
          kickTick = st.tick;
          log.push(`kick kind=${e.b} tgt=${st.ball.passTarget} pass=(${st.ball.passX.toFixed(1)},${st.ball.passZ.toFixed(1)}) v=${Math.hypot(st.ball.vx, st.ball.vz).toFixed(1)} r=(${st.players[MATE_A]!.x.toFixed(1)},${st.players[MATE_A]!.z.toFixed(1)}) rv=${st.players[MATE_A]!.vx.toFixed(1)},${st.players[MATE_A]!.vz.toFixed(1)}`);
        }
        if (kickTick > 0) {
          const q = st.players[MATE_A]!;
          if ((st.tick - kickTick) % 6 === 0) log.push(`t${st.tick - kickTick} q=(${q.x.toFixed(1)},${q.z.toFixed(1)}) v=${Math.hypot(q.vx,q.vz).toFixed(1)} ctrl=${q.ctrl} job=${q.job} tgt=(${q.tgtX.toFixed(1)},${q.tgtZ.toFixed(1)}) mm=${q.moveMode} b=(${st.ball.x.toFixed(1)},${st.ball.z.toFixed(1)}) act=${q.act}`);
          const d = Math.hypot(st.ball.x - q.x, st.ball.z - q.z);
          if (d < minD) { minD = d; spAtMin = Math.hypot(q.vx, q.vz); }
          if (st.ball.owner >= 0 && owner < 0) { owner = st.ball.owner; ownTick = st.tick - kickTick; spOwn = Math.hypot(q.vx, q.vz); log.push(`own at ${ownTick} by ${owner} pos=(${q.x.toFixed(1)},${q.z.toFixed(1)}) sp=${spOwn.toFixed(1)}`); return true; }
        }
        return false;
      },
    });
    console.log(vx, ticks, log.join('\n'), 'minD', minD.toFixed(2), 'spAtMin', spAtMin.toFixed(1));
  }
  void MATE_B; void KickKind;
});
