/**
 * [GFX-11] Animation: tackles, falls, keeper, celebrations (section 8 animation set: standing tackle, slide and
 * get-up, stumble, fall, keeper ready, keeper dives low/mid/high each side, catch, parry, keeper holding, wall
 * jump, three celebrations, dejection). `t` is the normalised sim action phase (GFX-12 aligns CONTACT_CONTACT with
 * p.actContact where the action has a contact tick).
 *
 * DIVES: the sim moves the keeper's hip along the dive line itself (sim/keeper/saveKinematics.ts: the player
 * position IS the hip), so the root stays on the sim position (ROOT_FWD / ROOT_SIDE stay small) and the clip rolls
 * the body about it (ROOT_ROLL toward the dive side, ROOT_Y to the dive height) with the arms extended overhead,
 * i.e. toward the dive side and height. One clip covers the whole GK_DIVE action: load, full stretch at the
 * contact fraction (p.actContact = full extension), stretch held, land on the side, get up into the ready stance.
 * Right-side clips are authored; left ones are mirrors. Height classes follow p.actA (0 low, 1 mid, 2 high).
 *
 * The slide keeps the pelvis near the grass (ROOT_Y about -0.72, leaning back with ROOT_PITCH) with the leading leg
 * along the ground; FALL ends lying on the back, which is where GET_UP starts. Celebrations are original and
 * generic: knee slide with arms spread (1), "aeroplane" arms out banking side to side (2), jump and fist pump (3).
 * KEEPER_READY is the locomotion clip (locomotion.ts keeperReadyPose).
 *
 * Allocation-free per call; clips are built once at module load.
 */

import { AnimId, type Pose, type PoseFn } from '../../contracts/render';
import type { PoseTable } from '../types';
import { keeperReadyPose } from './locomotion';
import { ANKLE_Y, createClip, evalClip, mirrorPose, type Clip, type KeySpec } from './poseMath';

const AY = ANKLE_Y;
const NEUTRAL = {
  ROOT_Y: -0.03, ROOT_PITCH: 0, ROOT_ROLL: 0, ROOT_YAW: 0, ROOT_FWD: 0, ROOT_SIDE: 0,
  SPINE_PITCH: 0.05, SPINE_YAW: 0, SPINE_ROLL: 0, HEAD_PITCH: 0, HEAD_YAW: 0,
  SHOULDER_L_PITCH: 0, SHOULDER_L_ROLL: 0.12, ELBOW_L: 0.3, SHOULDER_R_PITCH: 0, SHOULDER_R_ROLL: 0.12, ELBOW_R: 0.3,
  HIP_L_PITCH: 0, HIP_L_ROLL: 0, KNEE_L: 0, ANKLE_L: 0, HIP_R_PITCH: 0, HIP_R_ROLL: 0, KNEE_R: 0, ANKLE_R: 0,
} as const;

// ============================================================ tackles

const STAND_TACKLE = createClip([
  { t: 0, pose: NEUTRAL, ikL: [0.0, AY, -0.12, 0], ikR: [0.0, AY, 0.12, 0] },
  {
    t: 0.12, pose: { ROOT_Y: -0.12, SPINE_PITCH: 0.3, HEAD_PITCH: 0.1, SHOULDER_L_ROLL: 0.5, SHOULDER_R_ROLL: 0.5 },
    ikL: [-0.1, AY, -0.13, 0], ikR: [0.15, 0.15, 0.1, 0.1],
  },
  {
    t: 0.25,
    pose: {
      ROOT_Y: -0.25, ROOT_FWD: 0.15, SPINE_PITCH: 0.4, HEAD_PITCH: 0.2,
      SHOULDER_L_ROLL: 0.9, SHOULDER_L_PITCH: 0.2, SHOULDER_R_ROLL: 0.6, SHOULDER_R_PITCH: -0.3, ELBOW_L: 0.4, ELBOW_R: 0.5,
    },
    ikL: [-0.25, AY, -0.13, -0.3], ikR: [0.74, 0.1, 0.05, 0.25],
  },
  { t: 0.45, pose: { ROOT_Y: -0.23, ROOT_FWD: 0.13, SPINE_PITCH: 0.38 }, ikR: [0.62, 0.1, 0.08, 0.15] },
  { t: 0.7, pose: { ROOT_Y: -0.1, ROOT_FWD: 0.05, SPINE_PITCH: 0.2, SHOULDER_L_ROLL: 0.4, SHOULDER_R_ROLL: 0.3, SHOULDER_R_PITCH: 0 }, ikL: [-0.1, AY, -0.13, 0], ikR: [0.25, AY, 0.12, 0] },
  { t: 1, pose: NEUTRAL, ikL: [0.0, AY, -0.12, 0], ikR: [0.02, AY, 0.12, 0] },
], { contact: 0.25 });

