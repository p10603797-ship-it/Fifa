/**
 * [SIM-08] Import-cycle-safe shells of the KICK action handler and the ground-pass kick solver (helper of pass.ts,
 * owned by SIM-08).
 *
 * actions/registry.ts reads kickHandler and solveGroundPass from kicks/pass.ts while it builds its tables, and
 * kicks/pass.ts imports actions/dispatch (-> actions/registry) back. When kicks/pass.ts is the module that enters that
 * cycle (e.g. a rules / AI / test module imports it before anything imports the dispatcher), the registry would read
 * its exports before they exist (TDZ in a bundle, `undefined` -> the idle handler under vitest) and no foot kick would
 * ever reach its contact. This module has NO runtime imports, so it is always fully evaluated first; pass.ts
 * re-exports these shells as its first statement and binds the real implementation (bindPassImpl) at the end of its
 * body, long before the first tick runs. The shells only forward (no allocation).
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import type { ActionHandler, KickLaunch } from '../../contracts/systems';

/** The real implementation, provided by kicks/pass.ts. */
export interface PassImpl {
  update(s: SimState, slot: number, ev: EventSink): void;
  end(s: SimState, slot: number, interrupted: number): void;
  solveGroundPass(s: SimState, slot: number, out: KickLaunch): number;
}

const IMPL: PassImpl = {
  update() { /* bound by kicks/pass.ts */ },
  end() { /* bound by kicks/pass.ts */ },
  solveGroundPass() { return 0; },
};

/** Install the implementation (called once by kicks/pass.ts when it is evaluated). */
export function bindPassImpl(impl: PassImpl): void {
  IMPL.update = impl.update;
  IMPL.end = impl.end;
  IMPL.solveGroundPass = impl.solveGroundPass;
}

/** KickSolver for GROUND_PASS, DRIVEN_PASS, DINKED_PASS, KICK_OFF. */
export function solveGroundPass(s: SimState, slot: number, out: KickLaunch): number {
  return IMPL.solveGroundPass(s, slot, out);
}

/** ActionKind.KICK handler (generic foot-kick timing + solver dispatch). */
export const kickHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.update(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.end(s, slot, interrupted); },
};
