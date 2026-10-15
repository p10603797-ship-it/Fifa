/**
 * RUL-11: watchdog. Every reason fires on its trigger and recovers to a legal state (PHASE_TIMEOUT for each phase
 * with a maximum, ACTION_OVERRUN, BALL_UNTOUCHED, BALL_UNREACHABLE: out of play without a restart, in a net while
 * play goes on, resting on the net roof / crossbar; RESTART_BLOCKED is covered in rul-11-restart), and no watchdog
 * fires in normal flows.
 *
 * Same isolation as rul-11-restart: RUL-02..06 Setup/Default/tick/input, team AI, CPU brains and contacts are mocked
 * to no-ops; RUL-01's machine and the rest of the pipeline are real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BALL_RADIUS, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_DEPTH, POST_RADIUS,
} from '../../src/contracts/constants';
import { ActionKind, MatchPhase, ModeId, Period, RestartKind, WatchdogReason } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { recordTouch } from '../../src/sim/core/kick';
import { INVARIANT_NAMES, createInvariantChecker } from '../../src/sim/debug/invariants';
import { periodLength } from '../../src/sim/init';
import { awardRestart, isLegalRestartPosition, LOCAL_TUNING as RESTART_LT } from '../../src/sim/rules/restart';
import { LOCAL_TUNING, watchdogTick } from '../../src/sim/rules/watchdog';
import { step } from '../../src/sim/step';
import { makeScenario } from '../harness/scenario';

const H = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock('../../src/sim/rules/throwin', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/throwin')>()),
  throwInSetup: () => { H.log.push('setup:2'); }, throwInDefault: () => { H.log.push('default:2'); },
  throwInTick: () => { /* none */ }, throwInInput: () => { /* none */ },
  throwInHandler: { update() { /* none */ }, end() { /* none */ } },
}));
vi.mock('../../src/sim/rules/goalkick', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/goalkick')>()),
  goalKickSetup: () => { H.log.push('setup:3'); }, goalKickDefault: () => { H.log.push('default:3'); },
  goalKickTick: () => { /* none */ }, goalKickInput: () => { /* none */ },
}));
vi.mock('../../src/sim/rules/corner', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/corner')>()),
  cornerSetup: () => { H.log.push('setup:4'); }, cornerDefault: () => { H.log.push('default:4'); },
  cornerTick: () => { /* none */ }, cornerInput: () => { /* none */ },
}));
vi.mock('../../src/sim/rules/freekick', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/freekick')>()),
  freeKickSetup: () => { H.log.push('setup:5'); }, freeKickDefault: () => { H.log.push('default:5'); },
  freeKickTick: () => { /* none */ }, freeKickInput: () => { /* none */ },
}));
vi.mock('../../src/sim/rules/penalty', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/penalty')>()),
  penaltySetup: () => { H.log.push('setup:6'); }, penaltyDefault: () => { H.log.push('default:6'); },
  penaltyTick: () => { /* none */ }, penaltyInput: () => { /* none */ },
}));
vi.mock('../../src/sim/rules/shootout', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/shootout')>()),
  shootoutStart: () => { H.log.push('shootoutStart'); },
}));
vi.mock('../../src/ai/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/index')>()), teamAiTick: () => { /* none */ },
}));
vi.mock('../../src/ai/cpu/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/cpu/index')>()), cpuThink: () => { /* none */ },
}));
vi.mock('../../src/sim/contacts', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/contacts')>()), contactsTick: () => { /* none */ },
}));

beforeEach(() => { H.log.length = 0; });

const CHECKS = INVARIANT_NAMES.filter((n) => n !== 'chaser');
const EV = createEventBuffer();

function base(opts: { phase?: MatchPhase; mode?: ModeId; cup?: number } = {}): SimState {
  return makeScenario({
    phase: opts.phase ?? MatchPhase.IN_PLAY, humans: 0, seed: 5,
    config: { mode: opts.mode ?? ModeId.KICK_OFF, cupRules: opts.cup ?? 0 },
  });
}

/** One watchdog call on a crafted state; returns its events. */
function dog(s: SimState): SimEvent[] {
  EV.begin(s.tick);
  watchdogTick(s, EV);
  return EV.toArray();
}

