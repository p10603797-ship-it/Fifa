/**
 * [RUL-06] Penalties in play - taker on the spot, keeper on the line, everyone else outside the area and arc; aim + shoot/finesse/chip; keeper moves along the line and dives (right stick); after the kick play continues (IN_PLAY).
 * Each restart: setup (place taker and ball, legal positions via RUL-11), per-tick logic while waiting, input
 * from the taking / defending controllers, and the default action after T_RULES.restartTimeoutTicks.
 */

import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

/** Called once when this restart is awarded (after RUL-11 fills s.match.restart). Choose taker, place ball. */
export function penaltySetup(s: SimState, ev: EventSink): void { /* stub */ }
/** Per tick while the phase is active. */
export function penaltyTick(s: SimState, ev: EventSink): void { /* stub */ }
/** Set-piece input for controller ctrlIdx (SetPieceInputFn). */
export function penaltyInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void { /* stub */ }
/** Default action when the taker does not act in time (also used by the CPU fallback). */
export function penaltyDefault(s: SimState, ev: EventSink): void { /* stub */ }

