/**
 * [SIM-10] Through balls: THROUGH_GROUND, THROUGH_LOBBED, THROUGH_DINKED. "A through ball leads the runner
 * into space, weighted so he meets it in stride." Uses SIM-01 prediction/solvers and SIM-04 ticksToReach.
 */
import type { KickKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { ActionRequest, KickLaunch } from '../../contracts/systems';
import type { SimState } from '../../contracts/state';

export function startThrough(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  return 0;
}
/** KickSolver for THROUGH_GROUND, THROUGH_LOBBED, THROUGH_DINKED. */
export function solveThrough(s: SimState, slot: number, out: KickLaunch): number { return 0; }
/** Lead point for a through ball to runner target from slot with power 0..1. Returns 0 if no sensible lead. */
export function throughLeadPoint(s: SimState, slot: number, target: number, power: number, lofted: number, out: { x: number; z: number }): number {
  return 0;
}
