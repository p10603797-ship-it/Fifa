/**
 * [RUL-02] Import-cycle-safe shell of the THROW_IN action handler (helper of throwin.ts, owned by RUL-02).
 *
 * actions/registry.ts reads `throwInHandler` from rules/throwin.ts while it builds ACTION_HANDLERS, and throwin.ts
 * (through actions/dispatch, rules/restart, kicks/pass ...) imports the registry back. When throwin.ts is the module
 * that enters that cycle, the registry would read the handler before throwin.ts has defined it (TDZ in a bundle,
 * `undefined` -> the idle handler under vitest) and a throw-in taker would hold the ball until the watchdog forced the
 * restart. This module has NO runtime imports, so it is always fully evaluated first; throwin.ts re-exports the
 * shell as its first statement and binds the real implementation (bindThrowInImpl) at the end of its body, long
 * before the first tick runs. The shell only forwards calls (no allocation).
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import type { ActionHandler } from '../../contracts/systems';

/** The real implementation, provided by rules/throwin.ts. */
export interface ThrowInHandlerImpl {
  update(s: SimState, slot: number, ev: EventSink): void;
  end(s: SimState, slot: number, interrupted: number): void;
}

const IMPL: ThrowInHandlerImpl = {
  update() { /* bound by rules/throwin.ts */ },
  end() { /* bound by rules/throwin.ts */ },
};

/** Install the implementation (called once by rules/throwin.ts when it is evaluated). */
export function bindThrowInImpl(impl: ThrowInHandlerImpl): void {
  IMPL.update = impl.update;
  IMPL.end = impl.end;
}

/** ActionKind.THROW_IN: the throw-in taker walking to the line, holding the ball, throwing, stepping back in. */
export const throwInHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.update(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.end(s, slot, interrupted); },
};
