/**
 * [SIM-01] Ball flight: gravity, quadratic air drag, Magnus force from spin (curl, dip, backspin float),
 * spin decay; trajectory prediction and launch solvers used by passes, shots, keepers and AI.
 * Section 6 "Ball". Reference feel: ground pass 9-22 m/s; a 15 m/s pass rolls ~30 m; hard shot 25-36 m/s;
 * goal kick carries 45-60 m; bounce height roughly halves each bounce. Constants: T_BALL.
 * WAVE 0 BASELINE: gravity only. SIM-01 replaces it.
 */
import { T_BALL } from '../../contracts/tuning';
import type { BallState } from '../../contracts/state';
import type { BallPrediction } from '../../contracts/systems';
import type { V3 } from '../core/vec';

/** Integrate an AIRBORNE ball by dt seconds (forces + spin decay). No collisions (SIM-02 does those). */
export function ballAirStep(b: BallState, dt: number): void {
  b.vy -= T_BALL.gravity * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
}

/**
 * Predict the ball path for `ticks` ticks (<= MAX_PREDICT_TICKS) using the same physics as the sim
 * (SIM-02 ballPhysicsStep with no events), without touching `b`. Fills out.x/y/z and out.landIndex
 * (first sample at or below 0.5 m while descending after being above it; -1 none).
 */
export function predictBall(b: Readonly<BallState>, ticks: number, out: BallPrediction): void {
  out.count = 0;
  out.landIndex = -1;
}

/** Launch speed for a ground pass that arrives at `dist` metres with roughly `arriveSpeed` m/s. */
export function groundPassSpeed(dist: number, arriveSpeed: number): number {
  return Math.min(22, Math.max(9, Math.sqrt(arriveSpeed * arriveSpeed + 2 * T_BALL.rollDecel * dist)));
}

/**
 * Velocity for a lofted ball that lands at horizontal offset (dx, dz) from the ball, launched at `angle`
 * radians above horizontal, including drag (iterative). Writes the velocity into out and returns its speed.
 */
export function solveLaunch(dx: number, dz: number, angle: number, out: V3): number {
  out.x = 0; out.y = 0; out.z = 0;
  return 0;
}

/** Ticks until an airborne ball descends to height h (or -1 if it never does within 300 ticks). */
export function ticksToHeight(b: Readonly<BallState>, h: number): number {
  return -1;
}
