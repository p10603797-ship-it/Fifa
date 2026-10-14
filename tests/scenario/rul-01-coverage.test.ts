/**
 * RUL-01: every legal transition in contracts/transitions.ts is reachable through rulesTick flows (not just by
 * calling setPhase). Collaborators that are still Wave 0 stubs are stood in for at their documented contracts:
 * RUL-11 awardRestart (fill restart + setPhase(kind phase)), RUL-09 foulsTick (awards a free kick / penalty on
 * request) and RUL-07 shootoutTick (ends the shoot-out with a winner through setPhase).
 */
import { describe, expect, it, vi } from 'vitest';
import { CrossKind, MatchPhase, ModeId, Period, RestartKind } from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { LEGAL_TRANSITIONS } from '../../src/contracts/transitions';
import { createEventBuffer } from '../../src/sim/core/events';
import { rulesTick, setPhase } from '../../src/sim/rules/machine';
import { makeScenario, type ScenarioOptions } from '../harness/scenario';

const stand = vi.hoisted(() => ({
  setPhase: null as null | ((s: SimState, to: number, ev: EventSink) => void),
  awardRestart: null as null | ((s: SimState, kind: number, team: number, x: number, z: number, ev: EventSink) => void),
  foul: 0 as number, // RestartKind to award from foulsTick on the next tick (0 = none)
  shootoutTicks: 0,
}));

vi.mock('../../src/sim/rules/restart', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/sim/rules/restart')>();
  const PHASE_OF = [0, 1, 3, 4, 5, 6, 7];
  const award = (s: SimState, kind: number, team: number, x: number, z: number, ev: EventSink) => {
    const r = s.match.restart;
    r.kind = kind; r.team = team; r.x = x; r.z = z; r.t = 0; r.ready = 0; r.taken = 0;
    stand.setPhase!(s, PHASE_OF[kind]!, ev);
  };
  stand.awardRestart = award;
  return { ...mod, awardRestart: award };
});

vi.mock('../../src/sim/rules/fouls', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/sim/rules/fouls')>();
  return {
    ...mod,
    foulsTick: (s: SimState, ev: EventSink) => {
      if (stand.foul !== 0 && s.match.phase === MatchPhase.IN_PLAY) {
        const k = stand.foul;
        stand.foul = 0;
        stand.awardRestart!(s, k, 1, 30, 0, ev);
      }
    },
  };
});

vi.mock('../../src/sim/rules/shootout', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/sim/rules/shootout')>();
  return {
    ...mod,
    shootoutTick: (s: SimState, ev: EventSink) => {
      if (++stand.shootoutTicks >= 10) { s.match.shootout.winner = 0; stand.setPhase!(s, MatchPhase.POST_MATCH, ev); }
    },
  };
});

stand.setPhase = setPhase as (s: SimState, to: number, ev: EventSink) => void;

const seen = new Set<string>();
const EV = createEventBuffer();
const key = (a: number, b: number) => `${MatchPhase[a]}->${MatchPhase[b]}`;

/** One rulesTick with step()'s bookkeeping; `cross` is injected before the rules run. */
function tick(s: SimState, cross?: Partial<SimState['ball']>): SimEvent[] {
  s.tick++;
  EV.begin(s.tick);
  s.match.phaseT++;
  s.ball.cross = 0;
  if (cross) Object.assign(s.ball, cross);
  rulesTick(s, EV);
  const out = EV.toArray();
  for (const e of out) if (e.type === EventType.PHASE_CHANGE) seen.add(key(e.a, e.b));
  return out;
}

function until(s: SimState, phase: MatchPhase, n = 3000): void {
  for (let i = 0; i < n && s.match.phase !== phase; i++) tick(s);
  expect(MatchPhase[s.match.phase]).toBe(MatchPhase[phase]);
}

function scenario(opts: ScenarioOptions = {}): SimState {
  const s = makeScenario(opts);
  s.tick = 10000;
  return s;
}

const goal: Partial<SimState['ball']> = { cross: CrossKind.GOAL, crossX: 52.8, crossZ: 0, crossEnd: 1, lastTouch: 9, lastTouchTeam: 0, lastTouchTick: 9998 };
const touch: Partial<SimState['ball']> = { cross: CrossKind.TOUCHLINE, crossX: 5, crossZ: 34.3, crossEnd: 0, lastTouch: 9, lastTouchTeam: 0, lastTouchTick: 9998 };
const glKick: Partial<SimState['ball']> = { cross: CrossKind.GOAL_LINE, crossX: 52.8, crossZ: 10, crossEnd: 1, lastTouch: 9, lastTouchTeam: 0, lastTouchTick: 9998 };
const glCorner: Partial<SimState['ball']> = { cross: CrossKind.GOAL_LINE, crossX: 52.8, crossZ: 10, crossEnd: 1, lastTouch: 13, lastTouchTeam: 1, lastTouchTick: 9998 };

