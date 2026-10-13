/**
 * [RUL-05] Import-cycle-safe shell of the WALL_JUMP action handler (helper of freekick.ts, owned by RUL-05).
 *
 * actions/registry.ts reads `wallJumpHandler` from rules/freekick.ts while it builds ACTION_HANDLERS, and freekick.ts
 * (through actions/dispatch, rules/restart, kicks/* ...) imports the registry back. When freekick.ts is the module that
 * enters that cycle, the registry would read the handler before freekick.ts has defined it (TDZ in a bundle,
 * `undefined` -> the idle handler under Vitest) and wall members would never jump, brace or block. This module has NO
 * runtime imports, so it is always fully evaluated first; freekick.ts re-exports the shell as its first statement and
 * binds the real implementation (bindWallJumpImpl) at the end of its body, long before the first tick runs. The shell
 * only forwards calls (no allocation).
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import type { ActionHandler } from '../../contracts/systems';

/** The real implementation, provided by rules/freekick.ts. */
export interface WallJumpImpl {
  update(s: SimState, slot: number, ev: EventSink): void;
  end(s: SimState, slot: number, interrupted: number): void;
}

const IMPL: WallJumpImpl = {
  update() { /* bound by rules/freekick.ts */ },
  end() { /* bound by rules/freekick.ts */ },
};

/** Install the implementation (called once by rules/freekick.ts when it is evaluated). */
export function bindWallJumpImpl(impl: WallJumpImpl): void {
  IMPL.update = impl.update;
  IMPL.end = impl.end;
}

/** ActionKind.WALL_JUMP: a free-kick wall member bracing, jumping or charging (and blocking the ball). */
export const wallJumpHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.update(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.end(s, slot, interrupted); },
};
