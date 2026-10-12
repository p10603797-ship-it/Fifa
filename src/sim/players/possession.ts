/**
 * [SIM-06] Possession and dribbling (section 6). The ball stays its own physics object: the owner guides it
 * with touches ahead of his feet (closer at a jog, further at a sprint; close control when strafing/jockey-
 * dribbling), so it can be poked away between touches. Picks up loose balls that come within control range
 * (when no higher-priority contact happened this tick), and drops possession when the ball gets away.
 * Uses sim/core/kick.ts helpers (takePossession, releasePossession, recordTouch). Constants: T_DRIBBLE.
 * Runs LAST in the contact phase.
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';

export function dribbleTick(s: SimState, ev: EventSink): void {
  // Wave 0 stub.
}

/** True if `slot` could touch the ball this tick (distance, height, not stunned, noTouchT expired). */
export function canTouchBall(s: SimState, slot: number): boolean {
  return false;
}
