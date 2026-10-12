/** [SIM-02] Shared helpers for the ball contact tests (not a test file itself). */
import {
  BALL_RADIUS, GOAL_DEPTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, POST_RADIUS,
} from '../../src/contracts/constants';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { createBallState, type BallState } from '../../src/contracts/state';
import { ballStepTick } from '../../src/sim/ball/contact';
import { createEventBuffer } from '../../src/sim/core/events';

export const R = BALL_RADIUS;
/** Frame axes (end-relative u = end * x), same as contact.ts / render/goals.ts. */
export const FR_U = HALF_LENGTH - POST_RADIUS;
export const FR_Z = GOAL_HALF_WIDTH + POST_RADIUS;
export const FR_Y = GOAL_HEIGHT + POST_RADIUS;
export const FR_R = BALL_RADIUS + POST_RADIUS;
export const GL = HALF_LENGTH;
export const GB = HALF_LENGTH + GOAL_DEPTH;
export const GW = GOAL_HALF_WIDTH;
export const GH = GOAL_HEIGHT;

export function ball(over: Partial<BallState> = {}): BallState {
  const b = createBallState();
  Object.assign(b, over);
  if (over.y !== undefined && over.grounded === undefined) b.grounded = over.y > R + 1e-9 ? 0 : 1;
  return b;
}

export interface TickObs {
  /** Ball state after the tick (copy of the kinematics). */
  x: number; y: number; z: number; vx: number; vy: number; vz: number; inNet: number;
  /** Ball position at the start of the tick. */
  x0: number; y0: number; z0: number;
}

/** Run n ticks of ballStepTick; returns per-tick observations and all events (copied). */
export function runBall(b: BallState, n: number, onTick?: (i: number, b: BallState) => void): { obs: TickObs[]; events: SimEvent[] } {
  const ev = createEventBuffer();
  const obs: TickObs[] = [];
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = b.x;
    const y0 = b.y;
    const z0 = b.z;
    ev.begin(i + 1);
    ballStepTick(b, ev);
    for (const e of ev.toArray()) events.push(e);
    obs.push({ x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, inNet: b.inNet, x0, y0, z0 });
    if (onTick) onTick(i, b);
  }
  return { obs, events };
}

export function ofType(events: readonly SimEvent[], t: EventType): SimEvent[] {
  return events.filter((e) => e.type === t);
}

export function speed(b: { vx: number; vy: number; vz: number }): number {
  return Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
}

export function allFinite(b: BallState): boolean {
  for (const v of [b.x, b.y, b.z, b.vx, b.vy, b.vz, b.sx, b.sy, b.sz]) if (!Number.isFinite(v)) return false;
  return true;
}

/** Distance from point (u, y, z) (end-relative) to the nearest frame capsule axis (posts + bar). */
export function frameDist(u: number, y: number, z: number): number {
  let best = Infinity;
  for (const side of [-1, 1]) {
    const cy = Math.min(Math.max(y, 0), FR_Y);
    best = Math.min(best, Math.hypot(u - FR_U, y - cy, z - side * FR_Z));
  }
  const cz = Math.min(Math.max(z, -FR_Z), FR_Z);
  best = Math.min(best, Math.hypot(u - FR_U, y - FR_Y, z - cz));
  return best;
}

/** Minimum frame distance along a straight segment (sampled), end-relative coordinates. */
export function segFrameDist(u0: number, y0: number, z0: number, u1: number, y1: number, z1: number, samples = 64): number {
  let best = Infinity;
  for (let k = 0; k <= samples; k++) {
    const t = k / samples;
    best = Math.min(best, frameDist(u0 + (u1 - u0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t));
  }
  return best;
}

/** Centre strictly inside the net box of goal `end`. */
export function inNetBox(end: number, x: number, y: number, z: number): boolean {
  const u = end * x;
  return u > GL && u < GB && y < GH && z < GW && z > -GW;
}
