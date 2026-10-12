/**
 * RUL-01: the table-driven match state machine (setPhase / setPhaseSafe) against contracts/transitions.ts.
 * Every legal transition is accepted (PHASE_CHANGE a=from b=to, prevPhase, phaseT = 0); every illegal one throws in
 * test builds (__DEV_BUILD__) and is refused + logged as WATCHDOG by the non-throwing path.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase, ModeId, RestartKind, WatchdogReason } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { CLOCK_PHASES, LEGAL_TRANSITIONS, isLegalTransition } from '../../src/contracts/transitions';
import { createEventBuffer } from '../../src/sim/core/events';
import { setPhase, setPhaseSafe } from '../../src/sim/rules/machine';
import { makeScenario } from '../harness/scenario';

const ALL: MatchPhase[] = [];
for (let p = MatchPhase.PRE_MATCH; p <= MatchPhase.POST_MATCH; p++) ALL.push(p);
const name = (p: number): string => MatchPhase[p] ?? String(p);

function at(phase: MatchPhase, mode: ModeId = ModeId.KICK_OFF) {
  const s = makeScenario({ phase, config: { mode } });
  s.match.phaseT = 37;
  const ev = createEventBuffer();
  ev.begin(s.tick);
  return { s, ev };
}

describe('RUL-01 setPhase: legal transitions', () => {
  for (const from of ALL) {
    for (const to of LEGAL_TRANSITIONS[from]) {
      it(`${name(from)} -> ${name(to)} is accepted`, () => {
        const { s, ev } = at(from);
        setPhase(s, to, ev);
        expect(s.match.phase).toBe(to);
        expect(s.match.prevPhase).toBe(from);
        expect(s.match.phaseT).toBe(0);
        const pcs = ev.toArray().filter((e) => e.type === EventType.PHASE_CHANGE);
        expect(pcs).toHaveLength(1);
        expect([pcs[0]!.a, pcs[0]!.b]).toEqual([from, to]);
        expect(s.match.clockRunning).toBe(CLOCK_PHASES.includes(to) ? 1 : 0);
      });
    }
  }
});

describe('RUL-01 setPhase: illegal transitions', () => {
  const illegal: [MatchPhase, MatchPhase][] = [];
  for (const from of ALL) for (const to of ALL) if (!isLegalTransition(from, to)) illegal.push([from, to]);

  it('there are illegal pairs to test (sanity)', () => {
    expect(illegal.length).toBeGreaterThan(150);
  });

  it('every illegal transition throws in test builds and leaves the state untouched', () => {
    for (const [from, to] of illegal) {
      const { s, ev } = at(from);
      expect(() => setPhase(s, to, ev), `${name(from)} -> ${name(to)}`).toThrow(/illegal phase transition/);
      expect(s.match.phase).toBe(from);
      expect(s.match.phaseT).toBe(37);
      expect(ev.count).toBe(0);
    }
  });

  it('the shipped-game path refuses an illegal transition, counts it and logs WATCHDOG', () => {
    for (const [from, to] of illegal) {
      const { s, ev } = at(from);
      const before = s.match.watchdogCount;
      expect(setPhaseSafe(s, to, ev)).toBe(0);
      expect(s.match.phase).toBe(from);
      expect(s.match.watchdogCount).toBe(before + 1);
      const evs = ev.toArray();
      expect(evs).toHaveLength(1);
      expect(evs[0]!.type).toBe(EventType.WATCHDOG);
      expect(evs[0]!.a).toBe(WatchdogReason.OTHER);
      expect([evs[0]!.b, evs[0]!.c]).toEqual([from, to]);
    }
  });

  it('a corrupt phase value is never a legal source or target', () => {
    const { s, ev } = at(MatchPhase.IN_PLAY);
    expect(() => setPhase(s, 99 as MatchPhase, ev)).toThrow();
    s.match.phase = -1 as MatchPhase;
    expect(setPhaseSafe(s, MatchPhase.IN_PLAY, ev)).toBe(0);
  });

  it('setPhaseSafe performs legal transitions like setPhase', () => {
    const { s, ev } = at(MatchPhase.GOAL);
    expect(setPhaseSafe(s, MatchPhase.CELEBRATION, ev)).toBe(1);
    expect(s.match.phase).toBe(MatchPhase.CELEBRATION);
  });
});

describe('RUL-01 setPhase: bookkeeping', () => {
  it('entering IN_PLAY clears the pending restart kind', () => {
    const { s, ev } = at(MatchPhase.CORNER);
    s.match.restart.kind = RestartKind.CORNER;
    setPhase(s, MatchPhase.IN_PLAY, ev);
    expect(s.match.restart.kind).toBe(RestartKind.NONE);
  });

  it('entering POST_MATCH marks the result final and stops the clock', () => {
    const { s, ev } = at(MatchPhase.FULL_TIME);
    setPhase(s, MatchPhase.POST_MATCH, ev);
    expect(s.match.finished).toBe(1);
    expect(s.match.clockRunning).toBe(0);
  });

  it('a shoot-out ending in POST_MATCH takes the shoot-out winner when none was set', () => {
    const { s, ev } = at(MatchPhase.SHOOT_OUT);
    s.match.shootout.winner = 1;
    setPhase(s, MatchPhase.POST_MATCH, ev);
    expect(s.match.winner).toBe(1);
    expect(s.match.finished).toBe(1);
  });

  it('the clock is never marked running in practice mode', () => {
    const { s, ev } = at(MatchPhase.KICK_OFF, ModeId.PRACTICE);
    setPhase(s, MatchPhase.IN_PLAY, ev);
    expect(s.match.clockRunning).toBe(0);
  });
});
