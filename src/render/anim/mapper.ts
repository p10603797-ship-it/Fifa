/**
 * [GFX-12] Animation mapping and blending from sim state (ARCHITECTURE rule 3: animation is derived from sim state
 * and never feeds back). Chooses a clip per player from p.act / p.actKick / p.actSkill / p.actT / p.actDur, speed,
 * sprint, jockey and shield flags; advances distance-driven stride cycles; blends poses on clip changes; aligns the
 * kick contact frame with the sim contact tick. Consumed by the player model (GFX-07).
 *
 * WAVE 0 STUB (FND-05): idle / jog / sprint by speed, no blending. GFX-12 implements the full mapping.
 */

import { NUM_SLOTS } from '../../contracts/constants';
import { AnimId, type Pose, type PoseFn } from '../../contracts/render';
import type { ReadonlySimState } from '../../contracts/state';
import { ACTION_POSES } from './actions';
import { CONTACT_POSES } from './contact';
import { LOCOMOTION_POSES, neutralPose } from './locomotion';

/** Clip choice for one player this frame. Reused; never allocate per frame. */
export interface AnimSample {
  anim: AnimId;
  /** Normalised phase 0..1 for action clips. */
  t: number;
  /** -1 / +1 mirror for sided clips. */
  side: number;
  /** 0 right foot, 1 left foot. */
  foot: number;
}

export function createAnimSample(): AnimSample {
  return { anim: AnimId.IDLE, t: 0, side: 1, foot: 0 };
}

/** Per-player animation memory (stride cycles, current clip, blend). Owned by the model, advanced by GFX-12. */
export interface AnimBank {
  /** Stride phase per slot (radians), advanced by distance travelled. */
  cycle: Float32Array;
  /** Current clip per slot. */
  anim: Uint8Array;
  /** Blend weight toward the current clip, 0..1. */
  blend: Float32Array;
}

export function createAnimBank(): AnimBank {
  return { cycle: new Float32Array(NUM_SLOTS), anim: new Uint8Array(NUM_SLOTS), blend: new Float32Array(NUM_SLOTS).fill(1) };
}

/** Stride length per full cycle (m) at jog; GFX-09/12 tune it so feet do not slide. */
export const STRIDE_LENGTH = 2.6;

/** Advance a slot's stride cycle by the distance moved this frame (m). */
export function advanceCycle(bank: AnimBank, slot: number, distance: number): void {
  let c = bank.cycle[slot]! + (distance / STRIDE_LENGTH) * Math.PI * 2;
  if (c > Math.PI * 2) c -= Math.PI * 2 * Math.floor(c / (Math.PI * 2));
  bank.cycle[slot] = c;
}

/** Choose the clip for `slot` from discrete sim facts and the interpolated speed (m/s). Pure, no allocation. */
export function mapAnim(state: ReadonlySimState, slot: number, speed: number, out: AnimSample): void {
  const p = state.players[slot]!;
  out.t = 0;
  out.side = 1;
  out.foot = 0;
  if (speed < 0.3) out.anim = AnimId.IDLE;
  else if (p.sprinting === 1) out.anim = AnimId.SPRINT;
  else out.anim = AnimId.JOG;
}

/** PoseFn lookup indexed by AnimId (built once at module load). */
const POSE_FNS: PoseFn[] = [];
for (let i = 0; i <= AnimId.STRAFE; i++) {
  const id = i as AnimId;
  POSE_FNS[i] = LOCOMOTION_POSES[id] ?? ACTION_POSES[id] ?? CONTACT_POSES[id] ?? neutralPose;
}

export function poseFnFor(anim: AnimId): PoseFn {
  return POSE_FNS[anim] ?? neutralPose;
}

/** Write the pose for a sample into `out`. */
export function samplePose(sample: AnimSample, cycle: number, speed: number, out: Pose): void {
  poseFnFor(sample.anim)(out, sample.t, cycle, speed, sample.side, sample.foot);
}
