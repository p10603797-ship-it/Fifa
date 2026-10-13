/**
 * RUL-06 input contract with a working shot starter. SIM-11 shot.ts is replaced by a small stand-in that follows its
 * documented contract: startShot records the request and begins a SHOT action (wind-up, contact, recovery; charging
 * while the button is held, the resolver filling p.actPower), and the SHOT handler strikes at the contact tick through
 * core/kick applyKick toward the request's target (speed from the power). Everything else is the real pipeline: SIM-15
 * routes the frames (and fills the power bar), SIM-16 hands the taker / keeper to the controllers, TAI-13 CPU takers
 * produce InputFrames, GKP-06 commits the keeper's dive at the contact tick, RUL-11 / RUL-01 run the restart flow.
 * `K.cpuOff` silences TAI-13's CPU set-piece input (to exercise RUL-06's CPU fallback).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BALL_RADIUS, GOAL_HALF_WIDTH, HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, AssistLevel, GestureKind, KickKind, MatchPhase, WatchdogReason } from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import { AXIS_SCALE, Btn, GestureFlag, UNIT_SCALE, quantPos, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { ReqFlag, createKickLaunch, type ActionHandler, type ActionRequest } from '../../src/contracts/systems';
import { T_BALL, T_PASS, T_RULES } from '../../src/contracts/tuning';
import { beginAction, isFree } from '../../src/sim/actions/dispatch';
import { applyKick } from '../../src/sim/core/kick';
import { LOCAL_TUNING as LT, penaltyKeeper } from '../../src/sim/rules/penalty';
import { findEvents, runTicks, runUntil } from '../harness/scenario';
import { penaltyScenario, untilReady } from './rul-06-helpers';

interface Call { tick: number; slot: number; kind: number; req: ActionRequest; phase: number; rt: number }
interface Strike { tick: number; slot: number; kind: number; power: number; tz: number; keeperAct: number }

const K = vi.hoisted(() => ({ calls: [] as unknown[], strikes: [] as unknown[], refuse: false, cpuOff: false }));
const calls = (): Call[] => K.calls as Call[];
const strikes = (): Strike[] => K.strikes as Strike[];

const WINDUP = 10;
const RECOVERY = 14;

function fakeStartShot(s: SimState, slot: number, kind: number, req: ActionRequest, _ev: EventSink): number {
  const m = s.match;
  (K.calls as Call[]).push({ tick: s.tick, slot, kind, req: { ...req }, phase: m.phase, rt: m.restart.t });
  if (K.refuse) return 0;
  const p = s.players[slot]!;
  const b = s.ball;
  if (!isFree(p) || Math.hypot(b.x - p.x, b.z - p.z) > 1.5) return 0;
  beginAction(p, ActionKind.SHOT, WINDUP + 1 + RECOVERY, WINDUP);
  p.actKick = kind;
  p.actPower = req.charging === 1 ? 0 : req.power;
  p.actCharging = req.charging === 1 ? 1 : 0;
  p.actX = req.hasTarget === 1 ? req.targetX : b.x + req.dirX * 11;
  p.actZ = req.hasTarget === 1 ? req.targetZ : b.z + req.dirZ * 11;
  p.actDirX = req.dirX;
  p.actDirZ = req.dirZ;
  p.actCurve = req.curve;
  return 1;
}

const fakeShotHandler: ActionHandler = {
  update(s, slot, ev) {
    const p = s.players[slot]!;
    if (p.actDone === 1 || p.actCharging === 1 || p.actT < p.actContact) return;
    p.actDone = 1;
    const b = s.ball;
    const power = p.actPower;
    const v = 16 + 14 * power;
    const tx = p.actX + Math.sign(p.actX) * 0.5;
    const tz = p.actZ;
    const dx = tx - b.x, dz = tz - b.z;
    const d = Math.hypot(dx, dz);
    const tf = d / v;
    const l = createKickLaunch();
    l.vx = (dx / d) * v;
    l.vz = (dz / d) * v;
    l.vy = (0.9 - b.y) / tf + 0.5 * T_BALL.gravity * tf;
    l.kind = p.actKick;
    l.target = -1;
    l.tx = tx;
    l.tz = tz;
    l.onTarget = 1;
    const k = penaltyKeeper(s);
    (K.strikes as Strike[]).push({ tick: s.tick, slot, kind: p.actKick, power, tz, keeperAct: k >= 0 ? s.players[k]!.act : -1 });
    applyKick(s, slot, l, power, ev);
  },
  end() { /* nothing to clean */ },
};

