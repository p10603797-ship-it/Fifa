/**
 * [TAI-06] Team phase and transitions: updateTeamPhase sets team.phase/phaseT (build-up, attack, defend,
 * transition attack/defend, set piece) from possession and ball position, and team.possT/lostT;
 * assignTransition drives counter-attack runs after winning the ball and RECOVER runs after losing it.
 */
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';

export function updateTeamPhase(s: SimState, team: number, ev: EventSink): void { /* stub */ }
export function assignTransition(s: SimState, team: number, ev: EventSink): void { /* stub */ }
