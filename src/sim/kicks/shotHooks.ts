/**
 * [SIM-11] Import-cycle-safe shells of the SHOT action handler and the shot kick solver (helper of shot.ts, owned by
 * SIM-11).
 *
 * actions/registry.ts reads shotHandler and solveShot from kicks/shot.ts while it builds its tables, and kicks/shot.ts
 * imports actions/dispatch (-> actions/registry) back. When kicks/shot.ts is the module that enters that cycle (e.g. a
 * rules / AI / test module imports it before anything imports the dispatcher), the registry would read its exports
 * before they exist (TDZ in a bundle, `undefined` -> the idle handler under vitest) and no shot would ever reach its
 * contact. This module has NO runtime imports, so it is always fully evaluated first; shot.ts re-exports these shells
 * as its first statement and binds the real implementation (bindShotImpl) at the end of its body, long before the
 * first tick runs. The shells only forward (no allocation).
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import type { ActionHandler, KickLaunch } from '../../contracts/systems';

/** The real implementation, provided by kicks/shot.ts. */
export interface ShotImpl {
  update(s: SimState, slot: number, ev: EventSink): void;
  end(s: SimState, slot: number, interrupted: number): void;
  solveShot(s: SimState, slot: number, out: KickLaunch): number;
}

const IMPL: ShotImpl = {
  update() { /* bound by kicks/shot.ts */ },
  end() { /* bound by kicks/shot.ts */ },
  solveShot() { return 0; },
};

/** Install the implementation (called once by kicks/shot.ts when it is evaluated). */
export function bindShotImpl(impl: ShotImpl): void {
  IMPL.update = impl.update;
  IMPL.end = impl.end;
  IMPL.solveShot = impl.solveShot;
}

/** KickSolver for SHOT_*, FREE_KICK_SHOT, PENALTY. */
export function solveShot(s: SimState, slot: number, out: KickLaunch): number {
  return IMPL.solveShot(s, slot, out);
}

/** ActionKind.SHOT handler (wind-up, power charging, contact, recovery). */
export const shotHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.update(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.end(s, slot, interrupted); },
};