vi.mock('../../src/sim/kicks/shot', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/shot')>()),
  startShot: (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => fakeStartShot(s, slot, kind, req, ev),
  shotHandler: {
    update: (s: SimState, slot: number, ev: EventSink) => fakeShotHandler.update(s, slot, ev),
    end: (s: SimState, slot: number, i: number) => fakeShotHandler.end(s, slot, i),
  },
}));

vi.mock('../../src/ai/setpieces', async (orig) => {
  const real = await orig<typeof import('../../src/ai/setpieces')>();
  return {
    ...real,
    cpuSetPiece: (s: SimState, team: number, out: InputFrame, ev: EventSink) => {
      if (!K.cpuOff) real.cpuSetPiece(s, team, out, ev);
    },
  };
});

beforeEach(() => {
  K.calls.length = 0;
  K.strikes.length = 0;
  K.refuse = false;
  K.cpuOff = false;
});

const BOTH = [{ side: 0 }, { side: 1 }];

/** One frame for controller ci (filled by fill) on the next tick. */
function frameTick(s: SimState, ci: number, fill: (f: InputFrame) => void): SimEvent[] {
  return runTicks(s, 1, (_t, _st, out) => fill(out[ci]!), { check: 'core' });
}

function watchdogs(ev: readonly SimEvent[]): SimEvent[] {
  return findEvents(ev, EventType.WATCHDOG);
}

describe('RUL-06 buttons (pad / keyboard)', () => {
  it('SHOOT press -> startShot(PENALTY) toward the stick aim, SET_PIECE, target on the goal line; hold = power (power bar)', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 31, humans: BOTH });
    untilReady(s);
    const r = s.match.restart;
    const t = r.taker;
    // Aim with the stick, then press and hold SHOOT for 21 ticks (half the power bar) with the stick still on.
    const t0 = s.tick;
    const ev = runTicks(s, 25, (tick, _st, out) => {
      out[0]!.mx = 120; out[0]!.mz = 24;
      if (tick > t0 + 4) out[0]!.buttons = Btn.SHOOT;
    }, { check: 'core' });
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect(c.slot).toBe(t);
    expect(c.kind).toBe(KickKind.PENALTY);
    expect(c.phase).toBe(MatchPhase.PENALTY);
    expect(c.req.flags).toBe(ReqFlag.SET_PIECE);
    expect(c.req.charging).toBe(1);
    expect(c.req.hasTarget).toBe(1);
    expect(c.req.targetX).toBe(HALF_LENGTH);
    expect(c.req.targetZ).toBeCloseTo((24 / 120) * 11, 1);
    expect(c.req.assist).toBe(AssistLevel.ASSISTED);
    const ux = HALF_LENGTH - r.x, uz = c.req.targetZ - r.z, ul = Math.hypot(ux, uz);
    expect(c.req.dirX).toBeCloseTo(ux / ul, 9);
    expect(c.req.dirZ).toBeCloseTo(uz / ul, 9);
    expect(s.ctrl[0]!.powerBtn).toBe(Btn.SHOOT); // the resolver attached the power bar
    // Release: contact WINDUP ticks after the press at the power of the hold, then IN_PLAY.
    const after = runTicks(s, 15, undefined, { check: 'core' });
    expect(strikes()).toHaveLength(1);
    expect(strikes()[0]!.power).toBeGreaterThan(18 / T_PASS.powerFillTicks);
    expect(strikes()[0]!.power).toBeLessThan(24 / T_PASS.powerFillTicks);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.ctrl[0]!.powerBtn).toBe(0);
    expect(watchdogs([...ev, ...after])).toHaveLength(0);
  });

  it.each([
    ['B', Btn.SHOOT, KickKind.PENALTY],
    ['R1 + B', Btn.MOD_R | Btn.SHOOT, KickKind.SHOT_FINESSE],
    ['L1 + B', Btn.MOD_L | Btn.SHOOT, KickKind.SHOT_CHIP],
    ['L1 + R1 + B', Btn.MOD_L | Btn.MOD_R | Btn.SHOOT, KickKind.SHOT_POWER],
  ])('%s -> %i (explicit power from the frame, curve from frame.curve)', (_name, buttons, kind) => {
    const { s } = penaltyScenario({ team: 1, dir: -1, seed: 32, humans: BOTH });
    untilReady(s);
    frameTick(s, 1, (f) => { f.buttons = buttons; f.power = 100; f.curve = -64; f.mx = -127; });
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect(c.kind).toBe(kind);
    expect(c.req.charging).toBe(0);
    expect(c.req.power).toBeCloseTo(100 / UNIT_SCALE, 9);
    expect(c.req.curve).toBeCloseTo(-64 / AXIS_SCALE, 9);
    expect(c.req.targetX).toBe(-HALF_LENGTH);
    expect(c.req.targetZ).toBeCloseTo(0, 9);
    runTicks(s, WINDUP + 2, undefined, { check: 'core' });
    expect(strikes()).toHaveLength(1);
    expect(strikes()[0]!.kind).toBe(kind);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('a second press while the shot winds up starts nothing new (no double kick)', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 33, humans: BOTH });
    untilReady(s);
    frameTick(s, 0, (f) => { f.buttons = Btn.SHOOT; f.power = 90; });
    frameTick(s, 0, () => { /* release */ });
    frameTick(s, 0, (f) => { f.buttons = Btn.SHOOT | Btn.MOD_R; f.power = 90; });
    runTicks(s, WINDUP + 4, undefined, { check: 'core' });
    expect(calls()).toHaveLength(1);
    expect(strikes()).toHaveLength(1);
  });
});

