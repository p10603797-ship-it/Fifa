/**
 * [GFX-09] Locomotion clips (src/render/anim/locomotion.ts) and the shared pose maths (src/render/anim/poseMath.ts):
 * poses finite and within joint limits, cycle continuity (phase 0 == 2 PI), feet planted while the body passes over
 * them (foot world velocity ~0 during stance, measured with the GFX-07 FK helper footPoint as the model draws it),
 * stride length / arm swing scaling with speed, turn lean from the yaw rate, the directional clips (strafe, jockey,
 * shield, keeper ready), the flight-phase ground snap regression, and the IK helpers.
 */
import { describe, expect, it } from 'vitest';
import { AnimId, createPose, POSE_SIZE, PoseIdx, type Pose } from '../../src/contracts/render';
import {
  applyTurnLean, footPhase, LOCOMOTION_POSES, runDuty, shuffleStrideLength, strideLength, strideLengthFor, turnLeanAngle,
} from '../../src/render/anim/locomotion';
import {
  footPitchOf, IK_INFO, legIK, mirrorPose, plantToe, POSE_MAX, POSE_MIN, setFootPitch,
} from '../../src/render/anim/poseMath';
import {
  BODY, createSkeleton, footPoint, framePoint, GROUND_SNAP_MAX, handPoint, Joint, lowestPoint, solvePoseFK,
} from '../../src/render/players/fk';

const P = PoseIdx;
const TAU = Math.PI * 2;
const LOCO = [AnimId.IDLE, AnimId.JOG, AnimId.SPRINT, AnimId.TURN_LEAN, AnimId.STRAFE, AnimId.JOCKEY, AnimId.SHIELD, AnimId.KEEPER_READY];

function pose(anim: AnimId, t: number, cycle: number, speed: number, side = 1, foot = 0): Pose {
  const out = createPose();
  LOCOMOTION_POSES[anim]!(out, t, cycle, speed, side, foot);
  return out;
}

function withinLimits(p: Pose): string | null {
  for (let i = 0; i < POSE_SIZE; i++) {
    const v = p[i]!;
    if (!Number.isFinite(v)) return `channel ${i} not finite`;
    if (v < POSE_MIN[i]! - 1e-4 || v > POSE_MAX[i]! + 1e-4) return `channel ${i} = ${v} outside [${POSE_MIN[i]}, ${POSE_MAX[i]}]`;
  }
  return null;
}

/** Toe point (model space, as the model draws it: FK + ground correction) of side -1 left / +1 right. */
function toe(p: Pose, side: number): number[] {
  const o = [0, 0, 0];
  footPoint(p, side, 1, o);
  return o;
}

/**
 * Walk the body along `dir` (fraction of a turn) through two stride cycles at `speed` with the distance-driven phase
 * the mapper uses (cycle = 2 PI * distance / stride). For each stance (footPhase says the foot is planted) measure
 * how far the toe wanders in the world from where it touched down (drift, m), relative to the stance travel (slip),
 * the planted fraction per foot and the highest planted toe.
 */
function stanceSlip(anim: AnimId, speed: number, dir = 0, side = 1): { slip: number; drift: number; planted: number[]; lift: number } {
  const stride = strideLengthFor(anim, speed);
  const N = 720;
  const a = dir * TAU;
  const start: number[][] = [[0, 0, 0], [0, 0, 0]];
  const was = [false, false];
  let drift = 0, lift = 0, travel = 0;
  const plantedCount = [0, 0];
  for (let i = 0; i <= 2 * N; i++) {
    const dist = (stride * i) / N;
    const cycle = (TAU * dist) / stride;
    const p = pose(anim, dir, cycle, speed, side);
    const bx = dist * Math.cos(a), bz = dist * Math.sin(a);
    for (let f = 0; f < 2; f++) {
      const fs = f === 0 ? 1 : -1;
      const w = toe(p, fs);
      w[0] += bx; w[2] += bz;
      const ph = footPhase(anim, cycle, speed, dir, fs);
      const planted = ph > 0.01 && ph < 0.99;
      if (planted && i >= N) plantedCount[f]!++;
      if (planted && !was[f]) start[f] = w;
      if (planted && was[f]) {
        drift = Math.max(drift, Math.hypot(w[0]! - start[f]![0]!, w[1]! - start[f]![1]!, w[2]! - start[f]![2]!));
        lift = Math.max(lift, w[1]!);
      }
      if (planted) travel = Math.max(travel, ph * stride * (anim === AnimId.JOG || anim === AnimId.SPRINT || anim === AnimId.TURN_LEAN ? runDuty(speed) : 0.6));
      was[f] = planted;
    }
  }
  return { slip: travel > 0 ? drift / travel : 0, drift, planted: [plantedCount[0]! / N, plantedCount[1]! / N], lift };
}