/** Slide: drop to the grass on the hip, leading (right) leg along the ground, trailing leg tucked; quick get-up. */
const SLIDE_DOWN = {
  ROOT_Y: -0.72, ROOT_PITCH: -0.85, SPINE_PITCH: 0.1, HEAD_PITCH: 0.55, ROOT_ROLL: -0.12,
  HIP_R_PITCH: 0.74, KNEE_R: 0.05, ANKLE_R: -0.25, HIP_L_PITCH: 0.42, HIP_L_ROLL: 0.35, KNEE_L: 1.6, ANKLE_L: -0.2,
  SHOULDER_L_PITCH: -0.45, SHOULDER_L_ROLL: 0.55, ELBOW_L: 0.15, SHOULDER_R_PITCH: 1.1, SHOULDER_R_ROLL: 0.65, ELBOW_R: 0.5,
} as const;
const SLIDE = createClip([
  { t: 0, pose: { ...NEUTRAL, ROOT_Y: -0.06, SPINE_PITCH: 0.15, HIP_R_PITCH: 0.3, KNEE_R: 0.4, HIP_L_PITCH: -0.2, KNEE_L: 0.5 } },
  { t: 0.08, pose: SLIDE_DOWN },
  { t: 0.4, pose: { ...SLIDE_DOWN, ROOT_PITCH: -0.8, HEAD_PITCH: 0.45, KNEE_R: 0.12 } },
  {
    t: 0.6, pose: { ROOT_Y: -0.66, ROOT_PITCH: -0.3, ROOT_ROLL: -0.05, HEAD_PITCH: 0.15, HIP_R_PITCH: 1.1, KNEE_R: 0.7, ANKLE_R: 0, HIP_L_PITCH: 0.6, KNEE_L: 1.9, SHOULDER_L_PITCH: -0.3, SHOULDER_R_PITCH: 0.2, SHOULDER_R_ROLL: 0.4 },
  },
  {
    t: 0.82, pose: { ROOT_Y: -0.36, ROOT_PITCH: 0.35, ROOT_ROLL: 0, SPINE_PITCH: 0.2, HEAD_PITCH: -0.1, HIP_R_PITCH: 0.9, KNEE_R: 1.6, ANKLE_R: 0.5, HIP_L_PITCH: 0.7, HIP_L_ROLL: 0.1, KNEE_L: 1.7, ANKLE_L: 0.55, SHOULDER_L_PITCH: 0.4, SHOULDER_R_PITCH: 0.5, ELBOW_L: 0.5 },
  },
  { t: 1, pose: NEUTRAL },
], { contact: 0.08 });

// ============================================================ stumble, fall, get-up

const STUMBLE = createClip([
  { t: 0, pose: NEUTRAL },
  {
    t: 0.25, pose: { ROOT_Y: -0.1, ROOT_PITCH: 0.35, SPINE_PITCH: 0.2, HEAD_PITCH: -0.2, SHOULDER_L_PITCH: 0.9, SHOULDER_R_PITCH: 0.6, SHOULDER_L_ROLL: 0.8, SHOULDER_R_ROLL: 0.9, ELBOW_L: 0.5, ELBOW_R: 0.6, HIP_R_PITCH: 0.3, KNEE_R: 0.5, HIP_L_PITCH: -0.65, KNEE_L: 0.4, ANKLE_L: -0.3 },
  },
  {
    t: 0.5, pose: { ROOT_Y: -0.08, ROOT_PITCH: 0.25, ROOT_ROLL: 0.1, SHOULDER_L_PITCH: 0.5, SHOULDER_R_PITCH: 1.0, HIP_R_PITCH: -0.55, KNEE_R: 0.35, ANKLE_R: -0.3, HIP_L_PITCH: 0.2, KNEE_L: 0.5, ANKLE_L: 0 },
  },
  { t: 0.75, pose: { ROOT_Y: -0.05, ROOT_PITCH: 0.1, ROOT_ROLL: 0, SPINE_PITCH: 0.1, HEAD_PITCH: 0, SHOULDER_L_PITCH: 0.2, SHOULDER_R_PITCH: 0.3, SHOULDER_L_ROLL: 0.4, SHOULDER_R_ROLL: 0.4, HIP_R_PITCH: -0.15, KNEE_R: 0.25, HIP_L_PITCH: 0.1, KNEE_L: 0.2 } },
  { t: 1, pose: NEUTRAL },
]);

