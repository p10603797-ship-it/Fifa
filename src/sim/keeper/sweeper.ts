/**
 * [GKP-03] Coming out: rushes for through balls and one-on-ones, claims or punches crosses in the goal area,
 * smothers loose balls. Also executes the user's keeper-rush hold (resolver starts GK_RUSH). Never fights a
 * defender for the same ball. Handlers GK_RUSH and GK_PUNCH.
 */
import type { ActionHandler } from '../../contracts/systems';
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';

export function keeperComeOut(s: SimState, team: number, ev: EventSink): void { /* stub */ }
/** Start a rush (user hold or AI). Returns 1 if started. */
export function startKeeperRush(s: SimState, slot: number, ev: EventSink): number { return 0; }
export const rushHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const punchHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
