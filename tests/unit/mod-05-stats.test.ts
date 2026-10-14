/**
 * MOD-05: stats tracking, match summary and records. Synthetic event streams -> exact summaries; possession sums to
 * 1; header passes and throw-ins never count for pass completion; player ratings and player of the match;
 * shoot-out tallies; forfeit; a real CPU match produces sane numbers; lifetime records.
 */
import { describe, expect, it } from 'vitest';
import type { MatchSetup, MatchSummary, PlayerMatchStats } from '../../src/contracts/app';
import {
  CardKind, ChallengeOutcome, KickKind, MatchPhase, ModeId, Period, PracticeKind, RestartKind, Role,
} from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';
import { createInputFrame } from '../../src/contracts/input';
import {
  applyResult, emptyRecords, humanSideOf, loadRecords, recordCupWon, recordMatch, recordResult, RECORDS_PROGRESS_KEY,
  sanitizeRecords, withRecords,
} from '../../src/modes/records';
import { createStatsTracker, isPassStatKind, passCompletion, pickPlayerOfMatch, playerRating, RATING } from '../../src/modes/stats';
import { fakeSettings } from './mod-01-fakes';

type Ev = [EventType, number?, number?, number?, number?];

function setup(): { s: SimState; tracker: ReturnType<typeof createStatsTracker>; feed: (events: Ev[], ticks?: number) => void } {
  const cfg = createMatchConfig();
  cfg.halfMinutes = 4;
  const s = initMatch(cfg);
  s.match.phase = MatchPhase.IN_PLAY;
  s.match.period = Period.FIRST_HALF;
  const tracker = createStatsTracker();
  tracker.reset(s);
  const buf = createEventBuffer();
  const feed = (events: Ev[], ticks = 1): void => {
    for (let t = 0; t < ticks; t++) {
      s.tick++;
      buf.begin(s.tick);
      if (t === 0) for (const [type, a = 0, b = 0, c = 0, d = 0] of events) buf.emit(type, a, b, c, d);
      tracker.onTick(s, buf);
    }
  };
  return { s, tracker, feed };
}

