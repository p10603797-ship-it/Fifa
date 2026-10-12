/**
 * Action dispatcher. Lead-owned.
 * Each tick: for every active player with an action, actT++, then the owning handler's update(); when
 * actT >= actDur and the action is not charging, the handler's end() runs and the action clears.
 */
import { ActionKind, KickKind, SkillMove } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { MoveMode, type PlayerState, type SimState } from '../../contracts/state';
import { NUM_SLOTS } from '../../contracts/constants';
import { ACTION_HANDLERS } from './registry';

/** Start an action on a player (does not check whether the player is free; starters do that). */
export function beginAction(p: PlayerState, kind: ActionKind, dur: number, contact: number): void {
  p.act = kind;
  p.actT = 0;
  p.actDur = dur;
  p.actContact = contact;
  p.actDone = 0;
  p.actCharging = 0;
}

/** Reset the action fields to NONE (no handler call). */
export function clearAction(p: PlayerState): void {
  p.act = ActionKind.NONE;
  p.actT = 0;
  p.actDur = 0;
  p.actContact = -1;
  p.actDone = 0;
  p.actKick = KickKind.NONE;
  p.actSkill = SkillMove.NONE;
  p.actPower = 0;
  p.actCharging = 0;
  p.actSlot = -1;
  p.actCurve = 0;
  p.actA = 0;
  p.actB = 0;
  if (p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
}

/** End the current action through its handler. interrupted = 1 when cut short. */
export function endAction(s: SimState, slot: number, interrupted: number): void {
  const p = s.players[slot]!;
  if (p.act === ActionKind.NONE) return;
  const h = ACTION_HANDLERS[p.act];
  if (h) h.end(s, slot, interrupted);
  clearAction(p);
}

/** True if the player is free to start a new action. */
export function isFree(p: PlayerState): boolean {
  return p.active === 1 && p.act === ActionKind.NONE && p.stunT <= 0;
}

export function actionsTick(s: SimState, ev: EventSink): void {
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    const p = s.players[slot]!;
    if (p.active !== 1 || p.act === ActionKind.NONE) continue;
    const kind = p.act;
    p.actT++;
    const h = ACTION_HANDLERS[kind];
    if (!h) { clearAction(p); continue; }
    h.update(s, slot, ev);
    // The handler may have ended or replaced the action (beginAction resets actT).
    if (p.act === kind && p.actCharging === 0 && p.actT >= p.actDur) {
      h.end(s, slot, 0);
      clearAction(p);
    }
  }
}
