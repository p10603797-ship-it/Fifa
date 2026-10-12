/**
 * [TAI-01] Formations and role home positions. Formations 4-4-2, 4-3-3, 4-2-3-1, 3-5-2, 5-3-2, 4-1-2-1-2
 * (data/formations.ts). Each role's home position shifts with the ball, the team phase (build-up, attack,
 * defend, transition) and the tactical focus; staggered updates (T_AI.shapeInterval, team.shapeT). Writes
 * team.homeX/homeZ (per formIdx) and every player's homeX/homeZ. Mirror for attack direction (team.dir).
 * Handles teams playing short (fewer than 11) by stretching remaining roles.
 */
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';

export function updateShape(s: SimState, team: number, ev: EventSink): void { /* stub */ }
/** Base home position for a formation index given ball position (pure). */
export function homePosition(s: SimState, team: number, formIdx: number, out: { x: number; z: number }): void { out.x = 0; out.z = 0; }
