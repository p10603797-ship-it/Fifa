/**
 * [GFX-10] Animation: kicks, headers, touches, throw-ins (section 8 animation set: pass, shot, power shot, finesse,
 * header, volley, first touch, shield, throw-in, keeper throw and kick, skill). The kicking foot meets the ball on
 * the sim contact tick: `t` is the normalised action phase and GFX-12 maps it piecewise so that t = the clip's
 * contact fraction (ACTION_CONTACT) falls exactly on p.actContact. `foot` 0 = right, 1 = left (the clip is mirrored).
 *
 * Clips are keyframed full poses (poseMath.createClip, monotone cubic per channel) with IK legs: the support foot is
 * planted with leg IK while the body leans and rolls over it, and the kicking foot follows ankle targets whose
 * forward-most key is the contact key, so with the monotone interpolation the foot reaches its maximum forward
 * extension exactly at the contact fraction (backswing -> strike -> contact -> folding follow-through -> recover).
 * Ball contact point in model space for foot kicks is about (0.35, 0.12, 0.1) for the right foot.
 *
 * ACTION_HOLD gives the backswing-top phase per kick clip: while the sim holds a charged kick past its wind-up
 * (p.actCharging) the mapper holds the clip there.
 *
 * GK_THROW: foot 0 = overarm throw, foot 1 = underarm roll (not mirrored). SHIELD is the locomotion clip
 * (locomotion.ts shieldPose: t = move direction, side = arm side).
 *
 * Allocation-free per call; clips are built once at module load.
 */

import { AnimId, type Pose, type PoseFn } from '../../contracts/render';
import type { PoseTable } from '../types';
import { shieldPose } from './locomotion';
import { ANKLE_Y, createClip, evalClip, groundFoot, mirrorPose, type Clip } from './poseMath';

const AY = ANKLE_Y;
type Ik = readonly [number, number, number, number];
const STAND_L: Ik = [0.0, AY, -0.12, 0];
const STAND_R: Ik = [0.0, AY, 0.12, 0];
/** Neutral standing upper body / pelvis every clip starts and ends near (the mapper cross-fades the rest). */
const NEUTRAL = {
  ROOT_Y: -0.03, ROOT_PITCH: 0, ROOT_ROLL: 0, ROOT_YAW: 0, ROOT_FWD: 0, ROOT_SIDE: 0,
  SPINE_PITCH: 0.05, SPINE_YAW: 0, SPINE_ROLL: 0, HEAD_PITCH: 0, HEAD_YAW: 0,
  SHOULDER_L_PITCH: 0, SHOULDER_L_ROLL: 0.12, ELBOW_L: 0.3, SHOULDER_R_PITCH: 0, SHOULDER_R_ROLL: 0.12, ELBOW_R: 0.3,
} as const;

// ============================================================ foot kicks (right foot; mirrored for the left)

const PASS = createClip([
  { t: 0, pose: NEUTRAL, ikL: STAND_L, ikR: STAND_R },
  { t: 0.12, pose: { ROOT_Y: -0.06, SPINE_PITCH: 0.12, ROOT_ROLL: -0.04 }, ikL: [0.04, 0.16, -0.16, 0.1] },
  {
    t: 0.26,
    pose: {
      ROOT_Y: -0.09, SPINE_PITCH: 0.2, ROOT_ROLL: -0.1, SPINE_ROLL: 0.05, HEAD_PITCH: 0.2,
      SHOULDER_L_ROLL: 0.75, SHOULDER_L_PITCH: 0.2, ELBOW_L: 0.4, SHOULDER_R_ROLL: 0.35, SHOULDER_R_PITCH: -0.35,
    },
    ikL: [0.06, AY, -0.2, 0], ikR: [-0.3, 0.36, 0.12, -0.35],
  },
  {
    t: 0.42, pose: { ROOT_Y: -0.1, SPINE_PITCH: 0.22, ROOT_ROLL: -0.12, HEAD_PITCH: 0.3, SHOULDER_R_PITCH: 0.1 },
    ikR: [0.36, 0.13, 0.1, 0.15],
  },
  {
    t: 0.6, pose: { ROOT_Y: -0.07, SPINE_PITCH: 0.15, ROOT_ROLL: -0.08, HEAD_PITCH: 0.12, SHOULDER_R_PITCH: 0.3 },
    ikR: [0.29, 0.34, 0.08, 0.2],
  },
  {
    t: 0.8, pose: { ROOT_Y: -0.05, SPINE_PITCH: 0.1, ROOT_ROLL: -0.03, SHOULDER_L_ROLL: 0.3, SHOULDER_R_ROLL: 0.15, SHOULDER_R_PITCH: 0.1 },
    ikR: [0.16, 0.16, 0.13, 0.05],
  },
  { t: 1, pose: NEUTRAL, ikL: [0.06, AY, -0.2, 0], ikR: [0.06, AY, 0.06, 0] },
], { contact: 0.42 });

