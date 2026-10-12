/**
 * [SIM-03] Pitch geometry: lines, areas, goal volumes, out-of-play and goal detection.
 * "Out of play and goals need the whole ball over the whole line. Test them as a swept segment between ticks
 * so a fast ball cannot skip the line." A goal also requires under the bar and between the posts at the
 * crossing point; detection must not count a ball entering through the side netting.
 *
 * GEOMETRY (metres; origin at the centre spot, x along the length, z across, y up). `end` = -1 / +1 names the goal
 * at x = -52.5 / +52.5; u = end * x grows toward (and into) that goal.
 *  - Lines belong to the areas they bound. Pitch dimensions run to the OUTER edges of the lines: the field of play is
 *    |x| <= HALF_LENGTH, |z| <= HALF_WIDTH; penalty area u in [HALF_LENGTH - 16.5, HALF_LENGTH], |z| <= 20.16; goal
 *    area u in [HALF_LENGTH - 5.5, HALF_LENGTH], |z| <= 9.16 (all inclusive).
 *  - "Whole ball over the whole line" = the ball centre is beyond the outer edge of the line by MORE than
 *    BALL_RADIUS. The out-of-play planes are u = BALL_OUT_X = HALF_LENGTH + BALL_RADIUS (goal lines) and
 *    |z| = BALL_OUT_Z = HALF_WIDTH + BALL_RADIUS (touchlines). A centre exactly on a plane still touches the line:
 *    in play. The ball is on the field side while |x| <= BALL_OUT_X and |z| <= BALL_OUT_Z (the in-play rectangle).
 *  - Goal mouth (inGoalMouth): between the inner faces of the posts (|z| < GOAL_HALF_WIDTH) and under the underside
 *    of the bar (y < GOAL_HEIGHT), tested on the ball centre - the same strict box SIM-02 (ball/contact.ts) uses for
 *    the net volume. The posts, bar and net sheets keep the centre >= BALL_RADIUS inside that box or outside it, so
 *    real paths never sit on its boundary.
 *  - Goal volume (insideGoal): BALL_OUT_X < u < HALF_LENGTH + GOAL_DEPTH inside the mouth: the whole ball is over the
 *    goal line, in the net.
 *
 * SWEPT CROSSING (detectCrossing): the ball centre moves along the straight segment A -> B (one SIM-02 substep; every
 * substep segment of the tick is passed in order, so the union is the tick's path, bent by posts and nets).
 *  1. NONE if a crossing is already recorded this tick (s.ball.cross != NONE) or a coordinate is not finite.
 *  2. Field side: A must be inside the in-play rectangle. A ball already wholly out (behind a goal line, in a net,
 *     past a touchline) cannot cross again, so a crossing is reported once per exit and never from outside in.
 *  3. If B is beyond a goal-line plane (end = sign of B.x), the segment passes u = BALL_OUT_X at
 *     tG = (BALL_OUT_X - uA) / (uB - uA), in [0, 1) because uA <= BALL_OUT_X < uB. If the centre there is still
 *     within the touchline planes (|z(tG)| <= BALL_OUT_Z, corner tie within CORNER_EPS), the goal line was crossed
 *     first; otherwise (or if only B.z is beyond) the touchline was crossed first at tT. At the corner flag itself
 *     (both planes at once, i.e. the crossing point within CORNER_EPS of the corner, whichever plane the rounding put
 *     it on) the goal line wins: corner or goal kick, never a throw-in.
 *  4. Touchline: TOUCHLINE, crossX = x(tT), crossZ = side * BALL_OUT_Z, crossEnd = 0.
 *  5. Goal line at `end`: NONE if the ball is already in that net (inNet === end; SIM-02's in-net front wall holds it
 *     at exactly u = BALL_OUT_X, so without this check a ball in the net could "cross" again: a goal counts once).
 *     GOAL when the centre is inside the goal mouth both at the crossing point (u = BALL_OUT_X) and where the segment
 *     passes the goal line itself (u = HALF_LENGTH; or at A when A is already past the goal line). The mouth
 *     cross-section is convex, so the whole piece of the path between the goal line and the crossing point stayed
 *     in the mouth: the ball went in through the goal-mouth plane. A path that reaches the goal volume from the side
 *     (side netting) or from the top (roof) is GOAL_LINE, never GOAL. Otherwise GOAL_LINE (goal kick / corner).
 *     crossX = end * BALL_OUT_X, crossZ = z(tG), crossEnd = end.
 * Deterministic (only + - * / and comparisons) and allocation-free (no objects, closures or boxed temporaries).
 */
