/**
 * SIM-15 — BRIEF §9 Pitch gestures table, one test per row (attack, defence) plus keeper gestures and gesture
 * buffering. Real step() pipeline; starters are recording fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/kicks/pass', async (o) => (await import('./sim-15-fakes')).mockPass((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/lob', async (o) => (await import('./sim-15-fakes')).mockLob((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/through', async (o) => (await import('./sim-15-fakes')).mockThrough((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/shot', async (o) => (await import('./sim-15-fakes')).mockShot((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/aerial', async (o) => (await import('./sim-15-fakes')).mockAerial((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/skills', async (o) => (await import('./sim-15-fakes')).mockSkills((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/defend/tackle', async (o) => (await import('./sim-15-fakes')).mockTackle((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/keeper/sweeper', async (o) => (await import('./sim-15-fakes')).mockSweeper((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/keeper/handling', async (o) => (await import('./sim-15-fakes')).mockHandling((await o()) as Record<string, unknown>));
vi.mock('../../src/ai/runs', async (o) => (await import('./sim-15-fakes')).mockRuns((await o()) as Record<string, unknown>));
vi.mock('../../src/ai/support', async (o) => (await import('./sim-15-fakes')).mockSupport((await o()) as Record<string, unknown>));

import { GOAL_HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, GestureKind, KickKind } from '../../src/contracts/enums';
import { GestureFlag, type InputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { ReqFlag } from '../../src/contracts/systems';
import { LOCAL_TUNING } from '../../src/sim/control/resolveShared';
import { CALLS, calls, resetFakes } from './sim-15-fakes';
import { keepBall, run, scene } from './sim-15-setup';

const P = 9;
const T = 10; // teammate
beforeEach(() => resetFakes());

/** Attack scene: P1's slot 9 with the ball at (x, z), teammate 10 at (25, 5). */
function attack(x = 10, z = 0): SimState {
  const s = scene({ x, z });
  const t = s.players[T]!; t.x = 25; t.z = 5;
  return s;
}
function gesture(s: SimState, g: Partial<InputFrame>, ticks = 3): void {
  run(s, ticks, (i, st) => {
    if (st.ball.owner === P && st.players[P]!.act === ActionKind.NONE) keepBall(st, P);
    return i === 1 ? g : {};
  });
}
const dm = (m: number): number => Math.round(m * 10);