describe('RUL-01 every legal transition is reachable through rulesTick', () => {
  it('match start: PRE_MATCH -> KICK_OFF -> IN_PLAY, and PRE_MATCH -> SHOOT_OUT -> POST_MATCH', () => {
    const s = scenario();
    until(s, MatchPhase.KICK_OFF);
    until(s, MatchPhase.IN_PLAY);
    stand.shootoutTicks = 0;
    const so = scenario({ config: { startPhase: MatchPhase.SHOOT_OUT, mode: ModeId.SHOOT_OUT } });
    until(so, MatchPhase.SHOOT_OUT);
    until(so, MatchPhase.POST_MATCH);
    expect(so.match.winner).toBe(0);
    // [QF-1] PRE_MATCH -> IN_PLAY (config.startPhase IN_PLAY: practice, D-013): straight into play, ball on the spot.
    const ip = scenario({ config: { startPhase: MatchPhase.IN_PLAY, mode: ModeId.PRACTICE } });
    until(ip, MatchPhase.IN_PLAY);
    expect(ip.match.prevPhase).toBe(MatchPhase.PRE_MATCH);
    expect([ip.ball.x, ip.ball.z, ip.match.restart.kind]).toEqual([0, 0, RestartKind.NONE]);
  });

  it('restarts from play and back: THROW_IN, GOAL_KICK, CORNER via line crossings; FREE_KICK, PENALTY via fouls', () => {
    const cases: [Partial<SimState['ball']> | null, number, MatchPhase][] = [
      [touch, 0, MatchPhase.THROW_IN], [glKick, 0, MatchPhase.GOAL_KICK], [glCorner, 0, MatchPhase.CORNER],
      [null, RestartKind.FREE_KICK, MatchPhase.FREE_KICK], [null, RestartKind.PENALTY, MatchPhase.PENALTY],
    ];
    for (const [cross, foul, phase] of cases) {
      const s = scenario({ phase: MatchPhase.IN_PLAY });
      s.match.periodT = 100;
      stand.foul = foul;
      // A foul awarded first in the tick wins over a crossing in the same tick.
      tick(s, cross ?? goal);
      expect(MatchPhase[s.match.phase]).toBe(MatchPhase[phase]);
      if (!cross) expect(s.teams[0]!.goals).toBe(0);
      s.match.restart.taken = 1;
      tick(s);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    }
  });

  it('time up during each non-penalty restart -> HALF_TIME (first half) / FULL_TIME (second half)', () => {
    for (const [phase, kind] of [[MatchPhase.THROW_IN, 2], [MatchPhase.GOAL_KICK, 3], [MatchPhase.CORNER, 4], [MatchPhase.FREE_KICK, 5]] as const) {
      for (const period of [Period.FIRST_HALF, Period.SECOND_HALF]) {
        const s = scenario({ phase, match: { period } });
        s.match.restart.kind = kind;
        s.match.periodT = s.match.periodLen;
        tick(s);
        expect(s.match.phase).toBe(period === Period.FIRST_HALF ? MatchPhase.HALF_TIME : MatchPhase.FULL_TIME);
      }
    }
  });

  it('forfeits from KICK_OFF, IN_PLAY, every restart incl. PENALTY, and REPLAY -> FULL_TIME -> POST_MATCH', () => {
    for (const phase of [MatchPhase.KICK_OFF, MatchPhase.IN_PLAY, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER, MatchPhase.FREE_KICK, MatchPhase.PENALTY, MatchPhase.REPLAY]) {
      const s = scenario({ phase });
      s.match.goalTick = s.tick;
      s.match.forfeitTeam = 1;
      tick(s);
      expect(MatchPhase[s.match.phase]).toBe('FULL_TIME');
      until(s, MatchPhase.POST_MATCH);
    }
  });

  it('goal sequence to a kick-off, to half time and to full time', () => {
    for (const [period, end] of [[Period.FIRST_HALF, null], [Period.FIRST_HALF, MatchPhase.HALF_TIME], [Period.SECOND_HALF, MatchPhase.FULL_TIME]] as const) {
      const s = scenario({ phase: MatchPhase.IN_PLAY, match: { period }, config: { replaySeconds: 1 } });
      s.match.periodT = end === null ? 100 : s.match.periodLen;
      tick(s, goal);
      expect(s.match.phase).toBe(MatchPhase.GOAL);
      until(s, MatchPhase.CELEBRATION);
      until(s, MatchPhase.REPLAY);
      until(s, end ?? MatchPhase.KICK_OFF);
    }
  });

  it('play -> HALF_TIME -> KICK_OFF; play -> FULL_TIME -> EXTRA_TIME -> KICK_OFF; ET2 level -> FULL_TIME -> SHOOT_OUT -> POST_MATCH', () => {
    const s = scenario({ phase: MatchPhase.IN_PLAY, config: { cupRules: 1 } });
    s.match.periodT = s.match.periodLen;
    tick(s);
    expect(s.match.phase).toBe(MatchPhase.HALF_TIME);
    until(s, MatchPhase.KICK_OFF);
    s.match.restart.taken = 1;
    tick(s);
    s.match.periodT = s.match.periodLen;
    tick(s);
    expect(s.match.phase).toBe(MatchPhase.FULL_TIME);
    until(s, MatchPhase.EXTRA_TIME);
    until(s, MatchPhase.KICK_OFF);
    s.match.restart.taken = 1;
    tick(s);
    s.match.periodT = s.match.periodLen;
    tick(s);
    until(s, MatchPhase.KICK_OFF); // ET half time
    s.match.restart.taken = 1;
    tick(s);
    s.match.periodT = s.match.periodLen;
    tick(s);
    expect(s.match.phase).toBe(MatchPhase.FULL_TIME);
    stand.shootoutTicks = 0;
    until(s, MatchPhase.SHOOT_OUT);
    until(s, MatchPhase.POST_MATCH);
    expect([s.match.finished, s.match.winner]).toEqual([1, 0]);
  });

  it('covers every legal transition of contracts/transitions.ts (runs last)', () => {
    const missing: string[] = [];
    for (let from = MatchPhase.PRE_MATCH; from <= MatchPhase.POST_MATCH; from++) {
      for (const to of LEGAL_TRANSITIONS[from as MatchPhase]) if (!seen.has(key(from, to))) missing.push(key(from, to));
    }
    expect(missing).toEqual([]);
    expect(seen.size).toBe(Object.values(LEGAL_TRANSITIONS).reduce((n, l) => n + l.length, 0));
  });
});
