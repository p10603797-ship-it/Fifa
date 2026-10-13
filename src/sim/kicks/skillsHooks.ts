/**
 * [SIM-13] Import-cycle-safe shells of the SKILL / FAKE action handlers and the skill-touch kick solver (helper of
 * skills.ts, owned by SIM-13).
 *
 * actions/registry.ts reads skillHandler, fakeHandler and solveSkillTouch from kicks/skills.ts while it builds its
 * tables, and kicks/skills.ts imports actions/dispatch (-> actions/registry) back. When kicks/skills.ts is the module
 * that enters that cycle (e.g. a CPU / test module imports it before anything imports the dispatcher), the registry
 * would read its exports before they exist (TDZ in a bundle, `undefined` -> the idle handler under vitest) and no
 * skill move would ever run. This module has NO runtime imports, so it is always fully evaluated first; skills.ts
 * re-exports these shells as its first statement and binds the real implementation (bindSkillsImpl) at the end of its
 * body, long before the first tick runs. The shells only forward (no allocation).
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import type { ActionHandler, KickLaunch } from '../../contracts/systems';

/** The real implementation, provided by kicks/skills.ts. */
export interface SkillsImpl {
  skillUpdate(s: SimState, slot: number, ev: EventSink): void;
  skillEnd(s: SimState, slot: number, interrupted: number): void;
  fakeUpdate(s: SimState, slot: number, ev: EventSink): void;
  fakeEnd(s: SimState, slot: number, interrupted: number): void;
  solveSkillTouch(s: SimState, slot: number, out: KickLaunch): number;
}

const IMPL: SkillsImpl = {
  skillUpdate() { /* bound by kicks/skills.ts */ },
  skillEnd() { /* bound by kicks/skills.ts */ },
  fakeUpdate() { /* bound by kicks/skills.ts */ },
  fakeEnd() { /* bound by kicks/skills.ts */ },
  solveSkillTouch() { return 0; },
};

/** Install the implementation (called once by kicks/skills.ts when it is evaluated). */
export function bindSkillsImpl(impl: SkillsImpl): void {
  IMPL.skillUpdate = impl.skillUpdate;
  IMPL.skillEnd = impl.skillEnd;
  IMPL.fakeUpdate = impl.fakeUpdate;
  IMPL.fakeEnd = impl.fakeEnd;
  IMPL.solveSkillTouch = impl.solveSkillTouch;
}

/** KickSolver for KNOCK_ON, SKILL_TOUCH, DRIBBLE_TOUCH touches started as KICK actions. */
export function solveSkillTouch(s: SimState, slot: number, out: KickLaunch): number {
  return IMPL.solveSkillTouch(s, slot, out);
}

/** ActionKind.SKILL handler (scripted ball and body over the move's duration). */
export const skillHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.skillUpdate(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.skillEnd(s, slot, interrupted); },
};

/** ActionKind.FAKE handler (a KICK / SHOT wind-up cancelled into the fake-shot cut). */
export const fakeHandler: ActionHandler = {
  update(s, slot, ev) { IMPL.fakeUpdate(s, slot, ev); },
  end(s, slot, interrupted) { IMPL.fakeEnd(s, slot, interrupted); },
};
