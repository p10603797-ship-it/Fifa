/**
 * RUL-01: clock, added time, period ends (with the half-end deferral rules), half time, extra time, shoot-out entry,
 * friendly draws, forfeits, practice mode and displayClock.
 *
 * Period-end deferral is driven with rulesTick directly (tickRules) so other modules cannot move the ball; whole
 * periods and matches run through the real step() pipeline with the invariant checker.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { KickKind, MatchPhase, ModeId, Period, RestartKind } from '../../src/contracts/enums';
import { EventType, WhistleKind, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLOCK_PHASES } from '../../src/contracts/transitions';
import { T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { periodLength } from '../../src/sim/init';
import { LOCAL_TUNING, advanceCutscene, displayClock, isTimeUp, rulesTick } from '../../src/sim/rules/machine';
import { findEvents, makeScenario, runTicks, runUntil, type ScenarioOptions } from '../harness/scenario';

const EV = createEventBuffer();

/** One rulesTick with step()'s bookkeeping (tick, events, phaseT, cross reset). Returns that tick's events. */
function tickRules(s: SimState): SimEvent[] {
  s.tick++;
  EV.begin(s.tick);
  s.match.phaseT++;
  s.ball.cross = 0;
  rulesTick(s, EV);
  return EV.toArray();
}

/** Tick rules until pred or n ticks; returns all events and whether pred held. */
function rulesUntil(s: SimState, pred: (s: SimState) => boolean, n: number, each?: (s: SimState) => void): { events: SimEvent[]; reached: boolean } {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    if (each) each(s);
    events.push(...tickRules(s));
    if (pred(s)) return { events, reached: true };
  }
  return { events, reached: false };
}

const clock = { min: 0, sec: 0, added: 0, period: 0 };
function shown(s: SimState): string {
  displayClock(s, clock);
  return `${clock.min}:${String(clock.sec).padStart(2, '0')}${clock.added > 0 ? `+${clock.added}` : ''}`;
}

/** IN_PLAY with the given ticks left in the period, ball loose at rest on the centre spot. */
function nearEnd(left: number, opts: ScenarioOptions = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 0, y: 0.11, z: 0 }, ...opts });
  s.tick = 20000;
  s.match.periodT = s.match.periodLen - left;
  if (opts.match) Object.assign(s.match, opts.match, { periodT: (opts.match.periodLen ?? s.match.periodLen) - left });
  return s;
}

/** Keep a restart in its setup delay (RUL-11 / kind modules wait), so only the machine acts on it. */
function holdRestart(s: SimState): void {
  const r = s.match.restart;
  r.t = 0; r.ready = 0; r.taken = 0;
  s.match.phaseT = 0;
}

const isEnd = (s: SimState) => s.match.phase === MatchPhase.HALF_TIME || s.match.phase === MatchPhase.FULL_TIME;

// ================================================================ displayClock

describe('RUL-01 displayClock', () => {
  it('maps every half length (2..10 real minutes) to 45:00 halves and 15:00 extra-time periods', () => {
    for (let hm = 2; hm <= 10; hm++) {
      const s = makeScenario({ config: { halfMinutes: hm } });
      const m = s.match;
      for (const [period, base, lenMin] of [[1, 0, 45], [2, 45, 45], [3, 90, 15], [4, 105, 15]] as const) {
        m.period = period;
        m.periodLen = periodLength(s.config, period);
        m.addedT = 0;
        m.periodT = 0;
        expect(shown(s), `${hm} min, period ${period} start`).toBe(`${base}:00`);
        m.periodT = m.periodLen / 2;
        expect(shown(s)).toBe(`${base + lenMin / 2 - (lenMin % 2 ? 0.5 : 0)}:${lenMin % 2 ? '30' : '00'}`);
        m.periodT = m.periodLen;
        expect(shown(s), `${hm} min, period ${period} end`).toBe(`${base + lenMin}:00`);
        expect(clock.period).toBe(period);
      }
    }
  });

  it('added minutes appear only after regulation time, rounded up, capped at addedTimeMaxMinutes; seconds run on', () => {
    const s = makeScenario({ config: { halfMinutes: 4 } });
    const m = s.match;
    const perMin = m.periodLen / 45; // ticks per displayed minute (320)
    m.addedT = perMin * 2 + 1; // a bit over 2 displayed minutes
    m.periodT = m.periodLen - 1;
    expect(shown(s)).toBe('44:59');
    m.periodT = m.periodLen;
    expect(shown(s)).toBe('45:00+3');
    m.periodT = m.periodLen + perMin + perMin / 2;
    expect(shown(s)).toBe('46:30+3');
    m.addedT = perMin * 2;
    expect(shown(s)).toBe('46:30+2');
    m.addedT = perMin * 30;
    expect(clock.added).toBeLessThanOrEqual(T_RULES.addedTimeMaxMinutes);
    displayClock(s, clock);
    expect(clock.added).toBe(T_RULES.addedTimeMaxMinutes);
  });

  it('second half and extra time bases (45, 90, 105) and the shoot-out', () => {
    const s = makeScenario({ config: { halfMinutes: 3 } });
    const m = s.match;
    m.period = Period.SECOND_HALF; m.periodLen = periodLength(s.config, 2); m.periodT = m.periodLen / 3;
    expect(shown(s)).toBe('60:00');
    m.period = Period.ET_SECOND; m.periodLen = periodLength(s.config, 4); m.periodT = m.periodLen / 3;
    expect(shown(s)).toBe('110:00');
    m.period = Period.SHOOT_OUT;
    expect(shown(s)).toBe('120:00');
    const so = makeScenario({ config: { mode: ModeId.SHOOT_OUT } });
    so.match.period = Period.SHOOT_OUT;
    expect(shown(so)).toBe('0:00');
  });

  it('is pure and safe on a zero period length', () => {
    const s = makeScenario();
    s.match.periodLen = 0;
    s.match.periodT = 500;
    const before = JSON.stringify(s.match);
    expect(shown(s)).toBe('0:00');
    expect(JSON.stringify(s.match)).toBe(before);
  });
});