describe('SIM-15 §9 Pitch gestures: attack', () => {
  it('Tap a teammate -> ground pass to feet', () => {
    const s = attack();
    gesture(s, { gesture: GestureKind.TAP, gx: dm(25), gz: dm(5), gSlot: T });
    const c = calls('startPass');
    expect(c.map((x) => x.kind)).toEqual([KickKind.GROUND_PASS]);
    expect(c[0]!.targetSlot).toBe(T);
    expect(c[0]!.hasTarget).toBe(0);
    expect(c[0]!.flags & ReqFlag.GESTURE).toBe(ReqFlag.GESTURE);
    expect(c[0]!.charging).toBe(0);
    expect(c[0]!.power).toBeGreaterThan(0);
  });
  it('Tap just behind a teammate -> ground pass to feet', () => {
    const s = attack();
    gesture(s, { gesture: GestureKind.TAP, gx: dm(23.8), gz: dm(5), gSlot: -1 });
    const c = calls('startPass');
    expect(c.map((x) => x.kind)).toEqual([KickKind.GROUND_PASS]);
    expect(c[0]!.targetSlot).toBe(T);
  });
  it('Tap the space in front of a teammate -> through ball into that space', () => {
    const s = attack();
    gesture(s, { gesture: GestureKind.TAP, gx: dm(32), gz: dm(6), gSlot: -1 });
    const c = calls('startThrough');
    expect(c.map((x) => x.kind)).toEqual([KickKind.THROUGH_GROUND]);
    expect(c[0]!.targetSlot).toBe(T);
    expect(c[0]!.hasTarget).toBe(1);
    expect([c[0]!.targetX, c[0]!.targetZ]).toEqual([32, 6]);
  });
  it('Double-tap a teammate -> the lobbed version (lob pass to him)', () => {
    const s = attack();
    gesture(s, { gesture: GestureKind.DOUBLE_TAP, gx: dm(25), gz: dm(5), gSlot: T });
    const c = calls('startLob');
    expect(c.map((x) => x.kind)).toEqual([KickKind.LOB_PASS]);
    expect(c[0]!.targetSlot).toBe(T);
  });
  it('Double-tap the space in front -> lobbed through ball', () => {
    const s = attack();
    gesture(s, { gesture: GestureKind.DOUBLE_TAP, gx: dm(33), gz: dm(5), gSlot: -1 });
    expect(calls('startThrough').map((x) => x.kind)).toEqual([KickKind.THROUGH_LOBBED]);
  });
  it('In the crossing zone, double-tap toward a post -> cross to the near or far post', () => {
    const s = attack(36, 22);
    gesture(s, { gesture: GestureKind.DOUBLE_TAP, gx: dm(47), gz: dm(4), gSlot: -1 });
    const c = calls('startLob');
    expect(c.map((x) => x.kind)).toEqual([KickKind.CROSS]);
    expect(c[0]!.hasTarget).toBe(1);
    expect(c[0]!.targetZ).toBeCloseTo(GOAL_HALF_WIDTH, 9);
    expect(c[0]!.targetX).toBeCloseTo(52.5 - LOCAL_TUNING.crossPostDepth, 9);
    resetFakes();
    const s2 = attack(36, 22);
    gesture(s2, { gesture: GestureKind.DOUBLE_TAP, gx: dm(46), gz: dm(-5), gSlot: -1 });
    expect(calls('startLob')[0]!.targetZ).toBeCloseTo(-GOAL_HALF_WIDTH, 9);
  });
  it('Swipe toward goal -> shot; a faster swipe is harder', () => {
    const s = attack(30, 0);
    gesture(s, { gesture: GestureKind.SWIPE, gdx: 127, gdz: 10, gPower: 110 });
    const c = calls('startShot');
    expect(c.map((x) => x.kind)).toEqual([KickKind.SHOT_NORMAL]);
    expect(c[0]!.power).toBeCloseTo(110 / 127, 9);
    expect(c[0]!.dirX).toBeGreaterThan(0.99);
    expect(c[0]!.charging).toBe(0);
  });
  it('Curved swipe toward goal -> finesse shot that bends with the swipe', () => {
    const s = attack(30, 0);
    gesture(s, { gesture: GestureKind.CURVED_SWIPE, gdx: 127, gdz: 0, gPower: 80, gCurve: -60 });
    const c = calls('startShot');
    expect(c.map((x) => x.kind)).toEqual([KickKind.SHOT_FINESSE]);
    expect(c[0]!.curve).toBeCloseTo(-60 / 127, 9);
  });
  it('Tap on the goal -> chip shot', () => {
    const s = attack(30, 0);
    gesture(s, { gesture: GestureKind.TAP, gx: dm(52.5), gz: dm(1), gSlot: -1, gFlags: GestureFlag.ON_GOAL });
    const c = calls('startShot');
    expect(c.map((x) => x.kind)).toEqual([KickKind.SHOT_CHIP]);
    expect(c[0]!.hasTarget).toBe(1);
  });
  it('Quick back-and-forth swipe toward goal -> power shot', () => {
    const s = attack(30, 0);
    gesture(s, { gesture: GestureKind.BACK_FORTH_SWIPE, gdx: 120, gdz: -20, gPower: 127 });
    expect(calls('startShot').map((x) => x.kind)).toEqual([KickKind.SHOT_POWER]);
  });
  it('Swipe in your own half with the ball -> clearance', () => {
    const s = attack(-20, 0);
    gesture(s, { gesture: GestureKind.SWIPE, gdx: 127, gdz: 0, gPower: 120 });
    expect(calls('startClearance').map((x) => x.kind)).toEqual([KickKind.CLEARANCE]);
    expect(calls('startShot', false)).toHaveLength(0);
  });
  it('a swipe away from goal in the opposition half does nothing', () => {
    const s = attack(30, 0);
    gesture(s, { gesture: GestureKind.SWIPE, gdx: -127, gdz: 0, gPower: 100 });
    expect(CALLS.filter((c) => c.fn.startsWith('start'))).toHaveLength(0);
  });
  it('a gesture while the player is busy is buffered like a press', () => {
    const s = attack();
    const p = s.players[P]!;
    p.act = ActionKind.SKILL; p.actT = 0; p.actDur = 3; p.actContact = -1;
    gesture(s, { gesture: GestureKind.TAP, gx: dm(25), gz: dm(5), gSlot: T }, 8);
    const c = calls('startPass');
    expect(c).toHaveLength(1);
    expect(c[0]!.tick).toBe(4);
    expect(c[0]!.targetSlot).toBe(T);
  });
});