const SHOT = createClip([
  { t: 0, pose: NEUTRAL, ikL: STAND_L, ikR: STAND_R },
  { t: 0.12, pose: { ROOT_Y: -0.07, SPINE_PITCH: 0.1, ROOT_ROLL: -0.05 }, ikL: [0.03, 0.18, -0.16, 0.1] },
  {
    t: 0.27,
    pose: {
      ROOT_Y: -0.11, SPINE_PITCH: 0.12, ROOT_ROLL: -0.15, SPINE_YAW: 0.18, HEAD_PITCH: 0.2,
      SHOULDER_L_ROLL: 1.0, SHOULDER_L_PITCH: 0.35, ELBOW_L: 0.35, SHOULDER_R_ROLL: 0.45, SHOULDER_R_PITCH: -0.55,
    },
    ikL: [0.08, AY, -0.22, 0], ikR: [-0.4, 0.48, 0.1, -0.7],
  },
  {
    t: 0.42, pose: { ROOT_Y: -0.12, SPINE_PITCH: 0.28, SPINE_YAW: -0.12, ROOT_ROLL: -0.18, HEAD_PITCH: 0.32, SHOULDER_R_PITCH: 0.15 },
    ikR: [0.34, 0.2, 0.08, -0.6],
  },
  {
    t: 0.58, pose: { ROOT_Y: -0.06, SPINE_PITCH: 0.14, SPINE_YAW: -0.2, ROOT_ROLL: -0.1, HEAD_PITCH: 0.1, SHOULDER_R_PITCH: 0.45 },
    ikR: [0.27, 0.56, 0.05, -0.4],
  },
  {
    t: 0.8, pose: { ROOT_Y: -0.05, SPINE_PITCH: 0.1, SPINE_YAW: -0.05, ROOT_ROLL: -0.03, SHOULDER_L_ROLL: 0.4, SHOULDER_R_PITCH: 0.1 },
    ikR: [0.15, 0.18, 0.14, -0.1],
  },
  { t: 1, pose: NEUTRAL, ikL: [0.08, AY, -0.22, 0], ikR: [0.1, AY, 0.04, 0] },
], { contact: 0.42 });

const POWER_SHOT = createClip([
  { t: 0, pose: NEUTRAL, ikL: STAND_L, ikR: STAND_R },
  { t: 0.16, pose: { ROOT_Y: -0.08, SPINE_PITCH: 0.08, ROOT_ROLL: -0.06, SHOULDER_L_ROLL: 0.6 }, ikL: [0.04, 0.2, -0.17, 0.1] },
  {
    t: 0.42,
    pose: {
      ROOT_Y: -0.13, SPINE_PITCH: -0.04, ROOT_ROLL: -0.2, SPINE_YAW: 0.28, HEAD_PITCH: 0.18,
      SHOULDER_L_ROLL: 1.35, SHOULDER_L_PITCH: 0.5, ELBOW_L: 0.3, SHOULDER_R_ROLL: 0.55, SHOULDER_R_PITCH: -0.75,
    },
    ikL: [0.1, AY, -0.23, 0], ikR: [-0.5, 0.6, 0.12, -0.8],
  },
  {
    t: 0.58, pose: { ROOT_Y: -0.13, SPINE_PITCH: 0.24, SPINE_YAW: -0.18, ROOT_ROLL: -0.22, HEAD_PITCH: 0.3, SHOULDER_R_PITCH: 0.25, SHOULDER_L_PITCH: 0.1 },
    ikR: [0.33, 0.2, 0.08, -0.65],
  },
  {
    t: 0.72, pose: { ROOT_Y: -0.05, SPINE_PITCH: 0.02, SPINE_YAW: -0.3, ROOT_ROLL: -0.12, HEAD_PITCH: 0.05, SHOULDER_R_PITCH: 0.6, SHOULDER_L_ROLL: 1.0 },
    ikR: [0.3, 0.58, 0.04, -0.35],
  },
  {
    t: 0.88, pose: { ROOT_Y: -0.08, SPINE_PITCH: 0.12, SPINE_YAW: -0.08, ROOT_ROLL: -0.04, SHOULDER_L_ROLL: 0.5, SHOULDER_R_PITCH: 0.15 },
    ikR: [0.2, 0.15, 0.15, -0.05],
  },
  { t: 1, pose: NEUTRAL, ikL: [0.1, AY, -0.23, 0], ikR: [0.14, AY, 0.03, 0] },
], { contact: 0.58 });

