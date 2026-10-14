/**
 * [SIM-09] Crosses: crossTarget (near post / penalty spot / far post from power and stick, corner-tactic bias),
 * landing accuracy of a 75-rated crosser, whip away from the keeper, ground / low / floated crosses, target attacker,
 * corner reticle, far-from-box fallback, determinism.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, HALF_LENGTH, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH } from '../../src/contracts/constants';
import { AssistLevel, Command, KickKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch, ReqFlag } from '../../src/contracts/systems';
import { KICK_SOLVERS } from '../../src/sim/actions/registry';
import { attackerNear, crossTarget, groundCrossTarget, LOCAL_TUNING as LT, solveCross } from '../../src/sim/kicks/lob';
import {
  fly, KICKER, landing, launched, MATE_A, MATE_B, MATE_C, OPP_GK, place, quiet, skill, solveLobKick,
} from './sim-09-helpers';

const PT = { x: 0, z: 0 };

/** Crosser on the wing (side +1 / -1) of the end team 0 attacks (dir), facing roughly across toward the box. */
function wing(dir: number, side: number, seed = 1, rating = 80): SimState {
  const s = quiet(seed, dir * 37, side * 27, dir * 0.45, -side * 0.9);
  s.teams[0]!.dir = dir; s.teams[1]!.dir = -dir;
  skill(s, KICKER, rating);
  return s;
}

function zone(dir: number, side: number, depth: number, lat: number): { x: number; z: number } {
  return { x: dir * (HALF_LENGTH - depth), z: side * lat };
}

describe('SIM-09 crossTarget', () => {
  it('power picks near post / penalty spot / far post for either wing and attack direction (stick idle or at goal)', () => {
    for (const dir of [1, -1]) {
      for (const side of [1, -1]) {
        const s = wing(dir, side);
        for (const [pw, d, l] of [[0.1, LT.nearPostDepth, LT.nearPostSide], [0.5, LT.spotDepth, LT.spotSide], [0.9, LT.farPostDepth, LT.farPostSide]] as const) {
          const want = zone(dir, side, d, l);
          crossTarget(s, KICKER, pw, 0, 0, PT);
          expect(PT.x).toBeCloseTo(want.x, 9);
          expect(PT.z).toBeCloseTo(want.z, 9);
          // A stick straight at the goal line is neutral (TAI-09 passes (dir, 0)).
          crossTarget(s, KICKER, pw, dir, 0, PT);
          expect(PT.x).toBeCloseTo(want.x, 9);
          expect(PT.z).toBeCloseTo(want.z, 9);
        }
        // TAI-09's literal powers all answer inside the attacked penalty area, near post < spot < far post sideways.
        const zs: number[] = [];
        for (const pw of [0.3, 0.6, 0.9]) {
          crossTarget(s, KICKER, pw, dir, 0, PT);
          const u = dir * PT.x;
          expect(u).toBeGreaterThanOrEqual(HALF_LENGTH - PENALTY_AREA_DEPTH);
          expect(u).toBeLessThanOrEqual(HALF_LENGTH);
          expect(Math.abs(PT.z)).toBeLessThanOrEqual(PENALTY_AREA_HALF_WIDTH);
          zs.push(side * PT.z);
        }
        expect(zs[0]!).toBeGreaterThan(zs[1]!);
        expect(zs[1]!).toBeGreaterThan(zs[2]!);
      }
    }
  });

  it('the stick nudges the aim: across toward the far side, or pulled back toward the edge of the box', () => {
    const s = wing(1, 1);
    crossTarget(s, KICKER, 0.5, 0, 0, PT);
    const base = { ...PT };
    crossTarget(s, KICKER, 0.5, 0, -1, PT); // toward the far side (crosser on +z)
    expect(PT.z).toBeCloseTo(base.z - LT.stickSideShift, 9);
    crossTarget(s, KICKER, 0.5, 0, 1, PT); // toward his own touchline: near side
    expect(PT.z).toBeCloseTo(base.z + LT.stickSideShift, 9);
    crossTarget(s, KICKER, 0.5, -1, 0, PT); // away from goal: cut-back
    expect(PT.x).toBeCloseTo(base.x - LT.stickBackShift, 9);
    expect(PT.z).toBeCloseTo(base.z, 9);
  });

  it('corner tactics pull the target toward their zone', () => {
    const s = wing(1, -1);
    const pull = (cmd: number, pw: number): { x: number; z: number } => {
      s.teams[0]!.cornerTactic = cmd;
      crossTarget(s, KICKER, pw, 0, 0, PT);
      return { ...PT };
    };
    const spot = pull(0, 0.5);
    const near = pull(Command.CORNER_NEAR_POST, 0.5);
    const far = pull(Command.CORNER_FAR_POST, 0.5);
    const edge = pull(Command.CORNER_EDGE_OF_BOX, 0.5);
    const gk = pull(Command.CORNER_CROWD_KEEPER, 0.5);
    // Crosser on -z: near side is -z, far side +z.
    expect(near.z).toBeLessThan(spot.z - 2);
    expect(far.z).toBeGreaterThan(spot.z + 3);
    expect(edge.x).toBeLessThan(spot.x - 3);
    expect(gk.x).toBeGreaterThan(spot.x + 5);
    // Even a far-post power is pulled to the near post by that tactic.
    const nearFromFar = pull(Command.CORNER_NEAR_POST, 0.95);
    expect(nearFromFar.z).toBeLessThan(0);
  });

  it('is pure (no state or rng change) and safe for bad slots', () => {
    const s = wing(1, 1);
    const before = JSON.stringify(s);
    crossTarget(s, KICKER, 0.7, 0.3, -0.9, PT);
    groundCrossTarget(s, KICKER, 0.7, 0.3, -0.9, PT);
    attackerNear(s, KICKER, 40, 0, 1);
    expect(JSON.stringify(s)).toBe(before);
    crossTarget(s, -1, 0.5, 0, 0, PT);
    expect([PT.x, PT.z]).toEqual([0, 0]);
    crossTarget(s, KICKER, NaN, NaN, Infinity, PT);
    expect(Number.isFinite(PT.x) && Number.isFinite(PT.z)).toBe(true);
  });
});

