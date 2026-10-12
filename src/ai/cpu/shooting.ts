/**
 * [TAI-10] CPU shooting, dribbling and skill choices: expected-goal estimate from distance, angle, pressure and
 * keeper position; dribble-into-space scoring; skill move choice by skill stars and defender position.
 */
import type { SkillMove } from '../../contracts/enums';
import type { SimState } from '../../contracts/state';

/** Expected-goal estimate 0..1 for a shot by slot from (x, z). Pure. */
export function estimateXg(s: SimState, slot: number, x: number, z: number): number { return 0; }
/** Best dribble direction for slot into space; returns a score 0..1 and writes the unit direction. */
export function bestDribble(s: SimState, slot: number, out: { x: number; z: number }): number { out.x = 0; out.z = 0; return 0; }
/** Skill move to beat the nearest defender, or SkillMove.NONE. */
export function chooseSkill(s: SimState, slot: number): SkillMove { return 0; }
