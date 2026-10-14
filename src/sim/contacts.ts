/**
 * Contact phase (after ball physics). Lead-owned. Fixed priority so simultaneous contacts resolve
 * deterministically; each stage must skip new ball contacts when ballTouchedThisTick(s) is already true
 * (it may still update its own state, e.g. a tackle that hits the player instead of the ball).
 *
 * [QF-1] A ball that went wholly over a line during this tick's ballTick (ball.cross set) is out of play: nobody may
 * touch it after that (a player standing at the touchline used to pick up a ball already out and turn the restart
 * over to the wrong team; a keeper "saving" a ball already in the goal became the scorer). The stages still run (their
 * own state, countdowns), but see the ball as already touched this tick; touchedTick is restored afterwards, so the
 * touch bookkeeping (last touch, idle time) is exactly what it was when the ball crossed.
 */
import { CrossKind } from '../contracts/enums';
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';
import { keeperContacts } from './keeper/saves';
import { aerialContacts } from './kicks/aerial';
import { interceptContacts, tackleContacts } from './defend/tackle';
import { receiveContacts } from './players/firstTouch';
import { dribbleTick } from './players/possession';

export function contactsTick(s: SimState, ev: EventSink): void {
  const b = s.ball;
  const out = b.cross !== CrossKind.NONE;
  const touched = b.touchedTick;
  if (out) b.touchedTick = s.tick; // out of play: no stage may make a new ball contact this tick
  keeperContacts(s, ev); // GKP-02 (+ GKP-03 claims inside the dive/rush handlers)
  aerialContacts(s, ev); // SIM-12
  tackleContacts(s, ev); // SIM-14
  interceptContacts(s, ev); // SIM-14
  receiveContacts(s, ev); // SIM-07
  dribbleTick(s, ev); // SIM-06 (last: owner touches, loose-ball pick-up, possession loss)
  if (out && b.touchedTick === s.tick && b.lastTouchTick !== s.tick) b.touchedTick = touched;
}
