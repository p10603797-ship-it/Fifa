/**
 * [SIM-14] Tackles: standing (timed lunge with reach and recovery ticks; success from timing, angle and
 * attributes; mistimed = miss, stumble or foul), hard tackle, slide (long reach, long recovery, high foul risk
 * from behind), shoulder challenge alongside, push/pull when chasing, contextual clearance, interceptions when a
 * pass crosses a defender's reach. Every challenge that contacts an opponent is recorded in
 * s.match.challenges (pushChallenge) for RUL-09 to classify. Emits TACKLE, INTERCEPT.
 */
import type { ActionKind, KickKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { ActionHandler, ActionRequest, KickLaunch } from '../../contracts/systems';
import type { ChallengeRecord, SimState } from '../../contracts/state';

/** Start STAND_TACKLE, HARD_TACKLE, SLIDE_TACKLE, SHOULDER or PUSH_PULL against targetSlot (-1 = ball carrier). */
export function startTackle(s: SimState, slot: number, kind: ActionKind, targetSlot: number, ev: EventSink): number { return 0; }
/** Start a clearance (KickKind.CLEARANCE) — first-time when the ball arrives. */
export function startClearance(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number { return 0; }
/** KickSolver for CLEARANCE. */
export function solveClearance(s: SimState, slot: number, out: KickLaunch): number { return 0; }
/** Contact phase: tackles in their contact window touching ball / opponent. */
export function tackleContacts(s: SimState, ev: EventSink): void { /* stub */ }
/** Contact phase: defenders intercepting passes that cross their reach. */
export function interceptContacts(s: SimState, ev: EventSink): void { /* stub */ }
/** Put a player into STUMBLE or FALLEN (interrupting any action). */
export function knockDown(s: SimState, slot: number, kind: ActionKind, ev: EventSink): void { /* stub */ }
/** Append a challenge for RUL-09 (drops if the queue is full). */
export function pushChallenge(s: SimState, rec: Readonly<ChallengeRecord>): void { /* stub */ }
export const standTackleHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const hardTackleHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const slideTackleHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const shoulderHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const pushPullHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const stumbleHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const fallenHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const getUpHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
