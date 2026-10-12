/**
 * [RUL-10] Substitutions (up to 5, at any stoppage, from Command.SUBSTITUTE; a substituted player cannot
 * return; attributes copied into s.attrs; stamina fresh), sending off (slot inactive, team plays short, AI
 * reshapes; keeper sent off -> bench keeper replaces an outfield player, or with no subs left an outfield player
 * goes in goal), forfeit (below 7 players -> 3-0, FORFEIT). Maintains team.roster / onPitch / keeperSlot.
 * Never 12 players. Emits SUBSTITUTION.
 */
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

export function subsTick(s: SimState, ev: EventSink): void { /* stub */ }
/** Queue a substitution; returns 1 if accepted (valid, subs left, not already queued). */
export function requestSub(s: SimState, team: number, outSlot: number, inRoster: number): number { return 0; }
export function sendOff(s: SimState, slot: number, ev: EventSink): void { /* stub */ }
/** Ends the match 3-0 when a team is below MIN_PLAYERS. Returns 1 if it did. */
export function checkForfeit(s: SimState, ev: EventSink): number { return 0; }
