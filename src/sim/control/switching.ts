/**
 * [SIM-16] Player switching for every controller (humans and CPU brains): nearest effective defender by default
 * with a short lock-out (T_INPUT.switchLockTicks) so it never flip-flops; manual directional switch (right
 * stick flick) always available; auto-switch setting (Off, Air balls and loose balls, Auto); auto-switch to the
 * intended receiver of a pass and to the keeper when he gains the ball in hands; never lands on a sent-off,
 * substituted or inactive player; never switches away from the player about to receive. Writes ctrl.slot,
 * p.ctrl, ctrl.nextSwitch (faint marker) and emits SWITCH.
 * WAVE 0 BASELINE: ensureControlledPlayer picks the nearest outfield player to the ball. SIM-16 replaces it.
 */
import { EventType, type EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import { nearestOfTeam } from '../core/query';

/** Make sure controller c controls a valid active player of its side (called every tick by the resolver). */
export function ensureControlledPlayer(s: SimState, c: number, ev: EventSink): void {
  const ctl = s.ctrl[c]!;
  if (ctl.slot >= 0 && s.players[ctl.slot]!.active === 1 && s.players[ctl.slot]!.team === ctl.side) return;
  const slot = nearestOfTeam(s, ctl.side, s.ball.x, s.ball.z, -1, false);
  if (slot >= 0) switchTo(s, c, slot, ev);
}

/** Switch controller c to slot (validates; clears the previous player's ctrl). */
export function switchTo(s: SimState, c: number, slot: number, ev: EventSink): void {
  const ctl = s.ctrl[c]!;
  const old = ctl.slot;
  if (old === slot) return;
  if (old >= 0 && s.players[old]!.ctrl === c) s.players[old]!.ctrl = -1;
  ctl.slot = slot;
  s.players[slot]!.ctrl = c;
  ev.emit(EventType.SWITCH, old, slot, c);
}

/** Best switch target for controller c (manual L1 press / auto), or -1. dirX/dirZ != 0 for directional. Pure. */
export function bestSwitchTarget(s: SimState, c: number, dirX: number, dirZ: number): number {
  return -1;
}

/** Per-tick switching logic (auto-switch, lock-out, next-switch marker). Called by the resolver. */
export function switchTick(s: SimState, c: number, ev: EventSink): void {
  // stub
}