/** Lying on the back (end of FALL, start of GET_UP). */
const LYING = {
  ROOT_Y: -0.8, ROOT_PITCH: -1.45, ROOT_ROLL: 0, SPINE_PITCH: 0, HEAD_PITCH: 0.25,
  SHOULDER_L_PITCH: 0.2, SHOULDER_R_PITCH: 0.2, SHOULDER_L_ROLL: 1.1, SHOULDER_R_ROLL: 1.1, ELBOW_L: 0.3, ELBOW_R: 0.3,
  HIP_L_PITCH: 0.12, HIP_R_PITCH: 0.12, HIP_L_ROLL: 0.1, HIP_R_ROLL: 0.1, KNEE_L: 0.2, KNEE_R: 0.2, ANKLE_L: -0.2, ANKLE_R: -0.2,
} as const;

const FALL = createClip([
  { t: 0, pose: NEUTRAL },
  { t: 0.1, pose: { ROOT_Y: -0.25, ROOT_PITCH: -0.5, SPINE_PITCH: 0.2, HEAD_PITCH: 0.3, HIP_L_PITCH: 0.6, HIP_R_PITCH: 0.4, KNEE_L: 0.3, KNEE_R: 0.4, SHOULDER_L_PITCH: 0.8, SHOULDER_R_PITCH: 0.8, SHOULDER_L_ROLL: 1.2, SHOULDER_R_ROLL: 1.2 } },
  { t: 0.22, pose: { ROOT_Y: -0.68, ROOT_PITCH: -0.8, SPINE_PITCH: 0.15, HIP_L_PITCH: 0.8, HIP_R_PITCH: 0.9, KNEE_L: 0.5, KNEE_R: 0.4, SHOULDER_L_PITCH: -0.4, SHOULDER_R_PITCH: -0.4, SHOULDER_L_ROLL: 0.6, SHOULDER_R_ROLL: 0.6 } },
  { t: 0.35, pose: LYING },
  { t: 0.6, pose: { ...LYING, HIP_R_PITCH: 0.95, KNEE_R: 1.6, SHOULDER_L_PITCH: 1.2, SHOULDER_R_PITCH: 1.3, SHOULDER_L_ROLL: 0.3, SHOULDER_R_ROLL: 0.3, ELBOW_L: 0.8, ELBOW_R: 0.8, HEAD_PITCH: 0.45 } },
  { t: 0.85, pose: LYING },
  { t: 1, pose: LYING },
]);

const GET_UP = createClip([
  { t: 0, pose: { ...NEUTRAL, ...LYING } },
  { t: 0.35, pose: { ROOT_Y: -0.7, ROOT_PITCH: -0.4, SPINE_PITCH: 0.2, HEAD_PITCH: 0.1, HIP_L_PITCH: 0.95, HIP_R_PITCH: 0.65, KNEE_L: 1.5, KNEE_R: 0.4, SHOULDER_L_PITCH: -0.6, SHOULDER_R_PITCH: -0.6, SHOULDER_L_ROLL: 0.4, SHOULDER_R_ROLL: 0.4, ELBOW_L: 0.1, ELBOW_R: 0.1 } },
  { t: 0.65, pose: { ROOT_Y: -0.42, ROOT_PITCH: 0.45, SPINE_PITCH: 0.25, HEAD_PITCH: -0.15, HIP_L_PITCH: 0.75, HIP_R_PITCH: 0.75, HIP_L_ROLL: 0.05, HIP_R_ROLL: 0.05, KNEE_L: 1.9, KNEE_R: 1.9, ANKLE_L: 0.6, ANKLE_R: 0.6, SHOULDER_L_PITCH: 0.5, SHOULDER_R_PITCH: 0.5, SHOULDER_L_ROLL: 0.3, SHOULDER_R_ROLL: 0.3, ELBOW_L: 0.5, ELBOW_R: 0.5 } },
  { t: 1, pose: NEUTRAL },
]);

// ============================================================ keeper

