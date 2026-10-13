/**
 * [SIM-07] Shared setup for the first-touch tests: an IN_PLAY state with every player parked far from the action,
 * a ball arriving at a receiver, one contact-stage call, and outcome classification.
 */
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, ControllerKind, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import type { SimEvent } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { rngSeed } from '../../src/sim/core/rng';
import { LOCAL_TUNING, receiveContacts, TouchOutcome } from '../../src/sim/players/firstTouch';
import { makeScenario } from '../harness/scenario';

export const DT = 1 / 60;
/** Team 0: passer, receiver, another teammate, keeper. Team 1: two outfielders and the keeper. */
export const PASSER = 5;
export const RECV = 9;
export const MATE = 7;
export const GK0 = 0;
export const OPP = 15;
export const OPP2 = 16;
export const GK1 = 11;
/** Receiver spot. */
export const RX = 10;
export const RZ = 0;

/** Put slot at (x, z), idle, uncontrolled, facing +x. */
export function resetPlayer(s: SimState, slot: number, x: number, z: number): void {
  const p = s.players[slot]!;
  p.active = 1;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0; p.fx = 1; p.fz = 0;
  p.moveMode = MoveMode.STOP; p.ix = 0; p.iz = 0; p.tgtX = x; p.tgtZ = z; p.tgtSpeed = 0; p.wantSprint = 0;
  p.lookAt = 0; p.sprinting = 0; p.jockeying = 0; p.shielding = 0;
  p.act = ActionKind.NONE; p.actT = 0; p.actDur = 0; p.actContact = -1; p.actDone = 0; p.actKick = KickKind.NONE;
  p.actSkill = SkillMove.NONE; p.actPower = 0; p.actCharging = 0; p.actA = 0; p.actB = 0; p.actSlot = -1;
  p.ctrl = -1; p.stunT = 0; p.noTouchT = 0; p.touchCd = 0; p.stamina = 1;
}

/** IN_PLAY at tick 100, everybody parked around x = -45 (no pressure near the receiver spot), no chasers. */
export function baseState(seed = 1): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed });
  for (let i = 0; i < NUM_SLOTS; i++) resetPlayer(s, i, -46 + (i % 2) * 3, -30 + i * 2.8);
  for (let t = 0; t < 2; t++) s.teams[t]!.chaser = -1;
  for (let c = 0; c < s.ctrl.length; c++) s.ctrl[c]!.slot = -1;
  s.tick = 100;
  resetPlayer(s, RECV, RX, RZ);
  return s;
}

export interface Incoming {
  /** Ball speed toward the receiver, m/s. */
  speed: number;
  /** Direction from the receiver to where the ball comes from (default +x). */
  fromX?: number;
  fromZ?: number;
  /** Current distance of the ball from the receiver along its path, m (default 0.9: just inside the foot reach). */
  dist?: number;
  /** The ball's path passes this far to the side of the receiver, m (default 0: straight at him). */
  lateral?: number;
  y?: number;
  vy?: number;
  /** true (default): an untouched pass by `kicker` aimed at `target`; false: a loose ball last touched by OPP. */
  pass?: boolean;
  kicker?: number;
  target?: number;
  kind?: KickKind;
  /** Receiver faces the ball (default true). */
  face?: boolean;
}

/** Ball arriving at `slot` this tick (segment from one tick back), plus the pass bookkeeping. */
export function incoming(s: SimState, slot: number, o: Incoming): void {
  const p = s.players[slot]!;
  const b = s.ball;
  let fx = o.fromX ?? 1, fz = o.fromZ ?? 0;
  const fl = Math.sqrt(fx * fx + fz * fz);
  fx /= fl; fz /= fl;
  const d = o.dist ?? 0.9;
  const lat = o.lateral ?? 0;
  b.x = p.x + fx * d - fz * lat; b.z = p.z + fz * d + fx * lat; b.y = o.y ?? 0.11;
  b.vx = -fx * o.speed; b.vz = -fz * o.speed; b.vy = o.vy ?? 0;
  b.px = b.x - b.vx * DT; b.pz = b.z - b.vz * DT; b.py = b.y - b.vy * DT;
  b.grounded = b.y <= 0.115 && b.vy === 0 ? 1 : 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.owner = -1; b.ownerT = 0; b.heldBy = -1; b.inNet = 0; b.cross = 0; b.shotBy = -1;
  if (o.pass ?? true) {
    const k = o.kicker ?? PASSER;
    b.lastKickBy = k; b.lastKickTeam = s.players[k]!.team; b.lastKickKind = o.kind ?? KickKind.GROUND_PASS;
    b.lastKickTick = s.tick - 40;
    b.lastTouch = k; b.lastTouchTeam = s.players[k]!.team; b.lastTouchTick = b.lastKickTick; b.touchedTick = b.lastKickTick;
    b.passTarget = o.target ?? slot;
  } else {
    b.lastKickBy = OPP; b.lastKickTeam = 1; b.lastKickKind = KickKind.SHOT_NORMAL; b.lastKickTick = s.tick - 40;
    b.lastTouch = OPP2; b.lastTouchTeam = 1; b.lastTouchTick = s.tick - 10; b.touchedTick = s.tick - 10;
    b.passTarget = -1;
  }
  if (o.face ?? true) { p.fx = fx; p.fz = fz; }
}

/** Make slot a human-controlled player (controller 0). */
export function control(s: SimState, slot: number): void {
  const c = s.ctrl[0]!;
  c.kind = ControllerKind.HUMAN;
  c.side = s.players[slot]!.team;
  c.slot = slot;
  s.players[slot]!.ctrl = 0;
}

const EVB = createEventBuffer();

/** One contact stage: advance the tick and run receiveContacts; returns the events emitted. */
export function contactTick(s: SimState): SimEvent[] {
  s.tick++;
  s.ball.cross = 0;
  EVB.begin(s.tick);
  receiveContacts(s, EVB);
  const out: SimEvent[] = [];
  for (let i = 0; i < EVB.count; i++) {
    const e = EVB.get(i);
    out.push({ type: e.type, tick: e.tick, a: e.a, b: e.b, c: e.c, d: e.d, x: e.x, y: e.y, z: e.z });
  }
  return out;
}

export type Outcome = 'clean' | 'heavy' | 'miss' | 'none';

/** What happened to slot in the last contactTick. */
export function outcome(s: SimState, slot: number): Outcome {
  const p = s.players[slot]!;
  if (s.ball.owner === slot && p.act === ActionKind.FIRST_TOUCH && p.actA === TouchOutcome.CLEAN) return 'clean';
  if (p.act === ActionKind.FIRST_TOUCH && p.actA === TouchOutcome.HEAVY) return 'heavy';
  if (p.noTouchT === LOCAL_TUNING.missNoTouchTicks && s.ball.lastTouch !== slot) return 'miss';
  return 'none';
}

/** Run `n` seeded trials of `setup` (which must build a fresh arrival) and count the receiver's outcomes. */
export function trials(n: number, setup: (s: SimState) => void, slot = RECV): Record<Outcome, number> {
  const counts: Record<Outcome, number> = { clean: 0, heavy: 0, miss: 0, none: 0 };
  const s = baseState(1);
  for (let seed = 1; seed <= n; seed++) {
    resetPlayer(s, slot, RX, RZ);
    rngSeed(s.rng, seed);
    setup(s);
    contactTick(s);
    counts[outcome(s, slot)]++;
  }
  return counts;
}