describe('RUL-06 touch', () => {
  it.each([1, -1])('swipe toward the goal (dir %i): a penalty along the swipe; faster swipe = more power', (dir) => {
    const powers: number[] = [];
    for (const gPower of [20, 60, 100, 127]) {
      K.calls.length = 0;
      const { s } = penaltyScenario({ team: 0, dir, seed: 34, humans: BOTH });
      untilReady(s);
      frameTick(s, 0, (f) => { f.gesture = GestureKind.SWIPE; f.gdx = dir * 110; f.gdz = -20; f.gPower = gPower; });
      expect(calls()).toHaveLength(1);
      const c = calls()[0]!;
      expect(c.kind).toBe(KickKind.PENALTY);
      expect(c.req.flags).toBe(ReqFlag.SET_PIECE | ReqFlag.GESTURE);
      expect(c.req.charging).toBe(0);
      expect(c.req.targetX).toBe(dir * HALF_LENGTH);
      expect(c.req.targetZ).toBeCloseTo((-20 / 110) * 11, 9);
      powers.push(c.req.power);
    }
    expect(powers).toEqual([20, 60, 100, 127].map((g) => g / UNIT_SCALE));
    for (let i = 1; i < powers.length; i++) expect(powers[i]!).toBeGreaterThan(powers[i - 1]!);
  });

  it('curved swipe = finesse with the swipe\'s curl; back-and-forth = power shot; no speed = default power', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 35, humans: BOTH });
    untilReady(s);
    frameTick(s, 0, (f) => { f.gesture = GestureKind.CURVED_SWIPE; f.gdx = 100; f.gdz = 30; f.gPower = 80; f.gCurve = 90; });
    expect(calls()[0]!.kind).toBe(KickKind.SHOT_FINESSE);
    expect(calls()[0]!.req.curve).toBeCloseTo(90 / AXIS_SCALE, 9);
    const b = penaltyScenario({ team: 0, dir: 1, seed: 35, humans: BOTH }).s;
    untilReady(b);
    frameTick(b, 0, (f) => { f.gesture = GestureKind.BACK_FORTH_SWIPE; f.gdx = 100; f.gdz = 0; });
    expect(calls()[1]!.kind).toBe(KickKind.SHOT_POWER);
    expect(calls()[1]!.req.power).toBe(LT.gesturePower);
  });

  it('a swipe away from the goal is ignored; a swipe with no direction uses its end point', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 36, humans: BOTH });
    untilReady(s);
    frameTick(s, 0, (f) => { f.gesture = GestureKind.SWIPE; f.gdx = -100; f.gdz = 20; f.gPower = 90; });
    expect(calls()).toHaveLength(0);
    frameTick(s, 0, (f) => { f.gesture = GestureKind.SWIPE; f.gx = quantPos(HALF_LENGTH); f.gz = quantPos(-2.2); f.gPower = 90; });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.req.targetZ).toBeCloseTo(-2.2, 6);
  });

  it('tap on the goal = chip at that point (inside the posts); a tap elsewhere does nothing', () => {
    const { s } = penaltyScenario({ team: 1, dir: -1, seed: 37, humans: BOTH });
    untilReady(s);
    frameTick(s, 1, (f) => { f.gesture = GestureKind.TAP; f.gx = quantPos(-30); f.gz = quantPos(5); });
    expect(calls()).toHaveLength(0);
    frameTick(s, 1, (f) => {
      f.gesture = GestureKind.TAP; f.gFlags = GestureFlag.ON_GOAL; f.gx = quantPos(-HALF_LENGTH); f.gz = quantPos(-1.5);
    });
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect(c.kind).toBe(KickKind.SHOT_CHIP);
    expect(c.req.targetX).toBe(-HALF_LENGTH);
    expect(c.req.targetZ).toBeCloseTo(-1.5, 6);
    expect(c.req.power).toBe(LT.chipTapPower);
    expect(c.req.flags).toBe(ReqFlag.SET_PIECE | ReqFlag.GESTURE);
  });
});

