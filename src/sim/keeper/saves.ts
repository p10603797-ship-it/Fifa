/**
 * [GKP-02] Saves: reaction delay, dive reach and dive speed from attributes (T_GK); results are catch, parry
 * (away from danger when good), tip over, or beaten. A save is decided by whether the keeper physically reaches
 * the ball (dive kinematics vs predicted ball path), never by a dice roll that ignores where the shot went.
 * keeperSaveDecision starts GK_DIVE / sets up a save for incoming shots (keepers are always AI for saves);
 * keeperContacts resolves contact in the contact phase (first priority). Emits SAVE, KEEPER_HANDS.
 * Never dives after the ball has passed; never stays stuck in a dive. Target: 65-78% of on-target shots saved.
 */
import type { ActionHandler } from '../../contracts/systems';
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';

export function keeperSaveDecision(s: SimState, team: number, ev: EventSink): void { /* stub */ }
export function keeperContacts(s: SimState, ev: EventSink): void { /* stub */ }
export const diveHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const catchHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
