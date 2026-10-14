/**
 * [GFX-07] Forward kinematics of the player model (src/render/players/fk.ts): zero pose stands upright, every pose
 * channel moves the body the way contracts/render.ts says (pitch + swings forward, knee + bends backward, roll +
 * away from the body / toward the right, yaw + turns left...), frames stay rigid, ground handling (never sinks,
 * small floats of grounded poses planted, jumps stay airborne) and world placement (facing, height scale).
 */
import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { createPose, POSE_SIZE, PoseIdx, type Pose } from '../../src/contracts/render';
import {
  BODY, createSkeleton, FRAME_SIZE, framePoint, footPoint, groundLift, handPoint, Joint, JOINT_COUNT, liftSkeleton,
  lowestPoint, placeSkeletonAt, solvePoseFK, writeHiddenMatrix, writeJointMatrix,
} from '../../src/render/players/fk';

const P = PoseIdx;

function solve(pose: Pose): Float64Array {
  const sk = createSkeleton();
  solvePoseFK(pose, sk);
  return sk;
}

/** Point in joint j's local space -> model space. */
function pt(sk: Float64Array, j: number, x = 0, y = 0, z = 0): [number, number, number] {
  const o = [0, 0, 0];
  framePoint(sk, j, x, y, z, o);
  return [o[0]!, o[1]!, o[2]!];
}

const toe = (sk: Float64Array, j: number): [number, number, number] => pt(sk, j, BODY.toeX, -BODY.ankleY, 0);
const hand = (sk: Float64Array, j: number): [number, number, number] => pt(sk, j, 0, -(BODY.foreArm + BODY.hand), 0);
const crown = (sk: Float64Array): [number, number, number] => pt(sk, Joint.HEAD, 0, BODY.headY + BODY.headRY, 0);
const nose = (sk: Float64Array): [number, number, number] => pt(sk, Joint.HEAD, BODY.headRX, BODY.headY, 0);

function poseWith(fields: Partial<Record<keyof typeof PoseIdx, number>>): Pose {
  const p = createPose();
  for (const k of Object.keys(fields) as (keyof typeof PoseIdx)[]) p[P[k]] = fields[k]!;
  return p;
}

describe('GFX-07 FK: the zero pose stands upright', () => {
  it('soles on the grass, crown at 1.80 m, joints on their reference heights, symmetric', () => {
    const sk = solve(createPose());
    expect(toe(sk, Joint.ANKLE_L)[1]).toBeCloseTo(0, 9);
    expect(toe(sk, Joint.ANKLE_R)[1]).toBeCloseTo(0, 9);
    expect(pt(sk, Joint.ANKLE_L, BODY.heelX, -BODY.ankleY, 0)[1]).toBeCloseTo(0, 9);
    expect(crown(sk)[1]).toBeCloseTo(BODY.height, 9);
    expect(pt(sk, Joint.ROOT)).toEqual([0, BODY.pelvisY, 0]);
    expect(pt(sk, Joint.KNEE_L)[1]).toBeCloseTo(BODY.pelvisY - BODY.thigh, 9);
    expect(pt(sk, Joint.ANKLE_R)[1]).toBeCloseTo(BODY.ankleY, 9);
    expect(pt(sk, Joint.SHOULDER_L)[2]).toBeCloseTo(-BODY.shoulderZ, 9); // left is -z
    expect(pt(sk, Joint.SHOULDER_R)[2]).toBeCloseTo(BODY.shoulderZ, 9);
    // Upright: head straight above the pelvis, toes point forward (+x), hands hang beside the hips just clear.
    expect(crown(sk)[0]).toBeCloseTo(0, 9);
    expect(crown(sk)[2]).toBeCloseTo(0, 9);
    expect(toe(sk, Joint.ANKLE_L)[0]).toBeCloseTo(BODY.toeX, 9);
    const hl = hand(sk, Joint.ELBOW_L), hr = hand(sk, Joint.ELBOW_R);
    expect(hl[1]).toBeGreaterThan(0.7);
    expect(hl[1]).toBeLessThan(0.9);
    expect(hl[2]).toBeLessThan(-0.25);
    expect(hr[2]).toBeCloseTo(-hl[2], 9);
    expect(hl[0]).toBeCloseTo(0, 9);
    expect(lowestPoint(sk)).toBeCloseTo(0, 9);
    expect(groundLift(sk, createPose(), 0.06)).toBe(0);
  });

  it('every frame is a rotation (orthonormal, right-handed) for any pose', () => {
    let seed = 7;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let n = 0; n < 50; n++) {
      const pose = createPose();
      for (let k = 0; k < POSE_SIZE; k++) pose[k] = (rnd() - 0.5) * 3;
      const sk = solve(pose);
      for (let j = 0; j < JOINT_COUNT; j++) {
        const o = j * FRAME_SIZE;
        const c = [0, 1, 2].map((i) => new Vector3(sk[o + i * 3]!, sk[o + i * 3 + 1]!, sk[o + i * 3 + 2]!));
        for (let i = 0; i < 3; i++) {
          expect(c[i]!.length()).toBeCloseTo(1, 9);
          for (let k = i + 1; k < 3; k++) expect(c[i]!.dot(c[k]!)).toBeCloseTo(0, 9);
        }
        expect(new Vector3().crossVectors(c[0]!, c[1]!).dot(c[2]!)).toBeCloseTo(1, 9);
      }
      // Bone lengths never change.
      const len = (a: number, b: number): number => new Vector3(...pt(sk, a)).distanceTo(new Vector3(...pt(sk, b)));
      expect(len(Joint.HIP_L, Joint.KNEE_L)).toBeCloseTo(BODY.thigh, 9);
      expect(len(Joint.KNEE_R, Joint.ANKLE_R)).toBeCloseTo(BODY.shin, 9);
      expect(len(Joint.SHOULDER_L, Joint.ELBOW_L)).toBeCloseTo(BODY.upperArm, 9);
    }
  });

  it('non-finite pose values read as 0 (a NaN never reaches the GPU)', () => {
    const pose = createPose();
    pose[P.HIP_L_PITCH] = Number.NaN;
    pose[P.ROOT_Y] = Number.POSITIVE_INFINITY;
    pose[P.KNEE_R] = -1e9;
    const sk = solve(pose);
    const ref = solve(createPose());
    for (let k = 0; k < sk.length; k++) expect(sk[k]).toBeCloseTo(ref[k]!, 12);
  });
});