function run(s: SimState, n: number, until?: (s: SimState) => boolean, touchEvery = 0): SimEvent[] {
  const events = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker(CHECKS);
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    clearInputFrame(frames[0]!);
    clearInputFrame(frames[1]!);
    step(s, frames, events);
    if (touchEvery > 0 && s.tick % touchEvery === 0) recordTouch(s, 9);
    for (let k = 0; k < events.count; k++) all.push({ ...events.get(k) });
    const fails = checker.check(s, events);
    if (fails.length > 0) throw new Error(`invariant failure at t=${s.tick}:\n  ${fails.join('\n  ')}`);
    if (until?.(s)) break;
  }
  return all;
}

function watchdogs(ev: readonly SimEvent[]): number[][] {
  return ev.filter((e) => e.type === EventType.WATCHDOG).map((e) => [e.a, e.b]);
}

/** After an award: run to ready and check every position is legal, then let the restart finish back in IN_PLAY. */
function expectRecovers(s: SimState): void {
  // [QF-10] Throw-ins and free kicks away from goal are walked set-ups: ready once everyone is in place (capped).
  run(s, T_RULES.restartSetupTicks + RESTART_LT.setupExtendMaxTicks, (st) => st.match.restart.ready === 1);
  expect(s.match.restart.ready).toBe(1);
  for (let i = 0; i < NUM_SLOTS; i++) expect(isLegalRestartPosition(s, i), `slot ${i}`).toBe(true);
  expect([s.ball.x, s.ball.y, s.ball.z]).toEqual([s.match.restart.x, BALL_RADIUS, s.match.restart.z]);
  run(s, 600, (st) => st.match.phase === MatchPhase.IN_PLAY);
  expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
}

// ---------------------------------------------------------------- phase timeouts

