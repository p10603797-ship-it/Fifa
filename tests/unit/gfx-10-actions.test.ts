/**
 * [GFX-10] Kicks, headers, touches, throw-ins (src/render/anim/actions.ts): poses finite and within joint limits for
 * both feet, the kicking foot reaches its maximum forward extension exactly at the clip's contact fraction (FK via the
 * GFX-07 helper footPoint), the foot is at ball height there, the support foot stays planted through the strike,
 * left-foot clips mirror right-foot ones, power shot / finesse / header / volley / first touch / throw-in /
 * keeper distribution specifics, contact and hold fraction tables, and no clip digs into the grass.
 */
import { describe, expect, it } from 'vitest';
import { AnimId, createPose, POSE_SIZE, PoseIdx, type Pose } from '../../src/contracts/render';
import { ACTION_CLIPS, ACTION_CONTACT, ACTION_HOLD, ACTION_POSES } from '../../src/render/anim/actions';
import { POSE_MAX, POSE_MIN } from '../../src/render/anim/poseMath';
import { createSkeleton, footPoint, handPoint, Joint, lowestPoint, solvePoseFK, FRAME_SIZE } from '../../src/render/players/fk';

const P = PoseIdx;
const ALL = [AnimId.PASS, AnimId.SHOT, AnimId.POWER_SHOT, AnimId.FINESSE, AnimId.HEADER, AnimId.VOLLEY, AnimId.FIRST_TOUCH,
  AnimId.SHIELD, AnimId.THROW_IN, AnimId.GK_THROW, AnimId.GK_KICK, AnimId.SKILL];
const FOOT_KICKS = [AnimId.PASS, AnimId.SHOT, AnimId.POWER_SHOT, AnimId.FINESSE, AnimId.VOLLEY, AnimId.GK_KICK];

function pose(anim: AnimId, t: number, foot = 0, side = 1): Pose {
  const out = createPose();
  ACTION_POSES[anim]!(out, t, 0, 0, side, foot);
  return out;
}

/** Ankle joint of the kicking foot (model space, raw FK). side +1 right, -1 left. */
function ankle(p: Pose, side: number): number[] {
  const o = [0, 0, 0];
  footPoint(p, side, 0, o, 0);
  return o;
}

function limitsError(p: Pose): string | null {
  for (let i = 0; i < POSE_SIZE; i++) {
    const v = p[i]!;
    if (!Number.isFinite(v)) return `channel ${i} not finite`;
    if (v < POSE_MIN[i]! - 1e-4 || v > POSE_MAX[i]! + 1e-4) return `channel ${i} = ${v}`;
  }
  return null;
}

describe('[GFX-10] poses finite and within joint limits', () => {
  it('every action clip for both feet over the whole phase', () => {
    for (const anim of ALL) {
      for (const foot of [0, 1]) {
        for (let i = 0; i <= 100; i++) {
          const err = limitsError(pose(anim, i / 100, foot));
          expect(err, `${AnimId[anim]} foot ${foot} t=${i / 100}`).toBeNull();
        }
      }
    }
  });

  it('out-of-range and garbage phases clamp to the clip ends', () => {
    for (const anim of ALL) {
      const a = pose(anim, -3), b = pose(anim, 0), c = pose(anim, 9), d = pose(anim, 1);
      const n = pose(anim, Number.NaN);
      for (let k = 0; k < POSE_SIZE; k++) {
        expect(a[k]).toBeCloseTo(b[k]!, 6);
        expect(c[k]).toBeCloseTo(d[k]!, 6);
        expect(Number.isFinite(n[k]!)).toBe(true);
      }
    }
  });
});

