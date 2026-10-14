/**
 * TCH-07 scenario: touch events -> mapper -> the REAL step() pipeline (SIM-15 resolution, switching, dispatch). Each
 * section 9 cell is driven as the player would touch it (events at real times, one sample per tick) and the test
 * asserts the action start SIM-15 requested: starter, kind, flags, explicit power / charging, skill, tackle, keeper
 * release, switch, second defender, keeper rush. The starters are recording fakes (tests/scenario/tch-07-fakes.ts) so
 * the rows hold whatever state the starter modules are in. This proves the bits and their timing (press edges,
 * modifiers at the face press, the double-tap window, explicit power) mean in the sim what section 9 says.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/kicks/pass', async (o) => (await import('./tch-07-fakes')).mockPass((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/lob', async (o) => (await import('./tch-07-fakes')).mockLob((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/through', async (o) => (await import('./tch-07-fakes')).mockThrough((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/shot', async (o) => (await import('./tch-07-fakes')).mockShot((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/aerial', async (o) => (await import('./tch-07-fakes')).mockAerial((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/skills', async (o) => (await import('./tch-07-fakes')).mockSkills((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/defend/tackle', async (o) => (await import('./tch-07-fakes')).mockTackle((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/keeper/sweeper', async (o) => (await import('./tch-07-fakes')).mockSweeper((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/keeper/handling', async (o) => (await import('./tch-07-fakes')).mockHandling((await o()) as Record<string, unknown>));
vi.mock('../../src/ai/runs', async (o) => (await import('./tch-07-fakes')).mockRuns((await o()) as Record<string, unknown>));
vi.mock('../../src/ai/support', async (o) => (await import('./tch-07-fakes')).mockSupport((await o()) as Record<string, unknown>));

import { ActionKind, AutoSwitch, ControllerKind, GestureKind, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import type { CameraProjector, InputSampleContext } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { ReqFlag } from '../../src/contracts/systems';
import {
  ClusterMode, createTouchIntentState, pushButtonEvent, pushGestureEvent, SwipeDir, TouchButtonId as TB, TouchEdge as E,
  type TouchGestureEvent,
} from '../../src/contracts/touch';
import { createTouchMapper, LOCAL_TUNING } from '../../src/input/touch/mapper';
import { makeScenario, runTicks } from '../harness/scenario';
import { calls, CALLS, resetFakes, starts } from './tch-07-fakes';

const TICK = 1000 / 60;
beforeEach(() => resetFakes());

/** Quiet IN_PLAY scene: P1 controls `slot` at (x, z) facing +x; everyone else parked; the away CPU brain off. */
function scene(slot: number, x: number, z: number, ball: 'feet' | 'none' = 'feet'): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot, autoSwitch: AutoSwitch.OFF }], seed: 11 });
  const c3 = s.ctrl[3]!;
  if (c3.slot >= 0 && s.players[c3.slot]!.ctrl === 3) s.players[c3.slot]!.ctrl = -1;
  c3.kind = ControllerKind.NONE; c3.side = -1; c3.slot = -1;
  s.teams[1]!.cpu.active = 0;
  for (let i = 0; i < 22; i++) {
    if (i === slot) continue;
    const p = s.players[i]!;
    const team = i < 11 ? 0 : 1;
    const k = i % 11;
    if (k === 0) { p.x = team === 0 ? -50 : 50; p.z = 0; } else { p.x = team === 0 ? -44 : 44; p.z = -30 + k * 5.5; }
    p.vx = 0; p.vz = 0; p.fx = team === 0 ? 1 : -1; p.fz = 0;
  }
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0; p.fx = 1; p.fz = 0;
  const b = s.ball;
  if (ball === 'feet') keep(s, slot);
  else { b.owner = -1; b.heldBy = -1; }
  return s;
}

/** Ball at the dribbler's feet (the fakes do not move it). */
function keep(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  b.x = p.x + 0.5; b.z = p.z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
  b.owner = slot; b.heldBy = -1; b.lastTouch = slot; b.lastTouchTeam = p.team;
}

type Ev = readonly [t: number, b: TB, e: E, dir?: SwipeDir];

