/**
 * [SIM-14] Import-cycle-safe shells of the tackle / down-state action handlers and the clearance kick solver (helper
 * of defend/tackle.ts, owned by SIM-14).
 *
 * actions/registry.ts reads the handlers and solveClearance from defend/tackle.ts while it builds its tables, and
 * defend/tackle.ts imports actions/dispatch (-> actions/registry) back. When defend/tackle.ts is the module that enters
 * that cycle (e.g. a rules / AI / test module imports it before anything imports the dispatcher), the registry would
 * read its exports before they exist (TDZ in a bundle, `undefined` -> the idle handler under vitest) and no tackle
 * would ever run. This module has NO runtime imports, so it is always fully evaluated first; tackle.ts re-exports
 * these shells as its first statement and binds the real implementation (bindTackleImpl) at the end of its body, long
 * before the first tick runs. The shells only forward (no allocation). One update / end pair serves every action kind
 * of SIM-14: the implementation switches on p.act (the dispatcher calls end() before it clears the action).
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import type { ActionHandler, KickLaunch } from '../../contracts/systems';

/** The real implementation, provided by defend/tackle.ts. */
export interface TackleImpl {
  update(s: SimState, slot: number, ev: EventSink): void;
  end(s: SimState, slot: number, interrupted: number): void;
  solveClearance(s: SimState, slot: number, out: KickLaunch): number;
}

const IMPL: TackleImpl = {
  update() { /* bound by defend/tackle.ts */ },
  end() { /* bound by defend/tackle.ts */ },
  solveClearance() { return 0; },
};

/** Install the implementation (called once by defend/tackle.ts when it is evaluated). */
export function bindTackleImpl(impl: TackleImpl): void {
  IMPL.update = impl.update;
  IMPL.end = impl.end;
  IMPL.solveClearance = impl.solveClearance;
}

/** KickSolver for CLEARANCE. */
export function solveClearance(s: SimState, slot: number, out: KickLaunch): number {
  return IMPL.solveClearance(s, slot, out);
}

function shell(): ActionHandler {
  return {
    update(s, slot, ev) { IMPL.update(s, slot, ev); },
    end(s, slot, interrupted) { IMPL.end(s, slot, interrupted); },
  };
}

/** ActionKind.STAND_TACKLE handler. */
export const standTackleHandler: ActionHandler = shell();
/** ActionKind.HARD_TACKLE handler. */
export const hardTackleHandler: ActionHandler = shell();
/** ActionKind.SLIDE_TACKLE handler. */
export const slideTackleHandler: ActionHandler = shell();
/** ActionKind.SHOULDER handler. */
export const shoulderHandler: ActionHandler = shell();
/** ActionKind.PUSH_PULL handler. */
export const pushPullHandler: ActionHandler = shell();
/** ActionKind.STUMBLE handler. */
export const stumbleHandler: ActionHandler = shell();
/** ActionKind.FALLEN handler. */
export const fallenHandler: ActionHandler = shell();
/** ActionKind.GET_UP handler. */
export const getUpHandler: ActionHandler = shell();
