import { it } from 'vitest';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { makeScenario, runTicks } from '../harness/scenario';
it('dbg', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 7, humans: 0 });
    for (let i = 0; i < 22; i++) {
      if (i === 0 || i === 3) continue;
      const p = s.players[i]!;
      p.x = 15 + (i % 6) * 5; p.z = -25 + i * 2.3; p.vx = 0; p.vz = 0;
    }
    s.players[11]!.x = 50; s.players[11]!.z = 0;
    const k = s.players[0]!;
    k.x = -50.5; k.z = 0; k.vx = 0; k.vz = 0; k.fx = 1; k.fz = 0;
    const d = s.players[3]!;
    d.x = -50.5; d.z = 0.6; d.vx = 0; d.vz = 0;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = -34.5; b.z = 0; b.y = 0.2; b.px = b.x; b.pz = 0; b.py = 0.2;
    b.vx = -14; b.vz = 0; b.vy = 3.2; b.grounded = 0;
    b.lastTouch = 20; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.lastKickBy = 20; b.lastKickTeam = 1;
    b.lastKickKind = KickKind.SHOT_NORMAL; b.lastKickTick = s.tick; b.shotBy = 20; b.shotOnTarget = 1; b.passTarget = -1;
    runTicks(s, 150, undefined, { until: (st, evs) => {
      const q = st.players[3]!, kk = st.players[0]!;
      if (st.tick % 5 === 0 || evs.length) console.log(st.tick, 'ball', st.ball.x.toFixed(2), st.ball.y.toFixed(2), st.ball.z.toFixed(2), 'd3', q.x.toFixed(2), q.z.toFixed(2), 'act', q.act, 'job', q.job, 'ctrl', q.ctrl, 'k', kk.x.toFixed(2), kk.act, 'chaser', st.teams[0]!.chaser, evs.map((e) => EventType[e.type] + ':' + e.a + ':' + e.b).join(','));
      return st.ball.heldBy === 0 || st.ball.lastTouch === 0 || st.ball.lastTouch === 3; } });
});