describe('RUL-11 watchdog PHASE_TIMEOUT', () => {
  it('fires exactly at the phase maximum (never later) and not before', () => {
    const s = base({ phase: MatchPhase.GOAL });
    s.match.phaseT = T_RULES.phaseMaxTicks[MatchPhase.GOAL]! - 1;
    expect(dog(s)).toEqual([]);
    s.match.phaseT++;
    const ev = dog(s);
    expect(watchdogs(ev)).toEqual([[WatchdogReason.PHASE_TIMEOUT, MatchPhase.GOAL]]);
    expect(s.match.phase).toBe(MatchPhase.CELEBRATION);
    expect(s.match.phaseT).toBe(0);
    expect(s.match.watchdogCount).toBe(1);
  });

  it('IN_PLAY, SHOOT_OUT and POST_MATCH are unlimited', () => {
    for (const ph of [MatchPhase.IN_PLAY, MatchPhase.SHOOT_OUT, MatchPhase.POST_MATCH]) {
      const s = base({ phase: ph });
      s.match.phaseT = 100000;
      expect(dog(s).filter((e) => e.type === EventType.WATCHDOG && e.a === WatchdogReason.PHASE_TIMEOUT)).toEqual([]);
    }
  });

  it('cut-scenes and breaks move to their next legal step', () => {
    const cases: { name: string; prep: (s: SimState) => void; check: (s: SimState) => void }[] = [
      { name: 'CELEBRATION -> REPLAY', prep: (s) => { s.match.phase = MatchPhase.CELEBRATION; },
        check: (s) => expect(s.match.phase).toBe(MatchPhase.REPLAY) },
      { name: 'REPLAY -> kick-off by the conceding team', prep: (s) => { s.match.phase = MatchPhase.REPLAY; s.match.goalTeam = 0; },
        check: (s) => { expect(s.match.phase).toBe(MatchPhase.KICK_OFF); expect(s.match.restart.team).toBe(1); } },
      { name: 'REPLAY -> HALF_TIME when time is up', prep: (s) => { s.match.phase = MatchPhase.REPLAY; s.match.periodT = s.match.periodLen; },
        check: (s) => expect(s.match.phase).toBe(MatchPhase.HALF_TIME) },
      { name: 'REPLAY -> FULL_TIME when time is up in the second half',
        prep: (s) => { s.match.phase = MatchPhase.REPLAY; s.match.period = Period.SECOND_HALF; s.match.periodT = s.match.periodLen; },
        check: (s) => expect(s.match.phase).toBe(MatchPhase.FULL_TIME) },
      { name: 'HALF_TIME -> second-half kick-off, sides swapped',
        prep: (s) => { s.match.phase = MatchPhase.HALF_TIME; s.match.periodT = 999; s.match.firstKickoffTeam = 0; },
        check: (s) => {
          expect(s.match.phase).toBe(MatchPhase.KICK_OFF);
          expect([s.match.period, s.match.periodT, s.teams[0]!.dir, s.teams[1]!.dir, s.match.restart.team]).toEqual([Period.SECOND_HALF, 0, -1, 1, 1]);
        } },
      { name: 'FULL_TIME -> POST_MATCH (friendly)',
        prep: (s) => { s.match.phase = MatchPhase.FULL_TIME; s.match.period = Period.SECOND_HALF; s.teams[1]!.goals = 2; },
        check: (s) => { expect(s.match.phase).toBe(MatchPhase.POST_MATCH); expect([s.match.finished, s.match.winner]).toEqual([1, 1]); } },
      { name: 'FULL_TIME -> EXTRA_TIME (cup, level)',
        prep: (s) => { s.match.phase = MatchPhase.FULL_TIME; s.match.period = Period.SECOND_HALF; },
        check: (s) => expect(s.match.phase).toBe(MatchPhase.EXTRA_TIME) },
      { name: 'FULL_TIME after extra time -> SHOOT_OUT (cup, level)',
        prep: (s) => { s.match.phase = MatchPhase.FULL_TIME; s.match.period = Period.ET_SECOND; },
        check: (s) => {
          expect([s.match.phase, s.match.period]).toEqual([MatchPhase.SHOOT_OUT, Period.SHOOT_OUT]);
          expect(H.log).toContain('shootoutStart');
        } },
      { name: 'PRE_MATCH -> SHOOT_OUT (shoot-out mode)',
        prep: (s) => { s.match.phase = MatchPhase.PRE_MATCH; s.config.startPhase = MatchPhase.SHOOT_OUT; },
        check: (s) => {
          expect([s.match.phase, s.match.period]).toEqual([MatchPhase.SHOOT_OUT, Period.SHOOT_OUT]);
          expect(H.log).toContain('shootoutStart');
        } },
      { name: 'EXTRA_TIME -> first extra-time kick-off',
        prep: (s) => { s.match.phase = MatchPhase.EXTRA_TIME; s.match.period = Period.SECOND_HALF; },
        check: (s) => {
          expect(s.match.phase).toBe(MatchPhase.KICK_OFF);
          expect([s.match.period, s.match.periodT, s.match.periodLen]).toEqual([Period.ET_FIRST, 0, periodLength(s.config, Period.ET_FIRST)]);
        } },
      { name: 'PRE_MATCH -> first kick-off', prep: (s) => { s.match.phase = MatchPhase.PRE_MATCH; s.match.firstKickoffTeam = 1; },
        check: (s) => { expect(s.match.phase).toBe(MatchPhase.KICK_OFF); expect(s.match.restart.team).toBe(1); } },
    ];
    for (const c of cases) {
      const s = base({ cup: 1 });
      c.prep(s);
      s.match.phaseT = T_RULES.phaseMaxTicks[s.match.phase]!;
      const ph = s.match.phase;
      const ev = dog(s);
      expect(watchdogs(ev), c.name).toEqual([[WatchdogReason.PHASE_TIMEOUT, ph]]);
      c.check(s);
    }
  });

  it('a stuck restart is kicked and play goes on (in the real pipeline)', () => {
    const spots: [RestartKind, number, number][] = [
      [RestartKind.THROW_IN, 3, HALF_WIDTH], [RestartKind.GOAL_KICK, -47, 0], [RestartKind.CORNER, 52, 33.5],
      [RestartKind.FREE_KICK, 3, 0], [RestartKind.PENALTY, 41.5, 0],
    ];
    for (const [kind, x, z] of spots) {
      const s = base();
      EV.begin(s.tick);
      awardRestart(s, kind, 0, x, z, EV);
      const ph = s.match.phase;
      expect(ph).not.toBe(MatchPhase.IN_PLAY);
      s.match.phaseT = T_RULES.phaseMaxTicks[ph]! - 1;
      const ev = run(s, 1);
      expect(watchdogs(ev), RestartKind[kind]).toEqual([[WatchdogReason.PHASE_TIMEOUT, ph]]);
      expect(ev.filter((e) => e.type === EventType.KICK)).toHaveLength(1);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      expect(s.ball.lastTouchTeam).toBe(0);
    }
  });
});

// ---------------------------------------------------------------- action overruns