import {
  BALL_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_DEPTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH,
  PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST, CROSS_ZONE_DEPTH, CROSS_ZONE_MIN_Z,
} from '../../contracts/constants';
import { CrossKind } from '../../contracts/enums';
import type { SimState } from '../../contracts/state';

/** Goal-line out-of-play plane |x| (m): the whole ball is over a goal line when |centre x| > BALL_OUT_X. */
export const BALL_OUT_X = HALF_LENGTH + BALL_RADIUS;
/** Touchline out-of-play plane |z| (m): the whole ball is over a touchline when |centre z| > BALL_OUT_Z. */
export const BALL_OUT_Z = HALF_WIDTH + BALL_RADIUS;
/** Back of the net, u (m). */
const GOAL_BACK = HALF_LENGTH + GOAL_DEPTH;
/**
 * Numerical tolerance (m) for the corner-flag tie between the goal-line and touchline planes (a path through the
 * exact corner can land 1 ulp either side after interpolation). Geometry rounding only, not a gameplay value.
 */
const CORNER_EPS = 1e-9;
const OUT_X_EPS = BALL_OUT_X - CORNER_EPS;
const OUT_Z_EPS = BALL_OUT_Z + CORNER_EPS;
const NEG_OUT_X = -BALL_OUT_X;
const NEG_OUT_Z = -BALL_OUT_Z;

/**
 * The segment under test, (x0, y0, z0, x1, y1, z1). detectCrossing itself is only the quick rejects, kept tiny so V8
 * can inline it into SIM-02's substep (V8 boxes every fresh double passed to a call it does not inline; JSC never
 * does); the full test reads the segment from here, so calling it boxes nothing.
 */
const SEG = new Float64Array(6);

/**
 * Swept test of the ball centre moving (x0,y0,z0) -> (x1,y1,z1) during this tick. If the WHOLE ball crossed a
 * touchline or goal line (centre beyond the line by BALL_RADIUS), set s.ball.cross / crossX / crossZ / crossEnd
 * (only if s.ball.cross is NONE) and return the kind; otherwise return NONE. See the header for the geometry.
 */
export function detectCrossing(s: SimState, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): CrossKind {
  if (s.ball.cross !== CrossKind.NONE) return CrossKind.NONE;
  // B still in the in-play rectangle (or NaN): no crossing.
  if (!(x1 > BALL_OUT_X || x1 < NEG_OUT_X || z1 > BALL_OUT_Z || z1 < NEG_OUT_Z)) return CrossKind.NONE;
  // Field side: A must be in the in-play rectangle (a ball already wholly out cannot cross again; NaN -> NONE).
  if (!(x0 <= BALL_OUT_X && x0 >= NEG_OUT_X && z0 <= BALL_OUT_Z && z0 >= NEG_OUT_Z)) return CrossKind.NONE;
  const g = SEG;
  g[0] = x0; g[1] = y0; g[2] = z0; g[3] = x1; g[4] = y1; g[5] = z1;
  return judgeCrossing(s);
}