describe('RUL-06 keeper dive consumed at the kick', () => {
  it.each([[1, 1], [1, -1], [-1, 1], [-1, -1]])('dir %i, flick side %i: GKP-06 dives the human keeper that way at the contact tick', (dir, side) => {
    const { s } = penaltyScenario({ team: 0, dir, seed: 38, humans: BOTH });
    untilReady(s);
    const k = penaltyKeeper(s);
    frameTick(s, 1, (f) => { f.buttons = Btn.RS_FLICK; f.ax = 0; f.az = side * 127; });
    expect(s.match.restart.side).toBe(side);
    // The taker shoots the other way (aim at the opposite corner).
    frameTick(s, 0, (f) => { f.buttons = Btn.SHOOT; f.power = 95; f.mx = dir * 120; f.mz = -side * 30; });
    expect(calls()).toHaveLength(1);
    let diveTick = -1;
    runTicks(s, WINDUP + 3, (_t, st) => {
      if (diveTick < 0 && st.players[k]!.act === ActionKind.GK_DIVE) diveTick = st.tick;
    }, { check: 'core' });
    const kp = s.players[k]!;
    if (diveTick < 0 && kp.act === ActionKind.GK_DIVE) diveTick = s.tick;
    expect(strikes()).toHaveLength(1);
    expect(kp.act).toBe(ActionKind.GK_DIVE);
    // Committed in the tick of contact (GKP-06 anticipates the strike), not after it.
    expect(diveTick).toBe(strikes()[0]!.tick);
    expect(Math.sign(kp.actDirZ)).toBe(side);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('no choice made: the human keeper does not dive at the contact tick (he stands; GKP-02 reacts later)', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 39, humans: BOTH });
    untilReady(s);
    frameTick(s, 0, (f) => { f.buttons = Btn.SHOOT; f.power = 95; f.mx = 120; f.mz = 30; });
    runTicks(s, WINDUP + 1, undefined, { check: 'core' });
    expect(strikes()).toHaveLength(1);
    expect(strikes()[0]!.keeperAct).not.toBe(ActionKind.GK_DIVE);
  });

  it('the latest choice before contact wins (a flick during the taker\'s wind-up changes the dive)', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 40, humans: BOTH });
    untilReady(s);
    const k = penaltyKeeper(s);
    frameTick(s, 1, (f) => { f.buttons = Btn.RS_FLICK; f.az = 127; });
    frameTick(s, 0, (f) => { f.buttons = Btn.SHOOT; f.power = 95; });
    frameTick(s, 1, (f) => { f.buttons = Btn.RS_FLICK; f.az = -127; f.ax = 90; });
    expect([s.match.restart.side, s.match.restart.aimPower]).toEqual([-1, 2]);
    runTicks(s, WINDUP + 2, undefined, { check: 'core' });
    expect(s.players[k]!.act).toBe(ActionKind.GK_DIVE);
    expect(Math.sign(s.players[k]!.actDirZ)).toBe(-1);
  });
});

