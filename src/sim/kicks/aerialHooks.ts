/**
 * [SIM-12] Import-cycle-safe shells of the HEADER / VOLLEY action handlers and the header / volley kick solvers
 * (helper of aerial.ts, owned by SIM-12).
 *
 * actions/registry.ts reads headerHandler, volleyHandler, solveHeader and solveVolley from kicks/aerial.ts while it
 * builds its tables, and kicks/aerial.ts imports actions/dispatch (-> actions/registry) back. When kicks/aerial.ts is
 * the module that enters that cycle (e.g. an AI or test module imports it before anything imports the dispatcher),
 * the registry would read its exports before they exist (TDZ in a bundle, `undefined` -> the idle handler under
 * vitest) and nobody could ever head or volley the ball. This module has NO runtime imports, so it is always fully
 * evaluated first; aerial.ts re-exports these shells as its first statement and binds the real implementation
 * (bindAerialImpl) at the end of its body, long before the first tick runs. The shells only forward (no allocation).
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import type { ActionHandler, KickLaunch } from '../../contracts/systems';

/** The real implementation, provided by kicks/aerial.ts. */
export interface AerialImpl {
  update(s: SimState, slot: number, ev: EventSink): void;
  end(s: SimState, slot: number, interrupted: number): void;
  solveHeader(s: SimState, slot: number, out: KickLaunch): number;
  solveVolley(s: SimState, slot: number, out: KickLaunch): number;
}

const IMPL: AerialImpl = {
  update() { /* bound by kicks/aerial.ts */ },
  end() { /* bound by kicks/aerial.ts */ },
  solveHeader() { return 0; },
  solveVolley() { return 0; },
};

/** Install the implementation (called once by kicks/aerial.ts when it is evaluated). */
export function bindAerialImpl(impl: AerialImpl): void {
  IMPL.update = impl.update;
  IMPL.end = impl.end;
  IMPL.solveHeader = impl.solveHeader;
  IMPL.solveVolley = impl.solveVolley;
}

/** KickSolver for HEADER_SHOT, HEADER_PASS. */
export function solveHeader(s: SimState, slot: number, out: KickLaunch): number {
  return IMPL.solveHeader(s, slot, out);
}

/** KickSolver for VOLLEY_SHOT, VOLLEY_PASS. */
export function solveVolley(s: SimState, slot: number, out: KickLaunch): number {
  return IMPL.solveVolley(s, slot, out);
}

/** ActionKind.HEADER handler (approach, jump, contact window; the contact itself is resolved in aerialContacts). */
export const headerHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.update(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.end(s, slot, interrupted); },
};

/** ActionKind.VOLLEY handler (approach, contact window; the contact itself is resolved in aerialContacts). */
export const volleyHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.update(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.end(s, slot, interrupted); },
};
