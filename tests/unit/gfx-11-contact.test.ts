/**
 * [GFX-11] Tackles, falls, keeper, celebrations (src/render/anim/contact.ts): poses finite and within joint limits,
 * dives extend the hands toward the dive side and height (left mirrors right; low < mid < high), the slide keeps the
 * body near the grass, fall ends where get-up starts, catch gathers the hands to the chest, parry pushes the palms
 * up and out, three distinct celebrations, dejection hands on head, wall jump airborne, the sim's dive class / side
 * and celebration variant map to the right clips, and no clip digs into the grass.
 */
import { describe, expect, it } from 'vitest';
import { AnimId, createPose, POSE_SIZE, PoseIdx, type Pose } from '../../src/contracts/render';
import { celebrationAnim, CONTACT_CLIPS, CONTACT_CONTACT, CONTACT_POSES, diveAnim } from '../../src/render/anim/contact';
import { keeperReadyPose } from '../../src/render/anim/locomotion';
import { POSE_MAX, POSE_MIN } from '../../src/render/anim/poseMath';
import { createSkeleton, FRAME_SIZE, groundSkeleton, handPoint, Joint, lowestPoint, solvePoseFK } from '../../src/render/players/fk';

const P = PoseIdx;
const ALL = Object.keys(CONTACT_POSES).map(Number) as AnimId[];
const DIVES_R = [AnimId.DIVE_LOW_R, AnimId.DIVE_MID_R, AnimId.DIVE_HIGH_R];
const DIVES_L = [AnimId.DIVE_LOW_L, AnimId.DIVE_MID_L, AnimId.DIVE_HIGH_L];

function pose(anim: AnimId, t: number): Pose {
  const out = createPose();
  CONTACT_POSES[anim]!(out, t, 0, 0, 1, 0);
  return out;
}

/** Skeleton after the model's ground correction (what is drawn, model space). */
function drawn(p: Pose): Float64Array {
  const sk = createSkeleton();
  solvePoseFK(p, sk);
  groundSkeleton(sk, p);
  return sk;
}

function jointY(sk: Float64Array, j: number): number {
  return sk[j * FRAME_SIZE + 10]!;
}

function hand(p: Pose, side: number): number[] {
  const o = [0, 0, 0];
  handPoint(p, side, o);
  return o;
}

describe('[GFX-11] poses finite and within joint limits', () => {
  it('every contact clip over the whole phase', () => {
    for (const anim of ALL) {
      for (let i = 0; i <= 100; i++) {
        const p = pose(anim, i / 100);
        for (let k = 0; k < POSE_SIZE; k++) {
          const v = p[k]!;
          expect(Number.isFinite(v), `${AnimId[anim]} t=${i / 100} ch ${k}`).toBe(true);
          expect(v, `${AnimId[anim]} t=${i / 100} ch ${k}`).toBeGreaterThanOrEqual(POSE_MIN[k]! - 1e-4);
          expect(v, `${AnimId[anim]} t=${i / 100} ch ${k}`).toBeLessThanOrEqual(POSE_MAX[k]! + 1e-4);
        }
      }
    }
  });

  it('no clip digs into the grass (FK lowest point >= -3.5 cm; the model lifts that much at most)', () => {
    const sk = createSkeleton();
    for (const anim of ALL) {
      for (let i = 0; i <= 100; i++) {
        solvePoseFK(pose(anim, i / 100), sk);
        expect(lowestPoint(sk), `${AnimId[anim]} t=${i / 100}`).toBeGreaterThan(-0.035);
      }
    }
  });
});