describe('GFX-07 FK: pose channels move the body as contracts/render.ts says', () => {
  it('hip pitch + swings the leg forward, - backward; hip roll + abducts (away from the body)', () => {
    const fwd = solve(poseWith({ HIP_L_PITCH: 0.6 }));
    expect(pt(fwd, Joint.ANKLE_L)[0]).toBeGreaterThan(0.4);
    expect(pt(fwd, Joint.ANKLE_R)[0]).toBeCloseTo(0, 9); // the other leg stays
    const back = solve(poseWith({ HIP_R_PITCH: -0.5 }));
    expect(pt(back, Joint.ANKLE_R)[0]).toBeLessThan(-0.3);
    const abL = solve(poseWith({ HIP_L_ROLL: 0.4 }));
    expect(pt(abL, Joint.ANKLE_L)[2]).toBeLessThan(-BODY.hipZ - 0.2);
    const abR = solve(poseWith({ HIP_R_ROLL: 0.4 }));
    expect(pt(abR, Joint.ANKLE_R)[2]).toBeGreaterThan(BODY.hipZ + 0.2);
  });

  it('knee + bends the shin backward; ankle + lifts the toes, - points them', () => {
    const k = solve(poseWith({ KNEE_L: 1.2 }));
    expect(pt(k, Joint.ANKLE_L)[0]).toBeLessThan(-0.3);
    expect(pt(k, Joint.KNEE_L)[0]).toBeCloseTo(0, 9);
    const up = solve(poseWith({ ANKLE_R: 0.4 }));
    expect(toe(up, Joint.ANKLE_R)[1]).toBeGreaterThan(toe(solve(createPose()), Joint.ANKLE_R)[1] + 0.05);
    const point = solve(poseWith({ ANKLE_R: -0.6 }));
    expect(toe(point, Joint.ANKLE_R)[1]).toBeLessThan(0);
  });

  it('a kick: hip forward + straight knee puts the toe well in front, knee bent back on the backswing', () => {
    const back = solve(poseWith({ HIP_R_PITCH: -0.5, KNEE_R: 1.4 }));
    const strike = solve(poseWith({ HIP_R_PITCH: 0.9, KNEE_R: 0.1, ANKLE_R: -0.4 }));
    expect(toe(back, Joint.ANKLE_R)[0]).toBeLessThan(-0.4);
    expect(toe(strike, Joint.ANKLE_R)[0]).toBeGreaterThan(0.7);
  });

  it('shoulder pitch + swings the arm forward (up to overhead at pi); roll + raises it sideways; elbow + flexes forward', () => {
    const f = solve(poseWith({ SHOULDER_L_PITCH: Math.PI / 2 }));
    const h = hand(f, Joint.ELBOW_L);
    expect(h[0]).toBeGreaterThan(0.5);
    expect(h[1]).toBeCloseTo(BODY.pelvisY + BODY.spineY + BODY.shoulderY, 1);
    const over = solve(poseWith({ SHOULDER_L_PITCH: Math.PI, SHOULDER_R_PITCH: Math.PI }));
    expect(hand(over, Joint.ELBOW_L)[1]).toBeGreaterThan(1.9);
    expect(hand(over, Joint.ELBOW_R)[1]).toBeGreaterThan(1.9);
    const outL = solve(poseWith({ SHOULDER_L_ROLL: Math.PI / 2 }));
    expect(hand(outL, Joint.ELBOW_L)[2]).toBeLessThan(-0.75);
    const outR = solve(poseWith({ SHOULDER_R_ROLL: Math.PI / 2 }));
    expect(hand(outR, Joint.ELBOW_R)[2]).toBeGreaterThan(0.75);
    const el = solve(poseWith({ ELBOW_R: 1.5 }));
    expect(hand(el, Joint.ELBOW_R)[0]).toBeGreaterThan(0.3);
  });

  it('root pitch + leans forward, roll + toward the right, yaw + turns left, ROOT_Y raises, FWD / SIDE offset', () => {
    expect(crown(solve(poseWith({ ROOT_PITCH: 0.3 })))[0]).toBeGreaterThan(0.2);
    expect(crown(solve(poseWith({ ROOT_PITCH: -0.3 })))[0]).toBeLessThan(-0.2);
    expect(crown(solve(poseWith({ ROOT_ROLL: 0.3 })))[2]).toBeGreaterThan(0.2);
    const yaw = solve(poseWith({ ROOT_YAW: Math.PI / 2 }));
    expect(nose(yaw)[2]).toBeLessThan(-0.1); // facing -z = his left
    expect(toe(yaw, Joint.ANKLE_L)[2]).toBeLessThan(-0.15);
    expect(pt(solve(poseWith({ ROOT_Y: 0.3 })), Joint.ROOT)[1]).toBeCloseTo(BODY.pelvisY + 0.3, 6); // Pose is Float32
    const off = solve(poseWith({ ROOT_FWD: 0.5, ROOT_SIDE: -0.25 }));
    expect(pt(off, Joint.ROOT)[0]).toBeCloseTo(0.5, 6);
    expect(pt(off, Joint.ROOT)[2]).toBeCloseTo(-0.25, 6);
  });

  it('spine pitch bends the upper body only; head pitch + nods forward / down; head yaw + looks left', () => {
    const sp = solve(poseWith({ SPINE_PITCH: 0.5 }));
    expect(crown(sp)[0]).toBeGreaterThan(0.3);
    expect(toe(sp, Joint.ANKLE_L)).toEqual(toe(solve(createPose()), Joint.ANKLE_L));
    const nod = solve(poseWith({ HEAD_PITCH: 0.6 }));
    const n0 = nose(solve(createPose())), n1 = nose(nod);
    expect(n1[1]).toBeLessThan(n0[1] - 0.04);
    expect(pt(nod, Joint.HEAD)).toEqual(pt(solve(createPose()), Joint.HEAD)); // pivot at the neck base
    expect(nose(solve(poseWith({ HEAD_YAW: 0.8 })))[2]).toBeLessThan(-0.05);
    expect(crown(solve(poseWith({ SPINE_ROLL: 0.4 })))[2]).toBeGreaterThan(0.1);
    expect(nose(solve(poseWith({ SPINE_YAW: 0.8 })))[2]).toBeLessThan(-0.05);
  });

  it('footPoint / handPoint helpers (for GFX-09..11 tests) match the frames', () => {
    const pose = poseWith({ HIP_R_PITCH: 0.5, KNEE_R: 0.3, SHOULDER_L_PITCH: 0.7 });
    const sk = solve(pose);
    const out = [0, 0, 0];
    footPoint(pose, 1, 1, out);
    expect(out[0]).toBeCloseTo(toe(sk, Joint.ANKLE_R)[0], 9);
    footPoint(pose, -1, 0, out);
    expect(out[1]).toBeCloseTo(BODY.ankleY, 9);
    handPoint(pose, -1, out);
    expect(out[0]).toBeCloseTo(hand(sk, Joint.ELBOW_L)[0], 9);
  });
});

