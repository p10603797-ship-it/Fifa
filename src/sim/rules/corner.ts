/**
 * [RUL-04] Corners - ball in the corner arc on the correct side, opponents 9.15 m; lob cross (LOB), short pass (PASS), aim with left stick, target reticle with right stick; corner tactics (team.cornerTactic).
 * Each restart: setup (place taker and ball, legal positions via RUL-11), per-tick logic while waiting, input
 * from the taking / defending controllers, and the default action after T_RULES.restartTimeoutTicks.
 */

import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

/** Called once when this restart is awarded (after RUL-11 fills s.match.restart). Choose taker, place ball. */
export function cornerSetup(s: SimState, ev: EventSink): void { /* stub */ }
/** Per tick while the phase is active. */
export function cornerTick(s: SimState, ev: EventSink): void { /* stub */ }
/** Set-piece input for controller ctrlIdx (SetPieceInputFn). */
export function cornerInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void { /* stub */ }
/** Default action when the taker does not act in time (also used by the CPU fallback). */
export function cornerDefault(s: SimState, ev: EventSink): void { /* stub */ }

