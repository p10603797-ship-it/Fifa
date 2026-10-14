import '../../src/sim/actions/dispatch';
import { it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, MatchPhase } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { createEventBuffer } from '../../src/sim/core/events';
import { bodyContactTick } from '../../src/sim/players/bodies';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { makeScenario } from '../harness/scenario';
const EV = createEventBuffer();
it('probe', () => {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 1 });
  for (let i = 0; i < NUM_SLOTS; i++) { const p = s.players[i]!; p.x = -45 + i * 4; p.z = -32; p.vx = 0; p.vz = 0; p.fx = 1; p.fz = 0; p.moveMode = MoveMode.STOP; p.act = ActionKind.NONE; s.attrs[i]!.height = 182.5; s.attrs[i]!.strength = 50; }
  s.ball.x = 0; s.ball.z = 0; s.match.restart.taker = -1;
  const P = s.players;
  console.log('attrs', [5,16].map(k=>JSON.stringify({acc:s.attrs[k]!.accel, top:s.attrs[k]!.topSpeed, ag:s.attrs[k]!.agility})));
  P[5]!.x = -4; P[5]!.z = 0; P[16]!.x = 4; P[16]!.z = 0;
  for (let t = 0; t < 240; t++) {
    for (const k of [5, 16]) { const p = P[k]!; p.moveMode = MoveMode.ARRIVE; p.tgtX = 0; p.tgtZ = 0; p.tgtSpeed = 7; }
    s.tick++; EV.begin(s.tick); actionsTick(s, EV); locomotionTick(s, EV); bodyContactTick(s, EV);
    if (t % 20 === 0 || t > 236) console.log(t, [5, 16].map((k) => `${P[k]!.x.toFixed(4)},${P[k]!.z.toFixed(4)} v=${P[k]!.vx.toFixed(3)},${P[k]!.vz.toFixed(4)} f=${P[k]!.fx.toFixed(3)},${P[k]!.fz.toFixed(3)} mm=${P[k]!.moveMode}`).join(' | '));
  }
});
