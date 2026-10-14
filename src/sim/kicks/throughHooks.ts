/**
 * [SIM-10] Import-cycle-safe shell of the through-ball kick solver (helper of through.ts, owned by SIM-10).
 *
 * actions/registry.ts reads solveThrough from kicks/through.ts while it builds KICK_SOLVERS, and kicks/through.ts
 * imports actions/dispatch (-> actions/registry) back. When kicks/through.ts is the module that enters that cycle, the
 * registry could read its export before it exists (TDZ in a bundle, `undefined` under vitest) and no through ball would
 * ever be solved. This module has NO runtime imports, so it is always fully evaluated first; through.ts re-exports the
 * shell as its first statement and binds the real implementation (bindThroughImpl) at the end of its body. The shell
 * only forwards (no allocation).
 */
import type { SimState } from '../../contracts/state';
import type { KickLaunch } from '../../contracts/systems';

/** The real implementation, provided by kicks/through.ts. */
export interface ThroughImpl {
  solveThrough(s: SimState, slot: number, out: KickLaunch): number;
}

const IMPL: ThroughImpl = {
  solveThrough() { return 0; },
};

/** Install the implementation (called once by kicks/through.ts when it is evaluated). */
export function bindThroughImpl(impl: ThroughImpl): void {
  IMPL.solveThrough = impl.solveThrough;
}

/** KickSolver for THROUGH_GROUND, THROUGH_LOBBED, THROUGH_DINKED. */
export function solveThrough(s: SimState, slot: number, out: KickLaunch): number {
  return IMPL.solveThrough(s, slot, out);
}
