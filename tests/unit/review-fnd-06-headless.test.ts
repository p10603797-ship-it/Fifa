/**
 * Independent review of FND-06: adversarial tests for tools/headless.ts runMatch with a scripted sim.
 * src/sim/step is replaced by a test double so the harness can be driven through a full legal match (kick-off,
 * passes, a save in hand, a foul, a sending-off, a corner, a goal sequence, half-time, full time) with known
 * events, and through broken sims (tick that does not advance).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CardKind, ChallengeOutcome, ControllerKind, KickKind, MatchPhase, Period, RestartKind } from '../../src/contracts/enums';
import { EventType, type EventBuffer } from '../../src/contracts/events';
import type { InputFrame } from '../../src/contracts/input';
import { createMatchConfig, RosterStatus, type MatchConfig, type SimState } from '../../src/contracts/state';
import { CLOCK_PHASES } from '../../src/contracts/transitions';

type StepFn = (s: SimState, frames: readonly InputFrame[], ev: EventBuffer) => void;
const ctl = vi.hoisted(() => ({ fn: null as null | ((s: unknown, f: unknown, e: unknown) => void), calls: 0 }));

vi.mock('../../src/sim/step', () => ({
  step: (s: unknown, f: unknown, e: unknown): void => {
    ctl.calls++;
    if (ctl.calls > 20000) throw new Error('runaway: step called more than 20000 times');
    ctl.fn!(s, f, e);
  },
}));

// Imported after the mock is registered (vi.mock is hoisted).
import { runMatch } from '../../tools/headless';
import { playReplay } from '../../src/sim/replay';

function cpuConfig(): MatchConfig {
  const c = createMatchConfig();
  c.seed = 42;
  c.halfMinutes = 2;
  c.humans = [
    { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
    { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
  ];
  return c;
}

function setPhase(s: SimState, ev: EventBuffer, to: MatchPhase): void {
  ev.emit(EventType.PHASE_CHANGE, s.match.phase, to);
  s.match.prevPhase = s.match.phase;
  s.match.phase = to;
  s.match.phaseT = 0;
}

function loose(s: SimState): void {
  s.ball.owner = -1;
  s.ball.heldBy = -1;
}

/** Oracle for possession (documented semantics: IN_PLAY ticks, loose ball counts for the last team in possession). */
const oracle = { lastTeam: -1, poss: [0, 0] };

