/**
 * [SIM-09] Import-cycle-safe shells of the lob / cross kick solvers (helper of lob.ts, owned by SIM-09).
 *
 * actions/registry.ts reads solveLob and solveCross from kicks/lob.ts while it builds KICK_SOLVERS, and kicks/lob.ts
 * imports actions/dispatch (-> actions/registry) back. When kicks/lob.ts is the module that enters that cycle (a rules /
 * AI / test module imports it before anything imports the dispatcher), the registry could read its exports before they
 * exist (TDZ in a bundle, `undefined` under vitest) and no lob or cross would ever be solved. This module has NO
 * runtime imports, so it is always fully evaluated first; lob.ts re-exports these shells as its first statement and
 * binds the real implementation (bindLobImpl) at the end of its body, long before the first tick runs. The shells only
 * forward (no allocation).
 */
import type { SimState } from '../../contracts/state';
import type { KickLaunch } from '../../contracts/systems';

/** The real implementation, provided by kicks/lob.ts. */
export interface LobImpl {
  solveLob(s: SimState, slot: number, out: KickLaunch): number;
  solveCross(s: SimState, slot: number, out: KickLaunch): number;
}

const IMPL: LobImpl = {
  solveLob() { return 0; },
  solveCross() { return 0; },
};

/** Install the implementation (called once by kicks/lob.ts when it is evaluated). */
export function bindLobImpl(impl: LobImpl): void {
  IMPL.solveLob = impl.solveLob;
  IMPL.solveCross = impl.solveCross;
}

/** KickSolver for LOB_PASS, HIGH_LOB, DRIVEN_LOB (and GOAL_KICK, which the registry maps here). */
export function solveLob(s: SimState, slot: number, out: KickLaunch): number {
  return IMPL.solveLob(s, slot, out);
}

/** KickSolver for CROSS, GROUND_CROSS, LOW_CROSS. */
export function solveCross(s: SimState, slot: number, out: KickLaunch): number {
  return IMPL.solveCross(s, slot, out);
}
