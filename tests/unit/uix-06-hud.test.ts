/**
 * UIX-06: scoreboard formatting helpers, the period label, the displayed minute, the toast queue and the toast text
 * for each sim event (pure parts of src/ui/hud/scoreboard.ts, toasts.ts and hudShared.ts; Node, no DOM).
 */
import { describe, expect, it } from 'vitest';
import { CardKind, MatchPhase, ModeId, Period, PracticeKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { CLUBS } from '../../src/data/clubs';
import { minuteLabel } from '../../src/ui/hud/hudShared';
import {
  BoardMode, addedStr, boardMode, clockMinStr, clockSecStr, formatClock, kitHex, numStr, periodLabel, type BoardContext,
} from '../../src/ui/hud/scoreboard';
import {
  TOAST_CLEAR, TOAST_LEAVE, TOAST_SHOW, TOAST_TUNING, ToastQueue, currentMinute, rosterName, toastForEvent, type ToastSpec,
} from '../../src/ui/hud/toasts';
import { makeScenario } from '../harness/scenario';

function ev(type: EventType, a = 0, b = 0, c = 0, d = 0): SimEvent {
  return { type, tick: 0, a, b, c, d, x: 0, y: 0, z: 0 };
}

function board(over: Partial<BoardContext> = {}): BoardContext {
  return { period: Period.FIRST_HALF, phase: MatchPhase.IN_PLAY, mode: ModeId.KICK_OFF, practice: PracticeKind.NONE, shootoutActive: 0, ...over };
}

describe('UIX-06 scoreboard formatting', () => {
  it('formats the clock as mm:ss with two-digit fields (three-digit minutes in extra time)', () => {
    expect(formatClock(0, 0)).toBe('00:00');
    expect(formatClock(7, 5)).toBe('07:05');
    expect(formatClock(45, 0)).toBe('45:00');
    expect(formatClock(93, 59)).toBe('93:59');
    expect(formatClock(105, 30)).toBe('105:30');
    expect(formatClock(12.9, 59.9)).toBe('12:59');
  });

  it('clock strings are cached (same string object per value: no allocation per frame)', () => {
    expect(clockMinStr(23)).toBe(clockMinStr(23));
    expect(clockSecStr(7)).toBe(clockSecStr(7));
    expect(numStr(3)).toBe(numStr(3));
  });

  it('clamps broken values instead of printing NaN', () => {
    expect(clockMinStr(Number.NaN)).toBe('00');
    expect(clockSecStr(-4)).toBe('00');
    expect(clockSecStr(75)).toBe('59');
    expect(numStr(Number.POSITIVE_INFINITY)).toBe('0');
    expect(numStr(250)).toBe('199');
  });

  it('shows +N added time only when there is some', () => {
    expect(addedStr(0)).toBe('');
    expect(addedStr(-1)).toBe('');
    expect(addedStr(3)).toBe('+3');
    expect(addedStr(4.7)).toBe('+4');
    expect(addedStr(99)).toBe('+30');
  });

  it('labels the periods: none in normal time, HT / FT at the breaks, ET in extra time, PENS, PRACTICE', () => {
    expect(periodLabel(board())).toBe('');
    expect(periodLabel(board({ period: Period.SECOND_HALF }))).toBe('');
    expect(periodLabel(board({ phase: MatchPhase.HALF_TIME }))).toBe('HT');
    expect(periodLabel(board({ phase: MatchPhase.FULL_TIME, period: Period.SECOND_HALF }))).toBe('FT');
    expect(periodLabel(board({ phase: MatchPhase.POST_MATCH }))).toBe('FT');
    expect(periodLabel(board({ phase: MatchPhase.EXTRA_TIME }))).toBe('ET');
    expect(periodLabel(board({ period: Period.ET_FIRST }))).toBe('ET');
    expect(periodLabel(board({ period: Period.ET_SECOND }))).toBe('ET');
    expect(periodLabel(board({ period: Period.SHOOT_OUT, phase: MatchPhase.SHOOT_OUT }))).toBe('PENS');
    expect(periodLabel(board({ mode: ModeId.PRACTICE, practice: PracticeKind.FREE_PLAY }))).toBe('PRACTICE');
  });

  it('board mode: clock in a match, shoot-out tally in a shoot-out (match or mode), practice has no clock', () => {
    expect(boardMode(board())).toBe(BoardMode.CLOCK);
    expect(boardMode(board({ period: Period.SHOOT_OUT }))).toBe(BoardMode.PENS);
    expect(boardMode(board({ shootoutActive: 1 }))).toBe(BoardMode.PENS);
    expect(boardMode(board({ mode: ModeId.SHOOT_OUT }))).toBe(BoardMode.PENS);
    expect(boardMode(board({ mode: ModeId.PRACTICE }))).toBe(BoardMode.PRACTICE);
  });

  it('kit colours become #rrggbb', () => {
    expect(kitHex(0xff6b35)).toBe('#ff6b35');
    expect(kitHex(0x00000a)).toBe('#00000a');
    expect(kitHex(0x1ff6b35)).toBe('#ff6b35');
  });
});

describe('UIX-06 displayed minute', () => {
  it('is the minute in progress, with added time after the period end', () => {
    expect(minuteLabel(0, 30, Period.FIRST_HALF)).toBe("1'");
    expect(minuteLabel(22, 10, Period.FIRST_HALF)).toBe("23'");
    expect(minuteLabel(44, 59, Period.FIRST_HALF)).toBe("45'");
    expect(minuteLabel(45, 0, Period.FIRST_HALF)).toBe("45+1'");
    expect(minuteLabel(46, 20, Period.FIRST_HALF)).toBe("45+2'");
    expect(minuteLabel(45, 0, Period.SECOND_HALF)).toBe("46'");
    expect(minuteLabel(91, 0, Period.SECOND_HALF)).toBe("90+2'");
    expect(minuteLabel(104, 0, Period.ET_FIRST)).toBe("105'");
    expect(minuteLabel(121, 0, Period.ET_SECOND)).toBe("120+2'");
  });

  it('reads the live clock of a state (scaled halves)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    s.match.periodT = Math.floor(s.match.periodLen / 3); // 15:00 displayed
    expect(currentMinute(s)).toBe("16'");
  });
});

