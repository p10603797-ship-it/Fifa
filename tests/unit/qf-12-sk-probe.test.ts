import { describe, expect, it } from 'vitest';
import { ControllerKind, ModeId } from '../../src/contracts/enums';
import type { MatchSummary } from '../../src/contracts/app';
import { emptyTeamStats } from '../../src/modes/stats';
import { loadRecords, withRecords } from '../../src/modes/records';
import { defaultSetup } from '../../src/modes/setup';
import { cloneSetup, newFlow } from '../../src/ui/screens/matchFlow';
import { optionsFromSettings, startSetup } from '../../src/ui/screens/matchSettings';
import { fakeCtx } from './mod-01-fakes';

function summary(g0: number, g1: number, winner: number): MatchSummary {
  const a = emptyTeamStats(); const b = emptyTeamStats(); a.goals = g0; b.goals = g1;
  return { teams: [a, b], players: [], goals: [], playerOfMatch: null, shootout: null, winner, forfeit: -1, ticks: 1000 };
}
describe('probe', () => {
  it('change teams after play now', () => {
    const ctx = fakeCtx();
    const a = defaultSetup(ctx as never);
    const copy = cloneSetup(a);
    const b = startSetup(ctx, copy, optionsFromSettings(ctx.settings.get()), ModeId.KICK_OFF);
    b.onFinish!(summary(1, 0, 0), false);
    console.log('played after change-teams start', loadRecords(ctx.settings).played);
    const c = startSetup(ctx, cloneSetup(b), optionsFromSettings(ctx.settings.get()), ModeId.KICK_OFF);
    c.onFinish!(summary(1, 0, 0), false);
    console.log('played after 2nd change-teams', loadRecords(ctx.settings).played);
  });
});