describe('MOD-05 team stats from synthetic events', () => {
  it('counts every statistic exactly', () => {
    const { s, tracker, feed } = setup();
    feed([
      [EventType.SHOT, 9, 1], [EventType.SHOT, 10, 0], [EventType.SHOT, 20, 1],
      [EventType.TACKLE, 3, 9, 1], [EventType.TACKLE, 14, 2, 0], [EventType.TACKLE, 14, 2, 1],
      [EventType.FOUL, 4, 15, ChallengeOutcome.FOUL], [EventType.FOUL, 15, 4, ChallengeOutcome.FOUL_YELLOW],
      [EventType.FOUL, 16, 4, ChallengeOutcome.CLEAN],
      [EventType.CARD, 15, CardKind.YELLOW], [EventType.CARD, 15, CardKind.SECOND_YELLOW], [EventType.CARD, 5, CardKind.RED],
      [EventType.OFFSIDE, 10], [EventType.OFFSIDE, 21], [EventType.OFFSIDE, 21],
      [EventType.RESTART_AWARDED, RestartKind.CORNER, 0], [EventType.RESTART_AWARDED, RestartKind.CORNER, 1],
      [EventType.RESTART_AWARDED, RestartKind.THROW_IN, 1], [EventType.SAVE, 11, 0], [EventType.SAVE, 0, 1],
      [EventType.SAVE, 0, 1], [EventType.INTERCEPT, 13, 7], [EventType.INTERCEPT, 2, 18],
    ]);
    const sum = tracker.summary(s);
    const [h, a] = sum.teams;
    expect([h.shots, h.shotsOnTarget, a.shots, a.shotsOnTarget]).toEqual([2, 1, 1, 1]);
    expect([h.tackles, h.tacklesWon, a.tackles, a.tacklesWon]).toEqual([1, 1, 2, 1]);
    expect([h.fouls, a.fouls]).toEqual([1, 1]);
    expect([h.yellow, h.red, a.yellow, a.red]).toEqual([0, 1, 2, 1]);
    expect([h.offsides, a.offsides]).toEqual([1, 2]);
    expect([h.corners, a.corners]).toEqual([1, 1]);
    expect([h.saves, a.saves]).toEqual([2, 1]);
    expect([h.interceptions, a.interceptions]).toEqual([1, 1]);
    expect(sum.forfeit).toBe(-1);
    expect(sum.ticks).toBe(s.tick);
  });

  it('passes: only pass kinds count; completions need the passer\'s last kick to be a counted pass (no header passes, no throw-ins)', () => {
    const { s, tracker, feed } = setup();
    feed([[EventType.KICK, 4, KickKind.GROUND_PASS], [EventType.PASS_COMPLETE, 7, 4]]); // 1/1
    feed([[EventType.KICK, 7, KickKind.THROUGH_GROUND]]); // 2 attempts, intercepted later
    feed([[EventType.KICK, 6, KickKind.HEADER_PASS], [EventType.PASS_COMPLETE, 8, 6]]); // not counted at all
    feed([[EventType.KICK, 2, KickKind.THROW_IN], [EventType.PASS_COMPLETE, 3, 2]]); // not counted
    feed([[EventType.KICK, 0, KickKind.GK_THROW], [EventType.PASS_COMPLETE, 2, 0]]); // keeper throw: not counted
    feed([[EventType.KICK, 5, KickKind.CLEARANCE], [EventType.PASS_COMPLETE, 9, 5]]); // clearance: not counted
    feed([[EventType.KICK, 9, KickKind.CROSS], [EventType.PASS_COMPLETE, 10, 9], [EventType.PASS_COMPLETE, 8, 9]]); // once
    feed([[EventType.KICK, 12, KickKind.VOLLEY_PASS], [EventType.PASS_COMPLETE, 13, 12]]); // away 1/1
    feed([[EventType.KICK, 14, KickKind.LOB_PASS], [EventType.PASS_COMPLETE, 3, 14]]); // to an opponent: not completed
    const sum = tracker.summary(s);
    expect([sum.teams[0].passes, sum.teams[0].passesCompleted]).toEqual([3, 2]);
    expect([sum.teams[1].passes, sum.teams[1].passesCompleted]).toEqual([2, 1]);
    expect(passCompletion(sum.teams[0])).toBeCloseTo(2 / 3, 10);
    expect(isPassStatKind(KickKind.HEADER_PASS)).toBe(false);
    expect(isPassStatKind(KickKind.THROW_IN)).toBe(false);
    expect(isPassStatKind(KickKind.DINKED_PASS)).toBe(true);
    const p4 = sum.players.find((p) => p.team === 0 && p.rosterIdx === 4)!;
    expect([p4.passes, p4.passesCompleted]).toEqual([1, 1]);
  });

  it('possession: IN_PLAY ticks of the owning team, loose ball stays with the last owner, sums to exactly 1', () => {
    const { s, tracker, feed } = setup();
    s.ball.owner = -1;
    feed([], 10); // nobody owned it yet: not counted
    expect(tracker.summary(s).teams[0].possession).toBe(0.5);
    s.ball.owner = 5;
    feed([], 30);
    s.ball.owner = -1;
    feed([], 10); // loose after a home pass: still home
    s.ball.owner = 15;
    feed([], 20);
    s.match.phase = MatchPhase.THROW_IN;
    feed([], 50); // stoppage: not counted
    const sum = tracker.summary(s);
    expect(sum.teams[0].possession).toBeCloseTo(40 / 60, 12);
    expect(sum.teams[0].possession + sum.teams[1].possession).toBe(1);
    for (let i = 0; i < 20; i++) {
      const { s: s2, tracker: t2, feed: f2 } = setup();
      s2.ball.owner = 3;
      f2([], 1 + i * 7);
      s2.ball.owner = 12;
      f2([], 3 + i * 11);
      const p = t2.summary(s2).teams;
      expect(p[0].possession + p[1].possession).toBe(1);
    }
  });

  it('goals: scorer, assist, own goal and minute from the displayed clock; score from the state', () => {
    const { s, tracker, feed } = setup();
    s.match.periodLen = 4 * 3600;
    s.match.periodT = Math.round(4 * 3600 * (12.5 / 45)); // 12:30
    feed([[EventType.GOAL, 0, 9, 7, 0]]);
    s.match.period = Period.SECOND_HALF;
    s.match.periodT = 4 * 3600 + 600; // added time of the second half
    s.match.addedT = 1200;
    feed([[EventType.GOAL, 1, 3, -1, 1]]); // own goal by home #3, credited to away
    s.teams[0]!.goals = 1;
    s.teams[1]!.goals = 1;
    const sum = tracker.summary(s);
    expect(sum.goals).toEqual([
      { team: 0, rosterIdx: 9, assistRosterIdx: 7, ownGoal: false, minute: 13 },
      { team: 1, rosterIdx: 3, assistRosterIdx: -1, ownGoal: true, minute: 90 },
    ]);
    expect([sum.teams[0].goals, sum.teams[1].goals]).toEqual([1, 1]);
    const scorer = sum.players.find((p) => p.team === 0 && p.rosterIdx === 9)!;
    const assist = sum.players.find((p) => p.team === 0 && p.rosterIdx === 7)!;
    expect([scorer.goals, assist.assists]).toEqual([1, 1]);
    expect(sum.players.find((p) => p.team === 0 && p.rosterIdx === 3)!.goals).toBe(0);
  });

  it('a substitute is credited under his own squad index (slots are reused)', () => {
    const { s, tracker, feed } = setup();
    feed([[EventType.SHOT, 8, 1]]);
    s.players[8]!.rosterIdx = 14; // sub on for #8
    feed([[EventType.SUBSTITUTION, 0, 8, 14, 8], [EventType.SHOT, 8, 0]]);
    const sum = tracker.summary(s);
    expect(sum.players.find((p) => p.team === 0 && p.rosterIdx === 8)!.shots).toBe(1);
    expect(sum.players.find((p) => p.team === 0 && p.rosterIdx === 14)!.shots).toBe(1);
    expect(sum.players.filter((p) => p.team === 0)).toHaveLength(12);
  });

  it('minutes: clock time on the pitch on the 45-per-half scale', () => {
    const { s, tracker, feed } = setup();
    s.match.clockRunning = 1;
    feed([], 4 * 3600); // a full half at 4-minute halves
    s.match.clockRunning = 0;
    feed([], 600);
    const sum = tracker.summary(s);
    expect(sum.players.every((p) => p.minutes === 45)).toBe(true);
    expect(sum.players).toHaveLength(22);
  });

  it('winner: match winner, else goals, else shoot-out; forfeit reported', () => {
    const { s, tracker } = setup();
    expect(tracker.summary(s).winner).toBe(-1);
    s.match.shootout.winner = 1;
    s.match.shootout.goals[0] = 3;
    s.match.shootout.goals[1] = 4;
    let sum = tracker.summary(s);
    expect(sum.shootout).toEqual([3, 4]);
    expect(sum.winner).toBe(1);
    s.match.forfeitTeam = 0;
    s.match.winner = 1;
    sum = tracker.summary(s);
    expect([sum.forfeit, sum.winner]).toEqual([0, 1]);
  });

  it('reset clears everything', () => {
    const { s, tracker, feed } = setup();
    s.ball.owner = 2;
    feed([[EventType.SHOT, 9, 1], [EventType.GOAL, 0, 9, -1, 0]], 5);
    tracker.reset(s);
    const sum = tracker.summary(s);
    expect(sum.teams[0].shots).toBe(0);
    expect(sum.goals).toEqual([]);
    expect(sum.teams[0].possession).toBe(0.5);
  });
});

