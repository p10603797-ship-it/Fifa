/**
 * Render-side contracts: procedural pose layout shared by the animation modules (GFX-09..12) and the
 * player model (GFX-07). Lead-owned, frozen after Wave 0.
 *
 * Animation is derived from sim state and never feeds back into it (ARCHITECTURE rule 3).
 */

/**
 * Pose: joint values for one player, radians unless noted. Model space: the player faces +x (forward),
 * +y up, +z to the player's right. Rotations follow the right-hand rule about the named axis.
 * Positive pitch on a limb swings it forward (toward +x).
 */
export const PoseIdx = {
  /** Root vertical offset (m) added to the standing pelvis height (crouch < 0, jump > 0). */
  ROOT_Y: 0,
  /** Whole-body lean forward (+) / back (-) about the z axis. */
  ROOT_PITCH: 1,
  /** Whole-body roll toward the right (+) about the x axis (turn lean, dives). */
  ROOT_ROLL: 2,
  /** Body yaw offset relative to the sim facing (+ = turn left, about y). */
  ROOT_YAW: 3,
  /** Root offset forward (m) and sideways (m) relative to the sim position (dives, slides). */
  ROOT_FWD: 4,
  ROOT_SIDE: 5,
  SPINE_PITCH: 6,
  SPINE_YAW: 7,
  SPINE_ROLL: 8,
  HEAD_PITCH: 9,
  HEAD_YAW: 10,
  /** Shoulders: pitch (forward swing) and roll (raise sideways, + = away from the body). */
  SHOULDER_L_PITCH: 11,
  SHOULDER_L_ROLL: 12,
  ELBOW_L: 13,
  SHOULDER_R_PITCH: 14,
  SHOULDER_R_ROLL: 15,
  ELBOW_R: 16,
  /** Hips: pitch (forward swing) and roll (abduct, + = away from the body). */
  HIP_L_PITCH: 17,
  HIP_L_ROLL: 18,
  /** Knee flexion (>= 0 bends the shin backward). */
  KNEE_L: 19,
  ANKLE_L: 20,
  HIP_R_PITCH: 21,
  HIP_R_ROLL: 22,
  KNEE_R: 23,
  ANKLE_R: 24,
} as const;

export const POSE_SIZE = 25;

/** A pose buffer. Use createPose(); poses are pooled and never allocated per frame. */
export type Pose = Float32Array;

export function createPose(): Pose {
  return new Float32Array(POSE_SIZE);
}

/** Animation clip ids chosen by the mapper (GFX-12) and implemented by GFX-09/10/11. Append only. */
export enum AnimId {
  IDLE = 0,
  JOG = 1,
  SPRINT = 2,
  TURN_LEAN = 3,
  PASS = 4,
  SHOT = 5,
  POWER_SHOT = 6,
  FINESSE = 7,
  HEADER = 8,
  VOLLEY = 9,
  FIRST_TOUCH = 10,
  SHIELD = 11,
  STAND_TACKLE = 12,
  SLIDE = 13,
  GET_UP = 14,
  STUMBLE = 15,
  FALL = 16,
  THROW_IN = 17,
  KEEPER_READY = 18,
  DIVE_LOW_L = 19,
  DIVE_LOW_R = 20,
  DIVE_MID_L = 21,
  DIVE_MID_R = 22,
  DIVE_HIGH_L = 23,
  DIVE_HIGH_R = 24,
  CATCH = 25,
  PARRY = 26,
  GK_THROW = 27,
  GK_KICK = 28,
  CELEBRATE_1 = 29,
  CELEBRATE_2 = 30,
  CELEBRATE_3 = 31,
  DEJECTION = 32,
  JOCKEY = 33,
  SKILL = 34,
  WALL_JUMP = 35,
  KEEPER_HOLD = 36,
  STRAFE = 37,
}

/**
 * A pose function writes the pose of clip `anim` at normalised phase t (0..1) into out.
 * `cycle` is the distance-driven phase for locomotion (radians of the stride cycle), `speed` m/s,
 * `side` -1/+1 for mirrored clips, `foot` 0 right / 1 left for kicks.
 */
export type PoseFn = (out: Pose, t: number, cycle: number, speed: number, side: number, foot: number) => void;

/** Render statistics for diagnostics and the benchmark. */
export interface RenderStats {
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  resolutionScale: number;
  qualityTier: number;
}