// ================================================================ clock running

describe('RUL-01 clock', () => {
  it('glitch "timer drift": the clock advances exactly one tick per clock-phase tick and shows 45:00 at periodLen', () => {
    const s = makeScenario({ config: { halfMinutes: 2 } });
    let clockTicks = 0;
    let prevShown = -1;
    let at45 = '';
    const { reached, events } = runUntil(s, (st, tickEv) => {
      const m = st.match;
      if (CLOCK_PHASES.includes(m.prevPhase) || CLOCK_PHASES.includes(m.phase)) { /* counted below */ }
      displayClock(st, clock);
      const total = clock.min * 60 + clock.sec;
      expect(total).toBeGreaterThanOrEqual(prevShown);
      if (prevShown >= 0) expect(total - prevShown).toBeLessThanOrEqual(1);
      prevShown = total;
      if (m.periodT === m.periodLen && at45 === '') at45 = `${clock.min}:${String(clock.sec).padStart(2, '0')}`;
      void tickEv;
      return m.phase === MatchPhase.HALF_TIME;
    }, 9000, (_tick, st) => {
      if (CLOCK_PHASES.includes(st.match.phase)) clockTicks++;
    }, 'core');
    expect(reached).toBe(true);
    // Every tick that started in a clock phase advanced the clock by exactly one.
    expect(s.match.periodT).toBe(clockTicks);
    expect(at45).toBe('45:00');
    const end = findEvents(events, EventType.PERIOD_END);
    expect(end).toHaveLength(1);
    expect(s.match.periodT).toBeGreaterThanOrEqual(s.match.periodLen + s.match.addedT);
  });

  it('clock never runs backwards and stops outside clock phases over a whole cup match', () => {
    const s = makeScenario({ config: { halfMinutes: 2, cupRules: 1 } });
    let lastPeriod = s.match.period;
    let lastT = s.match.periodT;
    const { reached } = runUntil(s, (st) => {
      const m = st.match;
      if (m.period === lastPeriod) expect(m.periodT).toBeGreaterThanOrEqual(lastT);
      else expect(m.period).toBeGreaterThan(lastPeriod);
      if (!CLOCK_PHASES.includes(m.phase) && m.phase === m.prevPhase && m.period === lastPeriod && m.phaseT > 0) {
        expect(m.periodT).toBe(lastT);
      }
      lastPeriod = m.period;
      lastT = m.periodT;
      return m.phase === MatchPhase.SHOOT_OUT || m.phase === MatchPhase.POST_MATCH;
    }, 40000, undefined, 'core');
    expect(reached).toBe(true);
    // Level after 90 minutes (no goals while SIM-03 line detection is a stub) -> extra time -> shoot-out.
    if (s.teams[0]!.goals === s.teams[1]!.goals) {
      expect(s.match.phase).toBe(MatchPhase.SHOOT_OUT);
      expect(s.match.period).toBe(Period.SHOOT_OUT);
    } else {
      expect(s.match.phase).toBe(MatchPhase.POST_MATCH);
    }
  });

  it('added time accrues at addedTimeScale per restart-phase tick of regulation, is capped, and is frozen afterwards', () => {
    const s = makeScenario({ phase: MatchPhase.THROW_IN, config: { halfMinutes: 4 } });
    s.match.restart.kind = RestartKind.THROW_IN;
    s.match.periodT = 1000;
    for (let i = 0; i < 100; i++) { holdRestart(s); tickRules(s); }
    expect(s.match.phase).toBe(MatchPhase.THROW_IN);
    expect(s.match.addedT).toBe(100 * T_RULES.addedTimeScale);
    expect(s.match.periodT).toBe(1100);
    // In play: no accrual.
    s.match.phase = MatchPhase.IN_PLAY;
    s.match.restart.kind = RestartKind.NONE;
    for (let i = 0; i < 50; i++) tickRules(s);
    expect(s.match.addedT).toBe(50);
    // Capped at addedTimeMaxMinutes displayed.
    const cap = (T_RULES.addedTimeMaxMinutes * 60 * s.match.periodLen) / 2700;
    s.match.addedT = cap - 2;
    s.match.phase = MatchPhase.FREE_KICK;
    s.match.restart.kind = RestartKind.FREE_KICK;
    for (let i = 0; i < 10; i++) { holdRestart(s); tickRules(s); }
    expect(s.match.addedT).toBe(cap);
    displayClock(s, clock);
    // Frozen after regulation (no more accrual while the added time is played).
    s.match.addedT = 100;
    s.match.periodT = s.match.periodLen + 1;
    s.ball.x = 0;
    s.match.phase = MatchPhase.PENALTY; // never ends during a penalty: lets us watch accrual
    s.match.restart.kind = RestartKind.PENALTY;
    for (let i = 0; i < 30; i++) { holdRestart(s); tickRules(s); }
    expect(s.match.phase).toBe(MatchPhase.PENALTY);
    expect(s.match.addedT).toBe(100);
  });

  it('the kick-off that opens a period adds no stoppage; a kick-off after a goal does', () => {
    for (const [prev, expected] of [[MatchPhase.PRE_MATCH, 0], [MatchPhase.HALF_TIME, 0], [MatchPhase.EXTRA_TIME, 0], [MatchPhase.REPLAY, 20 * T_RULES.addedTimeScale]] as const) {
      const s = makeScenario({ phase: MatchPhase.KICK_OFF });
      s.match.prevPhase = prev;
      s.match.restart.kind = RestartKind.KICK_OFF;
      s.match.periodT = 500;
      for (let i = 0; i < 20; i++) { holdRestart(s); tickRules(s); }
      expect(s.match.periodT, MatchPhase[prev]).toBe(520);
      expect(s.match.addedT, MatchPhase[prev]).toBe(expected);
    }
  });

  it('the clock does not run in cut-scenes, PRE_MATCH or POST_MATCH', () => {
    for (const phase of [MatchPhase.PRE_MATCH, MatchPhase.GOAL, MatchPhase.CELEBRATION, MatchPhase.REPLAY, MatchPhase.HALF_TIME, MatchPhase.FULL_TIME, MatchPhase.EXTRA_TIME, MatchPhase.SHOOT_OUT, MatchPhase.POST_MATCH]) {
      const s = makeScenario({ phase });
      s.match.periodT = 300;
      s.match.goalTick = s.tick;
      tickRules(s);
      expect(s.match.periodT, MatchPhase[phase]).toBe(300);
    }
  });

  it('practice mode never ends: no clock, no period end, goals return to a kick-off', () => {
    const s = makeScenario({ config: { mode: ModeId.PRACTICE, halfMinutes: 2 } });
    const { events } = runUntil(s, () => false, 7600, undefined, 'none');
    expect(findEvents(events, EventType.PERIOD_END)).toHaveLength(0);
    expect(s.match.period).toBe(Period.FIRST_HALF);
    expect(s.match.periodT).toBe(0);
    expect([MatchPhase.KICK_OFF, MatchPhase.IN_PLAY]).toContain(s.match.phase);
    expect(isTimeUp(s)).toBe(false);
    // A goal in practice goes back to a kick-off.
    s.match.phase = MatchPhase.REPLAY;
    s.match.prevPhase = MatchPhase.CELEBRATION;
    s.match.goalTick = s.tick;
    s.match.periodT = 1e6;
    s.match.kickoffTeam = 1;
    const ev = tickRules(s);
    void ev;
    for (let i = 0; i < 500 && s.match.phase === MatchPhase.REPLAY; i++) tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.KICK_OFF);
    expect(s.match.restart.team).toBe(1);
  });
});