describe('GFX-07 ground handling', () => {
  it('never sinks: a crouch deeper than the legs allow is lifted onto the grass', () => {
    const pose = poseWith({ ROOT_Y: -0.4 });
    const sk = solve(pose);
    expect(lowestPoint(sk)).toBeCloseTo(-0.4, 6);
    const lift = groundLift(sk, pose, 0.06);
    expect(lift).toBeCloseTo(0.4, 6);
    liftSkeleton(sk, lift);
    expect(lowestPoint(sk)).toBeCloseTo(0, 9);
  });

  it('a slide / fall lying on the ground: no body part below the grass', () => {
    const pose = poseWith({ ROOT_Y: -0.75, ROOT_PITCH: -1.4, HIP_L_PITCH: 1.3, HIP_R_PITCH: 1.1, KNEE_R: 0.8, SHOULDER_L_PITCH: -0.4 });
    const sk = solve(pose);
    liftSkeleton(sk, groundLift(sk, pose, 0.06));
    expect(lowestPoint(sk)).toBeGreaterThanOrEqual(-1e-9);
    expect(lowestPoint(sk)).toBeLessThan(1e-6);
  });

  it('plants small floats of a grounded pose (bent knees, ROOT_Y 0) but keeps a jump airborne', () => {
    // Hips forward, knees back twice as far, ankles flat: the shins tilt back, the soles stay level, the legs get
    // shorter, so with ROOT_Y 0 the feet float a few cm.
    const crouch = poseWith({ KNEE_L: 0.6, KNEE_R: 0.6, HIP_L_PITCH: 0.3, HIP_R_PITCH: 0.3, ANKLE_L: 0.3, ANKLE_R: 0.3 });
    const sk = solve(crouch);
    const low = lowestPoint(sk);
    expect(low).toBeGreaterThan(0.01);
    expect(low).toBeLessThan(0.06);
    expect(groundLift(sk, crouch, 0.06)).toBeCloseTo(-low, 9);
    const jump = poseWith({ ROOT_Y: 0.35, KNEE_L: 0.4, KNEE_R: 0.4 });
    const sj = solve(jump);
    expect(groundLift(sj, jump, 0.06)).toBe(0);
    // A deliberate tuck far off the ground (more than snapMax) is left alone even with ROOT_Y 0.
    const tuck = poseWith({ KNEE_L: 2.2, KNEE_R: 2.2, HIP_L_PITCH: 1.2, HIP_R_PITCH: 1.2 });
    const st = solve(tuck);
    expect(lowestPoint(st)).toBeGreaterThan(0.06);
    expect(groundLift(st, tuck, 0.06)).toBe(0);
  });
});