describe('RUL-06 Default and CPU', () => {
  it('human timeout: the Default at exactly ready + 12 s (not before): PENALTY at defaultPower toward a corner; no watchdog', () => {
    const { s } = penaltyScenario({ team: 1, dir: -1, seed: 41, humans: BOTH });
    untilReady(s);
    const readyTick = s.tick;
    const ev = runTicks(s, T_RULES.restartTimeoutTicks - 1, undefined, { check: 'core' });
    expect(calls()).toHaveLength(0);
    ev.push(...runTicks(s, 1, undefined, { check: 'core' }));
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect(c.tick - readyTick).toBe(T_RULES.restartTimeoutTicks);
    expect(c.kind).toBe(KickKind.PENALTY);
    expect(c.req.power).toBe(LT.defaultPower);
    expect(c.req.charging).toBe(0);
    expect(c.req.flags).toBe(ReqFlag.SET_PIECE);
    expect(c.req.targetX).toBe(-HALF_LENGTH);
    expect(Math.abs(c.req.targetZ)).toBeGreaterThanOrEqual(GOAL_HALF_WIDTH - LT.defaultInsetMax - 1e-9);
    expect(Math.abs(c.req.targetZ)).toBeLessThanOrEqual(GOAL_HALF_WIDTH - LT.defaultInsetMin + 1e-9);
    ev.push(...runTicks(s, WINDUP + 2, undefined, { check: 'core' }));
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(watchdogs(ev)).toHaveLength(0);
  });

  it('the Default keeps the aim the taker set', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 42, humans: BOTH });
    untilReady(s);
    frameTick(s, 0, (f) => { f.mx = 120; f.mz = -18; });
    const aim = s.match.restart.aimZ;
    expect(aim).toBeCloseTo((-18 / 120) * 11, 1);
    runUntil(s, () => calls().length > 0, T_RULES.restartTimeoutTicks + 5, undefined, 'core');
    expect(calls()[0]!.req.targetZ).toBe(aim);
  });

  it('a Default refused by the shot starter is retried, and RUL-11\'s forced kick still ends it (logged)', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 43, humans: BOTH });
    untilReady(s);
    K.refuse = true;
    const r = runUntil(s, (st) => st.match.phase !== MatchPhase.PENALTY, T_RULES.restartTimeoutTicks + 400, undefined, 'core');
    expect(r.reached).toBe(true);
    expect(calls().length).toBeGreaterThan(10); // retried every tick while the taker waits
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(watchdogs(r.events).map((e) => e.a)).toEqual([WatchdogReason.RESTART_BLOCKED]);
  });

  it.each([[0, 1, 51], [1, -1, 52], [0, -1, 53]])('CPU taker (team %i, dir %i, seed %i) takes it through penaltyInput (TAI-13): CPU flag, hold = power, no Default, no watchdog', (team, dir, seed) => {
    const { s } = penaltyScenario({ team, dir, seed, humans: [{ side: team === 0 ? 1 : 0 }] });
    const ev = untilReady(s);
    const r = runUntil(s, (st) => st.match.phase !== MatchPhase.PENALTY, 400, undefined, 'core');
    ev.push(...r.events);
    expect(r.reached).toBe(true);
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect(c.req.flags & ReqFlag.CPU).toBe(ReqFlag.CPU);
    expect(c.req.charging).toBe(1);
    expect(c.kind).toBe(KickKind.PENALTY);
    expect(Math.abs(c.req.targetZ)).toBeLessThanOrEqual(LT.aimMaxZ + 1e-9);
    expect(Math.abs(c.req.targetZ)).toBeGreaterThan(1); // TAI-13 aims inside a post, not at the keeper
    expect(c.rt - T_RULES.restartSetupTicks).toBeLessThan(T_RULES.cpuRestartDelay + LT.cpuGraceTicks);
    expect(strikes()[0]!.power).toBeGreaterThan(0.55);
    expect(strikes()[0]!.power).toBeLessThan(0.95);
    expect(watchdogs(ev)).toHaveLength(0);
  });

  it('CPU fallback: a CPU side whose brain does not act gets the Default 1 s after cpuRestartDelay, before RUL-11\'s 4 s watchdog', () => {
    K.cpuOff = true;
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 54, humans: [{ side: 1 }] });
    const ev = untilReady(s);
    const r = runUntil(s, (st) => st.match.phase !== MatchPhase.PENALTY, 400, undefined, 'core');
    ev.push(...r.events);
    expect(r.reached).toBe(true);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.rt - T_RULES.restartSetupTicks).toBe(T_RULES.cpuRestartDelay + LT.cpuGraceTicks);
    expect(calls()[0]!.req.power).toBe(LT.defaultPower);
    expect(watchdogs(ev)).toHaveLength(0);
  });

  it('CPU v CPU at both ends: every penalty is taken and play goes on, no watchdog', () => {
    for (const [team, seed] of [[0, 61], [1, 62], [0, 63], [1, 64]] as const) {
      K.calls.length = 0;
      K.strikes.length = 0;
      const { s } = penaltyScenario({ team, seed, warmup: 60 });
      const ev = untilReady(s);
      const r = runUntil(s, (st) => st.match.phase !== MatchPhase.PENALTY, 400, undefined, 'core');
      ev.push(...r.events, ...runTicks(s, 120, undefined, { check: 'core' }));
      expect(r.reached).toBe(true);
      expect(strikes()).toHaveLength(1);
      expect(watchdogs(ev)).toHaveLength(0);
      expect(findEvents(ev, EventType.KICK, (e) => e.b === KickKind.PENALTY)).toHaveLength(1);
    }
  });
});

