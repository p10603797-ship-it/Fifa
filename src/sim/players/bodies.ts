/**
 * [SIM-05] Body contact: players collide as soft circles weighted by strength (no overlap beyond tolerance
 * for more than 1 s), shoulder-to-shoulder when running alongside, shielding puts the body between ball and
 * opponent (SHIELD action / p.shielding). Players never walk through the goal frame or net.
 * Emits BODY_CONTACT for audio.
 */
import type { EventSink } from '../../contracts/events';
import type { ActionHandler } from '../../contracts/systems';
import type { SimState } from '../../contracts/state';

export function bodyContactTick(s: SimState, ev: EventSink): void {
  // Wave 0 stub: no collisions.
}

/** ActionKind.SHIELD handler (shielding while in possession with L2 held). */
export const shieldHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