describe('[GFX-11] keeper dives', () => {
  it('maps the sim dive height class (actA 0/1/2) and side (actB -1/+1) to the matching clip', () => {
    expect(diveAnim(0, -1)).toBe(AnimId.DIVE_LOW_L);
    expect(diveAnim(0, 1)).toBe(AnimId.DIVE_LOW_R);
    expect(diveAnim(1, -1)).toBe(AnimId.DIVE_MID_L);
    expect(diveAnim(1, 1)).toBe(AnimId.DIVE_MID_R);
    expect(diveAnim(2, -1)).toBe(AnimId.DIVE_HIGH_L);
    expect(diveAnim(2, 1)).toBe(AnimId.DIVE_HIGH_R);
    expect(diveAnim(7, 0)).toBe(AnimId.DIVE_HIGH_R);
  });

  it('at full stretch (contact fraction) both hands reach toward the dive side', () => {
    for (let k = 0; k < 3; k++) {
      const cf = CONTACT_CONTACT[DIVES_R[k]!]!;
      expect(cf).toBeGreaterThan(0.2);
      expect(cf).toBeLessThan(0.5);
      const r = pose(DIVES_R[k]!, cf), l = pose(DIVES_L[k]!, cf);
      for (const side of [-1, 1]) {
        expect(hand(r, side)[2], `${AnimId[DIVES_R[k]!]} hand ${side}`).toBeGreaterThan(0.8);
        expect(hand(l, side)[2], `${AnimId[DIVES_L[k]!]} hand ${side}`).toBeLessThan(-0.8);
      }
      expect(r[P.ROOT_ROLL]).toBeGreaterThan(0.9); // body rolled toward the dive
      expect(l[P.ROOT_ROLL]).toBeLessThan(-0.9);
    }
  });

  it('hands go to the dive height: low near the grass, mid about chest-head height, high above the bar line', () => {
    const avgY = (anim: AnimId): number => {
      const p = pose(anim, CONTACT_CONTACT[anim]!);
      return (hand(p, -1)[1]! + hand(p, 1)[1]!) / 2;
    };
    expect(avgY(AnimId.DIVE_LOW_R)).toBeLessThan(0.65);
    expect(avgY(AnimId.DIVE_MID_R)).toBeGreaterThan(avgY(AnimId.DIVE_LOW_R) + 0.4);
    expect(avgY(AnimId.DIVE_HIGH_R)).toBeGreaterThan(avgY(AnimId.DIVE_MID_R) + 0.4);
    expect(avgY(AnimId.DIVE_HIGH_R)).toBeGreaterThan(1.6);
  });

  it('left dives mirror right dives; the dive ends back in the ready stance after landing on the side', () => {
    for (let k = 0; k < 3; k++) {
      for (const t of [0.2, 0.35, 0.6, 0.9]) {
        const r = pose(DIVES_R[k]!, t), l = pose(DIVES_L[k]!, t);
        expect(l[P.ROOT_ROLL]).toBeCloseTo(-r[P.ROOT_ROLL]!, 5);
        expect(l[P.SHOULDER_L_PITCH]).toBeCloseTo(r[P.SHOULDER_R_PITCH]!, 5);
      }
      const lying = drawn(pose(DIVES_R[k]!, 0.62));
      expect(jointY(lying, Joint.ROOT), 'lands low on the side').toBeLessThan(0.4);
      const end = pose(DIVES_R[k]!, 1);
      expect(Math.abs(end[P.ROOT_ROLL]!)).toBeLessThan(1e-4);
      expect(end[P.ROOT_Y]).toBeLessThan(-0.1); // crouched ready stance
    }
  });

  it('keeper ready (from the contact table) is the locomotion stance', () => {
    expect(CONTACT_POSES[AnimId.KEEPER_READY]).toBe(keeperReadyPose);
  });
});

