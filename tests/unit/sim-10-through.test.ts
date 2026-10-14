/**
 * [SIM-10] Through balls: starter, lead point (power scales the lead, space away from defenders and the keeper's claim
 * zone, inside the pitch, least-late fallback), runner selection, explicit point, into space, lobbed / dinked
 * clearance, driven variant, determinism.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, AssistLevel, KickKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch, ReqFlag } from '../../src/contracts/systems';
import { T_PASS } from '../../src/contracts/tuning';
import { groundRollTime } from '../../src/sim/ball/flight';
import { NULL_SINK } from '../../src/sim/core/events';
import { inPenaltyArea } from '../../src/sim/pitch/geometry';
import { ticksToReach } from '../../src/sim/players/locomotion';
import {
  isThroughKind, LOCAL_TUNING as LT, selectRunner, solveThrough, startThrough, throughLeadPoint,
} from '../../src/sim/kicks/through';
import {
  fly, heightNear, KICKER, launched, MATE_A, MATE_B, MATE_C, OPP_A, OPP_B, OPP_GK, place, quiet, req, solveThroughKick,
} from './sim-09-helpers';

const PT = { x: 0, z: 0 };

/** Passer at (0, -5), runner MATE_A at (x, z) running with (vx, vz). */
function scene(x = 14, z = 6, vx = 8, vz = 0): SimState {
  const s = quiet(1, 0, -5);
  const l = Math.hypot(vx, vz) || 1;
  place(s, MATE_A, x, z, vx / l || 1, vz / l, vx, vz);
  return s;
}

function lead(s: SimState, power: number, lofted = 0, target = MATE_A): { x: number; z: number } | null {
  return throughLeadPoint(s, KICKER, target, power, lofted, PT) === 1 ? { ...PT } : null;
}

/** Keeper's claim test used by the solver: reaches the point first (with his margin) inside his box. */
function keeperFirst(s: SimState, p: { x: number; z: number }, runner = MATE_A): boolean {
  const k = s.players[OPP_GK]!;
  const tr = ticksToReach(s, runner, p.x, p.z) / 60;
  const inBox = inPenaltyArea(p.x, p.z, 1);
  const reach = inBox ? LT.keeperReach : LT.oppReach;
  const d = Math.hypot(k.x - p.x, k.z - p.z);
  const tk = LT.oppReact + Math.max(0, d - reach) / LT.keeperSpeed;
  return tk < tr + (inBox ? LT.keeperMargin : LT.defMargin);
}

describe('SIM-10 startThrough', () => {
  it('starts the three through kinds as a KICK action and refuses other kinds or a busy / ball-less player', () => {
    for (const k of [KickKind.THROUGH_GROUND, KickKind.THROUGH_LOBBED, KickKind.THROUGH_DINKED]) {
      const s = scene();
      expect(isThroughKind(k)).toBe(true);
      expect(startThrough(s, KICKER, k, req({ power: 0.4, flags: ReqFlag.LOFTED }), NULL_SINK)).toBe(1);
      const p = s.players[KICKER]!;
      expect(p.act).toBe(ActionKind.KICK);
      expect(p.actKick).toBe(k);
      expect(p.actContact).toBe(T_PASS.windup);
      expect(p.actA).toBe(ReqFlag.LOFTED);
    }
    expect(startThrough(scene(), KICKER, KickKind.LOB_PASS, req(), NULL_SINK)).toBe(0);
    const s = scene();
    s.ball.owner = OPP_A;
    expect(startThrough(s, KICKER, KickKind.THROUGH_GROUND, req(), NULL_SINK)).toBe(0);
    const t = scene();
    t.players[KICKER]!.stunT = 5;
    expect(startThrough(t, KICKER, KickKind.THROUGH_GROUND, req(), NULL_SINK)).toBe(0);
  });
});