/** A short but complete and legal match, scripted by tick. */
const legalMatch: StepFn = (s, _frames, ev) => {
  s.tick++;
  ev.begin(s.tick);
  const m = s.match;
  m.phaseT++;
  const t = s.tick;
  switch (t) {
    case 1:
      setPhase(s, ev, MatchPhase.KICK_OFF);
      s.ctrl[2]!.slot = 9; s.players[9]!.ctrl = 2;
      s.ctrl[3]!.slot = 20; s.players[20]!.ctrl = 3;
      s.teams[0]!.chaser = 10; s.teams[1]!.chaser = 15;
      s.ball.owner = 9;
      break;
    case 2: setPhase(s, ev, MatchPhase.IN_PLAY); break;
    case 3: ev.emit(EventType.KICK, 9, KickKind.GROUND_PASS, 0.5); loose(s); break;
    case 4: ev.emit(EventType.PASS_COMPLETE, 10, 9); s.ball.owner = 10; break;
    case 5: ev.emit(EventType.PASS_COMPLETE, 10, 9); break; // duplicate, must not count twice
    case 6: ev.emit(EventType.KICK, 10, KickKind.SHOT_NORMAL, 0.9); ev.emit(EventType.SHOT, 10, 1, 0.2); loose(s); break;
    case 7: {
      ev.emit(EventType.SAVE, 11, 0, 20);
      const k = s.players[11]!;
      s.ball.x = k.x; s.ball.z = k.z; s.ball.y = 1;
      s.ball.owner = 11; s.ball.heldBy = 11;
      break;
    }
    case 8: ev.emit(EventType.KICK, 11, KickKind.GK_THROW, 0.4); loose(s); s.ball.y = 0.11; break;
    case 9: s.ball.owner = 12; break;
    case 10: ev.emit(EventType.KICK, 12, KickKind.CROSS, 0.7); loose(s); break;
    case 11:
      ev.emit(EventType.FOUL, 13, 10, ChallengeOutcome.FOUL, 0);
      ev.emit(EventType.FOUL, 14, 9, ChallengeOutcome.CLEAN, 0);
      ev.emit(EventType.CARD, 13, CardKind.YELLOW);
      ev.emit(EventType.RESTART_AWARDED, RestartKind.FREE_KICK, 0);
      setPhase(s, ev, MatchPhase.FREE_KICK);
      break;
    case 12: {
      ev.emit(EventType.CARD, 13, CardKind.SECOND_YELLOW);
      const p = s.players[13]!;
      p.active = 0;
      s.teams[1]!.roster[p.rosterIdx] = RosterStatus.SENT_OFF;
      s.teams[1]!.onPitch = 10;
      break;
    }
    case 13: setPhase(s, ev, MatchPhase.IN_PLAY); ev.emit(EventType.KICK, 10, KickKind.GROUND_PASS, 0.5); loose(s); break;
    case 14:
      ev.emit(EventType.OFFSIDE, 19);
      ev.emit(EventType.RESTART_AWARDED, RestartKind.CORNER, 0);
      setPhase(s, ev, MatchPhase.CORNER);
      break;
    case 15: setPhase(s, ev, MatchPhase.IN_PLAY); s.ball.owner = 9; break;
    case 16:
      ev.emit(EventType.GOAL, 0, 9, -1, 0);
      s.teams[0]!.goals = 1;
      loose(s);
      setPhase(s, ev, MatchPhase.GOAL);
      break;
    case 17: setPhase(s, ev, MatchPhase.CELEBRATION); break;
    case 18: setPhase(s, ev, MatchPhase.REPLAY); break;
    case 19: setPhase(s, ev, MatchPhase.KICK_OFF); s.ball.owner = 15; break;
    case 20: setPhase(s, ev, MatchPhase.IN_PLAY); break;
    case 41: ev.emit(EventType.PERIOD_END, Period.FIRST_HALF); setPhase(s, ev, MatchPhase.HALF_TIME); loose(s); break;
    case 42:
      setPhase(s, ev, MatchPhase.KICK_OFF);
      m.period = Period.SECOND_HALF;
      m.periodT = 0;
      s.teams[0]!.dir = -1; s.teams[1]!.dir = 1;
      s.ball.owner = 9;
      break;
    case 43: setPhase(s, ev, MatchPhase.IN_PLAY); break;
    case 61: ev.emit(EventType.WATCHDOG, 1); break;
    case 62: ev.emit(EventType.PERIOD_END, Period.SECOND_HALF); setPhase(s, ev, MatchPhase.FULL_TIME); loose(s); break;
    case 63: setPhase(s, ev, MatchPhase.POST_MATCH); break;
    default: break;
  }
  if (CLOCK_PHASES.includes(m.phase) && m.prevPhase === m.phase) m.periodT++;
  if (m.phase === MatchPhase.KICK_OFF || m.phase === MatchPhase.IN_PLAY) m.prevPhase = m.phase;
  if (s.ball.owner >= 0) oracle.lastTeam = s.ball.owner < 11 ? 0 : 1;
  if (m.phase === MatchPhase.IN_PLAY && oracle.lastTeam >= 0) oracle.poss[oracle.lastTeam]!++;
};

beforeEach(() => {
  ctl.calls = 0;
  ctl.fn = null;
  oracle.lastTeam = -1;
  oracle.poss = [0, 0];
});

