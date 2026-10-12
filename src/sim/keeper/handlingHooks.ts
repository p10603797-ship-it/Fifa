/**
 * [GKP-05] Import-cycle-safe shells of the keeper-handling action handlers and kick solver (helper of handling.ts,
 * owned by GKP-05).
 *
 * actions/registry.ts reads holdHandler, throwHandler, gkKickHandler and solveKeeperRelease from keeper/handling.ts
 * while it builds its tables, and keeper/handling.ts (through actions/dispatch and other sim modules) imports the
 * registry back. When keeper/handling.ts is the module that enters that cycle, the registry would read its exports
 * before they exist (TDZ in a bundle, `undefined` -> the idle handler under vitest) and a keeper would hold the ball
 * forever. This module has NO runtime imports, so it is always fully evaluated first; keeper/handling.ts re-exports
 * these shells as its first statement and binds the real implementation (bindHandlingImpl) at the end of its body,
 * long before the first tick runs. The shells only forward calls (no allocation).
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import type { ActionHandler, KickLaunch } from '../../contracts/systems';

/** The real implementation, provided by keeper/handling.ts. */
export interface HandlingImpl {
  holdUpdate(s: SimState, slot: number, ev: EventSink): void;
  holdEnd(s: SimState, slot: number, interrupted: number): void;
  releaseUpdate(s: SimState, slot: number, ev: EventSink): void;
  releaseEnd(s: SimState, slot: number, interrupted: number): void;
  solve(s: SimState, slot: number, out: KickLaunch): number;
}

const IMPL: HandlingImpl = {
  holdUpdate() { /* bound by keeper/handling.ts */ },
  holdEnd() { /* bound by keeper/handling.ts */ },
  releaseUpdate() { /* bound by keeper/handling.ts */ },
  releaseEnd() { /* bound by keeper/handling.ts */ },
  solve() { return 0; },
};

/** Install the implementation (called once by keeper/handling.ts when it is evaluated). */
export function bindHandlingImpl(impl: HandlingImpl): void {
  IMPL.holdUpdate = impl.holdUpdate;
  IMPL.holdEnd = impl.holdEnd;
  IMPL.releaseUpdate = impl.releaseUpdate;
  IMPL.releaseEnd = impl.releaseEnd;
  IMPL.solve = impl.solve;
}

/** KickSolver for keeper releases. */
export function solveKeeperRelease(s: SimState, slot: number, out: KickLaunch): number {
  return IMPL.solve(s, slot, out);
}

/** GK_HOLD: ball in hands, slow walk inside the hold box, 6-second rule. */
export const holdHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.holdUpdate(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.holdEnd(s, slot, interrupted); },
};

/** GK_THROW: overarm throw, driven throw, roll, drop at feet. */
export const throwHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.releaseUpdate(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.releaseEnd(s, slot, interrupted); },
};

/** GK_KICK: drop kick, driven kick. */
export const gkKickHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.releaseUpdate(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.releaseEnd(s, slot, interrupted); },
};