/** Finesse: open body (hips and shoulders turned), inside of the foot swings from outside-back across the ball. */
const FINESSE = createClip([
  { t: 0, pose: NEUTRAL, ikL: STAND_L, ikR: STAND_R },
  { t: 0.12, pose: { ROOT_Y: -0.06, SPINE_PITCH: 0.1, ROOT_YAW: 0.08 }, ikL: [0.02, 0.16, -0.17, 0.1] },
  {
    t: 0.27,
    pose: {
      ROOT_Y: -0.1, SPINE_PITCH: 0.14, ROOT_ROLL: -0.12, ROOT_YAW: 0.18, SPINE_YAW: -0.3, HEAD_PITCH: 0.2, HEAD_YAW: -0.15,
      SHOULDER_L_ROLL: 1.1, SHOULDER_L_PITCH: -0.3, ELBOW_L: 0.3, SHOULDER_R_ROLL: 0.5, SHOULDER_R_PITCH: -0.4,
    },
    ikL: [0.06, AY, -0.21, 0], ikR: [-0.32, 0.4, 0.3, -0.2],
  },
  {
    t: 0.42, pose: { ROOT_Y: -0.11, SPINE_PITCH: 0.2, ROOT_YAW: 0.26, SPINE_YAW: -0.12, ROOT_ROLL: -0.15, HEAD_PITCH: 0.3, SHOULDER_R_PITCH: 0.35 },
    ikR: [0.34, 0.13, 0.05, 0.2],
  },
  {
    t: 0.6, pose: { ROOT_Y: -0.07, SPINE_PITCH: 0.12, ROOT_YAW: 0.3, SPINE_YAW: 0.05, ROOT_ROLL: -0.08, HEAD_PITCH: 0.1, SHOULDER_R_PITCH: 0.5 },
    ikR: [0.26, 0.4, -0.13, 0.25],
  },
  {
    t: 0.8, pose: { ROOT_Y: -0.05, SPINE_PITCH: 0.08, ROOT_YAW: 0.12, SPINE_YAW: 0, ROOT_ROLL: -0.02, SHOULDER_L_ROLL: 0.4, SHOULDER_R_PITCH: 0.1 },
    ikR: [0.14, 0.16, 0.06, 0.05],
  },
  { t: 1, pose: NEUTRAL, ikL: [0.06, AY, -0.21, 0], ikR: [0.08, AY, 0.04, 0] },
], { contact: 0.42 });

