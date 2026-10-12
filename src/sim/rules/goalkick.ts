/**
 * [RUL-03] Goal kicks - ball in the goal area, keeper (or nominated) taker, opponents outside the penalty area until the ball is played; short or long.
 * Each restart: setup (place taker and ball, legal positions via RUL-11), per-tick logic while waiting, input
 * from the taking / defending controllers, and the default action after T_RULES.restartTimeoutTicks.
 */

import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

/** Called once when this restart is awarded (after RUL-11 fills s.match.restart). Choose taker, place ball. */
export function goalKickSetup(s: SimState, ev: EventSink): void { /* stub */ }
/** Per tick while the phase is active. */
export function goalKickTick(s: SimState, ev: EventSink): void { /* stub */ }
/** Set-piece input for controller ctrlIdx (SetPieceInputFn). */
export function goalKickInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void { /* stub */ }
/** Default action when the taker does not act in time (also used by the CPU fallback). */
export function goalKickDefault(s: SimState, ev: EventSink): void { /* stub */ }

