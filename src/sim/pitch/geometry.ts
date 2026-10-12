/**
 * [SIM-03] Pitch geometry: lines, areas, goal volumes, out-of-play and goal detection.
 * "Out of play and goals need the whole ball over the whole line. Test them as a swept segment between ticks
 * so a fast ball cannot skip the line." A goal also requires under the bar and between the posts at the
 * crossing point; detection must not count a ball entering through the side netting.
 * WAVE 0 BASELINE: queries implemented; detectCrossing returns NONE. SIM-03 owns and hardens all of it.
 */
import {
  BALL_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH,
  PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, CROSS_ZONE_DEPTH, CROSS_ZONE_MIN_Z,
} from '../../contracts/constants';
import { CrossKind } from '../../contracts/enums';
import type { SimState } from '../../contracts/state';

/**
 * Swept test of the ball centre moving (x0,y0,z0) -> (x1,y1,z1) during this tick. If the WHOLE ball crossed a
 * touchline or goal line (centre beyond the line by BALL_RADIUS), set s.ball.cross / crossX / crossZ / crossEnd
 * (only if s.ball.cross is NONE) and return the kind; otherwise return NONE.
 */
export function detectCrossing(s: SimState, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): CrossKind {
  return CrossKind.NONE;
}

/** end = -1 for the goal at x = -52.5, +1 for x = +52.5. */
export function inPenaltyArea(x: number, z: number, end: number): boolean {
  const dx = end * x;
  return dx >= HALF_LENGTH - PENALTY_AREA_DEPTH && dx <= HALF_LENGTH && z >= -PENALTY_AREA_HALF_WIDTH && z <= PENALTY_AREA_HALF_WIDTH;
}
export function inGoalArea(x: number, z: number, end: number): boolean {
  const dx = end * x;
  return dx >= HALF_LENGTH - GOAL_AREA_DEPTH && dx <= HALF_LENGTH && z >= -GOAL_AREA_HALF_WIDTH && z <= GOAL_AREA_HALF_WIDTH;
}
/** Crossing zone for a team attacking toward `dir`. */
export function inCrossingZone(x: number, z: number, dir: number): boolean {
  return dir * x >= HALF_LENGTH - CROSS_ZONE_DEPTH && (z >= CROSS_ZONE_MIN_Z || z <= -CROSS_ZONE_MIN_Z);
}
/** Inside the field of play (lines included), optional margin (positive = shrink). */
export function onPitch(x: number, z: number, margin = 0): boolean {
  return x >= -HALF_LENGTH + margin && x <= HALF_LENGTH - margin && z >= -HALF_WIDTH + margin && z <= HALF_WIDTH - margin;
}
/** Which goal mouth plane point (x, y, z) is inside: returns end (-1/+1) if within the goal volume behind the line, else 0. */
export function insideGoal(x: number, y: number, z: number): number {
  if (y > GOAL_HEIGHT || z < -GOAL_HALF_WIDTH || z > GOAL_HALF_WIDTH) return 0;
  if (x < -HALF_LENGTH - BALL_RADIUS) return -1;
  if (x > HALF_LENGTH + BALL_RADIUS) return 1;
  return 0;
}
/** Clamp a point into the pitch (with margin). */
export function clampToPitch(x: number, z: number, margin: number, out: { x: number; z: number }): void {
  out.x = Math.max(-HALF_LENGTH + margin, Math.min(HALF_LENGTH - margin, x));
  out.z = Math.max(-HALF_WIDTH + margin, Math.min(HALF_WIDTH - margin, z));
}