const READY = {
  ...NEUTRAL, ROOT_Y: -0.18, SPINE_PITCH: 0.3, HEAD_PITCH: -0.28,
  SHOULDER_L_PITCH: 0.85, SHOULDER_R_PITCH: 0.85, SHOULDER_L_ROLL: 0.4, SHOULDER_R_ROLL: 0.4, ELBOW_L: 1.1, ELBOW_R: 1.1,
  HIP_L_PITCH: 0.55, HIP_R_PITCH: 0.55, HIP_L_ROLL: 0.12, HIP_R_ROLL: 0.12, KNEE_L: 1.0, KNEE_R: 1.0, ANKLE_L: 0.45, ANKLE_R: 0.45,
} as const;

/** Full-stretch pose per dive height (right side): root roll toward the dive, arms overhead (toward the side). */
interface DiveSpec { roll: number; rootY: number; afterY: number; shoulder: number; spineRoll: number }
const DIVE_LOW_SPEC: DiveSpec = { roll: 1.5, rootY: -0.5, afterY: -0.62, shoulder: 2.55, spineRoll: 0.05 };
const DIVE_MID_SPEC: DiveSpec = { roll: 1.32, rootY: 0.0, afterY: -0.25, shoulder: 2.75, spineRoll: 0.12 };
const DIVE_HIGH_SPEC: DiveSpec = { roll: 1.0, rootY: 0.42, afterY: 0.2, shoulder: 2.95, spineRoll: 0.2 };

function diveClip(d: DiveSpec): Clip {
  const keys: KeySpec[] = [
    { t: 0, pose: READY },
    {
      t: 0.15, pose: {
        ROOT_Y: -0.27, ROOT_ROLL: 0.2, ROOT_SIDE: 0.04, SPINE_ROLL: 0.1, SPINE_PITCH: 0.2, HEAD_PITCH: -0.2,
        SHOULDER_L_PITCH: 1.5, SHOULDER_R_PITCH: 1.6, ELBOW_L: 0.6, ELBOW_R: 0.5,
        HIP_R_ROLL: 0.35, HIP_R_PITCH: 0.4, KNEE_R: 0.7, ANKLE_R: 0.2, HIP_L_PITCH: 0.7, KNEE_L: 1.25, ANKLE_L: 0.5,
      },
    },
    {
      t: 0.35, pose: {
        ROOT_Y: d.rootY, ROOT_ROLL: d.roll, ROOT_SIDE: 0.02, ROOT_PITCH: 0.05, SPINE_ROLL: d.spineRoll, SPINE_PITCH: 0.05,
        HEAD_PITCH: -0.1, HEAD_YAW: 0, SHOULDER_L_PITCH: d.shoulder, SHOULDER_R_PITCH: d.shoulder,
        SHOULDER_L_ROLL: 0.15, SHOULDER_R_ROLL: 0.3, ELBOW_L: 0.1, ELBOW_R: 0.08,
        HIP_R_ROLL: 0.15, HIP_R_PITCH: 0.1, KNEE_R: 0.15, ANKLE_R: -0.4, HIP_L_ROLL: 0.25, HIP_L_PITCH: -0.05, KNEE_L: 0.35, ANKLE_L: -0.5,
      },
    },
    { t: 0.47, pose: { ROOT_Y: d.afterY, ROOT_ROLL: Math.min(1.52, d.roll + 0.15) } },
    {
      t: 0.62, pose: {
        ROOT_Y: -0.73, ROOT_ROLL: 1.52, ROOT_SIDE: 0, SPINE_ROLL: 0.05, SHOULDER_L_PITCH: 2.2, SHOULDER_R_PITCH: 2.3,
        ELBOW_L: 0.8, ELBOW_R: 0.7, HIP_R_PITCH: 0.35, KNEE_R: 0.5, HIP_L_PITCH: 0.45, KNEE_L: 0.7,
      },
    },
    {
      t: 0.78, pose: {
        ROOT_Y: -0.7, ROOT_ROLL: 1.2, SHOULDER_L_PITCH: 1.4, SHOULDER_R_PITCH: 1.0, SHOULDER_R_ROLL: 0.9, ELBOW_R: 0.3,
        HIP_R_PITCH: 0.9, KNEE_R: 1.5, HIP_L_PITCH: 0.9, KNEE_L: 1.6,
      },
    },
    {
      t: 0.9, pose: {
        ROOT_Y: -0.4, ROOT_ROLL: 0.3, ROOT_PITCH: 0.3, SPINE_ROLL: 0, SPINE_PITCH: 0.3, SHOULDER_L_PITCH: 0.8, SHOULDER_R_PITCH: 0.6,
        SHOULDER_R_ROLL: 0.5, HIP_R_PITCH: 1.0, HIP_L_PITCH: 1.0, HIP_R_ROLL: 0.12, HIP_L_ROLL: 0.12, KNEE_R: 1.8, KNEE_L: 1.8, ANKLE_R: 0.6, ANKLE_L: 0.6,
      },
    },
    { t: 1, pose: READY },
  ];
  return createClip(keys, { contact: 0.35 });
}