describe('review FND-06 runMatch: termination', () => {
  it('stops at maxTicks even when a broken sim does not advance s.tick (counts its own ticks)', () => {
    // A sim module that corrupts s.tick (or a step that forgets to advance it) must not hang the soak.
    ctl.fn = (s, _f, e) => { (e as EventBuffer).begin((s as SimState).tick); };
    const r = runMatch({ config: cpuConfig(), maxTicks: 100, checker: 'core' });
    expect(r.exception).toBeUndefined();
    expect(ctl.calls).toBeLessThanOrEqual(100);
  });

  it('stops at maxTicks even when a broken sim moves s.tick backwards', () => {
    ctl.fn = (s, _f, e) => { const st = s as SimState; st.tick = st.tick > 0 ? st.tick - 1 : 0; (e as EventBuffer).begin(st.tick); };
    const r = runMatch({ config: cpuConfig(), maxTicks: 100, checker: 'none' });
    expect(r.exception).toBeUndefined();
    expect(ctl.calls).toBeLessThanOrEqual(100);
  });
});

describe('review FND-06 runMatch: a full legal scripted match', () => {
  it("finishes at POST_MATCH with zero failures in the 'all' set (no false positives on a legal flow)", () => {
    ctl.fn = legalMatch as (s: unknown, f: unknown, e: unknown) => void;
    const r = runMatch({ config: cpuConfig(), checker: 'all' });
    expect(r.exception).toBeUndefined();
    expect(r.invariantFailures.first).toEqual([]);
    expect(r.invariantFailures.count).toBe(0);
    expect(r.finished).toBe(true);
    expect(r.ticks).toBe(63);
    expect(r.endPhase).toBe(MatchPhase.POST_MATCH);
  });

  it('counts the statistics exactly', () => {
    ctl.fn = legalMatch as (s: unknown, f: unknown, e: unknown) => void;
    const r = runMatch({ config: cpuConfig(), checker: 'none' });
    const st = r.stats;
    expect(st.goals).toEqual([1, 0]);
    expect(st.shots).toEqual([1, 0]);
    expect(st.shotsOnTarget).toEqual([1, 0]);
    expect(st.passes).toEqual([2, 1]); // two ground passes (home), one cross (away); GK throw not a pass
    expect(st.passesCompleted).toEqual([1, 0]); // duplicate PASS_COMPLETE not counted
    expect(st.fouls).toEqual([0, 1]); // CLEAN challenge not a foul
    expect(st.yellows).toEqual([0, 1]);
    expect(st.reds).toEqual([0, 1]);
    expect(st.offsides).toEqual([0, 1]);
    expect(st.saves).toEqual([0, 1]);
    expect(st.corners).toEqual([1, 0]);
    expect(st.possessionTicks).toEqual(oracle.poss);
    expect(st.possessionPct[0] + st.possessionPct[1]).toBeCloseTo(100, 9);
    expect(r.watchdogs).toBe(1);
    expect(r.watchdogReasons).toEqual({ BALL_UNTOUCHED: 1 });
    expect(r.events.KICK).toBe(5);
    expect(r.events.GOAL).toBe(1);
    expect(r.events.PHASE_CHANGE).toBe(16);
  });

  it('checker on/off and recording on/off give the same hash, and the recorded replay plays back identically', () => {
    ctl.fn = legalMatch as (s: unknown, f: unknown, e: unknown) => void;
    const a = runMatch({ config: cpuConfig(), checker: 'none' });
    const b = runMatch({ config: cpuConfig(), checker: 'all', record: true });
    expect(b.hash).toBe(a.hash);
    const p = playReplay(JSON.parse(JSON.stringify(b.replay)) as NonNullable<typeof b.replay>);
    expect(p.divergedAt).toBe(-1);
    expect(p.hash).toBe(b.hash);
    expect(p.ticks).toBe(63);
  });
});

describe('review FND-06 runMatch: event accounting', () => {
  it('counts unknown event types under UNKNOWN and sums dropped events over ticks', () => {
    ctl.fn = (s, _f, e) => {
      const st = s as SimState;
      const ev = e as EventBuffer;
      st.tick++;
      ev.begin(st.tick);
      ev.emit(99 as EventType, 1);
      for (let i = 0; i < 70; i++) ev.emit(EventType.BOUNCE); // 64 fit, 7 dropped (incl. the one above)
    };
    const r = runMatch({ config: cpuConfig(), maxTicks: 3, checker: 'none' });
    expect(r.events.UNKNOWN).toBe(3);
    expect(r.events.BOUNCE).toBe(3 * 63);
    expect(r.eventsDropped).toBe(3 * 7);
  });
});
