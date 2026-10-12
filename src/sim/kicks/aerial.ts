/**
 * [SIM-12] Headers, volleys and aerial duels. When a human presses pass/lob/shoot while the ball is in the air
 * near the controlled player (or a teammate is under a cross), start HEADER or VOLLEY; aerialContacts resolves
 * jumps and contests between players (heading, height, strength, timing). Emits AERIAL.
 */
import type { KickKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { ActionHandler, ActionRequest, KickLaunch } from '../../contracts/systems';
import type { SimState } from '../../contracts/state';

export function startHeader(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number { return 0; }
export function startVolley(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number { return 0; }
/** True if the ball is a sensible header (h) or volley (v) chance for slot in the next few ticks. Pure. */
export function aerialChance(s: SimState, slot: number): number { return 0; }
export function aerialContacts(s: SimState, ev: EventSink): void { /* stub */ }
/** KickSolver for HEADER_SHOT, HEADER_PASS. */
export function solveHeader(s: SimState, slot: number, out: KickLaunch): number { return 0; }
/** KickSolver for VOLLEY_SHOT, VOLLEY_PASS. */
export function solveVolley(s: SimState, slot: number, out: KickLaunch): number { return 0; }
export const headerHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const volleyHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
