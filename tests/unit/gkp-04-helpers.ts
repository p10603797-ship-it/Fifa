/**
 * [GKP-04] Test helpers for keeper distribution tests: team 0's keeper (slot 0, defends the goal at x = -52.5,
 * attacks +x) holding the ball in open play with every other player placed from a layout. Used by
 * tests/unit/gkp-04-*.test.ts and tests/scenario/gkp-04-*.test.ts only.
 *
 * Team 0 (4-4-2 from initMatch): 1 RB, 2 CB, 3 CB, 4 LB, 5 RM, 6 CM, 7 CM, 8 LM, 9 ST, 10 ST.
 */
import { BALL_RADIUS, NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase, TeamStyle } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { keeperPickUp } from '../../src/sim/keeper/handling';
import { makeScenario, type ScenarioHuman } from '../harness/scenario';

export const GK = 0;
export const PICKUP = 100;
export type P2 = readonly [number, number];
export type Layout = Readonly<Record<number, P2>>;

/** Open build-up: defenders near the keeper, midfield 30-40 m away, strikers ~52 m away with ~7 m of space. */
export const MATES_OPEN: Layout = {
  1: [-36, 22], 2: [-38, 8], 3: [-38, -8], 4: [-36, -22],
  5: [-14, 22], 6: [-18, 6], 7: [-18, -6], 8: [-14, -22],
  9: [5, 8], 10: [5, -8],
};

/** Opponents in a mid block in their own half (no press, no counter); their centre-backs ~7 m from our strikers. */
export const OPPS_MID_BLOCK: Layout = {
  11: [50, 0],
  12: [14, -24], 13: [12, -6], 14: [12, 6], 15: [14, 24],
  16: [8, -26], 17: [8, -16], 18: [8, 16], 19: [8, 26],
  20: [-2, -20], 21: [-2, 20],
};

/**
 * High press: four opponents in our third on our back four, four more on our midfield, two on our strikers'
 * shoulders (~7 m). Only two opponent outfielders in their own half but no free outlet (not a counter).
 */
export const OPPS_HIGH_PRESS: Layout = {
  11: [50, 0],
  12: [-37, 21], 13: [-39, 7], 14: [-39, -7], 15: [-37, -21],
  16: [-15, 21], 17: [-19, 5], 18: [-19, -5], 19: [-15, -21],
  20: [12, 6], 21: [12, -6],
};

/** Counter: nine opponents committed into our half after an attack, one left back; our strikers free. */
export const OPPS_COMMITTED: Layout = {
  11: [50, 0],
  12: [-30, -14], 13: [-36, -6], 14: [-36, 6], 15: [-30, 14],
  16: [-24, -24], 17: [-26, -2], 18: [-26, 4], 19: [-24, 24],
  20: [-40, 0], 21: [20, 0],
};

export interface HoldingOpts {
  seed?: number;
  style?: TeamStyle;
  mates?: Layout;
  opps?: Layout;
  /** Keeper position (default 6 m off his line, central). */
  keeper?: P2;
  humans?: ScenarioHuman[];
  offside?: number;
}

/** IN_PLAY, keeper 0 holding the ball (picked up at tick PICKUP), everybody placed from the layouts, at rest. */
export function holdingScene(o: HoldingOpts = {}): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed: o.seed ?? 7, humans: o.humans ?? [],
    config: o.offside === undefined ? undefined : { offside: o.offside },
  });
  const mates = o.mates ?? MATES_OPEN;
  const opps = o.opps ?? OPPS_MID_BLOCK;
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === GK) continue;
    const p = s.players[i]!;
    const pos = i < 11 ? mates[i] : opps[i];
    if (pos) { p.x = pos[0]; p.z = pos[1]; }
    p.vx = 0; p.vz = 0;
    p.fx = p.team === 0 ? 1 : -1; p.fz = 0;
  }
  if (o.style !== undefined) s.teams[0]!.style = o.style;
  const k = s.players[GK]!;
  k.x = o.keeper?.[0] ?? -46.5;
  k.z = o.keeper?.[1] ?? 0;
  k.vx = 0; k.vz = 0; k.fx = 1; k.fz = 0;
  const b = s.ball;
  b.x = k.x + 0.4; b.y = BALL_RADIUS; b.z = k.z;
  b.px = b.x; b.py = b.y; b.pz = b.z;
  b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
  b.owner = -1; b.heldBy = -1;
  // Last played by an opponent (a shot), so the pick-up is legal.
  b.lastKickBy = 20; b.lastKickTeam = 1; b.lastKickKind = KickKind.SHOT_NORMAL; b.lastKickTick = PICKUP - 5;
  b.lastTouch = 20; b.lastTouchTeam = 1; b.lastTouchTick = PICKUP - 5;
  s.players[20]!.lastTouchTick = PICKUP - 5;
  s.tick = PICKUP;
  const ev = createEventBuffer();
  ev.begin(s.tick);
  keeperPickUp(s, GK, ev);
  if (s.ball.heldBy !== GK || s.players[GK]!.act !== ActionKind.GK_HOLD) throw new Error('holdingScene: pick-up failed');
  return s;
}

/** Events of a type by slot a. */
export function eventsOf(events: readonly SimEvent[], type: EventType, a?: number): SimEvent[] {
  return events.filter((e) => e.type === type && (a === undefined || e.a === a));
}

export function isKick(k: KickKind): boolean {
  return k === KickKind.GK_DROP_KICK || k === KickKind.GK_DRIVEN_KICK;
}

/** Tiny deterministic LCG for test layouts (tests may not depend on Math.random). */
export function lcg(seed: number): () => number {
  let x = (seed >>> 0) || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}
