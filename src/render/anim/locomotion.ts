/**
 * [GFX-09] Animation: locomotion clips (idle, jog, sprint, turn lean, strafe, jockey). Section 8 "Look": run cycles
 * advance with distance travelled so feet do not slide (`cycle` is the distance-driven stride phase in radians);
 * poses blend (GFX-12). Pose layout: contracts/render.ts PoseIdx (model faces +x, +z to the player's right).
 *
 * WAVE 0 STUB (FND-05): a neutral idle and a simple sine leg/arm swing for jog and sprint as a template.
 * GFX-09 replaces the bodies of these functions; keep the table keys and PoseFn signature.
 */

import { AnimId, PoseIdx, type Pose, type PoseFn } from '../../contracts/render';
import type { PoseTable } from '../types';

/** Write the neutral standing pose (all joints 0). */
export const neutralPose: PoseFn = (out: Pose) => {
  out.fill(0);
};

/** Simple swing used by the jog/sprint stubs: amplitude in radians. */
function swing(out: Pose, cycle: number, legAmp: number, armAmp: number, lean: number): void {
  out.fill(0);
  const s = Math.sin(cycle);
  out[PoseIdx.ROOT_PITCH] = lean;
  out[PoseIdx.HIP_L_PITCH] = s * legAmp;
  out[PoseIdx.HIP_R_PITCH] = -s * legAmp;
  out[PoseIdx.KNEE_L] = Math.max(0, -s) * legAmp * 1.4;
  out[PoseIdx.KNEE_R] = Math.max(0, s) * legAmp * 1.4;
  out[PoseIdx.SHOULDER_L_PITCH] = -s * armAmp;
  out[PoseIdx.SHOULDER_R_PITCH] = s * armAmp;
  out[PoseIdx.ELBOW_L] = 0.9;
  out[PoseIdx.ELBOW_R] = 0.9;
  out[PoseIdx.ROOT_Y] = -Math.abs(Math.cos(cycle)) * 0.03;
}

export const LOCOMOTION_POSES: PoseTable = {
  [AnimId.IDLE]: neutralPose,
  [AnimId.JOG]: (out, _t, cycle) => swing(out, cycle, 0.55, 0.45, 0.06),
  [AnimId.SPRINT]: (out, _t, cycle) => swing(out, cycle, 0.85, 0.7, 0.16),
  [AnimId.TURN_LEAN]: (out, _t, cycle, _speed, side) => {
    swing(out, cycle, 0.55, 0.45, 0.06);
    out[PoseIdx.ROOT_ROLL] = 0.2 * side;
  },
  [AnimId.STRAFE]: (out, _t, cycle) => swing(out, cycle, 0.3, 0.2, 0.02),
  [AnimId.JOCKEY]: (out, _t, cycle) => {
    swing(out, cycle, 0.25, 0.15, 0.1);
    out[PoseIdx.ROOT_Y] -= 0.12;
  },
};
