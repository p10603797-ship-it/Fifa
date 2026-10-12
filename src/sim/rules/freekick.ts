/**
 * [RUL-05] Free kicks and walls - direct free kicks at the foul spot; wall of 2-5 by distance and angle placed 9.15 m away; aim, curl/dip, shoot/finesse/chip, ground pass, lob/cross, choose taker (SPRINT); defending - wall jump (THROUGH), wall charge (PASS), move wall (SHIELD/SPRINT). WALL_JUMP handler.
 * Each restart: setup (place taker and ball, legal positions via RUL-11), per-tick logic while waiting, input
 * from the taking / defending controllers, and the default action after T_RULES.restartTimeoutTicks.
 */
import type { ActionHandler } from '../../contracts/systems';
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

/** Called once when this restart is awarded (after RUL-11 fills s.match.restart). Choose taker, place ball. */
export function freeKickSetup(s: SimState, ev: EventSink): void { /* stub */ }
/** Per tick while the phase is active. */
export function freeKickTick(s: SimState, ev: EventSink): void { /* stub */ }
/** Set-piece input for controller ctrlIdx (SetPieceInputFn). */
export function freeKickInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void { /* stub */ }
/** Default action when the taker does not act in time (also used by the CPU fallback). */
export function freeKickDefault(s: SimState, ev: EventSink): void { /* stub */ }
export const wallJumpHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
