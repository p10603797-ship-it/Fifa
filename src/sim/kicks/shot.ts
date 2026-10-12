/**
 * [SIM-11] Shooting: power, aim assist, error model, all shot types (normal, finesse, chip, power shot, low
 * driven, first-time; free-kick shots and penalties). Hold time sets power; the stick aims relative to the goal;
 * assisted aim biases toward the inside of the posts and away from the keeper. Error from finishing and
 * long-shot attributes, power above 80%, balance (angle between run and shot), pressure, weaker foot and ball
 * height at contact. A fake shot (SIM-13) cancels the wind-up into a touch. Owns the SHOT action handler.
 */
import type { KickKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { ActionHandler, ActionRequest, KickLaunch } from '../../contracts/systems';
import type { SimState } from '../../contracts/state';

export function startShot(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  return 0;
}
/** KickSolver for SHOT_*, FREE_KICK_SHOT, PENALTY. */
export function solveShot(s: SimState, slot: number, out: KickLaunch): number { return 0; }
/** Aim point on the goal mouth (z across the mouth, y height) for a shot by slot; assisted per assist level. */
export function shotAimPoint(s: SimState, slot: number, dirX: number, dirZ: number, power: number, assist: number, out: { x: number; y: number; z: number }): void {
  out.x = 0; out.y = 0; out.z = 0;
}
export const shotHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