/** The full swept test on SEG (A in the in-play rectangle, B beyond at least one out-of-play plane). */
function judgeCrossing(s: SimState): CrossKind {
  const b = s.ball;
  const x0 = SEG[0]!;
  const y0 = SEG[1]!;
  const z0 = SEG[2]!;
  const x1 = SEG[3]!;
  const y1 = SEG[4]!;
  const z1 = SEG[5]!;
  // Non-finite input (v - v is NaN for NaN and +-Infinity): nothing to judge.
  if (x1 - x1 !== 0 || y0 - y0 !== 0 || y1 - y1 !== 0 || z1 - z1 !== 0) return CrossKind.NONE;
  const overZ = z1 > BALL_OUT_Z || z1 < NEG_OUT_Z;
  if (x1 > BALL_OUT_X || x1 < NEG_OUT_X) {
    const end = x1 < 0 ? -1 : 1;
    const u0 = end * x0;
    const du = end * x1 - u0; // > 0: u0 <= BALL_OUT_X < u1
    const t = (BALL_OUT_X - u0) / du;
    const zc = z0 + (z1 - z0) * t;
    const azc = Math.abs(zc);
    if (azc <= OUT_Z_EPS) {
      // Over the goal line first (or exactly at the corner flag). A ball already in that net (held by its front wall
      // at exactly u = BALL_OUT_X) was already given as a goal: no second crossing.
      if (b.inNet === end) return CrossKind.NONE;
      const yc = y0 + (y1 - y0) * t;
      // Entry: where the centre passed the goal line itself (te > 0), or A when A is already past it (te = 0).
      const te = Math.max(0, (HALF_LENGTH - u0) / du);
      const aze = Math.abs(z0 + (z1 - z0) * te);
      const ye = y0 + (y1 - y0) * te;
      const kind = azc < GOAL_HALF_WIDTH && yc < GOAL_HEIGHT && aze < GOAL_HALF_WIDTH && ye < GOAL_HEIGHT
        ? CrossKind.GOAL : CrossKind.GOAL_LINE;
      b.cross = kind;
      b.crossX = end * BALL_OUT_X;
      b.crossZ = Math.max(NEG_OUT_Z, Math.min(BALL_OUT_Z, zc));
      b.crossEnd = end;
      return kind;
    }
    // |z(tG)| > BALL_OUT_Z: the ball went over the touchline before reaching the goal-line plane.
  }
  if (!overZ) return CrossKind.NONE;
  // Over the touchline first.
  const side = z1 < 0 ? -1 : 1;
  const w0 = side * z0;
  const t = (BALL_OUT_Z - w0) / (side * z1 - w0); // w0 <= BALL_OUT_Z < w1
  const xc = x0 + (x1 - x0) * t;
  if (Math.abs(xc) >= OUT_X_EPS) {
    // Exactly at the corner flag (e.g. a substep that ended on the corner point rounded to the touchline side):
    // the goal line wins, as in the goal-line branch. Never a goal (|z| > GOAL_HALF_WIDTH), and never in a net.
    const end = xc < 0 ? -1 : 1;
    b.cross = CrossKind.GOAL_LINE;
    b.crossX = end * BALL_OUT_X;
    b.crossZ = side * BALL_OUT_Z;
    b.crossEnd = end;
    return CrossKind.GOAL_LINE;
  }
  b.cross = CrossKind.TOUCHLINE;
  b.crossX = xc; // |xc| < BALL_OUT_X here
  b.crossZ = side * BALL_OUT_Z;
  b.crossEnd = 0;
  return CrossKind.TOUCHLINE;
}