const DIVE_LOW = diveClip(DIVE_LOW_SPEC);
const DIVE_MID = diveClip(DIVE_MID_SPEC);
const DIVE_HIGH = diveClip(DIVE_HIGH_SPEC);

const KEEPER_FEET_L = [0.14, AY, -0.18, -0.1] as const;
const KEEPER_FEET_R = [0.14, AY, 0.18, -0.1] as const;
const HOLD_CHEST = { SHOULDER_L_PITCH: 0.7, SHOULDER_R_PITCH: 0.7, SHOULDER_L_ROLL: 0.12, SHOULDER_R_ROLL: 0.12, ELBOW_L: 1.95, ELBOW_R: 1.95 } as const;

/** Catch: hands up and forward to meet the ball, then gathered into the chest. */
const CATCH = createClip([
  { t: 0, pose: { ...NEUTRAL, ROOT_Y: -0.15, SPINE_PITCH: 0.25, HEAD_PITCH: -0.2, SHOULDER_L_PITCH: 1.1, SHOULDER_R_PITCH: 1.1, SHOULDER_L_ROLL: 0.3, SHOULDER_R_ROLL: 0.3, ELBOW_L: 0.7, ELBOW_R: 0.7 }, ikL: KEEPER_FEET_L, ikR: KEEPER_FEET_R },
  { t: 0.5, pose: { ROOT_Y: -0.12, SHOULDER_L_PITCH: 1.3, SHOULDER_R_PITCH: 1.3, SHOULDER_L_ROLL: 0.22, SHOULDER_R_ROLL: 0.22, ELBOW_L: 0.35, ELBOW_R: 0.35, HEAD_PITCH: -0.05 } },
  { t: 0.8, pose: { ROOT_Y: -0.18, SPINE_PITCH: 0.35, HEAD_PITCH: 0.3, ...HOLD_CHEST } },
  { t: 1, pose: { ROOT_Y: -0.08, SPINE_PITCH: 0.12, HEAD_PITCH: 0.05 }, ikL: [0.06, AY, -0.15, 0], ikR: [0.06, AY, 0.15, 0] },
]);

/** Parry / punch: spring up with both palms pushed out at the ball. */
const PARRY = createClip([
  { t: 0, pose: { ...NEUTRAL, ROOT_Y: -0.15, SPINE_PITCH: 0.25, HEAD_PITCH: -0.2, SHOULDER_L_PITCH: 1.0, SHOULDER_R_PITCH: 1.0, SHOULDER_L_ROLL: 0.35, SHOULDER_R_ROLL: 0.35, ELBOW_L: 0.9, ELBOW_R: 0.9 }, ikL: KEEPER_FEET_L, ikR: KEEPER_FEET_R },
  { t: 0.3, pose: { ROOT_Y: -0.22, SPINE_PITCH: 0.3, SHOULDER_L_PITCH: 0.6, SHOULDER_R_PITCH: 0.6, ELBOW_L: 1.3, ELBOW_R: 1.3 } },
  {
    t: 0.5, pose: { ROOT_Y: 0.25, SPINE_PITCH: -0.1, HEAD_PITCH: -0.35, SHOULDER_L_PITCH: 2.5, SHOULDER_R_PITCH: 2.5, SHOULDER_L_ROLL: 0.32, SHOULDER_R_ROLL: 0.32, ELBOW_L: 0.08, ELBOW_R: 0.08 },
    ikL: [0.04, 0.28, -0.14, -0.5], ikR: [0.04, 0.28, 0.14, -0.5],
  },
  { t: 0.7, pose: { ROOT_Y: 0.05, SPINE_PITCH: 0.05, HEAD_PITCH: -0.2, SHOULDER_L_PITCH: 1.8, SHOULDER_R_PITCH: 1.8, ELBOW_L: 0.4, ELBOW_R: 0.4 }, ikL: [0.08, 0.12, -0.16, -0.3], ikR: [0.08, 0.12, 0.16, -0.3] },
  { t: 0.85, pose: { ROOT_Y: -0.16, SPINE_PITCH: 0.22, HEAD_PITCH: -0.2, SHOULDER_L_PITCH: 1.0, SHOULDER_R_PITCH: 1.0, ELBOW_L: 0.9, ELBOW_R: 0.9 }, ikL: KEEPER_FEET_L, ikR: KEEPER_FEET_R },
  { t: 1, pose: { ROOT_Y: -0.15, SPINE_PITCH: 0.25 } },
], { contact: 0.5 });