describe('SIM-10 throughLeadPoint', () => {
  it('leads the runner along his run into space; power scales the lead distance', () => {
    const s = scene(10, 6, 8, 0);
    const a = lead(s, 0)!, b = lead(s, 0.5)!, c = lead(s, 1)!;
    expect(a.z).toBeCloseTo(6, 6);
    expect(a.x).toBeGreaterThan(10);
    expect(b.x).toBeGreaterThanOrEqual(a.x);
    expect(c.x).toBeGreaterThan(a.x + 3);
    // A diagonal run is led along it.
    const d = lead(scene(10, 6, 6, 4), 0.5)!;
    expect((d.z - 6) / (d.x - 10)).toBeCloseTo(4 / 6, 6);
  });

  it('a standing or retreating runner is led toward the attacked goal (either direction)', () => {
    for (const dir of [1, -1]) {
      const s = quiet(1, 0, -5, dir, 0);
      s.teams[0]!.dir = dir; s.teams[1]!.dir = -dir;
      place(s, MATE_A, dir * 12, 6, -dir, 0, -dir * 3, 0);
      const p = lead(s, 0.5)!;
      expect(dir * (p.x - dir * 12)).toBeGreaterThan(3);
      expect(p.z).toBeCloseTo(6, 6);
    }
  });

  it('avoids the keeper\'s claim zone when possible, and still leads when it is not', () => {
    const open = scene(12, 6, 7, 0);
    const deep = lead(open, 1)!;
    expect(inPenaltyArea(deep.x, deep.z, 1)).toBe(true);
    const s = scene(12, 6, 7, 0);
    place(s, OPP_GK, 51, 0);
    const p = lead(s, 1)!;
    expect(p.x).toBeLessThan(deep.x - 2);
    expect(keeperFirst(s, p)).toBe(false);
    // Runner in the box with the keeper close: no safe point, a lead is still given (into the claim zone).
    const t = scene(38, 3, 7, 0);
    t.players[KICKER]!.x = 25; t.ball.x = 25.5;
    place(t, OPP_GK, 42, 3); // already off his line toward the runner
    const q = lead(t, 0.5)!;
    expect(q).not.toBeNull();
    expect(keeperFirst(t, q)).toBe(true);
  });

  it('moves away from a defender sitting on the power pick', () => {
    const s = scene(10, 6, 8, 0);
    const free = lead(s, 0.5)!;
    place(s, OPP_A, free.x, free.z + 1);
    const p = lead(s, 0.5)!;
    expect(Math.hypot(p.x - free.x, p.z - free.z)).toBeGreaterThan(2);
  });

  it('a ground lead avoids a path an opponent cuts out; a lofted one does not care about the path', () => {
    const s = scene(10, 6, 8, 0);
    const free = lead(s, 0)!;
    // Opponent standing on the ball's path to the free pick, near the passer (far from every lead point).
    const ox = 4, oz = -4;
    const fx = free.x - s.ball.x, fz = free.z - s.ball.z;
    const perp = (x: number, z: number, lx: number, lz: number): number => Math.abs((x - s.ball.x) * lz - (z - s.ball.z) * lx) / Math.hypot(lx, lz);
    expect(perp(ox, oz, fx, fz)).toBeLessThan(0.5);
    place(s, OPP_B, ox, oz);
    const g = lead(s, 0)!;
    expect(Math.hypot(g.x - free.x, g.z - free.z)).toBeGreaterThan(1.5);
    // The new path does not run into him.
    expect(perp(ox, oz, g.x - s.ball.x, g.z - s.ball.z)).toBeGreaterThan(LT.blockReach);
    // A lobbed lead flies over him: unchanged.
    const lf = scene(10, 6, 8, 0);
    const lfree = lead(lf, 0, 1)!;
    place(lf, OPP_B, ox, oz);
    expect(lead(lf, 0, 1)).toEqual(lfree);
  });

  it('stays inside the pitch (touchline and goal-line margins) and is pure', () => {
    for (const [x, z, vx, vz] of [[40, 30, 6, 6], [45, -31, 8, -2], [-30, 33, 0, 9]] as const) {
      const s = scene(x, z, vx, vz);
      const before = JSON.stringify(s);
      const p = lead(s, 1);
      expect(JSON.stringify(s)).toBe(before);
      if (!p) continue;
      expect(Math.abs(p.x)).toBeLessThanOrEqual(HALF_LENGTH - LT.goalLineMargin + 1e-9);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(HALF_WIDTH - LT.pitchMargin + 1e-9);
    }
  });

  it('a runner too far ahead and too fast: the least-late point when close, else no lead (0)', () => {
    const s = scene(14, 6, 6, 7.5);
    expect(lead(s, 0.5)).not.toBeNull();
    const far = scene(45, 30, 9, 0.5);
    far.players[KICKER]!.x = -45; far.ball.x = -44.5;
    expect(lead(far, 0.5)).toBeNull();
  });

  it('returns 0 for a bad target (himself, an opponent, inactive, out of range)', () => {
    const s = scene();
    expect(lead(s, 0.5, 0, KICKER)).toBeNull();
    expect(lead(s, 0.5, 0, OPP_A)).toBeNull();
    expect(lead(s, 0.5, 0, -1)).toBeNull();
    expect(lead(s, 0.5, 0, 99)).toBeNull();
    s.players[MATE_A]!.active = 0;
    expect(lead(s, 0.5)).toBeNull();
  });
});

