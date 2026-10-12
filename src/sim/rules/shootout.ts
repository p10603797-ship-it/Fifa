/**
 * [RUL-07] Penalty shoot-out: five each, then sudden death, every eligible player takes one before anyone
 * repeats; alternate teams; keepers on the line; result tracking in s.match.shootout; ends in POST_MATCH with a
 * winner. Used after extra time in cups and directly by Shoot-out mode (config.startPhase = SHOOT_OUT).
 */
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

export function shootoutStart(s: SimState, ev: EventSink): void { /* stub */ }
export function shootoutTick(s: SimState, ev: EventSink): void { /* stub */ }
export function shootoutInput(s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink): void { /* stub */ }