describe('GFX-07 world placement', () => {
  it('turns model +x to the facing, the right hand to (-fz, fx), scales by height, sits on (x, z)', () => {
    const model = solve(createPose());
    const w = createSkeleton();
    placeSkeletonAt(model, w, 10, -5, 0, 1, 1.1); // facing +z
    const tw = toe(w, Joint.ANKLE_R);
    const tm = toe(model, Joint.ANKLE_R);
    // Model toe (0.2, 0, 0.095): forward 0.2 -> +z, right 0.095 -> -x.
    expect(tw[0]).toBeCloseTo(10 - tm[2] * 1.1, 9);
    expect(tw[2]).toBeCloseTo(-5 + tm[0] * 1.1, 9);
    expect(tw[1]).toBeCloseTo(0, 9);
    expect(crown(w)[1]).toBeCloseTo(BODY.height * 1.1, 9);
    // Degenerate facing reads as +x.
    placeSkeletonAt(model, w, 0, 0, 0, 0, 1);
    expect(toe(w, Joint.ANKLE_L)[0]).toBeCloseTo(BODY.toeX, 9);
  });

  it('writeJointMatrix gives the same point as framePoint; hidden matrices collapse to the origin', () => {
    const pose = poseWith({ HIP_L_PITCH: 0.4, ROOT_YAW: 0.3, SPINE_ROLL: 0.2 });
    const model = solve(pose);
    const w = createSkeleton();
    placeSkeletonAt(model, w, 3, 4, 0.6, -0.8, 0.95);
    const arr = new Float32Array(16 * 2);
    writeJointMatrix(w, Joint.ANKLE_L, arr, 1);
    const m = new Matrix4().fromArray(arr, 16);
    const v = new Vector3(BODY.toeX, -BODY.ankleY, 0).applyMatrix4(m);
    const ref = pt(w, Joint.ANKLE_L, BODY.toeX, -BODY.ankleY, 0);
    expect(v.x).toBeCloseTo(ref[0], 5); expect(v.y).toBeCloseTo(ref[1], 5); expect(v.z).toBeCloseTo(ref[2], 5);
    writeHiddenMatrix(arr, 1);
    expect(Array.from(arr.subarray(16)).every((x) => x === 0)).toBe(true);
  });
});