// ================================================================ period end

describe('RUL-01 period end', () => {
  it('time up with the ball loose in midfield: the half ends at once (PERIOD_END, LONG whistle, HALF_TIME)', () => {
    const s = nearEnd(3);
    const { events, reached } = rulesUntil(s, isEnd, 10);
    expect(reached).toBe(true);
    expect(s.match.periodT).toBe(s.match.periodLen);
    expect(s.match.phase).toBe(MatchPhase.HALF_TIME);
    expect(findEvents(events, EventType.PERIOD_END).map((e) => e.a)).toEqual([Period.FIRST_HALF]);
    expect(findEvents(events, EventType.WHISTLE).map((e) => e.a)).toEqual([WhistleKind.LONG]);
  });

  it('glitch "half ends during a shot in flight": the end waits until the shot is resolved', () => {
    const s = nearEnd(5);
    s.ball.shotBy = 9;
    s.ball.shotTick = s.tick;
    const resolveAt = s.tick + 60;
    const { events, reached } = rulesUntil(s, isEnd, 200, (st) => {
      if (st.tick + 1 === resolveAt) st.ball.shotBy = -1; // saved / touched at this tick
      if (!isEnd(st)) expect(st.match.phase).toBe(MatchPhase.IN_PLAY);
    });
    expect(reached).toBe(true);
    expect(findEvents(events, EventType.PERIOD_END)[0]!.tick).toBe(resolveAt);
  });

  it('a shot in flight defers even past the 20 s extension cap, but only for shotFlightMaxTicks after the strike', () => {
    const s = nearEnd(1);
    s.match.extensionT = T_RULES.halfEndExtensionTicks + 50;
    s.ball.shotBy = 9;
    s.ball.shotTick = s.tick;
    const { events, reached } = rulesUntil(s, isEnd, 400);
    expect(reached).toBe(true);
    expect(findEvents(events, EventType.PERIOD_END)[0]!.tick).toBe(s.ball.shotTick + LOCAL_TUNING.shotFlightMaxTicks + 1);
  });

  it('a cross in flight defers the end until it lands and slows', () => {
    const s = nearEnd(2);
    const b = s.ball;
    Object.assign(b, { x: 30, y: 6, z: 20, vx: 3, vz: -3, grounded: 0, lastKickKind: KickKind.CROSS, lastKickBy: 7, lastKickTeam: 0 });
    b.lastKickTick = s.tick; b.lastTouchTick = s.tick; b.lastTouch = 7;
    const landAt = s.tick + 40;
    const { events, reached } = rulesUntil(s, isEnd, 300, (st) => {
      if (st.tick + 1 === landAt) { st.ball.grounded = 1; st.ball.y = 0.11; st.ball.vx = 1; st.ball.vz = 0; st.ball.x = 20; }
    });
    expect(reached).toBe(true);
    expect(findEvents(events, EventType.PERIOD_END)[0]!.tick).toBe(landAt);
  });

  it('a touched cross is no longer "in flight"; a ground cross counts while it rolls fast', () => {
    const s = nearEnd(1);
    Object.assign(s.ball, { x: 20, z: 0, vx: 10, grounded: 1, lastKickKind: KickKind.GROUND_CROSS, lastKickBy: 7, lastKickTeam: 0 });
    s.ball.lastKickTick = s.tick; s.ball.lastTouchTick = s.tick;
    tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    s.ball.lastTouchTick = s.tick; // someone touched it
    tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.HALF_TIME);
  });

  it('an attack in the final 25 m defers until the 20 s cap; the defenders\' ball there is neutral', () => {
    // Team 0 attacks +x in the first half: its carrier at x = 40 defers the end.
    const a = nearEnd(1, { ball: { x: 40, y: 0.11, z: 5 } });
    a.ball.owner = 9;
    const t0 = a.tick;
    const { events, reached } = rulesUntil(a, isEnd, T_RULES.halfEndExtensionTicks + 10);
    expect(reached).toBe(true);
    expect(findEvents(events, EventType.PERIOD_END)[0]!.tick - t0).toBe(T_RULES.halfEndExtensionTicks + 1);
    // Loose in the zone: deferred as well.
    const l = nearEnd(1, { ball: { x: -HALF_LENGTH + 10, y: 0.11, z: 0 } });
    tickRules(l);
    expect(l.match.phase).toBe(MatchPhase.IN_PLAY);
    // Team 1 defending its own final 25 m (x = +40) with the ball: neutral.
    const d = nearEnd(1, { ball: { x: 40, y: 0.11, z: 5 } });
    d.ball.owner = 12;
    tickRules(d);
    expect(d.match.phase).toBe(MatchPhase.HALF_TIME);
  });

  it('time up during a throw-in, goal kick, corner or free kick ends the half at once', () => {
    const kinds: [MatchPhase, RestartKind][] = [
      [MatchPhase.THROW_IN, RestartKind.THROW_IN], [MatchPhase.GOAL_KICK, RestartKind.GOAL_KICK],
      [MatchPhase.CORNER, RestartKind.CORNER], [MatchPhase.FREE_KICK, RestartKind.FREE_KICK],
    ];
    for (const [phase, kind] of kinds) {
      const s = nearEnd(0, { phase }); // regulation over (a restart tick inside regulation would still add stoppage)
      s.match.restart.kind = kind;
      tickRules(s);
      expect(s.match.phase, MatchPhase[phase]).toBe(MatchPhase.HALF_TIME);
      expect(s.match.restart.kind).toBe(RestartKind.NONE);
    }
  });

  it('never during a PENALTY: the half ends after the kick once the shot is resolved', () => {
    const s = nearEnd(1, { phase: MatchPhase.PENALTY });
    s.match.restart.kind = RestartKind.PENALTY;
    s.match.extensionT = T_RULES.halfEndExtensionTicks; // cap already used up
    for (let i = 0; i < 2000; i++) { holdRestart(s); tickRules(s); }
    expect(s.match.phase).toBe(MatchPhase.PENALTY);
    expect(s.match.extensionT).toBeGreaterThan(T_RULES.halfEndExtensionTicks + 1990); // deferred every tick
    // The kick: restart taken, shot in flight toward goal.
    s.match.restart.taken = 1;
    Object.assign(s.ball, { x: 45, shotBy: 9, shotTick: s.tick + 1, lastKickKind: KickKind.PENALTY });
    tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    s.ball.shotBy = -1; // saved and held? still in the box: cap used up -> ends
    tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.HALF_TIME);
  });

  it('a kick-off is never cut short: time up during KICK_OFF waits for the kick', () => {
    const s = nearEnd(1, { phase: MatchPhase.KICK_OFF });
    s.match.restart.kind = RestartKind.KICK_OFF;
    s.match.restart.taker = 9;
    s.match.restart.team = 0;
    for (let i = 0; i < 30; i++) tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.KICK_OFF);
    s.match.restart.taken = 1;
    tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.HALF_TIME);
  });

  it('the second half ends in FULL_TIME with the FINAL whistle (friendly)', () => {
    const s = nearEnd(1, { match: { period: Period.SECOND_HALF } });
    const ev = tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.FULL_TIME);
    expect(findEvents(ev, EventType.WHISTLE).map((e) => e.a)).toEqual([WhistleKind.FINAL]);
    expect(findEvents(ev, EventType.PERIOD_END).map((e) => e.a)).toEqual([Period.SECOND_HALF]);
  });
});

