/**
 * [SIM-13] Skill moves and fake shot. Eight to start: ball roll, step-over, body feint, drag-back, fake shot,
 * roulette, heel flick, knock-on (+ STOP_BALL, STOP_FACE_GOAL, HARD_STOP utility touches). Each has a fixed
 * duration (T_SKILL.duration), an exit direction and a window where the ball can be won (T_SKILL.vulnStart/
 * vulnEnd). The skill-star rating (attrs.skillMoves) gates the harder ones (T_SKILL.minStars). Emits SKILL.
 */
import type { SkillMove } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { ActionHandler, KickLaunch } from '../../contracts/systems';
import type { SimState } from '../../contracts/state';

/** Start a skill toward (dirX, dirZ) (pitch space; 0,0 = facing). Returns 1 if started. */
export function startSkill(s: SimState, slot: number, skill: SkillMove, dirX: number, dirZ: number, ev: EventSink): number { return 0; }
/** Cancel a KICK/SHOT wind-up into a fake (B or X then A). Returns 1 if converted. */
export function startFake(s: SimState, slot: number, ev: EventSink): number { return 0; }
/** True while slot is in the vulnerable window of a skill (ball can be won). */
export function inSkillVulnerableWindow(s: SimState, slot: number): boolean { return false; }
/** KickSolver for KNOCK_ON, SKILL_TOUCH, DRIBBLE_TOUCH touches started as KICK actions. */
export function solveSkillTouch(s: SimState, slot: number, out: KickLaunch): number { return 0; }
export const skillHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const fakeHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