describe('[GFX-09] stride length', () => {
  it('stride length (m per cycle) grows with speed, stays positive and bounded', () => {
    let last = 0;
    for (let v = 0; v <= 10; v += 0.25) {
      const s = strideLength(v);
      expect(s).toBeGreaterThan(0.45);
      expect(s).toBeLessThan(4.5);
      expect(s).toBeGreaterThanOrEqual(last - 1e-9);
      last = s;
    }
    expect(strideLength(5)).toBeGreaterThan(2.5); // a run covers ~1.5 m per step
    expect(strideLength(9)).toBeGreaterThan(strideLength(5));
    expect(strideLength(Number.NaN)).toBeGreaterThan(0);
    expect(strideLength(-3)).toBeGreaterThan(0);
  });

  it('shuffle clips (strafe, jockey, shield, keeper) use shorter, quicker steps', () => {
    for (const v of [1, 2.5, 4]) {
      expect(shuffleStrideLength(v)).toBeLessThan(strideLength(v));
      expect(strideLengthFor(AnimId.JOCKEY, v)).toBe(shuffleStrideLength(v));
      expect(strideLengthFor(AnimId.JOG, v)).toBe(strideLength(v));
      expect(strideLengthFor(AnimId.SPRINT, v)).toBe(strideLength(v));
    }
  });
});

describe('[GFX-09] poses finite and within joint limits', () => {
  it('every locomotion clip, phase, speed and direction stays finite and inside POSE_MIN / POSE_MAX', () => {
    for (const anim of LOCO) {
      for (const v of [0, 0.4, 1.5, 3, 5, 7.5, 9.6, 12]) {
        for (let i = 0; i <= 24; i++) {
          const c = (i / 24) * TAU;
          const t = i / 24;
          for (const side of [-1, 1]) {
            const err = withinLimits(pose(anim, t, c, v, side * (anim === AnimId.TURN_LEAN ? 3 : 1), i & 1));
            expect(err, `${AnimId[anim]} v=${v} c=${c.toFixed(2)}`).toBeNull();
          }
        }
      }
    }
  });

  it('garbage inputs (NaN / huge) still give finite poses', () => {
    for (const anim of LOCO) {
      expect(withinLimits(pose(anim, Number.NaN, Number.NaN, Number.NaN, Number.NaN, 0))).toBeNull();
      expect(withinLimits(pose(anim, 7.3, 1e6, 1e6, -50, 1))).toBeNull();
    }
  });
});

describe('[GFX-09] cycle continuity', () => {
  it('pose at cycle 0 equals pose at cycle 2 PI (and IDLE at t 0 equals t 1)', () => {
    for (const anim of [AnimId.JOG, AnimId.SPRINT, AnimId.STRAFE, AnimId.JOCKEY, AnimId.SHIELD, AnimId.KEEPER_READY, AnimId.TURN_LEAN]) {
      for (const v of [0.8, 2.5, 5, 8.5]) {
        const a = pose(anim, 0.25, 0, v, 1);
        const b = pose(anim, 0.25, TAU, v, 1);
        for (let k = 0; k < POSE_SIZE; k++) expect(Math.abs(a[k]! - b[k]!), `${AnimId[anim]} ch ${k}`).toBeLessThan(1e-4);
      }
    }
    const i0 = pose(AnimId.IDLE, 0, 0, 0), i1 = pose(AnimId.IDLE, 1, 0, 0);
    for (let k = 0; k < POSE_SIZE; k++) expect(Math.abs(i0[k]! - i1[k]!)).toBeLessThan(1e-4);
  });

  it('regression "knee snap at full extension": joints change < 0.5 rad per 60 Hz frame at any running speed', () => {
    for (const anim of [AnimId.JOG, AnimId.SPRINT]) {
      for (const v of [1, 2, 5, 7, 9, 9.6]) {
        const perFrame = (TAU * v) / 60 / strideLength(v); // cycle advance per frame at this speed
        const n = Math.ceil(TAU / perFrame);
        let prev = pose(anim, 0, 0, v);
        let minKnee = 9;
        for (let i = 1; i <= n; i++) {
          const cur = pose(anim, 0, i * perFrame, v);
          for (let k = 0; k < POSE_SIZE; k++) expect(Math.abs(cur[k]! - prev[k]!), `${AnimId[anim]} v=${v} i=${i} ch ${k}`).toBeLessThan(0.5);
          minKnee = Math.min(minKnee, cur[P.KNEE_L]!, cur[P.KNEE_R]!);
          prev = cur;
        }
        expect(minKnee, `${AnimId[anim]} v=${v} never locks the knee straight`).toBeGreaterThan(0.2);
      }
    }
  });
});

