/**
 * [SIM-07] First touch, trapping and aerial control. When a moving ball reaches a player who is receiving
 * (intended receiver, chaser, or anyone whose path it crosses and who chooses to control it), resolve the
 * first touch from ball speed and height, the ballControl attribute, pressure, and whether sprint is held:
 * clean control (takePossession), a heavy touch (ball knocked ahead with error), or a miss.
 * Runs in the contact phase after keepers, aerials, tackles and interceptions.
 */
import type { EventSink } from '../../contracts/events';
import type { ActionHandler } from '../../contracts/systems';
import type { SimState } from '../../contracts/state';

export function receiveContacts(s: SimState, ev: EventSink): void {
  // Wave 0 stub.
}

/** 0..1 quality of a first touch for slot given incoming ball speed (m/s) and height (m). Pure. */
export function touchQuality(s: SimState, slot: number, ballSpeed: number, height: number): number {
  return 1;
}

/** ActionKind.FIRST_TOUCH handler. */
export const firstTouchHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
