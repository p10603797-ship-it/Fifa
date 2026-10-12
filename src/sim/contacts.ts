/**
 * Contact phase (after ball physics). Lead-owned. Fixed priority so simultaneous contacts resolve
 * deterministically; each stage must skip new ball contacts when ballTouchedThisTick(s) is already true
 * (it may still update its own state, e.g. a tackle that hits the player instead of the ball).
 */
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';
import { keeperContacts } from './keeper/saves';
import { aerialContacts } from './kicks/aerial';
import { interceptContacts, tackleContacts } from './defend/tackle';
import { receiveContacts } from './players/firstTouch';
import { dribbleTick } from './players/possession';

export function contactsTick(s: SimState, ev: EventSink): void {
  keeperContacts(s, ev); // GKP-02 (+ GKP-03 claims inside the dive/rush handlers)
  aerialContacts(s, ev); // SIM-12
  tackleContacts(s, ev); // SIM-14
  interceptContacts(s, ev); // SIM-14
  receiveContacts(s, ev); // SIM-07
  dribbleTick(s, ev); // SIM-06 (last: owner touches, loose-ball pick-up, possession loss)
}