describe('SIM-09 cross solver', () => {
  it('the registry maps CROSS / GROUND_CROSS / LOW_CROSS to solveCross', () => {
    for (const k of [KickKind.CROSS, KickKind.GROUND_CROSS, KickKind.LOW_CROSS]) expect(KICK_SOLVERS[k]).toBe(solveCross);
  });

  it('crosses land within 2.5 m of the chosen zone for a 75-rated crosser', () => {
    for (const dir of [1, -1]) {
      for (const side of [1, -1]) {
        for (const pw of [0.15, 0.5, 0.9]) {
          const errs: number[] = [];
          for (let seed = 1; seed <= 25; seed++) {
            const s = wing(dir, side, seed, 75);
            crossTarget(s, KICKER, pw, 0, 0, PT);
            const want = { ...PT };
            const l = solveLobKick(s, KickKind.LOB_PASS, { power: pw }, seed)!;
            expect(l.kind).toBe(KickKind.CROSS);
            expect([l.tx, l.tz]).toEqual([want.x, want.z]);
            const ld = landing(s, l);
            errs.push(Math.hypot(ld.x - want.x, ld.z - want.z));
          }
          errs.sort((a, b) => a - b);
          const within = errs.filter((e) => e <= 2.5).length;
          expect(within / errs.length).toBeGreaterThanOrEqual(0.9);
          expect(errs[Math.floor(errs.length / 2)]!).toBeLessThan(1.5);
        }
      }
    }
  });

  it('whips the cross away from the keeper (curl bends it away from the goal) on both wings, both ends', () => {
    for (const dir of [1, -1]) {
      for (const side of [1, -1]) {
        for (const pw of [0.15, 0.5, 0.9]) {
          const s = wing(dir, side);
          const l = solveLobKick(s, KickKind.LOB_PASS, { power: pw }, 3)!;
          expect(l.sy).not.toBe(0);
          // Bend = landing minus the straight-line continuation of the launch direction.
          const b = launched(s, l);
          const hx = l.vx / Math.hypot(l.vx, l.vz), hz = l.vz / Math.hypot(l.vx, l.vz);
          const ld = landing(s, l);
          const rx = ld.x - b.x, rz = ld.z - b.z;
          const along = rx * hx + rz * hz;
          const bendX = rx - along * hx, bendZ = rz - along * hz;
          // Away from the goal centre toward the aim point.
          const ax = l.tx - dir * HALF_LENGTH, az = l.tz;
          expect(bendX * ax + bendZ * az).toBeGreaterThan(0);
          expect(Math.hypot(bendX, bendZ)).toBeGreaterThan(0.5);
          // SIM-01 convention: positive sy curls LEFT of travel (left of (hx, hz) is (hz, -hx)).
          expect(Math.sign(bendX * hz - bendZ * hx)).toBe(Math.sign(l.sy));
        }
      }
    }
  });

  it('more crossing = more whip; an explicit request curve sets the side', () => {
    const a = wing(1, 1); skill(a, KICKER, 30);
    const b = wing(1, 1); skill(b, KICKER, 95);
    const la = solveLobKick(a, KickKind.CROSS, { power: 0.5 })!;
    const lb = solveLobKick(b, KickKind.CROSS, { power: 0.5 })!;
    expect(Math.abs(lb.sy)).toBeGreaterThan(Math.abs(la.sy) * 1.5);
    const r = solveLobKick(wing(1, 1), KickKind.CROSS, { power: 0.5, curve: 1 })!;
    const l = solveLobKick(wing(1, 1), KickKind.CROSS, { power: 0.5, curve: -1 })!;
    expect(Math.sign(r.sy)).toBe(-1); // rightward = negative sy
    expect(Math.sign(l.sy)).toBe(1);
  });

  it('ground cross: along the floor to the near post (low power) or the penalty spot (high power), never the far post', () => {
    for (const side of [1, -1]) {
      for (const [pw, d, lat] of [[0.2, LT.nearPostDepth, LT.nearPostSide], [0.9, LT.spotDepth, LT.spotSide]] as const) {
        const s = wing(1, side);
        const l = solveLobKick(s, KickKind.GROUND_CROSS, { power: pw }, 5)!;
        expect(l.kind).toBe(KickKind.GROUND_CROSS);
        expect(l.vy).toBe(0);
        expect([l.sx, l.sy, l.sz]).toEqual([0, 0, 0]);
        const want = zone(1, side, d, lat);
        expect([l.tx, l.tz]).toEqual([want.x, want.z]);
        // The rolling ball passes close to the target with pace left.
        const b = launched(s, l);
        let best = Infinity, sp = 0, maxY = 0;
        fly(b, 240, (_i, bb) => {
          maxY = Math.max(maxY, bb.y);
          const dd = Math.hypot(bb.x - want.x, bb.z - want.z);
          if (dd < best) { best = dd; sp = Math.hypot(bb.vx, bb.vz); }
        });
        expect(maxY).toBeLessThan(BALL_RADIUS + 0.05);
        expect(best).toBeLessThan(2);
        expect(sp).toBeGreaterThan(LT.groundCrossArriveMin - 2);
      }
    }
  });

  it('low (driven) cross is fast and flat; a floated cross (LOFTED) is higher than the whipped one', () => {
    const apexAndSpeed = (kind: KickKind, flags = 0): [number, number] => {
      const s = wing(1, 1);
      const l = solveLobKick(s, kind, { power: 0.5, flags }, 2)!;
      const b = launched(s, l);
      let apex = 0;
      fly(b, 300, (_i, bb) => { apex = Math.max(apex, bb.y); return bb.bounces > 0; });
      return [apex, Math.hypot(l.vx, l.vy, l.vz)];
    };
    const [aLow, vLow] = apexAndSpeed(KickKind.LOW_CROSS);
    const [aCross, vCross] = apexAndSpeed(KickKind.CROSS);
    const [aFloat] = apexAndSpeed(KickKind.CROSS, ReqFlag.LOFTED);
    expect(aLow).toBeLessThan(2.2);
    expect(vLow).toBeGreaterThan(vCross + 3);
    expect(aCross).toBeGreaterThan(aLow + 1);
    expect(aFloat).toBeGreaterThan(aCross + 1);
  });

  it('launch.target is the best attacker near the aim point (keeper excluded), -1 when nobody is there', () => {
    const s = wing(1, 1);
    place(s, MATE_A, 42, 3);   // 1.5 m from the penalty spot
    place(s, MATE_B, 45, -2);  // 4 m away
    place(s, 0, 41.5, 0.5);    // own keeper on the spot: never the target
    let l = solveLobKick(s, KickKind.CROSS, { power: 0.5 })!;
    expect(l.target).toBe(MATE_A);
    const e = wing(1, 1);
    place(e, MATE_A, 20, -20);
    l = solveLobKick(e, KickKind.CROSS, { power: 0.5 })!;
    expect(l.target).toBe(-1);
    // An explicit receiver is led and kept as the target.
    const x = wing(1, 1);
    place(x, MATE_C, 44, -6, 1, 0, 0, 3);
    l = solveLobKick(x, KickKind.CROSS, { power: 0.5, targetSlot: MATE_C })!;
    expect(l.target).toBe(MATE_C);
    expect(l.tz).toBeGreaterThan(-6 + 1);
  });

  it('an explicit point (corner reticle) is the landing point: a corner cross lands near it', () => {
    let hits = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = quiet(seed, 51.8, 33.3, -0.6, -0.8);
      skill(s, KICKER, 75);
      place(s, OPP_GK, 52, 0);
      const l = solveLobKick(s, KickKind.CROSS, { power: 0.6, hasTarget: 1, targetX: 42, targetZ: 1 }, seed)!;
      expect([l.tx, l.tz]).toEqual([42, 1]);
      const ld = landing(s, l);
      if (Math.hypot(ld.x - 42, ld.z - 1) <= 2.5) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(18);
  });

  it('a ground cross asked for far from the box goes to a teammate like a pass', () => {
    const s = quiet(1, -20, 0);
    place(s, MATE_A, -5, 3);
    const l = solveLobKick(s, KickKind.GROUND_CROSS, { power: 0.4, dirX: 1, dirZ: 0.2 })!;
    expect(l.target).toBe(MATE_A);
    expect(Math.hypot(l.tx + 5, l.tz - 3)).toBeLessThan(0.5);
  });

  it('Manual: along the request direction over the power distance', () => {
    const s = wing(1, 1);
    const l = solveLobKick(s, KickKind.CROSS, { power: 0.5, dirX: 0, dirZ: -1, assist: AssistLevel.MANUAL })!;
    const d = LT.crossDistMin + (LT.crossDistMax - LT.crossDistMin) * 0.5;
    expect(l.tx).toBeCloseTo(s.ball.x, 6);
    expect(l.tz).toBeCloseTo(s.ball.z - d, 6);
  });

  it('is deterministic and touches nothing but the rng', () => {
    const a = solveLobKick(wing(1, 1, 3), KickKind.CROSS, { power: 0.45, dirX: 0.3, dirZ: -0.9 }, 21)!;
    const b = solveLobKick(wing(1, 1, 3), KickKind.CROSS, { power: 0.45, dirX: 0.3, dirZ: -0.9 }, 21)!;
    expect(b).toEqual(a);
    const s = wing(1, 1);
    solveLobKick(s, KickKind.CROSS, { power: 0.5 });
    const before = JSON.stringify({ ...s, rng: null });
    expect(solveCross(s, KICKER, createKickLaunch())).toBe(1);
    expect(JSON.stringify({ ...s, rng: null })).toBe(before);
  });
});
