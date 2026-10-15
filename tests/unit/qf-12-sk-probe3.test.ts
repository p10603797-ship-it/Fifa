import { beforeEach, describe, it } from 'vitest';
import { FormationId, MatchPhase, Period, Role, TacticalFocus, Command } from '../../src/contracts/enums';
import { RosterStatus, type SimState } from '../../src/contracts/state';
import { createCommandQueue } from '../../src/app/localInput';
import { pumpTeamOrders, resetTeamOrders, setFocusOrder, setFormationOrder, setTacticOrder, teamOrders } from '../../src/ui/screens/pause';
import { makeScenario, runTicks } from '../harness/scenario';

function bench(s: SimState, team: number): number[] {
  const field: number[] = [];
  for (let r = 11; r < 18; r++) if (s.squads[team]![r]!.pos !== Role.GK) field.push(r);
  return field;
}
beforeEach(() => resetTeamOrders());
describe('probe', () => {
  for (const n of [1, 5]) it('half-time flush with subs ' + n, () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.HALF_TIME, match: { period: Period.FIRST_HALF } });
    const t = s.teams[0]!;
    const b = bench(s, 0);
    const o = teamOrders(s, 0);
    const outs = [9, 8, 7, 6, 5];
    for (let i = 0; i < n; i++) o.subs.push({ out: outs[i]!, inRoster: b[i]!, sentTick: -1 });
    setFormationOrder(o, t, FormationId.F433);
    setFocusOrder(o, t, TacticalFocus.ATTACKING);
    for (let i = 0; i < 4; i++) setTacticOrder(o, t, i, 1);
    const queue = createCommandQueue();
    const sent: number[] = [];
    pumpTeamOrders(s, (h, c, a) => { sent.push(c); queue.push(h, c, a); }, Number.POSITIVE_INFINITY);
    runTicks(s, 400, (_tick, _st, frames) => queue.applyTo(frames));
    console.log(`n=${n} sent ${sent.length} phase ${s.match.phase} period ${s.match.period} subsUsed ${t.subsUsed} subCount ${t.subCount} formation ${t.formation} focus ${t.focus} press ${t.teamPress} roster ${b.slice(0, n).map((r) => t.roster[r]).join(',')}`);
  });
});