describe('MOD-05 ratings and player of the match', () => {
  it('rating formula: base, bonuses, penalties, clamped and rounded to one decimal', () => {
    const zero = {
      goals: 0, ownGoals: 0, assists: 0, shots: 0, shotsOn: 0, passes: 0, passesDone: 0, tackles: 0, tacklesWon: 0,
      interceptions: 0, saves: 0, fouls: 0, yellow: 0, red: 0, conceded: 0, keeper: false, defender: false, cleanSheet: false, result: 0,
    };
    expect(playerRating(zero)).toBe(RATING.base);
    expect(playerRating({ ...zero, goals: 2, assists: 1, result: 1 })).toBe(Math.round((6 + 2 + 0.7 + 0.3) * 10) / 10);
    expect(playerRating({ ...zero, goals: 9 })).toBe(RATING.max);
    expect(playerRating({ ...zero, red: 2, ownGoals: 2 })).toBe(RATING.min);
    expect(playerRating({ ...zero, keeper: true, saves: 4, cleanSheet: true })).toBe(Math.round((6 + 1.6 + 0.6) * 10) / 10);
    expect(playerRating({ ...zero, defender: true, conceded: 2 })).toBe(5.7);
  });

  it('player of the match is the top rating (tie-breaks: goals, assists, winner, home, squad index)', () => {
    const p = (team: number, rosterIdx: number, rating: number, goals = 0, assists = 0): PlayerMatchStats => ({
      team, rosterIdx, rating, goals, assists, shots: 0, passes: 0, passesCompleted: 0, tackles: 0, saves: 0, minutes: 90,
    });
    expect(pickPlayerOfMatch([p(0, 1, 6.5), p(1, 2, 8.1), p(0, 3, 7)], 0)).toBe(1);
    expect(pickPlayerOfMatch([p(0, 1, 8), p(1, 2, 8, 1)], 0)).toBe(1);
    expect(pickPlayerOfMatch([p(0, 1, 8, 1, 0), p(1, 2, 8, 1, 1)], 0)).toBe(1);
    expect(pickPlayerOfMatch([p(0, 1, 8), p(1, 2, 8)], 1)).toBe(1);
    expect(pickPlayerOfMatch([p(1, 1, 8), p(0, 5, 8)], -1)).toBe(1);
    expect(pickPlayerOfMatch([p(0, 5, 8), p(0, 2, 8)], -1)).toBe(1);
    expect(pickPlayerOfMatch([], 0)).toBe(-1);
  });

  it('summary.playerOfMatch picks the highest-rated player of the stream', () => {
    const { s, tracker, feed } = setup();
    feed([[EventType.SHOT, 19, 1], [EventType.GOAL, 1, 19, 20, 0], [EventType.SHOT, 19, 1], [EventType.GOAL, 1, 19, -1, 0]]);
    s.teams[1]!.goals = 2;
    s.match.winner = 1;
    const sum = tracker.summary(s);
    const best = sum.players.reduce((a, b) => (b.rating > a.rating ? b : a));
    expect(sum.playerOfMatch).toEqual({ team: best.team, rosterIdx: best.rosterIdx });
    expect(sum.playerOfMatch).toEqual({ team: 1, rosterIdx: 8 });
    const keeper = sum.players.find((x) => x.team === 0 && x.rosterIdx === 0)!;
    expect(keeper.rating).toBeLessThan(RATING.base);
    expect(s.players[0]!.isKeeper).toBe(1);
    expect(s.players[0]!.role).toBe(Role.GK);
  });
});