/** Volley: side-on, body leaning away, the leg swings up and across to meet the ball about knee-hip height. */
const VOLLEY = createClip([
  { t: 0, pose: NEUTRAL, ikL: STAND_L, ikR: STAND_R },
  { t: 0.15, pose: { ROOT_Y: -0.06, ROOT_ROLL: -0.1, SPINE_PITCH: 0.08 }, ikL: [0.0, 0.14, -0.2, 0.1] },
  {
    t: 0.3,
    pose: {
      ROOT_Y: -0.1, ROOT_ROLL: -0.35, SPINE_ROLL: -0.1, SPINE_PITCH: 0.05, HEAD_YAW: 0.2,
      SHOULDER_L_ROLL: 1.3, SHOULDER_L_PITCH: 0.2, SHOULDER_R_ROLL: 0.8, SHOULDER_R_PITCH: -0.2, ELBOW_L: 0.3, ELBOW_R: 0.5,
    },
    ikL: [0.02, AY, -0.26, 0], ikR: [-0.25, 0.45, 0.35, -0.5],
  },
  {
    t: 0.45, pose: { ROOT_ROLL: -0.5, SPINE_YAW: 0.25, HEAD_YAW: 0.25, HEAD_PITCH: 0.15, SHOULDER_R_PITCH: 0.2 },
    ikR: [0.32, 0.62, 0.38, -0.3],
  },
  {
    t: 0.62, pose: { ROOT_ROLL: -0.35, SPINE_YAW: 0.4, HEAD_YAW: 0.1, SHOULDER_R_PITCH: 0.45, SHOULDER_L_ROLL: 1.0 },
    ikR: [0.12, 0.58, 0.03, -0.2],
  },
  { t: 0.82, pose: { ROOT_Y: -0.06, ROOT_ROLL: -0.1, SPINE_YAW: 0.1, SHOULDER_L_ROLL: 0.4, SHOULDER_R_ROLL: 0.3 }, ikR: [0.08, 0.16, 0.14, 0] },
  { t: 1, pose: NEUTRAL, ikL: [0.02, AY, -0.26, 0], ikR: [0.04, AY, 0.0, 0] },
], { contact: 0.45 });

/** First touch: the receiving foot meets the ball and withdraws to cushion it; soft knees, eyes on the ball. */
const FIRST_TOUCH = createClip([
  { t: 0, pose: NEUTRAL, ikL: [0.0, AY, -0.13, 0], ikR: STAND_R },
  { t: 0.2, pose: { ROOT_Y: -0.06, SPINE_PITCH: 0.1, HEAD_PITCH: 0.25, SHOULDER_L_ROLL: 0.35, SHOULDER_R_ROLL: 0.3 }, ikR: [0.28, 0.2, 0.1, 0.25] },
  { t: 0.4, pose: { ROOT_Y: -0.09, SPINE_PITCH: 0.16, HEAD_PITCH: 0.35, ROOT_ROLL: -0.05 }, ikR: [0.16, 0.13, 0.1, 0.15] },
  { t: 0.7, pose: { ROOT_Y: -0.06, SPINE_PITCH: 0.1, HEAD_PITCH: 0.15, ROOT_ROLL: 0, SHOULDER_L_ROLL: 0.2, SHOULDER_R_ROLL: 0.18 }, ikR: [0.08, AY, 0.13, 0] },
  { t: 1, pose: NEUTRAL, ikR: [0.04, AY, 0.13, 0] },
], { contact: 0.4 });

/** Generic skill touch: the foot sweeps over / around the ball while the body dips to the side. */
const SKILL = createClip([
  { t: 0, pose: NEUTRAL, ikL: [0.02, AY, -0.14, 0], ikR: STAND_R },
  {
    t: 0.2, pose: { ROOT_Y: -0.08, ROOT_ROLL: -0.12, SPINE_ROLL: 0.1, SPINE_PITCH: 0.12, HEAD_PITCH: 0.25, SHOULDER_L_ROLL: 0.7, SHOULDER_R_ROLL: 0.5 },
    ikR: [0.2, 0.22, -0.02, 0.1],
  },
  { t: 0.45, pose: { ROOT_Y: -0.11, ROOT_ROLL: 0.15, SPINE_ROLL: -0.1, SPINE_YAW: -0.12, SHOULDER_L_ROLL: 0.45, SHOULDER_R_ROLL: 0.8 }, ikR: [0.27, 0.14, 0.24, 0] },
  { t: 0.7, pose: { ROOT_Y: -0.07, ROOT_ROLL: 0.06, SPINE_ROLL: 0, SPINE_YAW: 0, SHOULDER_R_ROLL: 0.4 }, ikR: [0.06, AY, 0.16, 0] },
  { t: 1, pose: NEUTRAL, ikR: [0.03, AY, 0.13, 0] },
], { contact: 0.45 });

// ============================================================ header