describe('[GFX-10] the kicking foot meets the ball at the contact fraction', () => {
  it('contact table: every kick clip has a contact fraction inside (0, 1) and a backswing hold before it', () => {
    for (const anim of [AnimId.PASS, AnimId.SHOT, AnimId.POWER_SHOT, AnimId.FINESSE, AnimId.HEADER, AnimId.VOLLEY, AnimId.THROW_IN, AnimId.GK_THROW, AnimId.GK_KICK]) {
      const cf = ACTION_CONTACT[anim]!;
      expect(cf, AnimId[anim]).toBeGreaterThan(0.2);
      expect(cf, AnimId[anim]).toBeLessThan(0.8);
      expect(ACTION_CLIPS[anim]!.contact).toBe(cf);
      expect(ACTION_HOLD[anim]!, AnimId[anim]).toBeLessThan(cf);
      expect(ACTION_HOLD[anim]!, AnimId[anim]).toBeGreaterThan(0);
    }
    expect(ACTION_CONTACT[AnimId.SHIELD]).toBeUndefined();
  });

  it('the kicking foot reaches its maximum forward extension exactly at the contact fraction (right and left foot)', () => {
    for (const anim of FOOT_KICKS) {
      const cf = ACTION_CONTACT[anim]!;
      for (const foot of [0, 1]) {
        const side = foot === 0 ? 1 : -1;
        let best = -9, arg = -1;
        for (let i = 0; i <= 1000; i++) {
          const t = i / 1000;
          const x = ankle(pose(anim, t, foot), side)[0]!;
          if (x > best) { best = x; arg = t; }
        }
        expect(Math.abs(arg - cf), `${AnimId[anim]} foot ${foot}: max reach at ${arg}, contact ${cf}`).toBeLessThan(0.0015);
        expect(best, `${AnimId[anim]} reaches the ball ahead of the body`).toBeGreaterThan(0.25);
      }
    }
  });

  it('at contact the foot is at the ball: ahead, low for ground kicks, beside the support foot, on the kicking side', () => {
    for (const anim of [AnimId.PASS, AnimId.SHOT, AnimId.POWER_SHOT, AnimId.FINESSE]) {
      const cf = ACTION_CONTACT[anim]!;
      const p = pose(anim, cf, 0);
      const a = ankle(p, 1);
      expect(a[0], AnimId[anim]).toBeGreaterThan(0.25);
      expect(a[1], AnimId[anim]).toBeLessThan(0.25);
      expect(a[2], AnimId[anim]).toBeGreaterThan(0); // right foot kicks on the right of the body line
      const toe = [0, 0, 0];
      footPoint(p, 1, 1, toe, 0);
      expect(toe[1], `${AnimId[anim]} toe above the grass`).toBeGreaterThan(-0.005);
      // The support foot is planted on the grass beside / behind the ball.
      const s = [0, 0, 0];
      footPoint(p, -1, 1, s, 0);
      expect(s[1], AnimId[anim]).toBeLessThan(0.01);
      expect(s[0]!, AnimId[anim]).toBeLessThan(a[0]!);
    }
  });

  it('the support foot stays planted from the plant to the end of the clip (ankle < 1 cm, toe pivots < 5 cm through the strike)', () => {
    // The skeleton has no hip twist, so a root yaw (finesse) turns the planted boot about its ankle: the toe pivots.
    for (const anim of [AnimId.PASS, AnimId.SHOT, AnimId.POWER_SHOT, AnimId.FINESSE, AnimId.VOLLEY, AnimId.GK_KICK]) {
      const cf = ACTION_CONTACT[anim]!;
      const refA = [0, 0, 0], refT = [0, 0, 0];
      footPoint(pose(anim, cf, 0), -1, 0, refA, 0);
      footPoint(pose(anim, cf, 0), -1, 1, refT, 0);
      for (let t = cf - 0.15; t <= 1; t += 0.01) {
        const a = [0, 0, 0], o = [0, 0, 0];
        footPoint(pose(anim, t, 0), -1, 0, a, 0);
        footPoint(pose(anim, t, 0), -1, 1, o, 0);
        expect(Math.hypot(a[0]! - refA[0]!, a[1]! - refA[1]!, a[2]! - refA[2]!), `${AnimId[anim]} ankle t=${t.toFixed(2)}`).toBeLessThan(0.01);
        if (t <= cf + 0.2) expect(Math.hypot(o[0]! - refT[0]!, o[1]! - refT[1]!, o[2]! - refT[2]!), `${AnimId[anim]} toe t=${t.toFixed(2)}`).toBeLessThan(0.05);
      }
    }
  });

  it('left-foot clips are exact mirrors of right-foot ones', () => {
    for (const anim of [AnimId.PASS, AnimId.SHOT, AnimId.VOLLEY, AnimId.HEADER, AnimId.FIRST_TOUCH, AnimId.SKILL]) {
      for (const t of [0.2, 0.45, 0.7]) {
        const r = ankle(pose(anim, t, 0), 1), l = ankle(pose(anim, t, 1), -1);
        expect(l[0]).toBeCloseTo(r[0]!, 4);
        expect(l[1]).toBeCloseTo(r[1]!, 4);
        expect(l[2]).toBeCloseTo(-r[2]!, 4);
      }
    }
  });
});

