import { it } from 'vitest';
import { MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { makeScenario, runTicks } from '../harness/scenario';

it('smoke', () => {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 3 });
  const ev = createEventBuffer(); ev.begin(s.tick);
  awardRestart(s, RestartKind.FREE_KICK, 0, 30, 4, ev);
  const r = s.match.restart;
  console.log('dir', s.teams[0]!.dir, 'phase', s.match.phase, 'taker', r.taker, 'wall', r.wallCount, [...r.wall], r.wallX.toFixed(2), r.wallZ.toFixed(2), 'aim', r.aimX, r.aimZ);
  const evs = runTicks(s, 400, undefined, { check: 'core', until: (st) => st.match.phase === MatchPhase.IN_PLAY });
  console.log('phase', s.match.phase, 't', r.t, 'taken', r.taken, 'kicks', evs.filter(e => e.type === 0).map(e => [e.tick, e.a, e.b]));
  console.log('watchdog', evs.filter(e => e.type === 19).map(e => [e.a, e.b]));
  for (let i = 0; i < r.wallCount; i++) { const p = s.players[r.wall[i]!]!; console.log('member', r.wall[i], p.x.toFixed(2), p.z.toFixed(2), Math.hypot(p.x - r.x, p.z - r.z).toFixed(2), p.act, p.actA); }
});