function spec(kind: ToastSpec['kind'], lifeMs = 1000, title: string = kind): ToastSpec {
  return { kind, title, code: '', line: '', sub: '', minute: '', team: -1, lifeMs };
}

describe('UIX-06 toast queue', () => {
  it('shows one toast at a time in order, fades it out before its life ends, then clears', () => {
    const q = new ToastQueue<ToastSpec>(4, 200);
    q.push(spec('goal', 1000, 'A'));
    q.push(spec('offside', 1000, 'B'));
    expect(q.advance(16)).toBe(TOAST_SHOW);
    expect(q.current?.title).toBe('A');
    expect(q.advance(700)).toBe(0);
    expect(q.advance(100)).toBe(TOAST_LEAVE); // 816 >= 1000 - 200
    expect(q.isLeaving).toBe(true);
    expect(q.advance(150)).toBe(0);
    expect(q.advance(100)).toBe(TOAST_SHOW); // A done, B starts
    expect(q.current?.title).toBe('B');
    expect(q.advance(800)).toBe(TOAST_LEAVE);
    expect(q.advance(300)).toBe(TOAST_CLEAR);
    expect(q.current).toBeNull();
    expect(q.advance(16)).toBe(0); // idle: nothing to write
  });

  it('a huge frame step skips straight to the next toast without a stale fade flag', () => {
    const q = new ToastQueue<ToastSpec>(4, 200);
    q.push(spec('goal', 1000, 'A'));
    q.push(spec('sub', 1000, 'B'));
    q.advance(1);
    expect(q.advance(5000)).toBe(TOAST_SHOW);
    expect(q.current?.title).toBe('B');
    expect(q.advance(5000)).toBe(TOAST_CLEAR);
  });

  it('ignores negative and non-finite frame steps (a paused match freezes the toast)', () => {
    const q = new ToastQueue<ToastSpec>(4, 200);
    q.push(spec('goal', 1000));
    q.advance(10);
    expect(q.advance(-50)).toBe(0);
    expect(q.advance(Number.NaN)).toBe(0);
    expect(q.current).not.toBeNull();
  });

  it('when full, drops the oldest waiting non-goal and keeps goals', () => {
    const q = new ToastQueue<ToastSpec>(3, 200);
    q.push(spec('goal', 1000, 'G1'));
    q.advance(1); // G1 on screen
    q.push(spec('offside', 1000, 'O1'));
    q.push(spec('goal', 1000, 'G2'));
    q.push(spec('sub', 1000, 'S1'));
    q.push(spec('yellow', 1000, 'Y1')); // full: O1 goes
    expect(q.pending).toBe(3);
    expect(q.dropped).toBe(1);
    const order: string[] = [];
    for (let i = 0; i < 10 && (q.current || q.pending); i++) {
      if (q.advance(1000) & TOAST_SHOW) order.push(q.current!.title);
    }
    expect(order).toEqual(['G2', 'S1', 'Y1']);
  });

  it('a full queue of goals drops a new non-goal, but a new goal replaces the oldest goal', () => {
    const q = new ToastQueue<ToastSpec>(2, 200);
    q.push(spec('goal', 1000, 'G1'));
    q.push(spec('goal', 1000, 'G2'));
    q.push(spec('offside', 1000, 'O'));
    expect(q.pending).toBe(2);
    q.push(spec('goal', 1000, 'G3'));
    q.advance(1);
    expect(q.current?.title).toBe('G2');
  });

  it('uses the tuned lives: goals longer than the others', () => {
    expect(TOAST_TUNING.goalLifeMs).toBeGreaterThan(TOAST_TUNING.lifeMs);
    expect(TOAST_TUNING.lifeMs).toBeGreaterThanOrEqual(2000);
    expect(TOAST_TUNING.goalLifeMs).toBeLessThanOrEqual(3000);
  });
});