describe('RUL-11 watchdog ACTION_OVERRUN', () => {
  it('ends an action stuck past its budget (and a charge held far too long) and logs it', () => {
    const s = base();
    const p = s.players[6]!;
    p.act = ActionKind.SKILL; p.actDur = 20; p.actT = 20 + LOCAL_TUNING.actionOverrunTicks;
    expect(dog(s)).toEqual([]);
    p.actT++;
    expect(watchdogs(dog(s))).toEqual([[WatchdogReason.ACTION_OVERRUN, 6]]);
    expect(p.act).toBe(ActionKind.NONE);
    const q = s.players[8]!;
    q.act = ActionKind.SHOT; q.actDur = 30; q.actCharging = 1; q.actT = 30 + LOCAL_TUNING.actionOverrunTicks + 10;
    expect(dog(s)).toEqual([]); // charging may legitimately run past actDur
    q.actT = 30 + LOCAL_TUNING.chargeOverrunTicks + 1;
    expect(watchdogs(dog(s))).toEqual([[WatchdogReason.ACTION_OVERRUN, 8]]);
    expect(q.act).toBe(ActionKind.NONE);
  });

  it('clears an action left on a sent-off player', () => {
    const s = base();
    const p = s.players[17]!;
    p.active = 0; p.act = ActionKind.STAND_TACKLE; p.actDur = 30; p.actT = 3;
    expect(watchdogs(dog(s))).toEqual([[WatchdogReason.ACTION_OVERRUN, 17]]);
    expect(p.act).toBe(ActionKind.NONE);
  });
});

// ---------------------------------------------------------------- ball checks