/** Keeper holding the ball at his chest, small weight shifts (looped). */
const KEEPER_HOLD = createClip([
  { t: 0, pose: { ...NEUTRAL, ROOT_Y: -0.04, SPINE_PITCH: 0.06, ...HOLD_CHEST }, ikL: [0.04, AY, -0.14, 0], ikR: [0.04, AY, 0.14, 0] },
  { t: 0.5, pose: { ROOT_SIDE: 0.015, SPINE_YAW: 0.06, HEAD_YAW: 0.15, ROOT_Y: -0.045 } },
  { t: 1, pose: { ROOT_SIDE: 0, SPINE_YAW: 0, HEAD_YAW: 0, ROOT_Y: -0.04 } },
], { repeat: 3 });

/** Wall: t = 0 is the brace (hands protecting); the jump takes off at the contact fraction. */
const BRACE = { ...NEUTRAL, SHOULDER_L_PITCH: 0.45, SHOULDER_R_PITCH: 0.45, SHOULDER_L_ROLL: -0.3, SHOULDER_R_ROLL: -0.3, ELBOW_L: 0.55, ELBOW_R: 0.55, HEAD_PITCH: 0.05 } as const;
const WALL_JUMP = createClip([
  { t: 0, pose: BRACE, ikL: [0.02, AY, -0.1, 0], ikR: [0.02, AY, 0.1, 0] },
  { t: 0.3, pose: { ROOT_Y: -0.2, SPINE_PITCH: 0.18 } },
  { t: 0.5, pose: { ROOT_Y: 0.35, SPINE_PITCH: 0.0, HEAD_PITCH: -0.1 }, ikL: [-0.06, 0.42, -0.1, -0.5], ikR: [-0.06, 0.42, 0.1, -0.5] },
  { t: 0.75, pose: { ROOT_Y: -0.15, SPINE_PITCH: 0.12 }, ikL: [0.02, AY, -0.1, 0], ikR: [0.02, AY, 0.1, 0] },
  { t: 1, pose: BRACE },
], { contact: 0.3 });

// ============================================================ celebrations, dejection

/** 1: knee slide, arms spread up, then back to the feet. */
const KNEELING = {
  ROOT_Y: -0.46, ROOT_PITCH: -0.3, SPINE_PITCH: -0.2, HEAD_PITCH: -0.4,
  HIP_L_PITCH: -0.3, HIP_R_PITCH: -0.3, HIP_L_ROLL: 0.12, HIP_R_ROLL: 0.12, KNEE_L: 1.57, KNEE_R: 1.57, ANKLE_L: -1.0, ANKLE_R: -1.0,
  SHOULDER_L_PITCH: 0.3, SHOULDER_R_PITCH: 0.3, SHOULDER_L_ROLL: 2.4, SHOULDER_R_ROLL: 2.4, ELBOW_L: 0.1, ELBOW_R: 0.1,
} as const;
const CELEBRATE_1 = createClip([
  { t: 0, pose: { ...NEUTRAL, SPINE_PITCH: 0.12 } },
  { t: 0.12, pose: { ROOT_Y: -0.3, ROOT_PITCH: -0.1, HIP_L_PITCH: 0.3, HIP_R_PITCH: 0.3, KNEE_L: 1.1, KNEE_R: 1.1, SHOULDER_L_ROLL: 1.6, SHOULDER_R_ROLL: 1.6, ELBOW_L: 0.3, ELBOW_R: 0.3 } },
  { t: 0.22, pose: KNEELING },
  { t: 0.62, pose: { ...KNEELING, ELBOW_L: 0.45, ELBOW_R: 0.45, HEAD_PITCH: -0.5 } },
  { t: 0.82, pose: { ROOT_Y: -0.3, ROOT_PITCH: 0.05, SPINE_PITCH: 0.15, HEAD_PITCH: 0, HIP_R_PITCH: 1.2, KNEE_R: 1.3, ANKLE_R: 0.3, HIP_L_PITCH: -0.1, KNEE_L: 1.4, ANKLE_L: -0.6, SHOULDER_L_ROLL: 0.5, SHOULDER_R_ROLL: 0.5, ELBOW_L: 0.4, ELBOW_R: 0.4 } },
  { t: 1, pose: NEUTRAL },
]);