const PROJ: CameraProjector = {
  screenToPitch(sx, sy, out) { out.x = (sx - 600) / 10; out.z = (sy - 400) / 10; return true; },
  pitchToScreen(x, y, z, out) { out.x = 600 + x * 10; out.y = 400 + z * 10 - y * 10; return true; },
  stickRotation: () => 0,
};

/**
 * Drive touch events (and gestures) through the mapper into the real pipeline for `ticks` ticks. `each(i, s)` runs
 * before every sample. Returns every sim event.
 */
function drive(s: SimState, evs: readonly Ev[], ticks: number, mode: ClusterMode, each?: (i: number, s: SimState) => void,
  gestures: readonly [number, TouchGestureEvent][] = []): SimEvent[] {
  const st = createTouchIntentState();
  let clock = 0;
  const m = createTouchMapper(st, { now: () => clock });
  let k = 0, g = 0, i = 0;
  return runTicks(s, ticks, (tick, state, out) => {
    clock = i * TICK;
    while (k < evs.length && evs[k]![0] <= clock + 1e-9) {
      const [t, b, e, d] = evs[k]!;
      pushButtonEvent(st, b, e, d ?? SwipeDir.NONE, t, mode);
      k++;
    }
    while (g < gestures.length && gestures[g]![0] <= clock + 1e-9) pushGestureEvent(st, gestures[g++]![1]);
    if (each) each(i, state);
    const ctx: InputSampleContext = { tick, human: 0, side: 0, state, projector: PROJ };
    m.sample(out[0]!, ctx);
    i++;
  });
}

const tap = (b: TB, at = 0, dur = 80): Ev[] => [[at, b, E.DOWN], [at + dur, b, E.UP], [at + dur, b, E.TAP]];
const flick = (b: TB, d: SwipeDir, at = 0): Ev[] => [[at, b, E.DOWN], [at + 40, b, E.SWIPE, d], [at + 60, b, E.UP]];
const swipeHold = (b: TB, d: SwipeDir, upAt = 500): Ev[] => [[0, b, E.DOWN], [40, b, E.SWIPE, d], [upAt, b, E.UP]];
const hold = (b: TB, upAt: number): Ev[] => [[0, b, E.DOWN], [170, b, E.HOLD], [upAt, b, E.UP]];
const doubleTap = (b: TB): Ev[] => [[0, b, E.DOWN], [60, b, E.UP], [60, b, E.TAP], [150, b, E.DOWN], [200, b, E.UP], [200, b, E.DOUBLE_TAP]];

const P = 9;
/** Attack scene: #9 dribbling at (x, 0); the ball stays at his feet while he is free. */
function attack(x = 10): SimState {
  return scene(P, x, 0);
}
const keepP = (_i: number, s: SimState): void => { if (s.players[P]!.act === ActionKind.NONE && (s.ball.owner === P || s.ball.owner < 0)) keep(s, P); };
const FLICK_PASS = Math.round(LOCAL_TUNING.flickPassPower * 127) / 127;
const FLICK_SHOT = Math.round(LOCAL_TUNING.flickShotPower * 127) / 127;