describe('MOD-05 real match', () => {
  it('a short CPU v CPU match: possession sums to 1, completed <= attempted, every player rated 3..10', () => {
    const cfg = createMatchConfig();
    cfg.halfMinutes = 2;
    cfg.seed = 77;
    cfg.humans = [
      { ...cfg.humans[1]! },
      { ...cfg.humans[1]! },
    ];
    const s = initMatch(cfg);
    const tracker = createStatsTracker();
    tracker.reset(s);
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    for (let i = 0; i < 60 * 60 && s.match.phase !== MatchPhase.POST_MATCH; i++) {
      step(s, frames, ev);
      tracker.onTick(s, ev);
    }
    const sum = tracker.summary(s);
    expect(sum.teams[0].possession + sum.teams[1].possession).toBe(1);
    for (const t of sum.teams) {
      expect(t.passesCompleted).toBeLessThanOrEqual(t.passes);
      expect(t.shotsOnTarget).toBeLessThanOrEqual(t.shots);
    }
    expect(sum.teams[0].passes + sum.teams[1].passes).toBeGreaterThan(0);
    expect(sum.players.length).toBeGreaterThanOrEqual(22);
    for (const p of sum.players) {
      expect(p.rating).toBeGreaterThanOrEqual(RATING.min);
      expect(p.rating).toBeLessThanOrEqual(RATING.max);
    }
    expect(sum.playerOfMatch).not.toBeNull();
  });
});

