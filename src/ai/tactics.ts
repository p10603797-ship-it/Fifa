/**
 * [TAI-14] Tactics and focus effects (quick tactics: offside trap, team press, extra striker, get in the box;
 * tactical focus default/defending/attacking; formation changes) applied to shape and pressing parameters;
 * applyCommand handles Command.* from any controller (emits TACTIC). Receiver lock and teammate assist for human
 * sides: the intended receiver of a pass (ball.passTarget) gets a RECEIVE job to meet the ball until the human
 * switches to him / steers him.
 */
import type { Command } from '../contracts/enums';
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';

export function applyCommand(s: SimState, team: number, cmd: Command, arg: number, ev: EventSink): void { /* stub */ }
export function tacticsTick(s: SimState, team: number, ev: EventSink): void { /* stub */ }
export function receiverAssist(s: SimState, team: number, ev: EventSink): void { /* stub */ }
