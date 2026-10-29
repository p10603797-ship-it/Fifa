/**
 * Action handler and kick solver registry. Lead-owned. Maps every ActionKind to its owner's handler and every
 * foot-kick KickKind to its owner's solver. A null solver means the kind is applied directly by its module.
 */
import { ActionKind, KickKind } from '../../contracts/enums';
import type { ActionHandler, KickSolver } from '../../contracts/systems';
import { kickHandler, solveGroundPass } from '../kicks/pass';
import { solveCross, solveLob } from '../kicks/lob';
import { solveThrough } from '../kicks/through';
import { shotHandler, solveShot } from '../kicks/shot';
import { headerHandler, solveHeader, solveVolley, volleyHandler } from '../kicks/aerial';
import { fakeHandler, skillHandler, solveSkillTouch } from '../kicks/skills';
import {
  fallenHandler, getUpHandler, hardTackleHandler, pushPullHandler, shoulderHandler, slideTackleHandler, solveClearance,
  standTackleHandler, stumbleHandler,
} from '../defend/tackle';
import { firstTouchHandler } from '../players/firstTouch';
import { shieldHandler } from '../players/bodies';
import { catchHandler, diveHandler } from '../keeper/saves';
import { punchHandler, rushHandler } from '../keeper/sweeper';
import { gkKickHandler, holdHandler, solveKeeperRelease, throwHandler } from '../keeper/handling';
import { throwInHandler } from '../rules/throwin';
import { wallJumpHandler } from '../rules/freekick';
import { setPieceHandler } from '../rules/restart';
import { celebrateHandler, dejectedHandler } from '../rules/machine';

const idle: ActionHandler = { update() { /* none */ }, end() { /* none */ } };

export const ACTION_HANDLERS: readonly ActionHandler[] = (() => {
  const h: ActionHandler[] = [];
  h[ActionKind.NONE] = idle;
  h[ActionKind.KICK] = kickHandler;
  h[ActionKind.SHOT] = shotHandler;
  h[ActionKind.HEADER] = headerHandler;
  h[ActionKind.VOLLEY] = volleyHandler;
  h[ActionKind.FIRST_TOUCH] = firstTouchHandler;
  h[ActionKind.SKILL] = skillHandler;
  h[ActionKind.FAKE] = fakeHandler;
  h[ActionKind.STAND_TACKLE] = standTackleHandler;
  h[ActionKind.HARD_TACKLE] = hardTackleHandler;
  h[ActionKind.SLIDE_TACKLE] = slideTackleHandler;
  h[ActionKind.SHOULDER] = shoulderHandler;
  h[ActionKind.PUSH_PULL] = pushPullHandler;
  h[ActionKind.STUMBLE] = stumbleHandler;
  h[ActionKind.FALLEN] = fallenHandler;
  h[ActionKind.GET_UP] = getUpHandler;
  h[ActionKind.GK_DIVE] = diveHandler;
  h[ActionKind.GK_HOLD] = holdHandler;
  h[ActionKind.GK_THROW] = throwHandler;
  h[ActionKind.GK_KICK] = gkKickHandler;
  h[ActionKind.GK_RUSH] = rushHandler;
  h[ActionKind.GK_PUNCH] = punchHandler;
  h[ActionKind.GK_CATCH] = catchHandler;
  h[ActionKind.THROW_IN] = throwInHandler;
  h[ActionKind.SET_PIECE] = setPieceHandler;
  h[ActionKind.CELEBRATE] = celebrateHandler;
  h[ActionKind.DEJECTED] = dejectedHandler;
  h[ActionKind.WALL_JUMP] = wallJumpHandler;
  h[ActionKind.SHIELD] = shieldHandler;
  for (let i = 0; i <= ActionKind.SHIELD; i++) if (!h[i]) h[i] = idle;
  return h;
})();

export const KICK_SOLVERS: readonly (KickSolver | null)[] = (() => {
  const k: (KickSolver | null)[] = new Array<KickSolver | null>(KickKind.SHOT_TRIVELA + 1).fill(null);
  k[KickKind.GROUND_PASS] = solveGroundPass;
  k[KickKind.DRIVEN_PASS] = solveGroundPass;
  k[KickKind.DINKED_PASS] = solveGroundPass;
  k[KickKind.KICK_OFF] = solveGroundPass;
  k[KickKind.LOB_PASS] = solveLob;
  k[KickKind.HIGH_LOB] = solveLob;
  k[KickKind.DRIVEN_LOB] = solveLob;
  k[KickKind.GOAL_KICK] = solveLob;
  k[KickKind.CROSS] = solveCross;
  k[KickKind.GROUND_CROSS] = solveCross;
  k[KickKind.LOW_CROSS] = solveCross;
  k[KickKind.THROUGH_GROUND] = solveThrough;
  k[KickKind.THROUGH_LOBBED] = solveThrough;
  k[KickKind.THROUGH_DINKED] = solveThrough;
  k[KickKind.SHOT_NORMAL] = solveShot;
  k[KickKind.SHOT_FINESSE] = solveShot;
  k[KickKind.SHOT_TRIVELA] = solveShot;
  k[KickKind.SHOT_CHIP] = solveShot;
  k[KickKind.SHOT_POWER] = solveShot;
  k[KickKind.SHOT_LOW_DRIVEN] = solveShot;
  k[KickKind.FREE_KICK_SHOT] = solveShot;
  k[KickKind.PENALTY] = solveShot;
  k[KickKind.HEADER_SHOT] = solveHeader;
  k[KickKind.HEADER_PASS] = solveHeader;
  k[KickKind.VOLLEY_SHOT] = solveVolley;
  k[KickKind.VOLLEY_PASS] = solveVolley;
  k[KickKind.CLEARANCE] = solveClearance;
  k[KickKind.KNOCK_ON] = solveSkillTouch;
  k[KickKind.SKILL_TOUCH] = solveSkillTouch;
  k[KickKind.DRIBBLE_TOUCH] = solveSkillTouch;
  k[KickKind.GK_THROW] = solveKeeperRelease;
  k[KickKind.GK_DRIVEN_THROW] = solveKeeperRelease;
  k[KickKind.GK_ROLL] = solveKeeperRelease;
  k[KickKind.GK_DROP_KICK] = solveKeeperRelease;
  k[KickKind.GK_DRIVEN_KICK] = solveKeeperRelease;
  k[KickKind.GK_RELEASE] = solveKeeperRelease;
  return k;
})();