describe('[GFX-09] feet planted while the body passes over them (no foot sliding)', () => {
  it('jog and sprint: a planted toe stays put (drift < 1 cm, < 2% of the stance travel) at every speed', () => {
    for (const anim of [AnimId.JOG, AnimId.SPRINT]) {
      for (const v of [0.5, 1, 1.5, 2, 3.5, 5, 6.5, 8, 9.6]) {
        const r = stanceSlip(anim, v);
        expect(r.drift, `${AnimId[anim]} v=${v} drift`).toBeLessThan(0.01);
        expect(r.slip, `${AnimId[anim]} v=${v}`).toBeLessThan(0.02);
        expect(r.lift, `${AnimId[anim]} v=${v} planted toe height`).toBeLessThan(0.004);
        // Each foot is on the grass for the duty factor of the cycle (contact timing vs stride).
        for (const f of r.planted) expect(f, `${AnimId[anim]} v=${v} planted`).toBeCloseTo(runDuty(v), 1);
      }
    }
  });

  it('foot contact timing: the right foot lands at cycle 0, the left half a cycle later', () => {
    const v = 5;
    const stride = strideLength(v);
    const duty = runDuty(v);
    // Mid-stance of the right foot (cycle = duty * PI) and of the left (PI + duty * PI).
    const r = toe(pose(AnimId.JOG, 0, duty * Math.PI, v), 1);
    const l = toe(pose(AnimId.JOG, 0, Math.PI + duty * Math.PI, v), -1);
    expect(r[1]).toBeLessThan(0.003);
    expect(l[1]).toBeLessThan(0.003);
    // In the middle of the swing each foot is clearly off the grass.
    expect(toe(pose(AnimId.JOG, 0, Math.PI + duty * Math.PI, v), 1)[1]).toBeGreaterThan(0.08);
    // Stance travel equals duty * stride (the planted foot passes under the body exactly at body speed).
    const a = toe(pose(AnimId.JOG, 0, 0.01, v), 1), b = toe(pose(AnimId.JOG, 0, duty * TAU - 0.01, v), 1);
    expect(a[0]! - b[0]!).toBeCloseTo(stride * duty * (1 - 0.02 / (duty * TAU)), 1);
  });

  it('shuffle clips plant their feet at their working speeds (strafe right / back, jockey, keeper sideways)', () => {
    const cases: [AnimId, number, number][] = [
      [AnimId.STRAFE, 0.25, 1.5], [AnimId.STRAFE, 0.25, 3], [AnimId.STRAFE, 0.5, 1.5], [AnimId.STRAFE, 0.75, 2.5],
      [AnimId.JOCKEY, 0, 2], [AnimId.JOCKEY, 0.25, 2.5], [AnimId.JOCKEY, 0.5, 1.5],
      [AnimId.KEEPER_READY, 0.75, 1.5], [AnimId.KEEPER_READY, 0.25, 3], [AnimId.SHIELD, 0.5, 1.5],
    ];
    for (const [anim, dir, v] of cases) {
      const r = stanceSlip(anim, v, dir);
      expect(r.drift, `${AnimId[anim]} dir=${dir} v=${v} drift`).toBeLessThan(0.04);
      expect(r.slip, `${AnimId[anim]} dir=${dir} v=${v}`).toBeLessThan(0.12);
      expect(r.lift, `${AnimId[anim]} dir=${dir} v=${v} planted toe height`).toBeLessThan(0.006);
    }
  });

  it('regression "ground snap pop in flight": the lowest foot never crosses the model ground snap while airborne', () => {
    // fk.ts plants grounded poses floating < GROUND_SNAP_MAX; a flight phase that crossed it would pop the body.
    const sk = createSkeleton();
    for (const anim of [AnimId.JOG, AnimId.SPRINT]) {
      for (const v of [3, 5, 7, 8.5, 9.6, 11]) {
        let maxLow = -1, minLow = 1;
        for (let i = 0; i <= 720; i++) {
          const p = pose(anim, 0, (i / 720) * TAU, v);
          solvePoseFK(p, sk);
          const low = lowestPoint(sk);
          maxLow = Math.max(maxLow, low);
          minLow = Math.min(minLow, low);
        }
        expect(maxLow, `${AnimId[anim]} v=${v}`).toBeLessThan(GROUND_SNAP_MAX * 0.8);
        expect(minLow, `${AnimId[anim]} v=${v} sinks`).toBeGreaterThan(-0.002);
      }
    }
  });
});

