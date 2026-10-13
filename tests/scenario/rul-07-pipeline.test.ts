/**
 * RUL-07 input contract with a working shot starter: SIM-11 startShot is replaced by a fake that records the request
 * and strikes at once through core/kick applyKick toward the request's target (or refuses, for the safety-net test).
 * Everything else is the real pipeline: TAI-13 CPU kickers produce InputFrames, SIM-15 routes them (and the human
 * frames) to shootoutInput, SIM-16 hands the kicker / keeper to the controllers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HALF_LENGTH, PENALTY_SPOT_DIST } from '../../src/contracts/constants';
import { AssistLevel, GestureKind, KickKind, MatchPhase, WatchdogReason } from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import { AXIS_SCALE, Btn, GestureFlag, UNIT_SCALE, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { ReqFlag, createKickLaunch, type ActionRequest } from '../../src/contracts/systems';
import { T_BALL, T_RULES } from '../../src/contracts/tuning';
import { applyKick } from '../../src/sim/core/kick';
import { rngGauss } from '../../src/sim/core/rng';
import { LOCAL_TUNING as LT, ShootoutSub, shootoutEnd } from '../../src/sim/rules/shootout';
import { findEvents, runTicks, runUntil } from '../harness/scenario';
import { shootoutScenario, untilPostMatch, untilSub } from './rul-07-helpers';

interface Call { tick: number; slot: number; kind: number; req: ActionRequest }

const K = vi.hoisted(() => ({ calls: [] as Call[], refuse: false }));

function fakeStartShot(s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink): number {
  K.calls.push({ tick: s.tick, slot, kind, req: { ...req } });
  if (K.refuse) return 0;
  const b = s.ball;
  const power = req.charging === 1 ? 0.75 : req.power;
  const v = 18 + 12 * power;
  const tx = req.hasTarget === 1 ? req.targetX : b.x + req.dirX * 11;
  // Like a real shot, not every kick goes where it was aimed (deterministic error from the sim RNG).
  const tz = (req.hasTarget === 1 ? req.targetZ : b.z + req.dirZ * 11) + rngGauss(s.rng) * 1.2;
  const dx = tx - b.x, dz = tz - b.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const tf = d / v;
  const l = createKickLaunch();
  l.vx = (dx / d) * v;
  l.vz = (dz / d) * v;
  l.vy = (1.0 - b.y) / tf + 0.5 * T_BALL.gravity * tf;
  l.kind = kind;
  l.target = -1;
  l.tx = tx;
  l.tz = tz;
  l.onTarget = 1;
  applyKick(s, slot, l, power, ev);
  return 1;
}

vi.mock('../../src/sim/kicks/shot', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/shot')>()),
  startShot: (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => fakeStartShot(s, slot, kind, req, ev),
}));

beforeEach(() => {
  K.calls.length = 0;
  K.refuse = false;
});

/** Both sides human; at AIM for the next kick. Returns the kicker's controller index. */
function humanAim(s: SimState): number {
  untilSub(s, ShootoutSub.AIM);
  const ci = s.match.shootout.team;
  expect(s.ctrl[ci]!.slot).toBe(s.match.shootout.kicker);
  return ci;
}

/** One frame for controller ci on the next tick, then until the kick is recorded. */
function press(s: SimState, ci: number, fill: (f: InputFrame) => void): SimEvent[] {
  const so = s.match.shootout;
  const team = so.team;
  const taken = so.taken[team]!;
  const ev = runTicks(s, 1, (_t, _st, out) => fill(out[ci]!), { check: 'core' });
  const r = runUntil(s, (st) => st.match.shootout.taken[team]! > taken, 400, undefined, 'core');
  expect(r.reached).toBe(true);
  return [...ev, ...r.events];
}