describe('SIM-15 §9 Pitch gestures: defence', () => {
  const D = 5, C = 20;
  function defence(): SimState {
    const s = scene({ slot: D, x: -24, z: 0, ball: 'none' });
    const q = s.players[C]!; q.x = -18; q.z = 0;
    const h = s.players[6]!; h.x = -22; h.z = -6;
    const b = s.ball;
    b.x = -18.5; b.z = 0; b.y = 0.11; b.px = b.x; b.pz = 0; b.vx = 0; b.vz = 0; b.owner = C; b.heldBy = -1; b.lastTouchTeam = 1; b.lastTouch = C;
    return s;
  }
  function keep(st: SimState): void {
    const q = st.players[C]!; q.x = -18; q.z = 0; q.vx = 0; q.vz = 0;
    const b = st.ball; b.x = -18.5; b.z = 0; b.vx = 0; b.vz = 0; b.owner = C;
  }
  it('Tap the opposing ball carrier -> press him (and a second defender)', () => {
    const s = defence();
    run(s, 3, (i, st) => { keep(st); return i === 1 ? { gesture: GestureKind.TAP, gx: dm(-18), gz: 0, gSlot: C } : {}; });
    const p = s.players[D]!;
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    expect(p.wantSprint).toBe(1);
    expect(p.tgtX).toBeLessThan(-18);
    expect(s.ctrl[0]!.secondDef).toBe(6);
    // the press lasts gesturePressTicks unless the stick moves
    run(s, 1, (_i, st) => { keep(st); return { mx: 127 }; });
    expect(s.players[D]!.moveMode).toBe(MoveMode.DIRECT);
  });
  it('Swipe in your own half without the ball -> slide tackle', () => {
    const s = defence();
    run(s, 3, (i, st) => { keep(st); return i === 1 ? { gesture: GestureKind.SWIPE, gdx: 127, gdz: 0, gPower: 90 } : {}; });
    expect(calls('startTackle').map((x) => x.kind)).toEqual([ActionKind.SLIDE_TACKLE]);
  });
  it('Double-tap the pitch when defending -> second defender', () => {
    const s = defence();
    run(s, 3, (i, st) => { keep(st); return i === 1 ? { gesture: GestureKind.DOUBLE_TAP, gx: dm(0), gz: dm(10), gSlot: -1 } : {}; });
    expect(s.ctrl[0]!.secondDef).toBe(6);
  });
  it('Tap your keeper when defending -> keeper rushes out', () => {
    const s = defence();
    run(s, 3, (i, st) => {
      keep(st);
      return i === 1 ? { gesture: GestureKind.TAP, gx: dm(-50), gz: 0, gSlot: 0, gFlags: GestureFlag.ON_OWN_KEEPER } : {};
    });
    const r = calls('startKeeperRush');
    expect(r).toHaveLength(1);
    expect(r[0]!.slot).toBe(0);
    expect(s.ctrl[0]!.slot).toBe(D); // no switch to the keeper
  });
  it('Tap a teammate when defending -> switch to him', () => {
    const s = defence();
    run(s, 2, (i, st) => { keep(st); return i === 1 ? { gesture: GestureKind.TAP, gx: dm(-22), gz: dm(-6), gSlot: 6 } : {}; });
    expect(s.ctrl[0]!.slot).toBe(6);
    expect(s.players[6]!.ctrl).toBe(0);
    expect(CALLS.filter((c) => c.fn.startsWith('start'))).toHaveLength(0);
  });
});

describe('SIM-15 keeper gestures (ball in hands)', () => {
  it('tap a teammate -> throw to him; swipe -> drop kick that way', () => {
    const s = scene({ slot: 0, x: -48, z: 0, ball: 'none' });
    const b = s.ball;
    b.owner = 0; b.heldBy = 0; b.x = -47.6; b.y = 1.2; b.z = 0; b.vx = 0; b.vz = 0;
    const k = s.players[0]!; k.act = ActionKind.GK_HOLD; k.actT = 0; k.actDur = 600;
    const t = s.players[2]!; t.x = -35; t.z = -10;
    run(s, 2, (i) => (i === 1 ? { gesture: GestureKind.TAP, gx: dm(-35), gz: dm(-10), gSlot: 2 } : {}));
    const c = calls('startKeeperRelease');
    expect(c.map((x) => x.kind)).toEqual([KickKind.GK_THROW]);
    expect(c[0]!.targetSlot).toBe(2);
    resetFakes();
    const s2 = scene({ slot: 0, x: -48, z: 0, ball: 'none' });
    const b2 = s2.ball;
    b2.owner = 0; b2.heldBy = 0; b2.x = -47.6; b2.y = 1.2; b2.z = 0; b2.vx = 0; b2.vz = 0;
    const k2 = s2.players[0]!; k2.act = ActionKind.GK_HOLD; k2.actT = 0; k2.actDur = 600;
    run(s2, 2, (i) => (i === 1 ? { gesture: GestureKind.SWIPE, gdx: 127, gdz: 0, gPower: 120 } : {}));
    expect(calls('startKeeperRelease').map((x) => x.kind)).toEqual([KickKind.GK_DROP_KICK]);
  });
});
