/**
 * [GFX-11] Animation: tackles, falls, keeper, celebrations (section 8 animation set: standing tackle, slide and
 * get-up, stumble, fall, keeper ready, keeper dives low/mid/high each side, catch, parry, keeper holding, wall
 * jump, three celebrations, dejection). `t` is the normalised sim action phase; dives use ROOT_FWD/ROOT_SIDE and
 * ROOT_ROLL so the body travels with the sim's dive.
 *
 * WAVE 0 STUB (FND-05): every clip writes the neutral pose. GFX-11 implements the clips.
 */

import { AnimId, type Pose, type PoseFn } from '../../contracts/render';
import type { PoseTable } from '../types';

const neutral: PoseFn = (out: Pose) => {
  out.fill(0);
};

export const CONTACT_POSES: PoseTable = {
  [AnimId.STAND_TACKLE]: neutral,
  [AnimId.SLIDE]: neutral,
  [AnimId.GET_UP]: neutral,
  [AnimId.STUMBLE]: neutral,
  [AnimId.FALL]: neutral,
  [AnimId.KEEPER_READY]: neutral,
  [AnimId.DIVE_LOW_L]: neutral,
  [AnimId.DIVE_LOW_R]: neutral,
  [AnimId.DIVE_MID_L]: neutral,
  [AnimId.DIVE_MID_R]: neutral,
  [AnimId.DIVE_HIGH_L]: neutral,
  [AnimId.DIVE_HIGH_R]: neutral,
  [AnimId.CATCH]: neutral,
  [AnimId.PARRY]: neutral,
  [AnimId.KEEPER_HOLD]: neutral,
  [AnimId.WALL_JUMP]: neutral,
  [AnimId.CELEBRATE_1]: neutral,
  [AnimId.CELEBRATE_2]: neutral,
  [AnimId.CELEBRATE_3]: neutral,
  [AnimId.DEJECTION]: neutral,
};