describe('[GFX-09] speed scaling, lean and posture', () => {
  it('stride length and arm swing scale with speed; sprint swings the arms harder and leans more than jog', () => {
    const swing = (anim: AnimId, v: number): number => {
      let lo = 9, hi = -9;
      for (let i = 0; i < 72; i++) {
        const p = pose(anim, 0, (i / 72) * TAU, v);
        lo = Math.min(lo, p[P.SHOULDER_R_PITCH]!);
        hi = Math.max(hi, p[P.SHOULDER_R_PITCH]!);
      }
      return hi - lo;
    };
    const reach = (v: number): number => {
      let lo = 9, hi = -9;
      for (let i = 0; i < 72; i++) {
        const x = toe(pose(AnimId.JOG, 0, (i / 72) * TAU, v), 1)[0]!;
        lo = Math.min(lo, x); hi = Math.max(hi, x);
      }
      return hi - lo;
    };
    expect(swing(AnimId.JOG, 5)).toBeGreaterThan(swing(AnimId.JOG, 2));
    expect(swing(AnimId.SPRINT, 8)).toBeGreaterThan(swing(AnimId.JOG, 8));
    expect(reach(6)).toBeGreaterThan(reach(2));
    expect(pose(AnimId.SPRINT, 0, 1, 8)[P.SPINE_PITCH]).toBeGreaterThan(pose(AnimId.JOG, 0, 1, 8)[P.SPINE_PITCH]!);
    expect(pose(AnimId.JOG, 0, 1, 5)[P.SPINE_PITCH]).toBeGreaterThan(pose(AnimId.JOG, 0, 1, 1)[P.SPINE_PITCH]!);
  });

  it('jog and sprint plant identically at the same speed (they cross-fade without the feet moving)', () => {
    for (const v of [3, 6]) {
      for (const c of [0.3, 1.2]) {
        const a = toe(pose(AnimId.JOG, 0, c, v), 1), b = toe(pose(AnimId.SPRINT, 0, c, v), 1);
        expect(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)).toBeLessThan(1e-3);
      }
    }
  });

  it('TURN_LEAN rolls into the turn from the yaw rate (side = rad/s, + = right), clamped', () => {
    expect(turnLeanAngle(2, 1)).toBeCloseTo(Math.atan(2 / 9.81), 6);
    expect(turnLeanAngle(6, -2)).toBeLessThan(0);
    expect(Math.abs(turnLeanAngle(9, 20))).toBeLessThanOrEqual(0.38 + 1e-9);
    expect(turnLeanAngle(0, 5)).toBe(0);
    expect(turnLeanAngle(5, 0)).toBe(0);
    const right = pose(AnimId.TURN_LEAN, 0, 1, 6, 2);
    const left = pose(AnimId.TURN_LEAN, 0, 1, 6, -2);
    const straight = pose(AnimId.TURN_LEAN, 0, 1, 6, 0);
    expect(right[P.ROOT_ROLL]).toBeGreaterThan(0.2);
    expect(left[P.ROOT_ROLL]).toBeLessThan(-0.2);
    expect(Math.abs(straight[P.ROOT_ROLL]!)).toBeLessThan(1e-6);
    // Harder turns lean more.
    expect(pose(AnimId.TURN_LEAN, 0, 1, 3, 1)[P.ROOT_ROLL]).toBeLessThan(pose(AnimId.TURN_LEAN, 0, 1, 3, 2)[P.ROOT_ROLL]! - 0.05);
    // The lean layer used by the mapper gives the same roll as the clip.
    const jog = pose(AnimId.JOG, 0, 1, 6);
    applyTurnLean(jog, turnLeanAngle(6, 2));
    expect(jog[P.ROOT_ROLL]).toBeCloseTo(right[P.ROOT_ROLL]!, 5);
  });

  it('IDLE breathes: chest and pelvis move with the breathing phase while the feet stay planted', () => {
    const a = pose(AnimId.IDLE, 0.25, 0, 0), b = pose(AnimId.IDLE, 0.75, 0, 0);
    expect(Math.abs(a[P.SPINE_PITCH]! - b[P.SPINE_PITCH]!)).toBeGreaterThan(0.01);
    expect(Math.abs(a[P.ROOT_SIDE]! - b[P.ROOT_SIDE]!)).toBeGreaterThan(0.01);
    for (const side of [-1, 1]) {
      const ta = toe(a, side), tb = toe(b, side);
      expect(Math.hypot(ta[0]! - tb[0]!, ta[2]! - tb[2]!)).toBeLessThan(0.004);
      expect(ta[1]).toBeLessThan(0.003);
    }
  });

  it('JOCKEY is a low crouch, SHIELD a wide stance with the arm out on its side, KEEPER_READY crouched with hands up', () => {
    const jog = pose(AnimId.JOG, 0, 0.5, 2.5);
    const jockey = pose(AnimId.JOCKEY, 0, 0.5, 0);
    expect(jockey[P.ROOT_Y]).toBeLessThan(jog[P.ROOT_Y]! - 0.05);
    expect(jockey[P.SPINE_PITCH]).toBeGreaterThan(0.2);

    const shieldR = pose(AnimId.SHIELD, 0, 0, 0, 1);
    const feetApart = Math.abs(toe(shieldR, 1)[2]! - toe(shieldR, -1)[2]!);
    expect(feetApart).toBeGreaterThan(0.35);
    expect(shieldR[P.SHOULDER_R_ROLL]).toBeGreaterThan(0.9);
    expect(shieldR[P.SHOULDER_L_ROLL]).toBeLessThan(0.6);
    const shieldL = pose(AnimId.SHIELD, 0, 0, 0, -1);
    expect(shieldL[P.SHOULDER_L_ROLL]).toBeGreaterThan(0.9);

    const keeper = pose(AnimId.KEEPER_READY, 0, 0, 0);
    expect(keeper[P.ROOT_Y]).toBeLessThan(-0.12);
    const hand = [0, 0, 0];
    handPoint(keeper, 1, hand);
    expect(hand[0]).toBeGreaterThan(0.2); // hands up in front
    expect(hand[1]).toBeGreaterThan(0.85);
  });

  it('STRAFE steps sideways: moving right the feet travel along +z in model space, backward along -x', () => {
    const v = 2;
    const stride = strideLengthFor(AnimId.STRAFE, v);
    // Mid-stance of the right foot: the planted toe moves toward -z (left) as the body moves right.
    const a = toe(pose(AnimId.STRAFE, 0.25, 0.2, v), 1), b = toe(pose(AnimId.STRAFE, 0.25, 1.6, v), 1);
    expect(a[2]! - b[2]!).toBeGreaterThan(0.15 * stride);
    const c = toe(pose(AnimId.STRAFE, 0.5, 0.2, v), 1), d = toe(pose(AnimId.STRAFE, 0.5, 1.6, v), 1);
    expect(d[0]! - c[0]!).toBeGreaterThan(0.15 * stride); // moving back: planted foot moves forward in model space
  });
});

