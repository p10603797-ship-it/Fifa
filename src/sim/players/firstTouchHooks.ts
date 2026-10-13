/**
 * [SIM-07] Import-cycle-safe shell of the FIRST_TOUCH action handler (helper of players/firstTouch.ts, owned by
 * SIM-07).
 *
 * actions/registry.ts reads firstTouchHandler from players/firstTouch.ts while it builds ACTION_HANDLERS, and
 * players/firstTouch.ts imports actions/dispatch (-> actions/registry) back for beginAction / isFree. When
 * players/firstTouch.ts is the module that enters that cycle (a test or tool importing it before anything imports
 * the dispatcher), the registry would read the handler before it exists (TDZ in a bundle, `undefined` -> the idle
 * handler under vitest) and FIRST_TOUCH would never slow the receiver or end early. This module has NO runtime
 * imports, so it is always fully evaluated first; firstTouch.ts re-exports the shell as its first statement and binds
 * the real implementation (bindFirstTouchImpl) at the end of its body, long before the first tick runs. The shell
 * only forwards calls (no allocation).
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import type { ActionHandler } from '../../contracts/systems';

/** The real implementation, provided by players/firstTouch.ts. */
export interface FirstTouchImpl {
  update(s: SimState, slot: number, ev: EventSink): void;
  end(s: SimState, slot: number, interrupted: number): void;
}

const IMPL: FirstTouchImpl = {
  update() { /* bound by players/firstTouch.ts */ },
  end() { /* bound by players/firstTouch.ts */ },
};

/** Install the implementation (called once by players/firstTouch.ts when it is evaluated). */
export function bindFirstTouchImpl(impl: FirstTouchImpl): void {
  IMPL.update = impl.update;
  IMPL.end = impl.end;
}

/** ActionKind.FIRST_TOUCH handler: the trap window (movement slowed, no other action; see firstTouch.ts). */
export const firstTouchHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.update(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.end(s, slot, interrupted); },
};