/** 2: "aeroplane": arms out wide, banking side to side through the upper body (works over a run too). */
const CELEBRATE_2 = createClip([
  { t: 0, pose: { ...NEUTRAL, SPINE_PITCH: 0.1, SHOULDER_L_ROLL: 1.5, SHOULDER_R_ROLL: 1.5, SHOULDER_L_PITCH: -0.1, SHOULDER_R_PITCH: -0.1, ELBOW_L: 0.05, ELBOW_R: 0.05 }, ikL: [0.02, AY, -0.14, 0], ikR: [0.02, AY, 0.14, 0] },
  { t: 0.25, pose: { SPINE_ROLL: 0.32, HEAD_YAW: -0.25, HEAD_PITCH: -0.1 } },
  { t: 0.75, pose: { SPINE_ROLL: -0.32, HEAD_YAW: 0.25 } },
  { t: 1, pose: { SPINE_ROLL: 0, HEAD_YAW: 0, HEAD_PITCH: 0 } },
], { repeat: 2 });

/** 3: jump and fist pump (looped). */
const CELEBRATE_3 = createClip([
  { t: 0, pose: { ...NEUTRAL }, ikL: [0.02, AY, -0.13, 0], ikR: [0.02, AY, 0.13, 0] },
  { t: 0.3, pose: { ROOT_Y: -0.18, SPINE_PITCH: 0.25, SHOULDER_R_PITCH: 0.5, ELBOW_R: 1.8, SHOULDER_L_PITCH: -0.3, ELBOW_L: 0.5 } },
  {
    t: 0.55, pose: { ROOT_Y: 0.3, SPINE_PITCH: -0.15, HEAD_PITCH: -0.35, SHOULDER_R_PITCH: 2.9, SHOULDER_R_ROLL: 0.3, ELBOW_R: 0.35, SHOULDER_L_PITCH: 0.2, SHOULDER_L_ROLL: 0.6, ELBOW_L: 0.6 },
    ikL: [-0.05, 0.38, -0.13, -0.5], ikR: [-0.05, 0.38, 0.13, -0.5],
  },
  { t: 0.8, pose: { ROOT_Y: -0.14, SPINE_PITCH: 0.15, HEAD_PITCH: -0.1, SHOULDER_R_PITCH: 1.8, ELBOW_R: 1.5, SHOULDER_L_ROLL: 0.3 }, ikL: [0.02, AY, -0.13, 0], ikR: [0.02, AY, 0.13, 0] },
  { t: 1, pose: NEUTRAL },
], { repeat: 3 });

/** Dejection: hands on head, then crouched with hands on knees. */
const DEJECTION = createClip([
  { t: 0, pose: NEUTRAL, ikL: [0.04, AY, -0.15, 0], ikR: [0.04, AY, 0.15, 0] },
  { t: 0.15, pose: { SPINE_PITCH: 0.15, HEAD_PITCH: 0.45, SHOULDER_L_PITCH: 2.3, SHOULDER_R_PITCH: 2.3, SHOULDER_L_ROLL: 1.1, SHOULDER_R_ROLL: 1.1, ELBOW_L: 2.4, ELBOW_R: 2.4 } },
  { t: 0.4, pose: { SPINE_YAW: 0.12, HEAD_YAW: 0.15 } },
  { t: 0.55, pose: { SPINE_YAW: -0.05, HEAD_YAW: -0.1 } },
  { t: 0.72, pose: { ROOT_Y: -0.28, SPINE_PITCH: 0.85, SPINE_YAW: 0, HEAD_YAW: 0, HEAD_PITCH: 0.15, SHOULDER_L_PITCH: 0.75, SHOULDER_R_PITCH: 0.75, SHOULDER_L_ROLL: 0.15, SHOULDER_R_ROLL: 0.15, ELBOW_L: 0.15, ELBOW_R: 0.15 } },
  { t: 1, pose: { ROOT_Y: -0.3, SPINE_PITCH: 0.88 } },
]);

// ============================================================ table

function plain(clip: Clip): PoseFn {
  return (out: Pose, t: number): void => {
    evalClip(clip, t, out);
  };
}