describe('RUL-11 watchdog ball checks', () => {
  function looseBall(s: SimState, x: number, y: number, z: number, lastTeam: number): void {
    const b = s.ball;
    b.x = x; b.y = y; b.z = z; b.px = x; b.py = y; b.pz = z;
    b.vx = 0; b.vy = 0; b.vz = 0; b.owner = -1; b.heldBy = -1;
    b.lastTouchTeam = lastTeam; b.lastTouch = lastTeam === 1 ? 14 : 4;
    b.grounded = y <= BALL_RADIUS + 1e-9 ? 1 : 0;
  }

  it('BALL_UNTOUCHED: a loose ball untouched for 8 s -> free kick to the team that did not touch it last, where it lies', () => {
    const s = base();
    looseBall(s, 10, BALL_RADIUS, 5, 0);
    s.ball.idleT = T_RULES.ballIdleTicks - 3;
    const ev = run(s, 5, (st) => st.match.phase !== MatchPhase.IN_PLAY);
    expect(watchdogs(ev)).toEqual([[WatchdogReason.BALL_UNTOUCHED, RestartKind.FREE_KICK]]);
    expect([s.match.phase, s.match.restart.team, s.match.restart.x, s.match.restart.z]).toEqual([MatchPhase.FREE_KICK, 1, 10, 5]);
    expect(s.match.watchdogCount).toBe(1);
    expectRecovers(s);
  });

  it('BALL_UNTOUCHED in the opponents\' penalty area: the free kick is moved outside the box', () => {
    const s = base();
    looseBall(s, 48, BALL_RADIUS, 3, 1); // team 0 attacks +x and gets the free kick
    s.ball.idleT = T_RULES.ballIdleTicks;
    dog(s);
    expect([s.match.restart.kind, s.match.restart.team, s.match.restart.x, s.match.restart.z]).toEqual(
      [RestartKind.FREE_KICK, 0, HALF_LENGTH - PENALTY_AREA_DEPTH - LOCAL_TUNING.boxMargin, 3]);
  });

  it('BALL_UNTOUCHED: a keeper holding the ball for 8 s gives the opponents a free kick', () => {
    const s = base();
    const k = s.teams[1]!.keeperSlot;
    s.players[k]!.x = 48; s.players[k]!.z = 0;
    looseBall(s, 48, 1, 0, 1);
    s.ball.owner = k; s.ball.heldBy = k;
    s.ball.idleT = T_RULES.ballIdleTicks;
    expect(watchdogs(dog(s))).toEqual([[WatchdogReason.BALL_UNTOUCHED, RestartKind.FREE_KICK]]);
    expect([s.match.restart.team, s.ball.heldBy, s.ball.owner]).toEqual([0, -1, -1]);
  });

  it('BALL_UNTOUCHED never fires for a ball being dribbled, nor in practice mode', () => {
    const s = base();
    looseBall(s, 0, BALL_RADIUS, 0, 0);
    s.ball.owner = 9; s.ball.idleT = 5000;
    expect(dog(s)).toEqual([]);
    const p = base({ mode: ModeId.PRACTICE });
    looseBall(p, 0, BALL_RADIUS, 0, 0);
    p.ball.idleT = 5000;
    expect(dog(p)).toEqual([]);
  });

  const outCases: [string, number, number, number, number, RestartKind, number][] = [
    // name, x, y, z, last touch team, kind, team
    ['beyond a touchline', 10, BALL_RADIUS, HALF_WIDTH + 1, 0, RestartKind.THROW_IN, 1],
    ['beyond a goal line, defenders touched last', HALF_LENGTH + 1, BALL_RADIUS, 12, 1, RestartKind.CORNER, 0],
    ['beyond a goal line, attackers touched last', HALF_LENGTH + 1, BALL_RADIUS, 12, 0, RestartKind.GOAL_KICK, 1],
    ['stuck in the net while IN_PLAY', -(HALF_LENGTH + 1.2), 0.5, 1, 1, RestartKind.GOAL_KICK, 0],
    ['resting on the net roof', HALF_LENGTH + 1, GOAL_HEIGHT + 0.15, 0.5, 1, RestartKind.CORNER, 0],
    ['behind the goal by the boards', -(HALF_LENGTH + 4), BALL_RADIUS, -6, 0, RestartKind.CORNER, 1],
  ];
  for (const [name, x, y, z, last, kind, team] of outCases) {
    it(`BALL_UNREACHABLE: ${name} -> ${RestartKind[kind]} for team ${team}, then a legal restart`, () => {
      const s = base();
      looseBall(s, x, y, z, last);
      if (name.includes('net')) s.ball.inNet = x > 0 ? 1 : -1;
      const ev = dog(s);
      expect(watchdogs(ev)).toEqual([[WatchdogReason.BALL_UNREACHABLE, kind]]);
      expect([s.match.restart.kind, s.match.restart.team]).toEqual([kind, team]);
      const r = s.match.restart;
      expect(Math.abs(r.x)).toBeLessThanOrEqual(HALF_LENGTH);
      expect(Math.abs(r.z)).toBeLessThanOrEqual(HALF_WIDTH);
      if (kind === RestartKind.CORNER) expect(Math.sign(r.x)).toBe(s.teams[team]!.dir);
      if (kind === RestartKind.GOAL_KICK) expect(Math.sign(r.x)).toBe(-s.teams[team]!.dir);
      expectRecovers(s);
    });
  }

  it('BALL_UNREACHABLE: a ball resting on top of the crossbar -> free kick to the defenders', () => {
    const s = base();
    looseBall(s, HALF_LENGTH, GOAL_HEIGHT + POST_RADIUS + BALL_RADIUS, 1, 0);
    s.ball.idleT = LOCAL_TUNING.restingTicks;
    expect(watchdogs(dog(s))).toEqual([[WatchdogReason.BALL_UNREACHABLE, RestartKind.FREE_KICK]]);
    expect([s.match.restart.team, s.match.restart.x, s.match.restart.z]).toEqual([1, HALF_LENGTH, 1]);
  });

  it('no false trigger: a high ball at the top of its flight, a ball on the line, a fresh resting ball', () => {
    const s = base();
    looseBall(s, 20, 3.0, 0, 0);
    s.ball.vy = 0.001; s.ball.py = 2.9986; s.ball.idleT = 200; // apex of a lob
    expect(dog(s)).toEqual([]);
    looseBall(s, HALF_LENGTH, BALL_RADIUS, 20, 0); // on the goal line (in play)
    s.ball.idleT = 10;
    expect(dog(s)).toEqual([]);
    looseBall(s, HALF_LENGTH, GOAL_HEIGHT + POST_RADIUS + BALL_RADIUS, 1, 0);
    s.ball.idleT = LOCAL_TUNING.restingTicks - 1; // just landed on the bar: give it a moment
    expect(dog(s)).toEqual([]);
  });

  it('no watchdog in normal flows: 30 s of play with the ball touched now and then', () => {
    const s = base();
    looseBall(s, -5, BALL_RADIUS, 3, 0);
    const ev = run(s, 1800, undefined, 300);
    expect(watchdogs(ev)).toEqual([]);
    expect(s.match.watchdogCount).toBe(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });
});
