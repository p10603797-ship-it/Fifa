/**
 * [GKP-02] Test double for keeper/handling.ts (GKP-05) following its documented contract, so the save tests do not
 * depend on GKP-05's progress: canHandle = keeper, active, inside his own penalty area, not a deliberate foot pass
 * from a teammate; keeperPickUp = hands + possession, ball still, KEEPER_HANDS(1), GK_HOLD.
 */
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, isFootPassKind } from '../../src/contracts/enums';
import { EventType, type EventSink } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import type { ActionHandler, ActionRequest, KickLaunch } from '../../src/contracts/systems';
import { T_GK } from '../../src/contracts/tuning';
import { takePossession } from '../../src/sim/core/kick';
import { inPenaltyArea } from '../../src/sim/pitch/geometry';

const idle: ActionHandler = { update() { /* none */ }, end() { /* none */ } };

export const mockState = { refuse: false, pickUps: 0 };

export function handlingMock() {
  return {
    canHandle(s: SimState, slot: number): boolean {
      if (mockState.refuse || slot < 0 || slot >= NUM_SLOTS) return false;
      const p = s.players[slot]!;
      if (p.isKeeper !== 1 || p.active !== 1) return false;
      const b = s.ball;
      if (isFootPassKind(b.lastKickKind) && b.lastKickTeam === p.team && b.lastTouch === b.lastKickBy) return false;
      return inPenaltyArea(p.x, p.z, -s.teams[p.team]!.dir);
    },
    keeperPickUp(s: SimState, slot: number, ev: EventSink): void {
      const b = s.ball;
      const p = s.players[slot]!;
      b.vx = 0; b.vy = 0; b.vz = 0; b.sx = 0; b.sy = 0; b.sz = 0;
      takePossession(s, slot, ev);
      b.heldBy = slot;
      ev.emit(EventType.KEEPER_HANDS, slot, 1);
      p.act = ActionKind.GK_HOLD; p.actT = 0; p.actDur = T_GK.maxHoldTicks; p.actContact = -1; p.actDone = 0; p.actCharging = 0;
      p.moveMode = MoveMode.STOP;
      mockState.pickUps++;
    },
    startKeeperRelease(s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink): number { return 0; },
    solveKeeperRelease(s: SimState, slot: number, out: KickLaunch): number { return 0; },
    holdHandler: idle,
    throwHandler: idle,
    gkKickHandler: idle,
  };
}
