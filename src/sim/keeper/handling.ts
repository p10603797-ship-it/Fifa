/**
 * [GKP-05] Keeper with the ball: pick-up into hands (only inside his own area; not from a deliberate pass from a
 * teammate's foot — isFootPassKind(ball.lastKickKind) && lastKickTeam === team), GK_HOLD carrying the ball
 * (positions the ball in his hands each tick), releases (throw, driven throw, roll, drop kick, driven kick, drop
 * at feet), the 6-second release rule (auto release for humans at T_GK.autoReleaseTicks), user control of throws
 * and kicks. Handlers GK_HOLD, GK_THROW, GK_KICK. Emits KEEPER_HANDS.
 */
import type { KickKind } from '../../contracts/enums';
import type { ActionHandler, ActionRequest, KickLaunch } from '../../contracts/systems';
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';

/** May slot handle the ball now (keeper, inside own area, back-pass rule)? Pure. */
export function canHandle(s: SimState, slot: number): boolean { return false; }
/** Take the ball into the keeper's hands (heldBy, owner) and start GK_HOLD. */
export function keeperPickUp(s: SimState, slot: number, ev: EventSink): void { /* stub */ }
/** Start a release of the given KickKind (GK_THROW, GK_DRIVEN_THROW, GK_ROLL, GK_DROP_KICK, GK_DRIVEN_KICK, GK_RELEASE = drop at feet). */
export function startKeeperRelease(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number { return 0; }
/** KickSolver for keeper releases. */
export function solveKeeperRelease(s: SimState, slot: number, out: KickLaunch): number { return 0; }
export const holdHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const throwHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
export const gkKickHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