describe('TCH-07 x sim: attack table rows start the section 9 kick (combo read at the face press)', () => {
  const rows: [string, Ev[], string, KickKind, number][] = [
    ['PASS tap -> ground pass', tap(TB.PASS), 'startPass', KickKind.GROUND_PASS, 0],
    ['PASS swipe up -> lob pass', flick(TB.PASS, SwipeDir.UP), 'startLob', KickKind.LOB_PASS, 0],
    ['PASS swipe down -> pass and go', flick(TB.PASS, SwipeDir.DOWN), 'startPass', KickKind.GROUND_PASS, ReqFlag.PASS_AND_GO],
    ['PASS swipe left -> driven lob', flick(TB.PASS, SwipeDir.LEFT), 'startLob', KickKind.DRIVEN_LOB, ReqFlag.DRIVEN],
    ['PASS swipe right -> driven ground pass', flick(TB.PASS, SwipeDir.RIGHT), 'startPass', KickKind.DRIVEN_PASS, ReqFlag.DRIVEN],
    ['THROUGH tap -> through ball', tap(TB.THROUGH), 'startThrough', KickKind.THROUGH_GROUND, 0],
    ['THROUGH swipe up -> lobbed through ball', flick(TB.THROUGH, SwipeDir.UP), 'startThrough', KickKind.THROUGH_LOBBED, 0],
    ['SHOOT tap -> shot', tap(TB.SHOOT), 'startShot', KickKind.SHOT_NORMAL, 0],
    ['SHOOT swipe up -> chip shot', flick(TB.SHOOT, SwipeDir.UP), 'startShot', KickKind.SHOT_CHIP, 0],
    ['SHOOT swipe down -> finesse shot', flick(TB.SHOOT, SwipeDir.DOWN), 'startShot', KickKind.SHOT_FINESSE, 0],
    ['SHOOT swipe right -> power shot', flick(TB.SHOOT, SwipeDir.RIGHT), 'startShot', KickKind.SHOT_POWER, 0],
  ];
  for (const [name, evs, fn, kind, flags] of rows) {
    it(name, () => {
      drive(attack(), evs, 40, ClusterMode.ATTACK, keepP);
      const c = starts();
      expect(c.map((x) => [x.fn, x.kind]), name).toEqual([[fn, kind]]);
      expect(c[0]!.flags & flags).toBe(flags);
      // A tap charges from the hold (power bar); a flicked swipe carries its explicit power.
      if (evs.some((e) => e[2] === E.SWIPE)) {
        expect(c[0]!.charging).toBe(0);
        expect(c[0]!.power).toBeCloseTo(fn === 'startShot' ? FLICK_SHOT : FLICK_PASS, 6);
      } else {
        expect(c[0]!.charging).toBe(1);
      }
    });
  }

  it('PASS / THROUGH hold -> the kick charges while the finger is down; a swipe kept down charges its combo', () => {
    drive(attack(), hold(TB.PASS, 450), 40, ClusterMode.ATTACK, keepP);
    expect(starts().map((c) => [c.fn, c.kind, c.charging])).toEqual([['startPass', KickKind.GROUND_PASS, 1]]);
    resetFakes();
    drive(attack(), swipeHold(TB.PASS, SwipeDir.LEFT, 600), 40, ClusterMode.ATTACK, keepP);
    expect(starts().map((c) => [c.fn, c.kind, c.charging])).toEqual([['startLob', KickKind.DRIVEN_LOB, 1]]);
  });

  it('PASS double tap -> dinked pass; THROUGH double tap -> dinked through ball (converted during the first wind-up)', () => {
    drive(attack(), doubleTap(TB.PASS), 40, ClusterMode.ATTACK, keepP);
    expect(starts().map((c) => [c.fn, c.kind])).toEqual([['startPass', KickKind.GROUND_PASS], ['startPass', KickKind.DINKED_PASS]]);
    resetFakes();
    drive(attack(), doubleTap(TB.THROUGH), 40, ClusterMode.ATTACK, keepP);
    expect(starts().map((c) => [c.fn, c.kind])).toEqual([['startThrough', KickKind.THROUGH_GROUND], ['startThrough', KickKind.THROUGH_DINKED]]);
  });

  it('SHOOT swipe left -> fake shot (a shot starts, then PASS during its wind-up fakes it)', () => {
    drive(attack(30), flick(TB.SHOOT, SwipeDir.LEFT), 30, ClusterMode.ATTACK, keepP);
    expect(starts().map((c) => c.fn)).toEqual(['startShot', 'startFake']);
    expect(calls('startPass')).toEqual([]);
  });

  it('THROUGH swipe down -> trigger a teammate\'s run (an L1 tap, no kick)', () => {
    drive(attack(), flick(TB.THROUGH, SwipeDir.DOWN), 30, ClusterMode.ATTACK, keepP);
    expect(CALLS.filter((c) => c.ok === 1).map((c) => c.fn)).toEqual(['triggerRun']);
  });

  it('SPRINT & SKILL: tap = the tap slot, swipes = their skills / knock-on / hard stop; hold = sprint, no stop-ball on a tap', () => {
    const rows: [Ev[], SkillMove][] = [
      [tap(TB.SPRINT_SKILL), SkillMove.STEP_OVER],
      [flick(TB.SPRINT_SKILL, SwipeDir.UP), SkillMove.ROULETTE],
      [flick(TB.SPRINT_SKILL, SwipeDir.RIGHT), SkillMove.HEEL_FLICK],
      [flick(TB.SPRINT_SKILL, SwipeDir.DOWN), SkillMove.KNOCK_ON],
      [flick(TB.SPRINT_SKILL, SwipeDir.LEFT), SkillMove.HARD_STOP],
    ];
    for (const [evs, skill] of rows) {
      resetFakes();
      const s = attack();
      s.players[P]!.vx = 5; // running with the ball, stick released
      drive(s, evs, 30, ClusterMode.ATTACK, keepP);
      expect(calls('startSkill').map((c) => c.kind), SkillMove[skill]).toEqual([skill]);
    }
    const s = attack();
    let sprint = 0;
    drive(s, hold(TB.SPRINT_SKILL, 800), 45, ClusterMode.ATTACK, (i, st) => { keepP(i, st); if (i > 12 && st.ctrl[0]!.buttons !== 0) sprint++; });
    expect(sprint).toBeGreaterThan(25);
  });
});

