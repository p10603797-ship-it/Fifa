/**
 * [GKP-03] Import-cycle-safe shells of the GK_RUSH / GK_PUNCH action handlers (helper of sweeper.ts, owned by GKP-03).
 *
 * actions/registry.ts reads rushHandler and punchHandler from keeper/sweeper.ts while it builds its tables, and
 * keeper/sweeper.ts (through actions/dispatch, keeper/handling and other sim modules) imports the registry back. When
 * keeper/sweeper.ts is the module that enters that cycle, the registry would read its handlers before they exist
 * (TDZ in a bundle, `undefined` -> the idle handler under vitest) and a rushing keeper would never stop. This module
 * has NO runtime imports, so it is always fully evaluated first; keeper/sweeper.ts re-exports these shells as its
 * first statement and binds the real implementation (bindSweeperImpl) at the end of its body, long before the first
 * tick runs. The shells only forward calls (no allocation).
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import type { ActionHandler } from '../../contracts/systems';

/** The real implementation, provided by keeper/sweeper.ts. */
export interface SweeperImpl {
  rushUpdate(s: SimState, slot: number, ev: EventSink): void;
  rushEnd(s: SimState, slot: number, interrupted: number): void;
  punchUpdate(s: SimState, slot: number, ev: EventSink): void;
  punchEnd(s: SimState, slot: number, interrupted: number): void;
}

const IMPL: SweeperImpl = {
  rushUpdate() { /* bound by keeper/sweeper.ts */ },
  rushEnd() { /* bound by keeper/sweeper.ts */ },
  punchUpdate() { /* bound by keeper/sweeper.ts */ },
  punchEnd() { /* bound by keeper/sweeper.ts */ },
};

/** Install the implementation (called once by keeper/sweeper.ts when it is evaluated). */
export function bindSweeperImpl(impl: SweeperImpl): void {
  IMPL.rushUpdate = impl.rushUpdate;
  IMPL.rushEnd = impl.rushEnd;
  IMPL.punchUpdate = impl.punchUpdate;
  IMPL.punchEnd = impl.punchEnd;
}

/** GK_RUSH: rushing out for a loose / through ball, narrowing a one-on-one, smothering at the feet, user rush. */
export const rushHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.rushUpdate(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.rushEnd(s, slot, interrupted); },
};

/** GK_PUNCH: going up for a cross in the goal area: catch (claim) or punch at the planned contact. */
export const punchHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.punchUpdate(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.punchEnd(s, slot, interrupted); },
};
