/**
 * [SIM-05] Shield starters for the input resolver (SIM-15) and CPU paths. Helper of bodies.ts, split out because it
 * needs sim/actions/dispatch (beginAction / endAction / isFree) and bodies.ts is imported by the action registry
 * (bodies -> dispatch -> registry -> bodies would be an import cycle that breaks whichever module loads first).
 *
 * The SHIELD action is the shield state: SIM-04 derives p.shielding from it and caps the speed; bodies.ts
 * (shieldHandler + bodyContactTick) faces the nearest opponent, keeps the body between ball and opponent and
 * holds challengers off.
 */
import { ActionKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import { NUM_SLOTS } from '../../contracts/constants';
import { beginAction, endAction, isFree } from '../actions/dispatch';
import { shieldLook } from './bodies';

/** Start the SHIELD action for the ball owner (feet). 1 = started or already shielding, 0 = refused. */
export function startShield(s: SimState, slot: number, _ev?: EventSink): number {
  if (slot < 0 || slot >= NUM_SLOTS) return 0;
  const p = s.players[slot]!;
  const b = s.ball;
  if (p.active !== 1 || b.owner !== slot || b.heldBy >= 0) return 0;
  if (p.act === ActionKind.SHIELD) { p.shielding = 1; return 1; }
  if (!isFree(p)) return 0;
  beginAction(p, ActionKind.SHIELD, 1, -1);
  p.shielding = 1;
  shieldLook(s, slot);
  return 1;
}

/** Stop shielding now (ends the SHIELD action through its handler; the player is free again this tick). */
export function stopShield(s: SimState, slot: number): void {
  if (slot < 0 || slot >= NUM_SLOTS) return;
  const p = s.players[slot]!;
  if (p.act === ActionKind.SHIELD) endAction(s, slot, 0);
  p.shielding = 0;
}

/**
 * Resolver hook, every tick for the controlled player in attack, after the movement intent is written:
 * held = 1 while SHIELD (L2) is held. Starts shielding when he has the ball at his feet and is free (sets this
 * tick's lookAt toward the nearest opponent), stops it on release. Returns 1 while shielding.
 */
export function applyShieldIntent(s: SimState, slot: number, held: number, ev?: EventSink): number {
  if (slot < 0 || slot >= NUM_SLOTS) return 0;
  const p = s.players[slot]!;
  if (held !== 1) {
    if (p.act === ActionKind.SHIELD) stopShield(s, slot);
    return 0;
  }
  if (startShield(s, slot, ev) !== 1) return 0;
  shieldLook(s, slot);
  return 1;
}
