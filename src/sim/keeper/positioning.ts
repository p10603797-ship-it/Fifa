/**
 * [GKP-01] Keeper positioning: on the arc between ball and goal centre, with depth adjusted for distance and
 * angle (T_GK.depthFar/depthNear); sets the keeper's movement intent (ARRIVE) when free and not acting.
 * Works for both teams, every attack direction. Keeper never carries the ball over his own line.
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';

export function keeperPositioning(s: SimState, team: number, ev: EventSink): void { /* stub */ }
/** Ideal keeper position for the current ball position (pure). */
export function idealKeeperSpot(s: SimState, team: number, out: { x: number; z: number }): void { out.x = 0; out.z = 0; }
