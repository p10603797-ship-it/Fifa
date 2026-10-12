/**
 * [RUL-02] Throw-ins - taker at the crossing point, opponents 2 m away, move along the line, short throw (PASS) or long throw (hold LOB); THROW_IN action handler; no offside from throw-ins; a goal cannot be scored direct from a throw-in.
 * Each restart: setup (place taker and ball, legal positions via RUL-11), per-tick logic while waiting, input
 * from the taking / defending controllers, and the default action after T_RULES.restartTimeoutTicks.
 */
import type { ActionHandler } from '../../contracts/systems';
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

/** Called once when this restart is awarded (after RUL-11 fills s.match.restart). Choose taker, place ball. */
export function throwInSetup(s: SimState, ev: EventSink): void { /* stub */ }
/** Per tick while the phase is active. */
export function throwInTick(s: SimState, ev: EventSink): void { /* stub */ }
/** Set-piece input for controller ctrlIdx (SetPieceInputFn). */
export function throwInInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void { /* stub */ }
/** Default action when the taker does not act in time (also used by the CPU fallback). */
export function throwInDefault(s: SimState, ev: EventSink): void { /* stub */ }
export const throwInHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