describe('TCH-07 x sim: keeper with the ball', () => {
  function keeper(): SimState {
    const s = scene(0, -48, 0, 'none');
    const b = s.ball;
    b.owner = 0; b.heldBy = 0; b.x = -47.6; b.y = 1.2; b.z = 0; b.vx = 0; b.vz = 0; b.px = b.x; b.py = b.y; b.pz = b.z;
    const k = s.players[0]!;
    k.act = ActionKind.GK_HOLD; k.actT = 0; k.actDur = 600; k.actContact = -1;
    return s;
  }
  const rows: [TB, KickKind][] = [
    [TB.PASS, KickKind.GK_THROW], [TB.THROUGH, KickKind.GK_DRIVEN_THROW], [TB.SHOOT, KickKind.GK_DROP_KICK], [TB.SPRINT_SKILL, KickKind.GK_RELEASE],
  ];
  for (const [b, kind] of rows) {
    it(`keeper ${TB[b]} -> ${KickKind[kind]}`, () => {
      drive(keeper(), tap(b), 20, ClusterMode.KEEPER);
      expect(calls('startKeeperRelease').map((c) => c.kind)).toEqual([kind]);
    });
  }
});

describe('TCH-07 x sim: defence buttons', () => {
  /** The away #18 dribbles at (-20, 0) toward the home goal; P1 controls #4 goal-side at (-21.3, 0). */
  function defence(): SimState {
    const s = scene(4, -21.3, 0, 'none');
    const c = s.players[18]!;
    c.x = -20; c.z = 0; c.fx = -1; c.fz = 0;
    const b = s.ball;
    b.x = -20.5; b.z = 0; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
    b.owner = 18; b.heldBy = -1; b.lastTouch = 18; b.lastTouchTeam = 1;
    return s;
  }
  const stand = [ActionKind.STAND_TACKLE, ActionKind.PUSH_PULL, ActionKind.SHOULDER];

  it('SPRINT & TACKLE tap -> a tackle by context (not a hard tackle)', () => {
    drive(defence(), tap(TB.SPRINT_TACKLE), 20, ClusterMode.DEFENCE);
    const c = calls('startTackle');
    expect(c.length).toBe(1);
    expect(stand).toContain(c[0]!.kind);
  });

  it('SPRINT & TACKLE swipe left -> hard tackle', () => {
    drive(defence(), flick(TB.SPRINT_TACKLE, SwipeDir.LEFT), 20, ClusterMode.DEFENCE);
    expect(calls('startTackle').map((c) => c.kind)).toEqual([ActionKind.HARD_TACKLE]);
  });

  it('SPRINT & TACKLE hold -> sprint, no tackle', () => {
    const s = defence();
    let sprint = 0;
    drive(s, hold(TB.SPRINT_TACKLE, 600), 30, ClusterMode.DEFENCE, (i, st) => { if (i > 2 && st.ctrl[0]!.buttons !== 0) sprint++; });
    expect(sprint).toBeGreaterThan(25);
    expect(calls('startTackle')).toEqual([]);
  });

  it('SLIDE -> slide tackle', () => {
    drive(defence(), tap(TB.SLIDE), 20, ClusterMode.DEFENCE);
    expect(calls('startTackle').map((c) => c.kind)).toEqual([ActionKind.SLIDE_TACKLE]);
  });

  it('CLEAR -> first-time clearance of a loose ball arriving in the own third', () => {
    const s = scene(4, -40, 0, 'none');
    const b = s.ball;
    b.owner = -1; b.lastTouchTeam = 1; b.x = -37; b.z = 0; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y;
    b.vx = -10; b.vz = 0; b.vy = 0; b.grounded = 1;
    const st = createTouchIntentState();
    st.clearOn = true; // CLEAR was showing when the finger landed
    let clock = 0;
    const m = createTouchMapper(st, { now: () => clock });
    let i = 0;
    runTicks(s, 6, (tick, state, out) => {
      clock = i * TICK;
      if (i === 0) { pushButtonEvent(st, TB.SLIDE, E.DOWN, SwipeDir.NONE, 0, ClusterMode.DEFENCE); }
      m.sample(out[0]!, { tick, human: 0, side: 0, state, projector: PROJ });
      i++;
    });
    expect(calls('startClearance').map((c) => c.kind)).toEqual([KickKind.CLEARANCE]);
    expect(calls('startTackle')).toEqual([]);
  });

  it('2ND DEF hold -> a second defender is called while held; tap -> called for a while', () => {
    let s = defence();
    let called = 0;
    drive(s, hold(TB.SECOND_DEF, 700), 40, ClusterMode.DEFENCE, (i, st) => { if (i > 12 && st.ctrl[0]!.secondDef >= 0) called++; });
    expect(called).toBeGreaterThan(20);
    s = defence();
    called = 0;
    drive(s, tap(TB.SECOND_DEF), 60, ClusterMode.DEFENCE, (i, st) => { if (i > 10 && st.ctrl[0]!.secondDef >= 0) called++; });
    expect(called).toBeGreaterThan(40);
  });

  it('2ND DEF swipe down -> the keeper rushes out', () => {
    drive(defence(), swipeHold(TB.SECOND_DEF, SwipeDir.DOWN, 400), 30, ClusterMode.DEFENCE);
    expect(calls('startKeeperRush').map((c) => c.slot)).toEqual([0]);
  });

  it('SWITCH tap -> change player; SWITCH swipe -> switch toward the swipe', () => {
    let s = defence();
    s.players[6]!.x = -23; s.players[6]!.z = 3;
    s.players[4]!.x = -38; s.players[4]!.z = 22;
    let ev = drive(s, tap(TB.SWITCH), 20, ClusterMode.DEFENCE);
    expect(ev.some((e) => e.type === EventType.SWITCH && e.c === 0)).toBe(true);
    expect(s.ctrl[0]!.slot).not.toBe(4);
    s = defence();
    s.players[6]!.x = -22; s.players[6]!.z = -16; // up the screen (-z) from #4
    s.players[2]!.x = -22; s.players[2]!.z = 16;
    ev = drive(s, flick(TB.SWITCH, SwipeDir.UP), 20, ClusterMode.DEFENCE);
    expect(ev.some((e) => e.type === EventType.SWITCH)).toBe(true);
    expect(s.ctrl[0]!.slot).toBe(6);
  });
});