describe('MOD-05 records', () => {
  const summary = (g0: number, g1: number, winner: number): MatchSummary => ({
    teams: [{ goals: g0 } as MatchSummary['teams'][0], { goals: g1 } as MatchSummary['teams'][1]],
    players: [], goals: [], playerOfMatch: null, shootout: null, winner, forfeit: -1, ticks: 0,
  });

  it('wins, draws, losses, goals, biggest win and streaks; saved with a schema', () => {
    const st = fakeSettings();
    recordResult(st, summary(3, 0, 0), 0, 4, 5);
    recordResult(st, summary(1, 1, -1), 0);
    recordResult(st, summary(0, 5, 1), 1, 6, 7); // human away wins 5-0
    recordResult(st, summary(2, 1, 0), 1); // human away loses 2-1
    const r = loadRecords(st);
    expect(r).toMatchObject({ played: 4, won: 2, drawn: 1, lost: 1, goalsFor: 3 + 1 + 5 + 1, goalsAgainst: 0 + 1 + 0 + 2, streak: 0, bestStreak: 1 });
    expect(r.biggestWin).toEqual({ goalsFor: 5, goalsAgainst: 0, club: 6, opponent: 7 });
    expect((st.loadProgress<{ schema: number }>(RECORDS_PROGRESS_KEY))!.schema).toBe(1);
    recordCupWon(st);
    expect(loadRecords(st).cupsWon).toBe(1);
    expect(recordResult(st, summary(1, 0, 0), -1).played).toBe(4);
  });

  it('a shoot-out win counts as a win; streaks count consecutive wins', () => {
    let r = emptyRecords();
    r = applyResult(r, { ...summary(1, 1, 0), shootout: [4, 2] }, 0);
    r = applyResult(r, summary(2, 0, 0), 0);
    expect([r.won, r.drawn, r.streak, r.bestStreak, r.goalsFor]).toEqual([2, 0, 2, 2, 3]);
  });

  it('malformed or foreign saves load as empty records', () => {
    expect(sanitizeRecords(null)).toEqual(emptyRecords());
    expect(sanitizeRecords({ schema: 99, played: 5 })).toEqual(emptyRecords());
    expect(sanitizeRecords({ played: -3, won: 'x', goalsFor: 2.7 })).toMatchObject({ played: 0, won: 0, goalsFor: 2 });
    expect(sanitizeRecords({ biggestWin: { goalsFor: 1, goalsAgainst: 3 } }).biggestWin).toBeNull();
  });

  it('recordMatch / withRecords: human side from the config; practice, CPU-only and quits never count', () => {
    const st = fakeSettings();
    const cfg = createMatchConfig();
    cfg.humans[0]!.side = 1;
    expect(humanSideOf(cfg)).toBe(1);
    expect(recordMatch(st, { config: cfg }, summary(0, 2, 1))!.won).toBe(1);
    expect(recordMatch(st, { config: cfg }, summary(0, 2, 1), true)).toBeNull();
    expect(recordMatch(st, { config: { ...cfg, mode: ModeId.PRACTICE, practice: PracticeKind.FREE_PLAY } }, summary(0, 2, 1))).toBeNull();
    const cpu = createMatchConfig();
    cpu.humans = [{ ...cpu.humans[1]! }, { ...cpu.humans[1]! }];
    expect(recordMatch(st, { config: cpu }, summary(1, 0, 0))).toBeNull();
    let inner = 0;
    const wrapped = withRecords<MatchSetup>(st, { config: cfg, bindings: [], onFinish: () => { inner++; } });
    expect(withRecords(st, wrapped)).toBe(wrapped);
    wrapped.onFinish!(summary(1, 3, 1), false);
    expect(inner).toBe(1);
    expect(loadRecords(st).played).toBe(2);
  });
});
