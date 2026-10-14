import { describe, it } from 'vitest';
import { ActionKind, ChallengeKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { makeScenario, runTicks } from '../harness/scenario';
const w = (...a: unknown[]) => process.stderr.write('\n' + a.join(' '));
describe('explore', () => {
  it('bot soak', () => {
    for (const seed of [1, 2]) {
      const s = makeScenario({ seed, config: { halfMinutes: 2 } });
      const t0 = Date.now();
      let err = '';
      let ev: ReturnType<typeof runTicks> = [];
      try { ev = runTicks(s, 7200, undefined, { check: 'all' }); } catch (e) { err = String(e).slice(0, 600); }
      const tk = ev.filter(e => e.type === EventType.TACKLE);
      const byKind = [0,1,2,3,4,5].map(k => `${ChallengeKind[k]}:${tk.filter(e=>e.d===k).length}/${tk.filter(e=>e.d===k&&e.c===1).length}`).join(' ');
      w('seed', seed, 'ms', Date.now() - t0, 'tick', s.tick, 'phase', MatchPhase[s.match.phase], 'tackles', byKind, 'intercepts', ev.filter(e => e.type === EventType.INTERCEPT).length, 'fouls', ev.filter(e => e.type === EventType.FOUL).length, 'cards', ev.filter(e => e.type === EventType.CARD).length, 'goals', s.teams[0]!.goals + '-' + s.teams[1]!.goals, 'clear', ev.filter(e => e.type === EventType.KICK && e.b === 22).length, 'passes', ev.filter(e => e.type === EventType.KICK && e.b >= 1 && e.b <= 12).length, 'poss', ev.filter(e => e.type === EventType.POSSESSION).length, 'defl', ev.filter(e => e.type === EventType.KICK && e.b === 26).length, 'pokes', ev.filter(e => e.type === EventType.KICK && e.b === 27).length, 'err', err);
    }
  });
});