describe('SIM-10 solveThrough', () => {
  it('picks a forward runner at the defensive line over a static teammate (SIM-08 pick only a bonus)', () => {
    const s = quiet(1, 0, 0);
    place(s, MATE_A, 20, 0);                 // static, straight ahead
    place(s, MATE_B, 22, 8, 1, 0, 7, 0);     // running forward at the line
    place(s, OPP_A, 24, -4); place(s, OPP_B, 24, 6);
    expect(selectRunner(s, KICKER, 1, 0, 0.5, AssistLevel.ASSISTED, 0)).toBe(MATE_B);
    expect(selectRunner(s, KICKER, 1, 0, 0.5, AssistLevel.MANUAL, 0)).toBe(-1);
    const l = solveThroughKick(s, KickKind.THROUGH_GROUND, { power: 0.5, dirX: 1 })!;
    expect(l.target).toBe(MATE_B);
    expect(l.tx).toBeGreaterThan(22);
  });

  it('the launch goes to the lead point, weighted to arrive when the runner does', () => {
    const s = scene(12, 6, 8, 0);
    const p = lead(s, 0.5)!;
    const l = solveThroughKick(s, KickKind.THROUGH_GROUND, { power: 0.5, dirX: 1, dirZ: 0.3 })!;
    expect(l.kind).toBe(KickKind.THROUGH_GROUND);
    expect(l.target).toBe(MATE_A);
    expect([l.tx, l.tz]).toEqual([p.x, p.z]);
    expect(l.vy).toBe(0);
    const D = Math.hypot(p.x - s.ball.x, p.z - s.ball.z);
    const tr = ticksToReach(s, MATE_A, p.x, p.z) / 60;
    expect(Math.abs(groundRollTime(Math.hypot(l.vx, l.vz), D) - tr)).toBeLessThan(0.25);
  });

  it('an explicit point (gesture) is honoured; the ball is weighted to the runner\'s arrival there', () => {
    const s = scene(12, 6, 8, 0);
    const l = solveThroughKick(s, KickKind.THROUGH_GROUND, { power: 0.5, hasTarget: 1, targetX: 28, targetZ: 9, targetSlot: MATE_A })!;
    expect([l.tx, l.tz, l.target]).toEqual([28, 9, MATE_A]);
    const D = Math.hypot(28 - s.ball.x, 9 - s.ball.z);
    const tr = ticksToReach(s, MATE_A, 28, 9) / 60;
    expect(Math.abs(groundRollTime(Math.hypot(l.vx, l.vz), D) - tr)).toBeLessThan(0.3);
  });

  it('no runner (or Manual): into space along the stick over the power distance', () => {
    for (const assist of [AssistLevel.ASSISTED, AssistLevel.MANUAL]) {
      const s = quiet(1, 0, 0);
      const l = solveThroughKick(s, KickKind.THROUGH_GROUND, { power: 0.5, dirX: 0.6, dirZ: 0.8, assist })!;
      const d = LT.spaceDistMin + (LT.spaceDistMax - LT.spaceDistMin) * 0.5;
      expect(l.tx).toBeCloseTo(s.ball.x + 0.6 * d, 6);
      expect(l.tz).toBeCloseTo(s.ball.z + 0.8 * d, 6);
      expect(l.target).toBe(-1);
    }
    // A teammate near the spot becomes the target.
    const s = quiet(1, 0, 0);
    place(s, MATE_C, 16, 23);
    const l = solveThroughKick(s, KickKind.THROUGH_GROUND, { power: 0.5, dirX: 0.6, dirZ: 0.8, assist: AssistLevel.MANUAL })!;
    expect(l.target).toBe(MATE_C);
  });

  it('lobbed through clears a defender in the lane; dinked flies lower than lobbed', () => {
    const s = scene(14, 6, 8, 0);
    const l = solveThroughKick(s, KickKind.THROUGH_LOBBED, { power: 0.5, dirX: 1 })!;
    expect(l.kind).toBe(KickKind.THROUGH_LOBBED);
    const mx = (s.ball.x + l.tx) / 2, mz = (s.ball.z + l.tz) / 2;
    expect(heightNear(s, l, mx, mz)).toBeGreaterThan(2.6);
    const d = solveThroughKick(scene(14, 6, 8, 0), KickKind.THROUGH_DINKED, { power: 0.5, dirX: 1 })!;
    const apex = (k: typeof l): number => {
      let a = 0;
      fly(launched(scene(14, 6, 8, 0), k), 300, (_i, b) => { a = Math.max(a, b.y); return b.bounces > 0; });
      return a;
    };
    expect(apex(d)).toBeLessThan(apex(l) - 1);
    expect(apex(d)).toBeGreaterThan(1);
  });

  it('driven (R1) through ball is played firmer', () => {
    const a = solveThroughKick(scene(12, 6, 8, 0), KickKind.THROUGH_GROUND, { power: 0.3, dirX: 1 })!;
    const b = solveThroughKick(scene(12, 6, 8, 0), KickKind.THROUGH_GROUND, { power: 0.3, dirX: 1, flags: ReqFlag.DRIVEN })!;
    expect(Math.hypot(b.vx, b.vz)).toBeGreaterThanOrEqual(Math.hypot(a.vx, a.vz));
    expect(Math.hypot(b.vx, b.vz)).toBeLessThanOrEqual(LT.groundSpeedMax * T_PASS.drivenMul + 1e-9);
  });

  it('is deterministic and touches nothing but the rng; finite output', () => {
    const a = solveThroughKick(scene(13, 7, 6, 2), KickKind.THROUGH_DINKED, { power: 0.7, dirX: 1 }, 9)!;
    const b = solveThroughKick(scene(13, 7, 6, 2), KickKind.THROUGH_DINKED, { power: 0.7, dirX: 1 }, 9)!;
    expect(b).toEqual(a);
    for (const v of [a.vx, a.vy, a.vz, a.sx, a.sy, a.sz, a.tx, a.tz]) expect(Number.isFinite(v)).toBe(true);
    const s = scene();
    solveThroughKick(s, KickKind.THROUGH_GROUND, { dirX: 1 });
    const before = JSON.stringify({ ...s, rng: null });
    expect(solveThrough(s, KICKER, createKickLaunch())).toBe(1);
    expect(JSON.stringify({ ...s, rng: null })).toBe(before);
  });
});
