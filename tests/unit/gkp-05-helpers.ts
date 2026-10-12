/**
 * [GKP-05] Test helpers for keeper handling tests: a keeper-with-the-ball scenario (team 0 keeper slot 0 defends the
 * goal at x = -52.5, depth u = x + 52.5), release requests and event helpers. Used by tests/unit/gkp-05-*.test.ts and
 * tests/scenario/gkp-05-*.test.ts only.
 */
import { BALL_RADIUS, HALF_LENGTH, NUM_SLOTS } from '../../src/contracts/constants';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { createActionRequest, type ActionRequest } from '../../src/contracts/systems';
import { createEventBuffer, type EventBufferImpl } from '../../src/sim/core/events';
import { keeperPickUp } from '../../src/sim/keeper/handling';
import { makeScenario, type ScenarioHuman } from '../harness/scenario';

export const KEEPER = 0;
/** Opponent used as the last shooter / toucher. */
export const OPP = 15;
/** Teammate used as a receiver. */
export const MATE = 5;
export const xAt = (u: number): number => u - HALF_LENGTH;
export const depth = (x: number): number => x + HALF_LENGTH;

export interface KeeperBallOpts {
  /** Keeper depth from his goal line and z. */
  u?: number;
  z?: number;
  /** Ball offset from the keeper (default 0.4 m in front, on the ground). */
  bdx?: number;
  bdz?: number;
  seed?: number;
  humans?: ScenarioHuman[];
  /** Receiver MATE position (default far away, parked with the rest). */
  mate?: { x: number; z: number };
}

/**
 * IN_PLAY with keeper 0 at (u, z) and the ball loose at his feet, last played by an opponent (a shot). Every other
 * player is parked in the middle of the pitch (opponents far from the keeper's teammates).
 */
export function keeperBall(o: KeeperBallOpts = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: o.seed ?? 11, humans: o.humans ?? [] });
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === KEEPER) continue;
    const p = s.players[i]!;
    p.x = i < 11 ? -20 + (i % 5) * 3 : 20 + (i % 5) * 3;
    p.z = -25 + (i % 11) * 5;
    p.vx = 0; p.vz = 0;
  }
  s.players[11]!.x = 50; s.players[11]!.z = 0;
  if (o.mate) { s.players[MATE]!.x = o.mate.x; s.players[MATE]!.z = o.mate.z; }
  const k = s.players[KEEPER]!;
  k.x = xAt(o.u ?? 4);
  k.z = o.z ?? 0;
  k.vx = 0; k.vz = 0; k.fx = 1; k.fz = 0;
  const b = s.ball;
  b.x = k.x + (o.bdx ?? 0.4); b.y = BALL_RADIUS; b.z = k.z + (o.bdz ?? 0);
  b.px = b.x; b.py = b.y; b.pz = b.z;
  b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
  b.owner = -1; b.heldBy = -1;
  b.lastKickBy = OPP; b.lastKickTeam = 1; b.lastKickKind = KickKind.SHOT_NORMAL; b.lastKickTick = 0;
  b.lastTouch = OPP; b.lastTouchTeam = 1; b.lastTouchTick = 0;
  s.players[OPP]!.lastTouchTick = 0;
  s.tick = 10;
  return s;
}

/** keeperBall + the keeper picks the ball up (events of the pick-up returned in the buffer). */
export function keeperHolding(o: KeeperBallOpts = {}): { s: SimState; ev: EventBufferImpl } {
  const s = keeperBall(o);
  const ev = createEventBuffer();
  ev.begin(s.tick);
  keeperPickUp(s, KEEPER, ev);
  return { s, ev };
}

export function request(fields: Partial<ActionRequest> = {}): ActionRequest {
  return Object.assign(createActionRequest(), fields);
}

/** Events of a type by slot a. */
export function eventsOf(events: readonly SimEvent[], type: EventType, a?: number): SimEvent[] {
  return events.filter((e) => e.type === type && (a === undefined || e.a === a));
}