describe('[GFX-11] tackles, falls, get-up', () => {
  it('standing tackle lunges: the tackling foot is furthest forward at the contact fraction', () => {
    const cf = CONTACT_CONTACT[AnimId.STAND_TACKLE]!;
    let best = -9, arg = -1;
    for (let i = 0; i <= 200; i++) {
      const sk = createSkeleton();
      solvePoseFK(pose(AnimId.STAND_TACKLE, i / 200), sk);
      const x = sk[Joint.ANKLE_R * FRAME_SIZE + 9]!;
      if (x > best) { best = x; arg = i / 200; }
    }
    expect(Math.abs(arg - cf)).toBeLessThan(0.01);
    expect(best).toBeGreaterThan(0.6);
  });

  it('slide: the leading leg is out at contact, the body stays near the ground through the slide', () => {
    const cf = CONTACT_CONTACT[AnimId.SLIDE]!;
    const atContact = createSkeleton();
    solvePoseFK(pose(AnimId.SLIDE, cf), atContact);
    expect(atContact[Joint.ANKLE_R * FRAME_SIZE + 9]!).toBeGreaterThan(0.6); // the tackling leg reaches out on contact
    for (let t = 0.2; t <= 0.45; t += 0.01) {
      const sk = drawn(pose(AnimId.SLIDE, t));
      expect(jointY(sk, Joint.ROOT), `pelvis at t=${t.toFixed(2)}`).toBeLessThan(0.35);
      expect(jointY(sk, Joint.ANKLE_R), `leading ankle at t=${t.toFixed(2)}`).toBeLessThan(0.25);
      expect(sk[Joint.ANKLE_R * FRAME_SIZE + 9]!, 'leg out in front').toBeGreaterThan(0.6);
    }
    const up = drawn(pose(AnimId.SLIDE, 1));
    expect(jointY(up, Joint.ROOT)).toBeGreaterThan(0.85); // back on his feet
  });

  it('fall ends lying on the back, exactly where get-up starts; get-up ends standing', () => {
    const fallEnd = pose(AnimId.FALL, 1), getUp0 = pose(AnimId.GET_UP, 0);
    for (let k = 0; k < POSE_SIZE; k++) expect(fallEnd[k], `ch ${k}`).toBeCloseTo(getUp0[k]!, 3);
    expect(jointY(drawn(fallEnd), Joint.ROOT)).toBeLessThan(0.3);
    expect(fallEnd[P.ROOT_PITCH]).toBeLessThan(-1.2);
    expect(jointY(drawn(pose(AnimId.GET_UP, 1)), Joint.ROOT)).toBeGreaterThan(0.85);
    // Mid get-up the player is sitting / crouching, between lying and standing.
    const mid = jointY(drawn(pose(AnimId.GET_UP, 0.65)), Joint.ROOT);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.75);
  });

  it('stumble pitches the upper body forward with the arms thrown out, then recovers', () => {
    const s = pose(AnimId.STUMBLE, 0.25);
    expect(s[P.SPINE_PITCH]! + s[P.ROOT_PITCH]!).toBeGreaterThan(0.4);
    expect(s[P.SHOULDER_L_ROLL]).toBeGreaterThan(0.6);
    expect(Math.abs(pose(AnimId.STUMBLE, 1)[P.ROOT_PITCH]!)).toBeLessThan(1e-4);
  });
});

describe('[GFX-11] catch, parry, hold, wall', () => {
  it('catch: hands meet the ball up in front, then gather into the chest', () => {
    const reach = pose(AnimId.CATCH, 0.5), gathered = pose(AnimId.CATCH, 0.85);
    const rh = hand(reach, 1), gh = hand(gathered, 1);
    expect(rh[0]!).toBeGreaterThan(gh[0]! + 0.1);
    expect(gh[1]).toBeGreaterThan(0.9);
    expect(gh[1]).toBeLessThan(1.45);
    expect(Math.abs(gh[2]!)).toBeLessThan(0.3);
  });

  it('parry: springs up with both palms pushed up and out at the contact fraction', () => {
    const cf = CONTACT_CONTACT[AnimId.PARRY]!;
    const p = pose(AnimId.PARRY, cf);
    const sk = drawn(p);
    expect(jointY(sk, Joint.HEAD)).toBeLessThan(hand(p, 1)[1]!);
    expect(hand(p, -1)[1]).toBeGreaterThan(2.0);
    expect(p[P.ROOT_Y]).toBeGreaterThan(0.15);
  });

  it('keeper hold keeps the ball at the chest (hands together in front) and loops smoothly', () => {
    const a = pose(AnimId.KEEPER_HOLD, 0), b = pose(AnimId.KEEPER_HOLD, 1);
    for (let k = 0; k < POSE_SIZE; k++) expect(a[k]).toBeCloseTo(b[k]!, 4);
    const h = hand(pose(AnimId.KEEPER_HOLD, 0.4), 1);
    expect(h[0]).toBeGreaterThan(0.1);
    expect(h[1]).toBeGreaterThan(0.9);
    expect(CONTACT_CLIPS[AnimId.KEEPER_HOLD]!.repeat).toBeGreaterThan(1);
  });

  it('wall: braced at t = 0 (hands low in front), airborne after the take-off contact fraction', () => {
    const cf = CONTACT_CONTACT[AnimId.WALL_JUMP]!;
    const brace = pose(AnimId.WALL_JUMP, 0);
    expect(brace[P.SHOULDER_L_ROLL]).toBeLessThan(0);
    const sk = createSkeleton();
    solvePoseFK(pose(AnimId.WALL_JUMP, cf + 0.2), sk);
    expect(lowestPoint(sk)).toBeGreaterThan(0.2);
  });
});

