import { describe, it } from 'vitest';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { startTackle } from '../../src/sim/defend/tackle';
import { createEventBuffer } from '../../src/sim/core/events';
import { P1, P2, owned, place, scene, stepN, pass, loose } from './sim-14-helpers';

describe('explore', () => {
  it('stand tackle from front', () => {
    const s = scene(3);
    place(s, P1, 0, 0, 1, 0);
    owned(s, P1, 0.6, 0);
    place(s, P2, 2.0, 0, -1, 0);
    const ev = createEventBuffer();
    console.log('start', startTackle(s, P2, ActionKind.STAND_TACKLE, -1, ev));
    const out = stepN(s, 40, (st, e) => {
      const p = st.players[P2]!;
      console.log(st.tick, ActionKind[p.act], p.actT, p.x.toFixed(2), p.vx.toFixed(2), 'ball', st.ball.x.toFixed(2), st.ball.owner, e.filter(x=>x.type===EventType.TACKLE||x.type===EventType.KICK||x.type===EventType.FOUL).map(x=>`${EventType[x.type]} a${x.a} b${x.b} c${x.c} d${x.d}`).join(';'));
    });
  });
  it('slide from behind', () => {
    const s = scene(3);
    place(s, P1, 0, 0, 1, 0, 3);
    owned(s, P1, 0.6, 0);
    place(s, P2, -3, 0, 1, 0, 7);
    const ev = createEventBuffer();
    console.log('start', startTackle(s, P2, ActionKind.SLIDE_TACKLE, -1, ev));
    stepN(s, 80, (st, e) => {
      const p = st.players[P2]!; const q = st.players[P1]!;
      const ch = st.match.challenges.filter(c=>c.active);
      console.log(st.tick, ActionKind[p.act], p.actT, p.x.toFixed(2), p.vx.toFixed(2), 'v', ActionKind[q.act], q.x.toFixed(2), 'ball', st.ball.x.toFixed(2), st.ball.owner, e.filter(x=>x.type===EventType.TACKLE||x.type===EventType.KICK||x.type===EventType.FOUL||x.type===EventType.CARD).map(x=>`${EventType[x.type]} a${x.a} b${x.b} c${x.c} d${x.d}`).join(';'), ch.length);
    });
  });
});
