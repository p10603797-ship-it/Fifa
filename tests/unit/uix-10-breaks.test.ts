/**
 * UIX-10 unit tests: stats rows (formatting, possession adding up to 100, pass accuracy without passes), scorer lines
 * (a brace listed once, own goals credited to the right team and named from the scorer's own squad), player of the
 * match (the tracker's pick, best rating, goals and assists, winner tie-break), the result line and the final
 * actions per mode. The screens themselves are covered by tests/e2e/uix-10-breaks.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import type { GoalRecord, MatchSummary, PlayerMatchStats, TeamMatchStats } from '../../src/contracts/app';
import { ModeId } from '../../src/contracts/enums';
import { emptyTeamStats } from '../../src/modes/stats';
import { finalActions, resultLine } from '../../src/ui/screens/fullTime';
import {
  FULL_STAT_KEYS, HALF_STAT_KEYS, homeShare, pickPlayerOfMatch, scorersByTeam, statRows,
} from '../../src/ui/screens/halfTime';

function team(over: Partial<TeamMatchStats> = {}): TeamMatchStats {
  return { ...emptyTeamStats(), ...over };
}

function summary(over: Partial<MatchSummary> = {}): MatchSummary {
  return {
    teams: [team(), team()], players: [], goals: [], playerOfMatch: null, shootout: null, winner: -1, forfeit: -1, ticks: 0,
    ...over,
  };
}

const goal = (team: number, rosterIdx: number, minute: number, assistRosterIdx = -1, ownGoal = false): GoalRecord =>
  ({ team, rosterIdx, assistRosterIdx, ownGoal, minute });

const player = (team: number, rosterIdx: number, rating: number, goals = 0, assists = 0): PlayerMatchStats => ({
  team, rosterIdx, goals, assists, shots: 0, passes: 0, passesCompleted: 0, tackles: 0, saves: 0, rating, minutes: 90,
});

describe('UIX-10 stats rows', () => {
  it('full table rows in order with the summary numbers', () => {
    const s = summary({
      teams: [
        team({ goals: 2, shots: 11, shotsOnTarget: 5, possession: 0.613, passes: 200, passesCompleted: 170, tackles: 14, fouls: 6, yellow: 2, red: 0, offsides: 3, corners: 7, saves: 1 }),
        team({ goals: 1, shots: 4, shotsOnTarget: 2, possession: 0.387, passes: 90, passesCompleted: 61, tackles: 20, fouls: 11, yellow: 3, red: 1, offsides: 1, corners: 2, saves: 4 }),
      ],
    });
    const rows = statRows(s);
    expect(rows.map((r) => r.key)).toEqual([...FULL_STAT_KEYS]);
    const by = Object.fromEntries(rows.map((r) => [r.key, [r.home, r.away]]));
    expect(by).toEqual({
      possession: ['61%', '39%'], shots: ['11', '4'], onTarget: ['5', '2'], passes: ['170/200', '61/90'],
      passAccuracy: ['85%', '68%'], tackles: ['14', '20'], fouls: ['6', '11'], yellow: ['2', '3'], red: ['0', '1'],
      offsides: ['3', '1'], corners: ['7', '2'], saves: ['1', '4'],
    });
  });

  it('possession always adds up to 100 (rounding) and survives bad input', () => {
    for (const p of [0.505, 0.495, 0.333, 0.6667, 0, 1]) {
      const r = statRows(summary({ teams: [team({ possession: p }), team({ possession: 1 - p })] }), ['possession'])[0]!;
      expect(r.homeValue + r.awayValue).toBe(100);
    }
    const bad = statRows(summary({ teams: [team({ possession: Number.NaN }), team()] }), ['possession'])[0]!;
    expect([bad.home, bad.away]).toEqual(['50%', '50%']);
  });

  it('pass accuracy is 0% without passes (no NaN)', () => {
    const r = statRows(summary(), ['passAccuracy'])[0]!;
    expect([r.home, r.away]).toEqual(['0%', '0%']);
  });

  it('half-time subset and the comparison bar share', () => {
    expect(statRows(summary(), HALF_STAT_KEYS).map((r) => r.key)).toEqual(['possession', 'shots', 'onTarget', 'passes', 'corners', 'fouls']);
    expect(homeShare({ homeValue: 0, awayValue: 0 })).toBe(0.5);
    expect(homeShare({ homeValue: 3, awayValue: 1 })).toBe(0.75);
  });
});

describe('UIX-10 scorers', () => {
  const names = (t: number, r: number): string => `T${t}P${r}`;

  it('lists goals per team with minutes; a brace is one line with both minutes', () => {
    const s = summary({ goals: [goal(0, 9, 12.4, 7), goal(1, 10, 30), goal(0, 9, 67)] });
    const [home, away] = scorersByTeam(s, names);
    expect(home.map((l) => l.text)).toEqual(["T0P9 12', 67'"]);
    expect(away.map((l) => l.text)).toEqual(["T1P10 30'"]);
  });

  it('an own goal counts for the scoring team, is named from the scorer\'s own squad and marked (og)', () => {
    const s = summary({ goals: [goal(0, 4, 81, -1, true), goal(0, 4, 85, -1, true)] });
    const [home, away] = scorersByTeam(s, names);
    expect(home.map((l) => l.text)).toEqual(["T1P4 81', 85' (og)"]);
    expect(away).toEqual([]);
  });

  it('minute 0 shows as 1\'', () => {
    expect(scorersByTeam(summary({ goals: [goal(1, 2, 0)] }), names)[1][0]!.text).toBe("T1P2 1'");
  });
});

describe('UIX-10 player of the match', () => {
  it('uses the tracker\'s pick with his stats', () => {
    const s = summary({ playerOfMatch: { team: 1, rosterIdx: 3 }, players: [player(1, 3, 8.4, 1, 1), player(0, 9, 9.1, 2)] });
    expect(pickPlayerOfMatch(s)).toEqual({ team: 1, rosterIdx: 3, goals: 1, assists: 1, rating: 8.4, official: true });
  });

  it('else the best rated player (the winner on a tie)', () => {
    const s = summary({ winner: 1, players: [player(0, 9, 7.5), player(1, 5, 7.5), player(1, 2, 6)] });
    expect(pickPlayerOfMatch(s)).toMatchObject({ team: 1, rosterIdx: 5, rating: 7.5, official: false });
  });

  it('else the top scorer (goals count double, assists once; own goals ignored; winner on a tie)', () => {
    const s = summary({
      winner: 0,
      goals: [goal(1, 10, 5), goal(0, 9, 20, 7), goal(0, 7, 50, 9), goal(1, 3, 60, -1, true)],
    });
    // T0 #9: 1 goal + 1 assist = 3; T0 #7: 1 goal + 1 assist = 3; T1 #10: 1 goal = 2. First of the tied winners.
    expect(pickPlayerOfMatch(s)).toEqual({ team: 0, rosterIdx: 9, goals: 1, assists: 1, rating: null, official: false });
    const s2 = summary({ winner: 1, goals: [goal(0, 9, 5), goal(1, 4, 50)] });
    expect(pickPlayerOfMatch(s2)).toMatchObject({ team: 1, rosterIdx: 4 });
  });

  it('nobody stands out in a goalless match without ratings', () => {
    expect(pickPlayerOfMatch(summary())).toBeNull();
    expect(pickPlayerOfMatch(summary({ goals: [goal(0, 4, 10, -1, true)] }))).toBeNull();
  });
});

describe('UIX-10 result line and final actions', () => {
  const codes: [string, string] = ['AAA', 'BBB'];
  it('forfeit, penalties, after extra time, or nothing', () => {
    expect(resultLine(summary({ forfeit: 1 }), codes, false)).toBe('BBB forfeited');
    expect(resultLine(summary({ shootout: [4, 3] }), codes, true)).toBe('Penalties 4-3, AAA win');
    expect(resultLine(summary({ shootout: [2, 5] }), codes, true)).toBe('Penalties 2-5, BBB win');
    expect(resultLine(summary(), codes, true)).toBe('After extra time');
    expect(resultLine(summary(), codes, false)).toBe('');
  });

  it('Rematch and Change Teams for local modes; the cup continues; online cannot restart', () => {
    expect(finalActions(ModeId.KICK_OFF, false)).toEqual({ rematch: true, changeTeams: 'team-select', cup: false });
    expect(finalActions(ModeId.FRIEND_LOCAL, false)).toEqual({ rematch: true, changeTeams: 'team-select', cup: false });
    expect(finalActions(ModeId.SHOOT_OUT, false)).toEqual({ rematch: true, changeTeams: 'team-select', cup: false });
    expect(finalActions(ModeId.CUP, false)).toEqual({ rematch: false, changeTeams: null, cup: true });
    expect(finalActions(ModeId.FRIEND_ONLINE, true)).toEqual({ rematch: false, changeTeams: 'online-lobby', cup: false });
    expect(finalActions(ModeId.KICK_OFF, true).rematch).toBe(false);
  });
});