describe('RUL-07 with a working startShot', () => {
  it.each([3, 4])('CPU v CPU (seed %i): every kick taken by TAI-13 through shootoutInput, no safety net, POST_MATCH', (seed) => {
    const s = shootoutScenario(seed);
    const events = untilPostMatch(s, 20000);
    const so = s.match.shootout;
    expect(s.match.phase).toBe(MatchPhase.POST_MATCH);
    expect([0, 1]).toContain(s.match.winner);
    expect(findEvents(events, EventType.WATCHDOG)).toEqual([]);
    const kicks = findEvents(events, EventType.SHOOTOUT_KICK);
    expect(K.calls).toHaveLength(kicks.length);
    expect(kicks.length).toBe(so.taken[0]! + so.taken[1]!);
    for (const c of K.calls) {
      expect(c.kind).toBe(KickKind.PENALTY);
      expect(c.req.flags).toBe(ReqFlag.SET_PIECE | ReqFlag.CPU);
      expect(c.req.hasTarget).toBe(1);
      expect(Math.abs(c.req.targetX)).toBe(HALF_LENGTH);
      expect(Math.abs(c.req.targetZ)).toBeLessThanOrEqual(LT.aimMaxZ + 1e-9);
      expect(Math.hypot(c.req.dirX, c.req.dirZ)).toBeCloseTo(1, 9);
    }
    // TAI-13 kicks a couple of seconds into AIM, well before the CPU timeout.
    const aims = findEvents(events, EventType.WHISTLE);
    expect(aims.length).toBeGreaterThan(0);
  });

  it('human kicker buttons: SHOOT / R1 / L1 / L1+R1 -> PENALTY / FINESSE / CHIP / POWER, power bar or explicit power', () => {
    const s = shootoutScenario(5, [{ side: 0 }, { side: 1 }]);
    const cases: { buttons: number; power: number; kind: KickKind }[] = [
      { buttons: Btn.SHOOT, power: 0, kind: KickKind.PENALTY },
      { buttons: Btn.SHOOT | Btn.MOD_R, power: 0, kind: KickKind.SHOT_FINESSE },
      { buttons: Btn.SHOOT | Btn.MOD_L, power: 0, kind: KickKind.SHOT_CHIP },
      { buttons: Btn.SHOOT | Btn.MOD_L | Btn.MOD_R, power: 0, kind: KickKind.SHOT_POWER },
      { buttons: Btn.SHOOT, power: 100, kind: KickKind.PENALTY },
    ];
    for (const c of cases) {
      const ci = humanAim(s);
      const end = shootoutEnd(s);
      const kicker = s.match.shootout.kicker;
      K.calls.length = 0;
      press(s, ci, (f) => { f.buttons = c.buttons; f.power = c.power; f.mx = end * 120; f.mz = -24; f.curve = 40; });
      expect(K.calls).toHaveLength(1);
      const call = K.calls[0]!;
      expect(call.slot).toBe(kicker);
      expect(call.kind).toBe(c.kind);
      expect(call.req.flags).toBe(ReqFlag.SET_PIECE);
      expect(call.req.assist).toBe(AssistLevel.ASSISTED);
      expect(call.req.charging).toBe(c.power > 0 ? 0 : 1);
      expect(call.req.power).toBeCloseTo(c.power / UNIT_SCALE, 9);
      expect(call.req.curve).toBeCloseTo(40 / AXIS_SCALE, 9);
      expect(call.req.hasTarget).toBe(1);
      expect(call.req.targetX).toBe(end * HALF_LENGTH);
      expect(call.req.targetZ).toBeCloseTo(-(PENALTY_SPOT_DIST * 24) / 120, 6);
      const sx = end * (HALF_LENGTH - PENALTY_SPOT_DIST);
      const d = Math.hypot(call.req.targetX - sx, call.req.targetZ);
      expect(call.req.dirX).toBeCloseTo((call.req.targetX - sx) / d, 9);
      expect(call.req.dirZ).toBeCloseTo(call.req.targetZ / d, 9);
    }
  });

  it('touch: swipe = penalty (gPower), curved swipe = finesse (gCurve), back-and-forth = power shot, tap on goal = chip', () => {
    const s = shootoutScenario(6, [{ side: 0 }, { side: 1 }]);
    // A swipe away from the goal is ignored.
    let ci = humanAim(s);
    let end = shootoutEnd(s);
    runTicks(s, 1, (_t, _st, out) => { out[ci]!.gesture = GestureKind.SWIPE; out[ci]!.gdx = -end * 100; out[ci]!.gPower = 90; });
    expect(K.calls).toHaveLength(0);
    const cases = [
      { gesture: GestureKind.SWIPE, kind: KickKind.PENALTY, curve: 0 },
      { gesture: GestureKind.CURVED_SWIPE, kind: KickKind.SHOT_FINESSE, curve: 64 / AXIS_SCALE },
      { gesture: GestureKind.BACK_FORTH_SWIPE, kind: KickKind.SHOT_POWER, curve: 0 },
    ];
    for (const c of cases) {
      ci = humanAim(s);
      end = shootoutEnd(s);
      K.calls.length = 0;
      press(s, ci, (f) => { f.gesture = c.gesture; f.gdx = end * 100; f.gdz = 30; f.gPower = 90; f.gCurve = 64; });
      expect(K.calls).toHaveLength(1);
      const call = K.calls[0]!;
      expect(call.kind).toBe(c.kind);
      expect(call.req.flags).toBe(ReqFlag.SET_PIECE | ReqFlag.GESTURE);
      expect(call.req.charging).toBe(0);
      expect(call.req.power).toBeCloseTo(90 / UNIT_SCALE, 9);
      expect(call.req.curve).toBeCloseTo(c.curve, 9);
      expect(call.req.targetZ).toBeCloseTo((PENALTY_SPOT_DIST * 30) / 100, 6);
    }
    ci = humanAim(s);
    end = shootoutEnd(s);
    K.calls.length = 0;
    press(s, ci, (f) => { f.gesture = GestureKind.TAP; f.gFlags = GestureFlag.ON_GOAL; f.gx = end * 525; f.gz = -20; });
    expect(K.calls).toHaveLength(1);
    expect(K.calls[0]!.kind).toBe(KickKind.SHOT_CHIP);
    expect(K.calls[0]!.req.targetZ).toBeCloseTo(-2, 9);
    expect(K.calls[0]!.req.power).toBe(LT.chipTapPower);
  });

  it('human timeout: the Default (startShot PENALTY, defaultPower, no charging) exactly 12 s into AIM, no watchdog', () => {
    const s = shootoutScenario(7, [{ side: 0 }, { side: 1 }]);
    humanAim(s);
    const t0 = s.tick;
    const ev = runUntil(s, () => K.calls.length > 0, T_RULES.restartTimeoutTicks + 10, undefined, 'core').events;
    expect(K.calls).toHaveLength(1);
    const call = K.calls[0]!;
    expect(call.tick - t0).toBe(T_RULES.restartTimeoutTicks);
    expect(call.kind).toBe(KickKind.PENALTY);
    expect(call.req.power).toBe(LT.defaultPower);
    expect(call.req.charging).toBe(0);
    expect(call.req.flags).toBe(ReqFlag.SET_PIECE);
    expect(Math.abs(call.req.targetZ)).toBeGreaterThan(1);
    expect(Math.abs(call.req.targetZ)).toBeLessThan(LT.aimMaxZ);
    expect(findEvents(ev, EventType.WATCHDOG)).toEqual([]);
  });

  it('CPU kicker whose kicks keep being refused: Default at 4 s (logged), forced kick 2 s later (logged), result recorded', () => {
    K.refuse = true;
    const s = shootoutScenario(8);
    untilSub(s, ShootoutSub.AIM);
    const t0 = s.tick;
    const so = s.match.shootout;
    const team = so.team;
    const k = so.kicker;
    const r = runUntil(s, (st) => st.match.shootout.taken[team]! > 0, 1000, undefined, 'core');
    expect(r.reached).toBe(true);
    const wd = findEvents(r.events, EventType.WATCHDOG);
    expect(wd.map((e) => [e.a, e.tick - t0])).toEqual([
      [WatchdogReason.RESTART_BLOCKED, LT.cpuTimeoutTicks],
      [WatchdogReason.RESTART_BLOCKED, LT.cpuTimeoutTicks + LT.defaultGraceTicks],
    ]);
    // TAI-13 tried first (charging SHOOT presses), then the Default every tick from 4 s.
    expect(K.calls.some((c) => c.req.charging === 1 && c.tick - t0 < LT.cpuTimeoutTicks)).toBe(true);
    expect(K.calls.filter((c) => c.req.charging === 0 && c.req.power === LT.defaultPower).length).toBeGreaterThan(1);
    const kick = findEvents(r.events, EventType.KICK, (e) => e.a === k);
    expect(kick).toHaveLength(1);
    expect(kick[0]!.tick - t0).toBe(LT.cpuTimeoutTicks + LT.defaultGraceTicks);
    expect(findEvents(r.events, EventType.SHOOTOUT_KICK)).toHaveLength(1);
  });
});