describe('TCH-07 x sim: pitch gestures', () => {
  const g = (kind: GestureKind, sx: number, sy: number, ex = sx, ey = sy, vx = 0): TouchGestureEvent =>
    ({ kind, sx, sy, ex, ey, vx, vy: 0, curve: 0, tMs: 10, fromBall: false });

  it('tap a teammate -> pass to his feet (target = him); swipe toward goal -> shot', () => {
    let s = attack();
    s.players[7]!.x = 24; s.players[7]!.z = 2;
    drive(s, [], 20, ClusterMode.ATTACK, keepP, [[16, g(GestureKind.TAP, 600 + 240, 400 + 20)]]);
    let c = starts();
    expect(c.map((x) => [x.fn, x.kind])).toEqual([['startPass', KickKind.GROUND_PASS]]);
    expect(c[0]!.flags & ReqFlag.GESTURE).toBe(ReqFlag.GESTURE);
    resetFakes();
    s = attack(30);
    drive(s, [], 20, ClusterMode.ATTACK, keepP, [[16, g(GestureKind.SWIPE, 600 + 310, 400, 600 + 450, 400, 2.5)]]);
    c = starts();
    expect(c.map((x) => [x.fn, x.kind])).toEqual([['startShot', KickKind.SHOT_NORMAL]]);
  });
});