describe('[GFX-11] celebrations and dejection', () => {
  it('maps the sim celebration variant (actA 0..2) to the three clips', () => {
    expect(celebrationAnim(0)).toBe(AnimId.CELEBRATE_1);
    expect(celebrationAnim(1)).toBe(AnimId.CELEBRATE_2);
    expect(celebrationAnim(2)).toBe(AnimId.CELEBRATE_3);
    expect(celebrationAnim(9)).toBe(AnimId.CELEBRATE_1);
  });

  it('three distinct celebrations: knee slide (kneeling, arms up), aeroplane (arms out level), jump and fist pump', () => {
    const knee = pose(AnimId.CELEBRATE_1, 0.4);
    const kneeSk = drawn(knee);
    expect(jointY(kneeSk, Joint.KNEE_L)).toBeLessThan(0.15);
    expect(jointY(kneeSk, Joint.KNEE_R)).toBeLessThan(0.15);
    expect(hand(knee, 1)[1]!).toBeGreaterThan(jointY(kneeSk, Joint.HEAD));

    const plane = pose(AnimId.CELEBRATE_2, 0.1);
    const ps = drawn(plane);
    const sh = jointY(ps, Joint.SHOULDER_R);
    expect(Math.abs(hand(plane, 1)[1]! - sh)).toBeLessThan(0.2); // arms out level with the shoulders
    expect(Math.abs(hand(plane, 1)[2]!)).toBeGreaterThan(0.7);
    expect(Math.abs(pose(AnimId.CELEBRATE_2, 0.125)[P.SPINE_ROLL]!)).toBeGreaterThan(0.2); // banks side to side

    // Jump: airborne at the top of each of the three hops, right fist punched up.
    const sk = createSkeleton();
    for (const t of [0.55 / 3, (1 + 0.55) / 3, (2 + 0.55) / 3]) {
      const p = pose(AnimId.CELEBRATE_3, t);
      solvePoseFK(p, sk);
      expect(lowestPoint(sk), `t=${t}`).toBeGreaterThan(0.15);
      expect(hand(p, 1)[1]!).toBeGreaterThan(2.0);
    }

    // Pairwise clearly different poses.
    const mids = [knee, plane, pose(AnimId.CELEBRATE_3, 0.55 / 3)];
    for (let a = 0; a < 3; a++) {
      for (let b = a + 1; b < 3; b++) {
        let d = 0;
        for (let k = 0; k < POSE_SIZE; k++) d += Math.abs(mids[a]![k]! - mids[b]![k]!);
        expect(d, `celebrations ${a} vs ${b}`).toBeGreaterThan(3);
      }
    }
  });

  it('dejection: hands on the head, head down, then crouched with hands on the knees', () => {
    const p = pose(AnimId.DEJECTION, 0.3);
    const sk = drawn(p);
    const headY = jointY(sk, Joint.HEAD);
    for (const side of [-1, 1]) {
      const h = hand(p, side);
      expect(Math.abs(h[1]! - (headY + 0.15)), `hand ${side} on the head`).toBeLessThan(0.2);
    }
    expect(p[P.HEAD_PITCH]).toBeGreaterThan(0.3);
    const late = pose(AnimId.DEJECTION, 0.9);
    expect(late[P.SPINE_PITCH]).toBeGreaterThan(0.6);
    expect(late[P.ROOT_Y]).toBeLessThan(-0.15);
  });
});