/** end = -1 for the goal at x = -52.5, +1 for x = +52.5. Lines included. */
export function inPenaltyArea(x: number, z: number, end: number): boolean {
  const dx = end * x;
  return dx >= HALF_LENGTH - PENALTY_AREA_DEPTH && dx <= HALF_LENGTH && z >= -PENALTY_AREA_HALF_WIDTH && z <= PENALTY_AREA_HALF_WIDTH;
}
/** Goal area (six-yard box) of goal `end`, lines included. */
export function inGoalArea(x: number, z: number, end: number): boolean {
  const dx = end * x;
  return dx >= HALF_LENGTH - GOAL_AREA_DEPTH && dx <= HALF_LENGTH && z >= -GOAL_AREA_HALF_WIDTH && z <= GOAL_AREA_HALF_WIDTH;
}
/** Crossing zone for a team attacking toward `dir`: within CROSS_ZONE_DEPTH of that goal line and |z| >= CROSS_ZONE_MIN_Z. */
export function inCrossingZone(x: number, z: number, dir: number): boolean {
  return dir * x >= HALF_LENGTH - CROSS_ZONE_DEPTH && (z >= CROSS_ZONE_MIN_Z || z <= -CROSS_ZONE_MIN_Z);
}
/** Inside the field of play (lines included), optional margin (positive = shrink). */
export function onPitch(x: number, z: number, margin = 0): boolean {
  return x >= -HALF_LENGTH + margin && x <= HALF_LENGTH - margin && z >= -HALF_WIDTH + margin && z <= HALF_WIDTH - margin;
}
/**
 * Goal volume containing the ball centre (x, y, z): end (-1/+1) if the whole ball is over that goal line inside the
 * net (BALL_OUT_X < u < HALF_LENGTH + GOAL_DEPTH, |z| < GOAL_HALF_WIDTH, y < GOAL_HEIGHT), else 0.
 */
export function insideGoal(x: number, y: number, z: number): number {
  if (!(y < GOAL_HEIGHT && z < GOAL_HALF_WIDTH && z > -GOAL_HALF_WIDTH)) return 0;
  if (x < -BALL_OUT_X && x > -GOAL_BACK) return -1;
  if (x > BALL_OUT_X && x < GOAL_BACK) return 1;
  return 0;
}
/** Ball centre (y, z) inside the goal-mouth opening: between the inner faces of the posts and under the bar. */
export function inGoalMouth(y: number, z: number): boolean {
  return z < GOAL_HALF_WIDTH && z > -GOAL_HALF_WIDTH && y < GOAL_HEIGHT;
}
/** The whole ball (centre x, z) is over a goal line or a touchline (out of play by position). NaN -> false. */
export function ballOverLine(x: number, z: number): boolean {
  return x > BALL_OUT_X || x < -BALL_OUT_X || z > BALL_OUT_Z || z < -BALL_OUT_Z;
}
/** Clamp a point into the pitch (with margin, positive = shrink). NaN -> 0 (centre line); margin past the half-size -> 0. */
export function clampToPitch(x: number, z: number, margin: number, out: { x: number; z: number }): void {
  const hx = HALF_LENGTH - margin;
  const hz = HALF_WIDTH - margin;
  out.x = !(hx >= 0) || !(x === x) ? 0 : x > hx ? hx : x < -hx ? -hx : x;
  out.z = !(hz >= 0) || !(z === z) ? 0 : z > hz ? hz : z < -hz ? -hz : z;
}
/** Penalty spot x for goal `end` (z = 0). */
export function penaltySpot(end: number): number {
  return end * (HALF_LENGTH - PENALTY_SPOT_DIST);
}
/** In the own half of a team attacking toward `dir` (the halfway line counts as own half, as for offside). */
export function isInOwnHalf(x: number, dir: number): boolean {
  return dir * x <= 0;
}
/** Distance (m, on the ground plane) from (x, z) to the goal-mouth segment of goal `end` (x = end * HALF_LENGTH, |z| <= GOAL_HALF_WIDTH). */
export function distToGoalMouth(x: number, z: number, end: number): number {
  const dx = end * HALF_LENGTH - x;
  const az = z < 0 ? -z : z;
  const dz = az > GOAL_HALF_WIDTH ? az - GOAL_HALF_WIDTH : 0;
  return Math.sqrt(dx * dx + dz * dz);
}
