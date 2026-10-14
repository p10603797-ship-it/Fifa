/**
 * [SIM-09] Lob starter and solver: kinds, crossing-zone conversion, receiver lead, landing on the receiver over a
 * defender, Semi / Manual / explicit point, launch angles, error growth, determinism.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, AssistLevel, KickKind, MatchPhase } from '../../src/contracts/enums';
import { createKickLaunch } from '../../src/contracts/systems';
import { T_PASS } from '../../src/contracts/tuning';
import { KICK_SOLVERS } from '../../src/sim/actions/registry';
import { NULL_SINK } from '../../src/sim/core/events';
import { rngSeed } from '../../src/sim/core/rng';
import { isLobKind, lobKindAt, LOCAL_TUNING as LT, solveLob, startLob } from '../../src/sim/kicks/lob';
import {
  heightNear, KICKER, landing, MATE_A, MATE_B, OPP_A, place, quiet, req, skill, solveLobKick,
} from './sim-09-helpers';

describe('SIM-09 startLob', () => {
  it('accepts every lob / cross kind (and GOAL_KICK, which the registry maps to solveLob) and refuses the rest', () => {
    for (const k of [KickKind.LOB_PASS, KickKind.HIGH_LOB, KickKind.DRIVEN_LOB, KickKind.CROSS, KickKind.GROUND_CROSS, KickKind.LOW_CROSS, KickKind.GOAL_KICK]) {
      const s = quiet();
      expect(isLobKind(k)).toBe(true);
      expect(startLob(s, KICKER, k, req(), NULL_SINK)).toBe(1);
      const p = s.players[KICKER]!;
      expect(p.act).toBe(ActionKind.KICK);
      expect(p.actContact).toBe(T_PASS.windup);
      expect(p.actDur).toBe(T_PASS.windup + T_PASS.contact + T_PASS.recovery);
    }
    for (const k of [KickKind.GROUND_PASS, KickKind.THROUGH_GROUND, KickKind.SHOT_NORMAL, KickKind.NONE]) {
      expect(startLob(quiet(), KICKER, k, req(), NULL_SINK)).toBe(0);
    }
  });

  it('fills the KICK action fields in the SIM-08 layout', () => {
    const s = quiet();
    expect(startLob(s, KICKER, KickKind.LOB_PASS, req({
      power: 0.7, charging: 1, dirX: 3, dirZ: 4, targetSlot: MATE_A, hasTarget: 1, targetX: 20, targetZ: -5, curve: 2,
      assist: AssistLevel.SEMI, flags: 0x5,
    }), NULL_SINK)).toBe(1);
    const p = s.players[KICKER]!;
    expect(p.actKick).toBe(KickKind.LOB_PASS);
    expect(p.actPower).toBeCloseTo(0.7, 12);
    expect(p.actCharging).toBe(1);
    expect(p.actDirX).toBeCloseTo(0.6, 12);
    expect(p.actDirZ).toBeCloseTo(0.8, 12);
    expect(p.actSlot).toBe(MATE_A);
    expect([p.actX, p.actZ]).toEqual([20, -5]);
    expect(p.actCurve).toBe(1);
    expect(p.actA).toBe(0x5);
    expect(p.actB).toBe(AssistLevel.SEMI + 4);
  });

  it('refuses when busy, the ball is someone else\'s or held, out of reach, or the phase is not live for him', () => {
    let s = quiet();
    s.players[KICKER]!.act = ActionKind.SHOT;
    expect(startLob(s, KICKER, KickKind.LOB_PASS, req(), NULL_SINK)).toBe(0);
    s = quiet();
    s.ball.owner = MATE_A;
    expect(startLob(s, KICKER, KickKind.LOB_PASS, req(), NULL_SINK)).toBe(0);
    s = quiet();
    s.ball.owner = -1; s.ball.x = 10; s.ball.z = 10;
    expect(startLob(s, KICKER, KickKind.LOB_PASS, req(), NULL_SINK)).toBe(0);
    s = quiet();
    s.match.phase = MatchPhase.HALF_TIME;
    expect(startLob(s, KICKER, KickKind.LOB_PASS, req(), NULL_SINK)).toBe(0);
    s = quiet();
    s.match.phase = MatchPhase.CORNER; s.match.restart.taker = MATE_A; s.match.restart.taken = 0;
    expect(startLob(s, KICKER, KickKind.CROSS, req(), NULL_SINK)).toBe(0);
    s.match.restart.taker = KICKER;
    expect(startLob(s, KICKER, KickKind.CROSS, req(), NULL_SINK)).toBe(1);
  });

  it('accepts a loose ball arriving at him within the wind-up (first-time lob)', () => {
    const s = quiet();
    const b = s.ball;
    b.owner = -1; b.x = -6; b.z = 0; b.vx = 12; b.vz = 0;
    expect(startLob(s, KICKER, KickKind.LOB_PASS, req(), NULL_SINK)).toBe(1);
  });
});

describe('SIM-09 crossing-zone conversion', () => {
  it('LOB_PASS -> CROSS and DRIVEN_LOB -> LOW_CROSS inside the zone; unchanged outside; other kinds never change', () => {
    for (const dir of [1, -1]) {
      for (const zs of [1, -1]) {
        const s = quiet(1, dir * 40, zs * 25, dir, 0);
        s.teams[0]!.dir = dir; s.teams[1]!.dir = -dir;
        expect(lobKindAt(s, KICKER, KickKind.LOB_PASS)).toBe(KickKind.CROSS);
        expect(lobKindAt(s, KICKER, KickKind.DRIVEN_LOB)).toBe(KickKind.LOW_CROSS);
        expect(lobKindAt(s, KICKER, KickKind.HIGH_LOB)).toBe(KickKind.HIGH_LOB);
        expect(lobKindAt(s, KICKER, KickKind.GROUND_CROSS)).toBe(KickKind.GROUND_CROSS);
        expect(startLob(s, KICKER, KickKind.LOB_PASS, req(), NULL_SINK)).toBe(1);
        expect(s.players[KICKER]!.actKick).toBe(KickKind.CROSS);
        // Same flank, wrong end (own half) or central: no conversion.
        const o = quiet(1, -dir * 40, zs * 25, dir, 0);
        o.teams[0]!.dir = dir; o.teams[1]!.dir = -dir;
        expect(lobKindAt(o, KICKER, KickKind.LOB_PASS)).toBe(KickKind.LOB_PASS);
        const c = quiet(1, dir * 40, zs * 5, dir, 0);
        c.teams[0]!.dir = dir; c.teams[1]!.dir = -dir;
        expect(lobKindAt(c, KICKER, KickKind.DRIVEN_LOB)).toBe(KickKind.DRIVEN_LOB);
      }
    }
  });

  it('a DRIVEN_LOB started in the zone is struck as a LOW_CROSS (fast and flat)', () => {
    const s = quiet(1, 38, 26, 0.5, -1);
    const l = solveLobKick(s, KickKind.DRIVEN_LOB, { power: 0.5 })!;
    expect(l.kind).toBe(KickKind.LOW_CROSS);
  });
});

describe('SIM-09 lob solver', () => {
  it('the registry maps LOB_PASS / HIGH_LOB / DRIVEN_LOB / GOAL_KICK to solveLob', () => {
    for (const k of [KickKind.LOB_PASS, KickKind.HIGH_LOB, KickKind.DRIVEN_LOB, KickKind.GOAL_KICK]) expect(KICK_SOLVERS[k]).toBe(solveLob);
  });

  it('lobs clear a defender in the lane and drop to the receiver', () => {
    for (const [kind, maxErr] of [[KickKind.LOB_PASS, 1.5], [KickKind.HIGH_LOB, 1.5], [KickKind.DRIVEN_LOB, 1.5]] as const) {
      const s = quiet();
      place(s, MATE_A, 26, 4);
      place(s, OPP_A, 12, 2);
      const l = solveLobKick(s, kind, { power: 0.6, dirX: 1, dirZ: 0.15 })!;
      expect(l.kind).toBe(kind);
      expect(l.target).toBe(MATE_A);
      expect(Math.hypot(l.tx - 26, l.tz - 4)).toBeLessThan(0.01);
      const ld = landing(s, l);
      expect(Math.hypot(ld.x - 26, ld.z - 4)).toBeLessThan(maxErr);
      // Over the defender's reach (a standing head ~2 m; the lob and high lob clear a jumping one too).
      expect(heightNear(s, l, 12, 2)).toBeGreaterThan(kind === KickKind.DRIVEN_LOB ? 2.3 : 3.5);
    }
  });

  it('launch angles follow T_PASS lob / highLob / drivenLob, with backspin (topspin on the driven lob)', () => {
    for (const [kind, ang, back] of [[KickKind.LOB_PASS, T_PASS.lobAngle, 1], [KickKind.HIGH_LOB, T_PASS.highLobAngle, 1], [KickKind.DRIVEN_LOB, T_PASS.drivenLobAngle, -1]] as const) {
      const s = quiet();
      place(s, MATE_A, 25, 0);
      const l = solveLobKick(s, kind, { power: 0.5, dirX: 1 })!;
      expect(Math.atan2(l.vy, Math.hypot(l.vx, l.vz))).toBeCloseTo(ang, 2);
      // Backspin about (-dirZ, 0, dirX): for travel along +x that is +sz.
      expect(Math.sign(l.sz)).toBe(back);
    }
  });

  it('leads a running receiver: lands where he will be when the ball comes down', () => {
    const s = quiet();
    place(s, MATE_A, 20, 6, 1, 0, 6, 0);
    const l = solveLobKick(s, KickKind.LOB_PASS, { power: 0.5, dirX: 1, dirZ: 0.3 })!;
    expect(l.target).toBe(MATE_A);
    const ld = landing(s, l);
    const t = ld.tick / 60;
    // His position after the flight at his current velocity.
    expect(Math.abs(l.tx - (20 + 6 * t))).toBeLessThan(1.0);
    expect(Math.hypot(ld.x - (20 + 6 * t), ld.z - 6)).toBeLessThan(1.5);
    expect(l.tx).toBeGreaterThan(30);
  });

  it('an explicit receiver (gesture / lock) is honoured over the stick choice', () => {
    const s = quiet();
    place(s, MATE_A, 25, 0);
    place(s, MATE_B, 5, 25);
    const l = solveLobKick(s, KickKind.LOB_PASS, { dirX: 1, targetSlot: MATE_B })!;
    expect(l.target).toBe(MATE_B);
    expect(Math.hypot(l.tx - 5, l.tz - 25)).toBeLessThan(0.01);
  });

  it('an explicit point is the landing point; the teammate there becomes the target', () => {
    const s = quiet();
    place(s, MATE_A, 30, -10);
    const l = solveLobKick(s, KickKind.LOB_PASS, { hasTarget: 1, targetX: 31, targetZ: -12, dirX: 1 })!;
    expect([l.tx, l.tz]).toEqual([31, -12]);
    expect(l.target).toBe(MATE_A);
    const ld = landing(s, l);
    expect(Math.hypot(ld.x - 31, ld.z + 12)).toBeLessThan(1.5);
  });

  it('no receiver: into space along the stick over the power-implied distance; Manual ignores receivers', () => {
    for (const pw of [0.2, 0.8]) {
      const s = quiet();
      const l = solveLobKick(s, KickKind.LOB_PASS, { power: pw, dirX: 1, dirZ: 0 })!;
      expect(l.target).toBe(-1);
      const d = LT.lobDistMin + (LT.lobDistMax - LT.lobDistMin) * pw;
      expect(Math.hypot(l.tx - (s.ball.x + d), l.tz - s.ball.z)).toBeLessThan(0.01);
    }
    const s = quiet();
    place(s, MATE_A, 25, 2);
    const l = solveLobKick(s, KickKind.LOB_PASS, { power: 0.5, dirX: 0, dirZ: -1, assist: AssistLevel.MANUAL })!;
    expect(l.tz).toBeLessThan(-20);
    expect(l.target).toBe(-1);
  });

  it('Semi blends the power-implied distance into the receiver distance', () => {
    const a = quiet(); place(a, MATE_A, 25, 0);
    const b = quiet(); place(b, MATE_A, 25, 0);
    const la = solveLobKick(a, KickKind.LOB_PASS, { power: 1, dirX: 1 })!;
    const lb = solveLobKick(b, KickKind.LOB_PASS, { power: 1, dirX: 1, assist: AssistLevel.SEMI })!;
    expect(la.target).toBe(MATE_A);
    expect(lb.target).toBe(MATE_A);
    const d = 24.5 + (LT.lobDistMax - 24.5) * LT.semiPowerBlend;
    expect(Math.abs(lb.tx - a.ball.x - d)).toBeLessThan(0.05);
    expect(lb.tx).toBeGreaterThan(la.tx + 5);
  });

  it('targets stay inside the pitch and launches are finite and capped', () => {
    const s = quiet(1, 45, 30, 1, 1);
    place(s, MATE_A, 50, 33, 1, 0, 8, 6);
    const l = solveLobKick(s, KickKind.HIGH_LOB, { power: 1, dirX: 1, dirZ: 1 })!;
    expect(Math.abs(l.tx)).toBeLessThanOrEqual(HALF_LENGTH);
    expect(Math.abs(l.tz)).toBeLessThanOrEqual(HALF_WIDTH);
    const far = quiet(1, -45, 0);
    const lf = solveLobKick(far, KickKind.DRIVEN_LOB, { hasTarget: 1, targetX: 50, targetZ: 0 })!;
    expect(Math.hypot(lf.vx, lf.vy, lf.vz)).toBeLessThanOrEqual(LT.loftSpeedMax + 1e-9);
    for (const v of [l.vx, l.vy, l.vz, l.sx, l.sy, l.sz, lf.vx, lf.vy, lf.vz]) expect(Number.isFinite(v)).toBe(true);
  });

  it('error grows with weak long passing and with pressure (landing spread over seeds)', () => {
    const spread = (attr: number, pressured: boolean): number => {
      let sum = 0;
      for (let seed = 1; seed <= 24; seed++) {
        const s = quiet();
        skill(s, KICKER, attr);
        place(s, MATE_A, 30, 0);
        if (pressured) place(s, OPP_A, 1, 1.5);
        const l = solveLobKick(s, KickKind.LOB_PASS, { power: 0.5, dirX: 1 }, seed)!;
        const ld = landing(s, l);
        sum += Math.hypot(ld.x - 30, ld.z);
      }
      return sum / 24;
    };
    const good = spread(90, false);
    expect(spread(35, false)).toBeGreaterThan(good * 1.5);
    expect(spread(90, true)).toBeGreaterThan(good * 1.2);
  });

  it('is deterministic and uses s.rng only (same state and seed -> same launch; rng advanced by the error draws)', () => {
    const mk = () => { const s = quiet(4); place(s, MATE_A, 22, 7, 1, 0, 3, 1); return s; };
    const a = solveLobKick(mk(), KickKind.LOB_PASS, { power: 0.4, dirX: 1 }, 11)!;
    const b = solveLobKick(mk(), KickKind.LOB_PASS, { power: 0.4, dirX: 1 }, 11)!;
    expect(b).toEqual(a);
    const c = solveLobKick(mk(), KickKind.LOB_PASS, { power: 0.4, dirX: 1 }, 12)!;
    expect(c.vx === a.vx && c.vz === a.vz).toBe(false);
    // The solver does not touch state other than the rng.
    const s = mk();
    expect(startLob(s, KICKER, KickKind.LOB_PASS, req({ dirX: 1 }), NULL_SINK)).toBe(1);
    rngSeed(s.rng, 3);
    const before = JSON.stringify({ ...s, rng: null });
    expect(solveLob(s, KICKER, createKickLaunch())).toBe(1);
    expect(JSON.stringify({ ...s, rng: null })).toBe(before);
  });
});