// ================================================================ breaks, extra time, results

describe('RUL-01 half time, extra time and results', () => {
  it('PRE_MATCH lasts preMatchTicks then kicks off (first kick-off team from init); a human SKIP starts it early', () => {
    const s = makeScenario();
    const { reached } = runUntil(s, (st) => st.match.phase === MatchPhase.KICK_OFF, 500);
    expect(reached).toBe(true);
    expect(s.tick).toBe(LOCAL_TUNING.preMatchTicks);
    expect(s.match.restart.team).toBe(s.match.firstKickoffTeam);
    const h = makeScenario({ humans: 1 });
    runTicks(h, 10, (tick, _st, out) => { if (tick === 10) out[0]!.buttons = Btn.SKIP; });
    expect(h.match.phase).toBe(MatchPhase.KICK_OFF);
  });

  it('shoot-out mode: PRE_MATCH -> SHOOT_OUT (period 5)', () => {
    const s = makeScenario({ config: { startPhase: MatchPhase.SHOOT_OUT, mode: ModeId.SHOOT_OUT } });
    const { reached } = runUntil(s, (st) => st.match.phase === MatchPhase.SHOOT_OUT, 500, undefined, 'core');
    expect(reached).toBe(true);
    expect(s.match.period).toBe(Period.SHOOT_OUT);
  });

  it('half time: directions swap, period 2 starts at 0 with the same length, the other team kicks off', () => {
    const s = makeScenario({ phase: MatchPhase.HALF_TIME, config: { halfMinutes: 3 } });
    s.match.periodT = s.match.periodLen + 77;
    s.match.addedT = 50;
    s.match.extensionT = 30;
    s.match.firstKickoffTeam = 1;
    const len = s.match.periodLen;
    const { reached } = runUntil(s, (st) => st.match.phase === MatchPhase.KICK_OFF, 500, undefined, 'core');
    expect(reached).toBe(true);
    expect(s.tick).toBe(T_RULES.halfTimeTicks);
    expect([s.teams[0]!.dir, s.teams[1]!.dir]).toEqual([-1, 1]);
    const m = s.match;
    expect([m.period, m.periodT, m.periodLen, m.addedT, m.extensionT]).toEqual([Period.SECOND_HALF, 0, len, 0, 0]);
    expect(m.restart.team).toBe(0);
    expect(m.kickoffTeam).toBe(0);
  });

  it('half time is skippable', () => {
    const s = makeScenario({ phase: MatchPhase.HALF_TIME, humans: 1 });
    runTicks(s, 5, (tick, _st, out) => { if (tick === 5) out[0]!.buttons = Btn.SKIP; });
    expect(s.match.phase).toBe(MatchPhase.KICK_OFF);
  });

  it('friendly draw: FULL_TIME -> POST_MATCH, winner -1, finished', () => {
    const s = makeScenario({ phase: MatchPhase.FULL_TIME, match: { period: Period.SECOND_HALF } });
    s.teams[0]!.goals = 2; s.teams[1]!.goals = 2;
    const { reached } = runUntil(s, (st) => st.match.phase === MatchPhase.POST_MATCH, 500, undefined, 'core');
    expect(reached).toBe(true);
    expect(s.tick).toBe(T_RULES.fullTimeTicks);
    expect([s.match.winner, s.match.finished]).toEqual([-1, 1]);
  });

  it('friendly or cup with a winner after 90 minutes: POST_MATCH with the winner', () => {
    for (const cupRules of [0, 1]) {
      const s = makeScenario({ phase: MatchPhase.FULL_TIME, config: { cupRules }, match: { period: Period.SECOND_HALF } });
      s.teams[0]!.goals = 1; s.teams[1]!.goals = 3;
      runUntil(s, (st) => st.match.phase === MatchPhase.POST_MATCH, 500);
      expect([s.match.phase, s.match.winner, s.match.finished]).toEqual([MatchPhase.POST_MATCH, 1, 1]);
    }
  });

  it('cup tie level after 90: LONG whistle, EXTRA_TIME, ET1 (a third of a half, re-toss), short ET half time, ET2 (swapped), level -> SHOOT_OUT', () => {
    const s = nearEnd(1, { config: { cupRules: 1, halfMinutes: 3 }, match: { period: Period.SECOND_HALF }, teams: [{ dir: -1 }, { dir: 1 }] });
    s.teams[0]!.goals = 1; s.teams[1]!.goals = 1;
    let ev = tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.FULL_TIME);
    expect(findEvents(ev, EventType.WHISTLE).map((e) => e.a)).toEqual([WhistleKind.LONG]);
    expect(rulesUntil(s, (st) => st.match.phase === MatchPhase.EXTRA_TIME, 500).reached).toBe(true);
    expect(s.tick).toBeGreaterThan(0);
    // A seeded re-toss decides the ET1 kick-off.
    rulesUntil(s, (st) => st.match.phase === MatchPhase.KICK_OFF, 500);
    const m = s.match;
    expect(m.period).toBe(Period.ET_FIRST);
    expect(m.periodLen).toBe(Math.round((3 * 3600) / 3));
    expect(m.periodT).toBe(0);
    expect([s.teams[0]!.dir, s.teams[1]!.dir]).toEqual([-1, 1]); // no swap into extra time
    const et1Kicker = m.restart.team;
    expect(et1Kicker).toBe(m.firstKickoffTeam);
    // Play ET1 out: kick-off taken, then time up.
    m.restart.taken = 1;
    tickRules(s);
    m.periodT = m.periodLen - 1;
    s.ball.x = 0; s.ball.z = 0; s.ball.owner = -1; s.ball.shotBy = -1;
    ev = tickRules(s);
    expect(m.phase).toBe(MatchPhase.HALF_TIME);
    expect(findEvents(ev, EventType.PERIOD_END).map((e) => e.a)).toEqual([Period.ET_FIRST]);
    const r = rulesUntil(s, (st) => st.match.phase === MatchPhase.KICK_OFF, 500);
    expect(r.reached).toBe(true);
    expect(r.events.length).toBeGreaterThan(0);
    expect(m.phaseT).toBe(0);
    expect(m.period).toBe(Period.ET_SECOND);
    expect([s.teams[0]!.dir, s.teams[1]!.dir]).toEqual([1, -1]);
    expect(m.restart.team).toBe(et1Kicker === 0 ? 1 : 0);
    // ET half time is the short break.
    const htTicks = findEvents(r.events, EventType.PHASE_CHANGE).at(-1)!.tick - findEvents(ev, EventType.PHASE_CHANGE).at(-1)!.tick;
    expect(htTicks).toBe(LOCAL_TUNING.etHalfTimeTicks);
    // ET2 ends level -> FULL_TIME (LONG) -> SHOOT_OUT.
    m.restart.taken = 1;
    tickRules(s);
    m.periodT = m.periodLen - 1;
    s.ball.x = 0; s.ball.owner = -1;
    ev = tickRules(s);
    expect(m.phase).toBe(MatchPhase.FULL_TIME);
    expect(findEvents(ev, EventType.WHISTLE).map((e) => e.a)).toEqual([WhistleKind.LONG]);
    rulesUntil(s, (st) => st.match.phase !== MatchPhase.FULL_TIME, 500);
    expect(m.phase).toBe(MatchPhase.SHOOT_OUT);
    expect(m.period).toBe(Period.SHOOT_OUT);
    expect(m.finished).toBe(0);
  });

  it('cup tie decided in extra time: FINAL whistle and POST_MATCH with the winner', () => {
    const s = nearEnd(1, { config: { cupRules: 1 }, match: { period: Period.ET_SECOND } });
    s.match.periodLen = periodLength(s.config, Period.ET_SECOND);
    s.match.periodT = s.match.periodLen - 1;
    s.teams[0]!.goals = 2; s.teams[1]!.goals = 1;
    const ev = tickRules(s);
    expect(findEvents(ev, EventType.WHISTLE).map((e) => e.a)).toEqual([WhistleKind.FINAL]);
    rulesUntil(s, (st) => st.match.phase === MatchPhase.POST_MATCH, 500);
    expect([s.match.phase, s.match.winner]).toEqual([MatchPhase.POST_MATCH, 0]);
  });

  it('the ET re-toss is deterministic for a seed', () => {
    const toss = (seed: number) => {
      const s = makeScenario({ seed, phase: MatchPhase.EXTRA_TIME, config: { cupRules: 1 }, match: { period: Period.SECOND_HALF } });
      rulesUntil(s, (st) => st.match.phase === MatchPhase.KICK_OFF, 500);
      return s.match.restart.team;
    };
    for (const seed of [1, 2, 3, 4, 5]) expect(toss(seed)).toBe(toss(seed));
    const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(toss));
    expect(seen.size).toBe(2);
  });
});