/** Header: crouch, jump with the arms swinging up, head back, then the neck snaps forward through the ball. */
const HEADER = createClip([
  { t: 0, pose: NEUTRAL, ikL: STAND_L, ikR: STAND_R },
  {
    t: 0.22, pose: { ROOT_Y: -0.2, SPINE_PITCH: 0.28, HEAD_PITCH: -0.1, SHOULDER_L_PITCH: -0.6, SHOULDER_R_PITCH: -0.6, ELBOW_L: 0.4, ELBOW_R: 0.4 },
    ikL: [0.06, AY, -0.13, 0], ikR: [0.06, AY, 0.13, 0],
  },
  {
    t: 0.38, pose: { ROOT_Y: 0.08, SPINE_PITCH: -0.12, HEAD_PITCH: -0.4, SHOULDER_L_PITCH: 1.4, SHOULDER_R_PITCH: 1.4, SHOULDER_L_ROLL: 0.4, SHOULDER_R_ROLL: 0.4 },
    ikL: [-0.02, 0.2, -0.12, -0.6], ikR: [-0.02, 0.2, 0.12, -0.6],
  },
  {
    t: 0.5, pose: { ROOT_Y: 0.38, SPINE_PITCH: 0.28, HEAD_PITCH: 0.4, SHOULDER_L_PITCH: 0.9, SHOULDER_R_PITCH: 0.9, SHOULDER_L_ROLL: 0.95, SHOULDER_R_ROLL: 0.95, ELBOW_L: 1.0, ELBOW_R: 1.0 },
    ikL: [-0.12, 0.6, -0.12, -0.5], ikR: [0.0, 0.52, 0.12, -0.5],
  },
  { t: 0.64, pose: { ROOT_Y: 0.2, SPINE_PITCH: 0.18, HEAD_PITCH: 0.12, SHOULDER_L_ROLL: 0.8, SHOULDER_R_ROLL: 0.8 }, ikL: [-0.04, 0.35, -0.13, -0.4], ikR: [0.04, 0.3, 0.13, -0.4] },
  {
    t: 0.8, pose: { ROOT_Y: -0.16, SPINE_PITCH: 0.22, HEAD_PITCH: 0.05, SHOULDER_L_PITCH: 0.3, SHOULDER_R_PITCH: 0.3, SHOULDER_L_ROLL: 0.5, SHOULDER_R_ROLL: 0.5, ELBOW_L: 0.5, ELBOW_R: 0.5 },
    ikL: [0.04, AY, -0.13, 0], ikR: [0.06, AY, 0.13, 0],
  },
  { t: 1, pose: NEUTRAL, ikL: [0.03, AY, -0.13, 0], ikR: [0.04, AY, 0.13, 0] },
], { contact: 0.5 });

// ============================================================ throw-in

/** Two-handed overhead throw from a staggered stance; t = 0 is the ready hold (ball overhead). */
const THROW_IN = createClip([
  {
    t: 0, pose: { ...NEUTRAL, ROOT_Y: -0.05, SPINE_PITCH: -0.05, HEAD_PITCH: -0.1, SHOULDER_L_PITCH: 2.75, SHOULDER_R_PITCH: 2.75, SHOULDER_L_ROLL: 0.25, SHOULDER_R_ROLL: 0.25, ELBOW_L: 1.5, ELBOW_R: 1.5 },
    ikL: [0.22, AY, -0.1, 0], ikR: groundFoot(-0.22, 0.12, -0.25),
  },
  { t: 0.3, pose: { ROOT_Y: -0.08, ROOT_PITCH: -0.08, SPINE_PITCH: -0.35, HEAD_PITCH: -0.2, SHOULDER_L_PITCH: 3.1, SHOULDER_R_PITCH: 3.1, ELBOW_L: 2.2, ELBOW_R: 2.2 } },
  { t: 0.45, pose: { ROOT_Y: -0.07, ROOT_PITCH: 0.05, SPINE_PITCH: 0.25, HEAD_PITCH: 0.05, SHOULDER_L_PITCH: 2.3, SHOULDER_R_PITCH: 2.3, ELBOW_L: 0.35, ELBOW_R: 0.35 } },
  { t: 0.65, pose: { ROOT_Y: -0.05, ROOT_PITCH: 0.04, SPINE_PITCH: 0.35, SHOULDER_L_PITCH: 1.3, SHOULDER_R_PITCH: 1.3, ELBOW_L: 0.2, ELBOW_R: 0.2 } },
  { t: 1, pose: NEUTRAL, ikL: [0.1, AY, -0.12, 0], ikR: [-0.05, AY, 0.12, 0] },
], { contact: 0.45 });