describe('[GFX-09] IK helpers (poseMath)', () => {
  it('legIK puts the ankle on the target, with root yaw / roll / pitch / offsets compensated', () => {
    const sk = createSkeleton();
    const o = [0, 0, 0];
    const roots: number[][] = [[-0.05, 0, 0, 0, 0, 0], [-0.2, 0.3, 0.2, -0.25, 0.1, -0.05], [-0.12, -0.4, -0.3, 0.6, -0.1, 0.08]];
    for (const r of roots) {
      for (const side of [-1, 1]) {
        const p = createPose();
        p[P.ROOT_Y] = r[0]!; p[P.ROOT_PITCH] = r[1]!; p[P.ROOT_ROLL] = r[2]!; p[P.ROOT_YAW] = r[3]!; p[P.ROOT_FWD] = r[4]!; p[P.ROOT_SIDE] = r[5]!;
        const target = [0.25 + 0.05 * side, 0.2, 0.14 * side];
        legIK(p, side, target[0]!, target[1]!, target[2]!);
        expect(IK_INFO[1]).toBe(0);
        solvePoseFK(p, sk);
        framePoint(sk, side < 0 ? Joint.ANKLE_L : Joint.ANKLE_R, 0, 0, 0, o);
        expect(Math.hypot(o[0]! - target[0]!, o[1]! - target[1]!, o[2]! - target[2]!)).toBeLessThan(1e-5);
        expect(p[side < 0 ? P.KNEE_L : P.KNEE_R]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('out-of-reach targets straighten the leg toward them and are flagged', () => {
    const p = createPose();
    legIK(p, 1, 2, 0, 0.1);
    expect(IK_INFO[1]).toBe(1);
    expect(p[P.KNEE_R]).toBeLessThan(0.1);
    expect(withinLimits(p)).toBeNull();
  });

  it('plantToe puts the toe exactly on the target with the requested pitch (or the reachable one)', () => {
    for (const pitch of [0, -0.4, 0.15]) {
      const p = createPose();
      p[P.ROOT_Y] = -0.1; p[P.ROOT_ROLL] = 0.15; p[P.ROOT_YAW] = 0.2;
      plantToe(p, 1, 0.3, 0.02, 0.15, pitch);
      const o = [0, 0, 0];
      const sk = createSkeleton();
      solvePoseFK(p, sk); // raw FK (the other leg is left straight and would trigger the never-sink lift)
      framePoint(sk, Joint.ANKLE_R, BODY.toeX, -BODY.ankleY, 0, o);
      expect(Math.hypot(o[0]! - 0.3, o[1]! - 0.02, o[2]! - 0.15), `pitch ${pitch}`).toBeLessThan(2e-3);
      expect(footPitchOf(p, 1)).toBeCloseTo(pitch, 2);
    }
  });

  it('setFootPitch makes a flat foot flat (toe and heel at the same height)', () => {
    const p = createPose();
    p[P.ROOT_PITCH] = 0.2; p[P.ROOT_ROLL] = -0.1;
    legIK(p, -1, 0.1, 0.15, -0.12);
    setFootPitch(p, -1, 0);
    const t = [0, 0, 0], h = [0, 0, 0];
    footPoint(p, -1, 1, t, 0);
    footPoint(p, -1, 2, h, 0);
    expect(Math.abs(t[1]! - h[1]!)).toBeLessThan(0.01);
  });

  it('mirrorPose swaps the limbs and negates lateral channels (twice = identity)', () => {
    const p = pose(AnimId.SHIELD, 0.1, 0.7, 1.2, 1);
    const m = new Float32Array(p);
    mirrorPose(m);
    expect(m[P.SHOULDER_L_ROLL]).toBeCloseTo(p[P.SHOULDER_R_ROLL]!, 6);
    expect(m[P.SPINE_ROLL]).toBeCloseTo(-p[P.SPINE_ROLL]!, 6);
    mirrorPose(m);
    for (let k = 0; k < POSE_SIZE; k++) expect(m[k]).toBeCloseTo(p[k]!, 6);
  });

  it('every locomotion pose keeps the body above the grass (FK lowest point >= -4 mm before ground correction)', () => {
    const sk = createSkeleton();
    for (const anim of LOCO) {
      for (const v of [0, 1, 2.5, 4]) {
        for (let i = 0; i < 24; i++) {
          solvePoseFK(pose(anim, i / 24, (i / 24) * TAU, v, 1), sk);
          // TURN_LEAN rolls the planted legs with the body (the model's never-sink rule lifts the few mm).
          expect(lowestPoint(sk), `${AnimId[anim]} v=${v} i=${i}`).toBeGreaterThan(anim === AnimId.TURN_LEAN ? -0.015 : -0.004);
        }
      }
    }
    expect(BODY.pelvisY).toBeGreaterThan(0.8); // the FK body the gait was tuned against
  });
});