describe('RUL-01 advanceCutscene (watchdog hook)', () => {
  it('ends each cut-scene / break exactly like a skip; 0 for play, restarts, shoot-out and POST_MATCH', () => {
    const next: [MatchPhase, MatchPhase][] = [
      [MatchPhase.PRE_MATCH, MatchPhase.KICK_OFF], [MatchPhase.GOAL, MatchPhase.CELEBRATION],
      [MatchPhase.CELEBRATION, MatchPhase.REPLAY], [MatchPhase.REPLAY, MatchPhase.KICK_OFF],
      [MatchPhase.HALF_TIME, MatchPhase.KICK_OFF], [MatchPhase.FULL_TIME, MatchPhase.POST_MATCH],
      [MatchPhase.EXTRA_TIME, MatchPhase.KICK_OFF],
    ];
    for (const [from, to] of next) {
      const s = makeScenario({ phase: from, match: { period: from === MatchPhase.EXTRA_TIME ? Period.SECOND_HALF : Period.FIRST_HALF } });
      s.match.goalTick = s.tick;
      s.match.goalTeam = 0;
      if (from === MatchPhase.FULL_TIME) s.match.period = Period.SECOND_HALF;
      EV.begin(s.tick);
      expect(advanceCutscene(s, EV), MatchPhase[from]).toBe(1);
      expect(MatchPhase[s.match.phase]).toBe(MatchPhase[to]);
    }
    for (const ph of [MatchPhase.IN_PLAY, MatchPhase.KICK_OFF, MatchPhase.CORNER, MatchPhase.SHOOT_OUT, MatchPhase.POST_MATCH]) {
      const s = makeScenario({ phase: ph });
      EV.begin(s.tick);
      expect(advanceCutscene(s, EV), MatchPhase[ph]).toBe(0);
      expect(s.match.phase).toBe(ph);
    }
  });
});