// ============================================================ keeper distribution

const HOLD_CHEST = { SHOULDER_L_PITCH: 0.7, SHOULDER_R_PITCH: 0.7, SHOULDER_L_ROLL: 0.12, SHOULDER_R_ROLL: 0.12, ELBOW_L: 1.9, ELBOW_R: 1.9 } as const;

const GK_THROW_OVER = createClip([
  { t: 0, pose: { ...NEUTRAL, ...HOLD_CHEST }, ikL: STAND_L, ikR: STAND_R },
  {
    t: 0.28,
    pose: {
      ROOT_Y: -0.07, ROOT_YAW: -0.15, SPINE_YAW: -0.4, SPINE_PITCH: -0.05,
      SHOULDER_R_PITCH: -0.7, SHOULDER_R_ROLL: 1.3, ELBOW_R: 1.2, SHOULDER_L_PITCH: 1.3, SHOULDER_L_ROLL: 0.2, ELBOW_L: 0.2,
    },
    ikL: [0.15, 0.14, -0.1, 0.1],
  },
  {
    t: 0.45, pose: { ROOT_YAW: 0.05, SPINE_YAW: 0.25, SPINE_PITCH: 0.25, SHOULDER_R_PITCH: 2.5, SHOULDER_R_ROLL: 0.5, ELBOW_R: 0.25, SHOULDER_L_PITCH: 0.3 },
    ikL: [0.3, AY, -0.1, 0], ikR: groundFoot(-0.12, 0.13, -0.3),
  },
  { t: 0.65, pose: { SPINE_PITCH: 0.35, SHOULDER_R_PITCH: 1.0, SHOULDER_R_ROLL: 0.3, ELBOW_R: 0.3 } },
  { t: 1, pose: NEUTRAL, ikL: [0.12, AY, -0.12, 0], ikR: [-0.02, AY, 0.13, 0] },
], { contact: 0.45 });

const GK_ROLL = createClip([
  { t: 0, pose: { ...NEUTRAL, ...HOLD_CHEST }, ikL: STAND_L, ikR: STAND_R },
  {
    t: 0.3, pose: { ROOT_Y: -0.22, SPINE_PITCH: 0.45, HEAD_PITCH: -0.2, SHOULDER_R_PITCH: -0.9, SHOULDER_R_ROLL: 0.15, ELBOW_R: 0.2, SHOULDER_L_PITCH: 0.6, ELBOW_L: 0.6 },
    ikL: [0.32, AY, -0.12, 0], ikR: groundFoot(-0.25, 0.14, -0.4),
  },
  { t: 0.45, pose: { ROOT_Y: -0.28, SPINE_PITCH: 0.55, SHOULDER_R_PITCH: 0.8, ELBOW_R: 0.15 } },
  { t: 0.7, pose: { ROOT_Y: -0.14, SPINE_PITCH: 0.35, SHOULDER_R_PITCH: 1.0, SHOULDER_L_PITCH: 0.3 } },
  { t: 1, pose: NEUTRAL, ikL: [0.12, AY, -0.12, 0], ikR: [-0.02, AY, 0.13, 0] },
], { contact: 0.45 });