describe('UIX-06 toast content per event', () => {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY });
  s.match.periodT = Math.floor(s.match.periodLen / 2); // 22:30 -> 23'
  const scorer = 9;
  const scorerName = rosterName(s, 0, s.players[scorer]!.rosterIdx);
  const homeCode = CLUBS[s.teams[0]!.clubIdx]!.code;
  const awayCode = CLUBS[s.teams[1]!.clubIdx]!.code;

  it('GOAL: team code, scorer and minute', () => {
    const t = toastForEvent(ev(EventType.GOAL, 0, scorer, -1, 0), s, CLUBS)!;
    expect(t.kind).toBe('goal');
    expect(t.title).toBe('GOAL');
    expect(t.code).toBe(homeCode);
    expect(scorerName.length).toBeGreaterThan(0);
    expect(t.line).toBe(scorerName);
    expect(t.minute).toBe("23'");
    expect(t.team).toBe(0);
    expect(t.lifeMs).toBe(TOAST_TUNING.goalLifeMs);
  });

  it('GOAL: an own goal credits the scoring team and marks the player (OG)', () => {
    const t = toastForEvent(ev(EventType.GOAL, 1, scorer, -1, 1), s, CLUBS)!;
    expect(t.code).toBe(awayCode);
    expect(t.line).toBe(`${scorerName} (OG)`);
  });

  it('CARD: yellow, red and second yellow name the player and his team', () => {
    const slot = 14;
    const name = rosterName(s, 1, s.players[slot]!.rosterIdx);
    const y = toastForEvent(ev(EventType.CARD, slot, CardKind.YELLOW), s, CLUBS)!;
    expect(y).toMatchObject({ kind: 'yellow', title: 'YELLOW CARD', code: awayCode, line: name, team: 1 });
    const r = toastForEvent(ev(EventType.CARD, slot, CardKind.RED), s, CLUBS)!;
    expect(r).toMatchObject({ kind: 'red', title: 'RED CARD', line: name, sub: 'Sent off' });
    const y2 = toastForEvent(ev(EventType.CARD, slot, CardKind.SECOND_YELLOW), s, CLUBS)!;
    expect(y2).toMatchObject({ kind: 'red', title: 'SECOND YELLOW', sub: 'Sent off' });
    expect(toastForEvent(ev(EventType.CARD, slot, CardKind.NONE), s, CLUBS)).toBeNull();
  });

  it('SUBSTITUTION: player coming on and player going off (from the event, else the roster seen before)', () => {
    const inName = rosterName(s, 0, 13);
    const outName = rosterName(s, 0, 7);
    const t = toastForEvent(ev(EventType.SUBSTITUTION, 0, 7, 13, 7), s, CLUBS)!;
    expect(t).toMatchObject({ kind: 'sub', title: 'SUBSTITUTION', code: homeCode, line: inName, sub: outName });
    const fallback = toastForEvent(ev(EventType.SUBSTITUTION, 0, 7, 13, 13), s, CLUBS, 7)!;
    expect(fallback.sub).toBe(outName);
    const unknown = toastForEvent(ev(EventType.SUBSTITUTION, 0, 7, 13, 13), s, CLUBS, -1)!;
    expect(unknown.sub).toBe('');
    expect(toastForEvent(ev(EventType.SUBSTITUTION, 5, 7, 13, 7), s, CLUBS)).toBeNull();
  });

  it('OFFSIDE names the player', () => {
    const t = toastForEvent(ev(EventType.OFFSIDE, 10), s, CLUBS)!;
    expect(t).toMatchObject({ kind: 'offside', title: 'OFFSIDE', code: homeCode, line: rosterName(s, 0, s.players[10]!.rosterIdx) });
  });

  it('ADVANTAGE: shown when it starts and when it is brought back, not when play simply goes on', () => {
    expect(toastForEvent(ev(EventType.ADVANTAGE, 1, 1), s, CLUBS)).toMatchObject({ kind: 'advantage', line: 'Play on', code: awayCode });
    expect(toastForEvent(ev(EventType.ADVANTAGE, 2, 0), s, CLUBS)).toMatchObject({ kind: 'advantage', line: 'Brought back' });
    expect(toastForEvent(ev(EventType.ADVANTAGE, 0, 0), s, CLUBS)).toBeNull();
  });

  it('FORFEIT names the club', () => {
    const t = toastForEvent(ev(EventType.FORFEIT, 1), s, CLUBS)!;
    expect(t.kind).toBe('forfeit');
    expect(t.line).toBe(`${CLUBS[s.teams[1]!.clubIdx]!.name} forfeit`);
    expect(t.lifeMs).toBe(TOAST_TUNING.forfeitLifeMs);
  });

  it('other events make no toast', () => {
    for (const type of [EventType.KICK, EventType.SHOT, EventType.WHISTLE, EventType.SAVE, EventType.PHASE_CHANGE]) {
      expect(toastForEvent(ev(type, 1, 2, 3), s, CLUBS)).toBeNull();
    }
  });

  it('bad slots give empty names, never a crash', () => {
    expect(toastForEvent(ev(EventType.OFFSIDE, 99), s, CLUBS)!.line).toBe('');
    expect(toastForEvent(ev(EventType.GOAL, 0, -1, -1, 0), s, CLUBS)!.line).toBe('');
  });
});