// ================================================================ forfeit

describe('RUL-01 forfeit', () => {
  it('forfeit in play: FULL_TIME (FINAL whistle) -> POST_MATCH, result 3-0 to the other team', () => {
    const s = nearEnd(5000);
    s.teams[0]!.goals = 0; s.teams[1]!.goals = 1;
    tickRules(s);
    s.match.forfeitTeam = 1; // RUL-10 checkForfeit / sendOff flags it
    const ev = tickRules(s);
    expect(s.match.phase).toBe(MatchPhase.FULL_TIME);
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([3, 0]);
    expect(findEvents(ev, EventType.WHISTLE).map((e) => e.a)).toEqual([WhistleKind.FINAL]);
    const periodT = s.match.periodT;
    rulesUntil(s, (st) => st.match.phase === MatchPhase.POST_MATCH, 500);
    expect([s.match.phase, s.match.winner, s.match.finished]).toEqual([MatchPhase.POST_MATCH, 0, 1]);
    expect(s.match.periodT).toBe(periodT); // clock stopped
  });

  it('forfeit keeps a bigger winning margin; a cup tie never goes to extra time after a forfeit', () => {
    const s = nearEnd(5000, { config: { cupRules: 1 }, match: { period: Period.SECOND_HALF } });
    s.teams[0]!.goals = 1; s.teams[1]!.goals = 6;
    s.match.forfeitTeam = 0;
    tickRules(s);
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([1, 6]);
    rulesUntil(s, (st) => st.match.phase === MatchPhase.POST_MATCH, 500);
    expect(s.match.winner).toBe(1);
    const lvl = nearEnd(5000, { config: { cupRules: 1 }, match: { period: Period.SECOND_HALF } });
    lvl.teams[0]!.goals = 2; lvl.teams[1]!.goals = 2;
    lvl.match.forfeitTeam = 1;
    rulesUntil(lvl, (st) => st.match.phase === MatchPhase.POST_MATCH, 600);
    expect([lvl.match.phase, lvl.teams[0]!.goals, lvl.teams[1]!.goals, lvl.match.winner]).toEqual([MatchPhase.POST_MATCH, 3, 0, 0]);
  });

  it('a forfeit during a cut-scene waits for a phase that may end the match (REPLAY), from restarts at once', () => {
    const s = makeScenario({ phase: MatchPhase.GOAL, config: { replaySeconds: 8 } });
    s.match.goalTick = s.tick;
    s.match.forfeitTeam = 0;
    const { events } = rulesUntil(s, (st) => st.match.phase === MatchPhase.FULL_TIME, 1000);
    expect(findEvents(events, EventType.PHASE_CHANGE).map((e) => `${MatchPhase[e.a]}->${MatchPhase[e.b]}`))
      .toEqual(['GOAL->CELEBRATION', 'CELEBRATION->REPLAY', 'REPLAY->FULL_TIME']);
    for (const phase of [MatchPhase.KICK_OFF, MatchPhase.THROW_IN, MatchPhase.PENALTY]) {
      const r = makeScenario({ phase });
      r.match.forfeitTeam = 1;
      tickRules(r);
      expect(r.match.phase, MatchPhase[phase]).toBe(MatchPhase.FULL_TIME);
    }
  });

  it('glitch "a team below 7 players not ending the match": safety net when RUL-10 has not flagged it', () => {
    const s = nearEnd(5000);
    for (const slot of [12, 13, 14, 15, 16]) s.players[slot]!.active = 0; // 6 left
    const ev = tickRules(s);
    expect(findEvents(ev, EventType.FORFEIT).map((e) => e.a)).toEqual([1]);
    expect(s.match.forfeitTeam).toBe(1);
    expect(s.match.phase).toBe(MatchPhase.FULL_TIME);
    expect([s.teams[0]!.goals, s.teams[1]!.goals]).toEqual([3, 0]);
  });

  it('practice mode never forfeits (reduced sides are allowed)', () => {
    const s = nearEnd(5000, { config: { mode: ModeId.PRACTICE } });
    for (let slot = 12; slot < 22; slot++) s.players[slot]!.active = 0;
    tickRules(s);
    expect(s.match.forfeitTeam).toBe(-1);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });
});

describe('RUL-01 config sanity', () => {
  it('createMatchConfig defaults keep the goal sequence within 12 s', () => {
    const c = createMatchConfig();
    const replay = Math.min(c.replaySeconds * 60, T_RULES.replayTicks);
    expect(T_RULES.goalPhaseTicks + T_RULES.celebrationTicks + replay).toBeLessThanOrEqual(T_RULES.goalSequenceMaxTicks);
  });
});