function mirrored(clip: Clip): PoseFn {
  return (out: Pose, t: number): void => {
    evalClip(clip, t, out);
    mirrorPose(out);
  };
}

/** Clips by AnimId (right-side versions for the dives; exposed for tests and the pose viewer). */
export const CONTACT_CLIPS: Partial<Record<AnimId, Clip>> = {
  [AnimId.STAND_TACKLE]: STAND_TACKLE,
  [AnimId.SLIDE]: SLIDE,
  [AnimId.GET_UP]: GET_UP,
  [AnimId.STUMBLE]: STUMBLE,
  [AnimId.FALL]: FALL,
  [AnimId.DIVE_LOW_L]: DIVE_LOW,
  [AnimId.DIVE_LOW_R]: DIVE_LOW,
  [AnimId.DIVE_MID_L]: DIVE_MID,
  [AnimId.DIVE_MID_R]: DIVE_MID,
  [AnimId.DIVE_HIGH_L]: DIVE_HIGH,
  [AnimId.DIVE_HIGH_R]: DIVE_HIGH,
  [AnimId.CATCH]: CATCH,
  [AnimId.PARRY]: PARRY,
  [AnimId.KEEPER_HOLD]: KEEPER_HOLD,
  [AnimId.WALL_JUMP]: WALL_JUMP,
  [AnimId.CELEBRATE_1]: CELEBRATE_1,
  [AnimId.CELEBRATE_2]: CELEBRATE_2,
  [AnimId.CELEBRATE_3]: CELEBRATE_3,
  [AnimId.DEJECTION]: DEJECTION,
};

/** Phase of the contact moment per clip (tackle contact, dive full extension, punch, wall take-off). */
export const CONTACT_CONTACT: Partial<Record<AnimId, number>> = {};
for (const k of Object.keys(CONTACT_CLIPS)) {
  const id = Number(k) as AnimId;
  const c = CONTACT_CLIPS[id]!.contact;
  if (c >= 0) CONTACT_CONTACT[id] = c;
}

/** Dive clip for a sim height class (p.actA: 0 low, 1 mid, 2 high) and side (p.actB: -1 left, +1 right). */
export function diveAnim(heightClass: number, side: number): AnimId {
  const right = side >= 0;
  if (heightClass >= 2) return right ? AnimId.DIVE_HIGH_R : AnimId.DIVE_HIGH_L;
  if (heightClass >= 1) return right ? AnimId.DIVE_MID_R : AnimId.DIVE_MID_L;
  return right ? AnimId.DIVE_LOW_R : AnimId.DIVE_LOW_L;
}

/** Celebration clip for a sim variant (p.actA 0..2). */
export function celebrationAnim(variant: number): AnimId {
  const v = variant | 0;
  return v === 1 ? AnimId.CELEBRATE_2 : v === 2 ? AnimId.CELEBRATE_3 : AnimId.CELEBRATE_1;
}

export const CONTACT_POSES: PoseTable = {
  [AnimId.STAND_TACKLE]: plain(STAND_TACKLE),
  [AnimId.SLIDE]: plain(SLIDE),
  [AnimId.GET_UP]: plain(GET_UP),
  [AnimId.STUMBLE]: plain(STUMBLE),
  [AnimId.FALL]: plain(FALL),
  [AnimId.KEEPER_READY]: keeperReadyPose,
  [AnimId.DIVE_LOW_L]: mirrored(DIVE_LOW),
  [AnimId.DIVE_LOW_R]: plain(DIVE_LOW),
  [AnimId.DIVE_MID_L]: mirrored(DIVE_MID),
  [AnimId.DIVE_MID_R]: plain(DIVE_MID),
  [AnimId.DIVE_HIGH_L]: mirrored(DIVE_HIGH),
  [AnimId.DIVE_HIGH_R]: plain(DIVE_HIGH),
  [AnimId.CATCH]: plain(CATCH),
  [AnimId.PARRY]: plain(PARRY),
  [AnimId.KEEPER_HOLD]: plain(KEEPER_HOLD),
  [AnimId.WALL_JUMP]: plain(WALL_JUMP),
  [AnimId.CELEBRATE_1]: plain(CELEBRATE_1),
  [AnimId.CELEBRATE_2]: plain(CELEBRATE_2),
  [AnimId.CELEBRATE_3]: plain(CELEBRATE_3),
  [AnimId.DEJECTION]: plain(DEJECTION),
};