describe('RUL-06 glitch list', () => {
  it('glitch: controller disconnect during a penalty (taker mid power bar): the release ends the charge, the kick goes, nothing stays held', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 71, humans: BOTH });
    untilReady(s);
    runTicks(s, 12, (_t, _st, out) => { out[0]!.buttons = Btn.SHOOT; out[0]!.mx = 120; out[0]!.mz = 20; }, { check: 'core' });
    expect(s.ctrl[0]!.powerBtn).toBe(Btn.SHOOT);
    // The pad drops: neutral frames from now on (InputSource.releaseAll).
    const ev = runTicks(s, 30, undefined, { check: 'core' });
    expect(strikes()).toHaveLength(1);
    expect(s.ctrl[0]!.powerBtn).toBe(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(watchdogs(ev)).toHaveLength(0);
  });

  it('glitch: controller disconnect during a penalty (before the kick): the Default takes it after 12 s; a keeper whose pad drops stays on his line with his choice', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 72, humans: BOTH });
    untilReady(s);
    const k = penaltyKeeper(s);
    runTicks(s, 40, (t, _st, out) => {
      out[0]!.mx = 120; out[0]!.mz = -25; // taker aiming
      out[1]!.mz = 127; // keeper moving
      if (t % 20 === 0) { out[1]!.buttons = Btn.RS_FLICK; out[1]!.az = -127; }
    }, { check: 'core' });
    const choice = [s.match.restart.side, s.match.restart.aimPower];
    expect(choice[0]).toBe(-1);
    // Both pads drop.
    const kz = s.players[k]!.z;
    const ev = runTicks(s, T_RULES.restartTimeoutTicks - 40 - 1, undefined, { check: 'core' });
    expect(calls()).toHaveLength(0);
    expect(Math.abs(s.players[k]!.z - kz)).toBeLessThan(0.6); // stopped, not drifting
    expect(Math.abs(s.players[k]!.z)).toBeLessThanOrEqual(LT.keeperMaxZ + 1e-9);
    expect(Math.abs(s.players[k]!.x - HALF_LENGTH)).toBeLessThan(1);
    expect([s.match.restart.side, s.match.restart.aimPower]).toEqual(choice);
    ev.push(...runTicks(s, 1 + WINDUP + 2, undefined, { check: 'core' }));
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.req.targetZ).toBeCloseTo((-25 / 120) * 11, 1); // the aim set before the drop
    expect(s.players[k]!.act).toBe(ActionKind.GK_DIVE);
    expect(Math.sign(s.players[k]!.actDirZ)).toBe(-1);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(watchdogs(ev)).toHaveLength(0);
    expect(s.ball.y).toBeGreaterThanOrEqual(BALL_RADIUS - 1e-9);
  });
});