/** Drop kick: ball held, released in front, struck on the half volley, high follow-through leaning back. */
const GK_KICK = createClip([
  { t: 0, pose: { ...NEUTRAL, ...HOLD_CHEST }, ikL: STAND_L, ikR: STAND_R },
  { t: 0.2, pose: { ROOT_Y: -0.05, SHOULDER_L_PITCH: 1.0, SHOULDER_R_PITCH: 1.0, ELBOW_L: 0.4, ELBOW_R: 0.4 }, ikL: [0.15, 0.14, -0.14, 0.1] },
  {
    t: 0.36, pose: { ROOT_Y: -0.09, SPINE_PITCH: 0.06, ROOT_ROLL: -0.1, SHOULDER_L_ROLL: 0.9, SHOULDER_R_ROLL: 0.6, SHOULDER_L_PITCH: 0.4, SHOULDER_R_PITCH: 0.2 },
    ikL: [0.2, AY, -0.16, 0], ikR: [-0.38, 0.45, 0.1, -0.7],
  },
  { t: 0.5, pose: { ROOT_Y: -0.1, SPINE_PITCH: -0.1, ROOT_ROLL: -0.12, HEAD_PITCH: 0.15 }, ikR: [0.42, 0.3, 0.08, -0.6] },
  { t: 0.66, pose: { ROOT_Y: -0.04, SPINE_PITCH: -0.15, ROOT_ROLL: -0.08, HEAD_PITCH: 0, SHOULDER_L_ROLL: 1.1 }, ikR: [0.33, 0.66, 0.04, -0.4] },
  { t: 0.85, pose: { ROOT_Y: -0.06, SPINE_PITCH: 0.08, ROOT_ROLL: -0.02, SHOULDER_L_ROLL: 0.4, SHOULDER_R_ROLL: 0.3 }, ikR: [0.14, 0.15, 0.13, 0] },
  { t: 1, pose: NEUTRAL, ikL: [0.2, AY, -0.16, 0], ikR: [0.16, AY, 0.06, 0] },
], { contact: 0.5 });

// ============================================================ table

function sided(clip: Clip): PoseFn {
  return (out: Pose, t: number, _cycle: number, _speed: number, _side: number, foot: number): void => {
    evalClip(clip, t, out);
    if (foot === 1) mirrorPose(out);
  };
}

const gkThrow: PoseFn = (out, t, _cycle, _speed, _side, foot) => {
  evalClip(foot === 1 ? GK_ROLL : GK_THROW_OVER, t, out);
};

/** Clips by AnimId (exposed for tests and the debug pose viewer). */
export const ACTION_CLIPS: Partial<Record<AnimId, Clip>> = {
  [AnimId.PASS]: PASS,
  [AnimId.SHOT]: SHOT,
  [AnimId.POWER_SHOT]: POWER_SHOT,
  [AnimId.FINESSE]: FINESSE,
  [AnimId.HEADER]: HEADER,
  [AnimId.VOLLEY]: VOLLEY,
  [AnimId.FIRST_TOUCH]: FIRST_TOUCH,
  [AnimId.THROW_IN]: THROW_IN,
  [AnimId.GK_THROW]: GK_THROW_OVER,
  [AnimId.GK_KICK]: GK_KICK,
  [AnimId.SKILL]: SKILL,
};

/** Underarm keeper roll (GK_THROW with foot 1). */
export const GK_ROLL_CLIP: Clip = GK_ROLL;

/** Phase of the ball contact per clip (the mapper aligns it with p.actContact). */
export const ACTION_CONTACT: Partial<Record<AnimId, number>> = {};
for (const k of Object.keys(ACTION_CLIPS)) {
  const id = Number(k) as AnimId;
  const c = ACTION_CLIPS[id]!.contact;
  if (c >= 0) ACTION_CONTACT[id] = c;
}

/** Backswing-top phase per kick clip: held while the sim holds a charged kick past its wind-up. */
export const ACTION_HOLD: Partial<Record<AnimId, number>> = {
  [AnimId.PASS]: 0.26,
  [AnimId.SHOT]: 0.27,
  [AnimId.POWER_SHOT]: 0.42,
  [AnimId.FINESSE]: 0.27,
  [AnimId.VOLLEY]: 0.3,
  [AnimId.HEADER]: 0.22,
  [AnimId.GK_KICK]: 0.36,
  [AnimId.GK_THROW]: 0.28,
  [AnimId.THROW_IN]: 0.3,
};

export const ACTION_POSES: PoseTable = {
  [AnimId.PASS]: sided(PASS),
  [AnimId.SHOT]: sided(SHOT),
  [AnimId.POWER_SHOT]: sided(POWER_SHOT),
  [AnimId.FINESSE]: sided(FINESSE),
  [AnimId.HEADER]: sided(HEADER),
  [AnimId.VOLLEY]: sided(VOLLEY),
  [AnimId.FIRST_TOUCH]: sided(FIRST_TOUCH),
  [AnimId.SHIELD]: shieldPose,
  [AnimId.THROW_IN]: sided(THROW_IN),
  [AnimId.GK_THROW]: gkThrow,
  [AnimId.GK_KICK]: sided(GK_KICK),
  [AnimId.SKILL]: sided(SKILL),
};
