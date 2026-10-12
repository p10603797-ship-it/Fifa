/**
 * [SIM-09] Lobs and crosses: LOB_PASS, HIGH_LOB, DRIVEN_LOB, CROSS, GROUND_CROSS, LOW_CROSS.
 * "In the crossing zone, a lob becomes a cross aimed at the near post, far post or penalty spot from power
 * and stick." Corner tactics (team.cornerTactic) bias cross targets. Uses SIM-01 solveLaunch.
 */
import type { KickKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { ActionRequest, KickLaunch } from '../../contracts/systems';
import type { SimState } from '../../contracts/state';

/** Start a lob or cross (kind decided by caller; in the crossing zone LOB_PASS upgrades to CROSS). */
export function startLob(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  return 0;
}
/** KickSolver for LOB_PASS, HIGH_LOB, DRIVEN_LOB. */
export function solveLob(s: SimState, slot: number, out: KickLaunch): number { return 0; }
/** KickSolver for CROSS, GROUND_CROSS, LOW_CROSS. */
export function solveCross(s: SimState, slot: number, out: KickLaunch): number { return 0; }
/** Cross aim point (near post / far post / penalty spot) from power 0..1 and stick, for the team attacking dir. */
export function crossTarget(s: SimState, slot: number, power: number, dirX: number, dirZ: number, out: { x: number; z: number }): void {
  out.x = 0; out.z = 0;
}