describe('[GFX-10] clip specifics', () => {
  it('power shot: longer wind-up (later contact) and a bigger backswing than the normal shot', () => {
    expect(ACTION_CONTACT[AnimId.POWER_SHOT]!).toBeGreaterThan(ACTION_CONTACT[AnimId.SHOT]! + 0.1);
    const back = (anim: AnimId): number => {
      let m = 9;
      for (let i = 0; i <= 100; i++) m = Math.min(m, ankle(pose(anim, i / 100), 1)[0]!);
      return m;
    };
    expect(back(AnimId.POWER_SHOT)).toBeLessThan(back(AnimId.SHOT) - 0.05);
    expect(back(AnimId.SHOT)).toBeLessThan(back(AnimId.PASS) - 0.05);
  });

  it('finesse: open body (hips and shoulders turned) and the foot sweeps across the ball (outside-in)', () => {
    const cf = ACTION_CONTACT[AnimId.FINESSE]!;
    const c = pose(AnimId.FINESSE, cf);
    expect(Math.abs(c[P.ROOT_YAW]!)).toBeGreaterThan(0.15);
    const before = ankle(pose(AnimId.FINESSE, cf - 0.15), 1), after = ankle(pose(AnimId.FINESSE, cf + 0.18), 1);
    expect(before[2]!).toBeGreaterThan(after[2]! + 0.2);
  });

  it('header: crouch, jump with the head back, neck snaps forward through the ball at contact while airborne', () => {
    const cf = ACTION_CONTACT[AnimId.HEADER]!;
    const sk = createSkeleton();
    const c = pose(AnimId.HEADER, cf);
    solvePoseFK(c, sk);
    expect(lowestPoint(sk)).toBeGreaterThan(0.15); // airborne at contact
    expect(c[P.ROOT_Y]).toBeGreaterThan(0.25);
    expect(pose(AnimId.HEADER, cf - 0.12)[P.HEAD_PITCH]).toBeLessThan(-0.2); // head back
    expect(c[P.HEAD_PITCH]).toBeGreaterThan(0.25); // snapped forward
    expect(pose(AnimId.HEADER, 0.22)[P.ROOT_Y]).toBeLessThan(-0.1); // load
  });

  it('volley: side-on (body rolled away), the foot meets the ball about knee-hip height out to the side', () => {
    const cf = ACTION_CONTACT[AnimId.VOLLEY]!;
    const c = pose(AnimId.VOLLEY, cf);
    expect(c[P.ROOT_ROLL]).toBeLessThan(-0.3);
    const a = ankle(c, 1);
    expect(a[1]).toBeGreaterThan(0.4);
    expect(a[2]).toBeGreaterThan(0.25);
  });

  it('first touch: the foot reaches for the ball, then withdraws to cushion it at the touch', () => {
    const reach = ankle(pose(AnimId.FIRST_TOUCH, 0.2), 1), touch = ankle(pose(AnimId.FIRST_TOUCH, 0.4), 1);
    expect(reach[0]!).toBeGreaterThan(touch[0]! + 0.05);
    expect(touch[1]).toBeLessThan(0.2);
  });

  it('throw-in: two-handed overhead hold at t = 0, ball behind the head at the wind-up, arms forward after release', () => {
    const head = (p: Pose): number => {
      const sk = createSkeleton();
      solvePoseFK(p, sk);
      return sk[Joint.HEAD * FRAME_SIZE + 10]!;
    };
    const hand = (p: Pose, side: number): number[] => { const o = [0, 0, 0]; handPoint(p, side, o, 0); return o; };
    const hold = pose(AnimId.THROW_IN, 0);
    for (const side of [-1, 1]) expect(hand(hold, side)[1]!).toBeGreaterThan(head(hold) + 0.1);
    const wind = pose(AnimId.THROW_IN, ACTION_HOLD[AnimId.THROW_IN]!);
    expect(hand(wind, 1)[0]!).toBeLessThan(0.05); // behind / over the head
    const after = pose(AnimId.THROW_IN, 0.65);
    expect(hand(after, 1)[0]!).toBeGreaterThan(0.3);
    // Hands stay together (two-handed) through the throw.
    for (const t of [0, 0.3, 0.45]) {
      const p = pose(AnimId.THROW_IN, t);
      expect(Math.abs(hand(p, 1)[1]! - hand(p, -1)[1]!)).toBeLessThan(0.02);
    }
  });

  it('keeper distribution: overarm throw (foot 0) differs from the crouched underarm roll (foot 1); drop kick strikes', () => {
    const over = pose(AnimId.GK_THROW, 0.45, 0), roll = pose(AnimId.GK_THROW, 0.45, 1);
    expect(over[P.SHOULDER_R_PITCH]).toBeGreaterThan(2);
    expect(roll[P.ROOT_Y]).toBeLessThan(over[P.ROOT_Y]! - 0.15);
    const hand = [0, 0, 0];
    handPoint(roll, 1, hand, 0);
    expect(hand[1]).toBeLessThan(0.5); // ball released near the grass
    const kick = ankle(pose(AnimId.GK_KICK, ACTION_CONTACT[AnimId.GK_KICK]!), 1);
    expect(kick[0]).toBeGreaterThan(0.35);
    expect(kick[1]).toBeGreaterThan(0.2); // half volley off the drop
  });

  it('shield is the locomotion shield (arm out on its side)', () => {
    const p = createPose();
    ACTION_POSES[AnimId.SHIELD]!(p, 0, 0, 0, -1, 0);
    expect(p[P.SHOULDER_L_ROLL]).toBeGreaterThan(0.9);
  });

  it('no action clip digs into the grass (FK lowest point >= -2.5 cm; the model lifts that much at most)', () => {
    const sk = createSkeleton();
    for (const anim of ALL) {
      for (const foot of [0, 1]) {
        for (let i = 0; i <= 100; i++) {
          solvePoseFK(pose(anim, i / 100, foot), sk);
          expect(lowestPoint(sk), `${AnimId[anim]} foot ${foot} t=${i / 100}`).toBeGreaterThan(-0.025);
        }
      }
    }
  });
});
