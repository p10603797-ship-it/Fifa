/**
 * [GFX-10] Animation: kicks, headers, touches, throw-ins (section 8 animation set: pass, shot, power shot, finesse,
 * header, volley, first touch, shield, throw-in, keeper throw and kick, skill). The kicking foot meets the ball on
 * the sim contact tick: `t` is the normalised action phase from the sim (p.actT / p.actDur) and GFX-12 aligns the
 * contact frame with p.actContact. `foot` 0 = right, 1 = left; `side` mirrors.
 *
 * WAVE 0 STUB (FND-05): every clip writes the neutral pose. GFX-10 implements the clips.
 */

import { AnimId, type Pose, type PoseFn } from '../../contracts/render';
import type { PoseTable } from '../types';

const neutral: PoseFn = (out: Pose) => {
  out.fill(0);
};

export const ACTION_POSES: PoseTable = {
  [AnimId.PASS]: neutral,
  [AnimId.SHOT]: neutral,
  [AnimId.POWER_SHOT]: neutral,
  [AnimId.FINESSE]: neutral,
  [AnimId.HEADER]: neutral,
  [AnimId.VOLLEY]: neutral,
  [AnimId.FIRST_TOUCH]: neutral,
  [AnimId.SHIELD]: neutral,
  [AnimId.THROW_IN]: neutral,
  [AnimId.GK_THROW]: neutral,
  [AnimId.GK_KICK]: neutral,
  [AnimId.SKILL]: neutral,
};
