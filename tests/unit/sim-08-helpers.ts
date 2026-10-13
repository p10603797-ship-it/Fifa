/**
 * [SIM-08] Shared setup for the passing / KICK action tests: a quiet IN_PLAY state (everyone parked far away), a
 * passer with the ball at his feet, request building, solver calls and scratch-ball flight.
 */
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, AssistLevel, ControllerKind, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { createBallState, MoveMode, type BallState, type SimState } from '../../src/contracts/state';
import { createActionRequest, createKickLaunch, type ActionRequest, type KickLaunch } from '../../src/contracts/systems';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState } from '../../src/sim/ball/flight';
import { NULL_SINK } from '../../src/sim/core/events';
import { rngSeed } from '../../src/sim/core/rng';
import { solveGroundPass, startPass } from '../../src/sim/kicks/pass';
import { makeScenario } from '../harness/scenario';

export const DT = 1 / 60;
/** Team 0 passer and teammates; team 1 opponents. */
export const PASSER = 6;
export const MATE_A = 9;
export const MATE_B = 10;
export const MATE_C = 7;
export const OPP_A = 15;
export const OPP_B = 16;

/** Put slot at (x, z), idle, uncontrolled, facing (fx, fz). */
export function place(s: SimState, slot: number, x: number, z: number, fx = 1, fz = 0): void {
  const p = s.players[slot]!;
  p.active = 1;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0; p.fx = fx; p.fz = fz;
  p.moveMode = MoveMode.STOP; p.ix = 0; p.iz = 0; p.tgtX = x; p.tgtZ = z; p.tgtSpeed = 0; p.wantSprint = 0;
  p.lookAt = 0; p.sprinting = 0; p.jockeying = 0; p.shielding = 0;
  p.act = ActionKind.NONE; p.actT = 0; p.actDur = 0; p.actContact = -1; p.actDone = 0; p.actKick = KickKind.NONE;
  p.actSkill = SkillMove.NONE; p.actPower = 0; p.actCharging = 0; p.actA = 0; p.actB = 0; p.actSlot = -1;
  p.actDirX = 0; p.actDirZ = 0; p.actX = 0; p.actZ = 0; p.actCurve = 0;
  p.ctrl = -1; p.stunT = 0; p.noTouchT = 0; p.touchCd = 0; p.stamina = 1;
}

/** Every attribute of slot that matters for passing set to v (weakFoot / foot separately). */
export function skill(s: SimState, slot: number, v: number, weakFoot = 5, foot = 0): void {
  const a = s.attrs[slot]!;
  a.shortPassing = v; a.longPassing = v; a.vision = v; a.ballControl = v;
  a.weakFoot = weakFoot; a.foot = foot;
}

/**
 * IN_PLAY at tick 100: everybody parked in a far corner strip (x = -46 / -43, z spread), no chasers or
 * controllers, the passer at (0, 0) facing +x with the ball at his feet.
 */
export function quiet(seed = 1): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed });
  for (let i = 0; i < NUM_SLOTS; i++) place(s, i, -46 + (i % 2) * 3, -30 + i * 2.8);
  for (let t = 0; t < 2; t++) s.teams[t]!.chaser = -1;
  for (let c = 0; c < s.ctrl.length; c++) s.ctrl[c]!.slot = -1;
  s.tick = 100;
  place(s, PASSER, 0, 0);
  skill(s, PASSER, 80);
  giveBall(s, PASSER);
  return s;
}

/** Ball at slot's kicking spot (0.5 m ahead along his facing), owned by him, at rest. */
export function giveBall(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  b.x = p.x + p.fx * 0.5; b.z = p.z + p.fz * 0.5; b.y = 0.11;
  b.px = b.x; b.py = b.y; b.pz = b.z;
  b.vx = 0; b.vy = 0; b.vz = 0; b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = 1; b.bounces = 0; b.owner = slot; b.ownerT = 10; b.heldBy = -1; b.inNet = 0; b.shotBy = -1;
  b.passTarget = -1; b.lastTouch = slot; b.lastTouchTeam = p.team; b.lastTouchTick = s.tick - 5; b.touchedTick = s.tick - 5;
}

export interface ReqOpts {
  power?: number;
  charging?: number;
  dirX?: number;
  dirZ?: number;
  targetSlot?: number;
  hasTarget?: number;
  targetX?: number;
  targetZ?: number;
  assist?: AssistLevel;
  flags?: number;
}

/** A filled ActionRequest. */
export function req(o: ReqOpts = {}): ActionRequest {
  const r = createActionRequest();
  r.power = o.power ?? 0.5;
  r.charging = o.charging ?? 0;
  r.dirX = o.dirX ?? 1;
  r.dirZ = o.dirZ ?? 0;
  r.targetSlot = o.targetSlot ?? -1;
  r.hasTarget = o.hasTarget ?? 0;
  r.targetX = o.targetX ?? 0;
  r.targetZ = o.targetZ ?? 0;
  r.assist = o.assist ?? AssistLevel.ASSISTED;
  r.flags = o.flags ?? 0;
  return r;
}

/** startPass then the solver (as at contact) with the rng reseeded; returns the launch (or null if refused). */
export function solve(s: SimState, kind: KickKind, o: ReqOpts = {}, seed = 7, slot = PASSER): KickLaunch | null {
  if (startPass(s, slot, kind, req(o), NULL_SINK) !== 1) return null;
  rngSeed(s.rng, seed);
  const out = createKickLaunch();
  return solveGroundPass(s, slot, out) === 1 ? out : null;
}

/** Horizontal launch speed. */
export function hspeed(l: KickLaunch): number { return Math.sqrt(l.vx * l.vx + l.vz * l.vz); }

/** Copy of the ball launched with l (as applyKick would set it). */
export function launched(s: SimState, l: KickLaunch): BallState {
  const b = createBallState();
  copyBallState(b, s.ball);
  b.vx = l.vx; b.vy = l.vy; b.vz = l.vz; b.sx = l.sx; b.sy = l.sy; b.sz = l.sz;
  b.grounded = l.vy > 0.5 ? 0 : b.grounded; b.owner = -1; b.bounces = 0;
  return b;
}

/** Fly a ball n ticks with the sim's physics, calling f(tick, ball) after each tick (stop when f returns true). */
export function fly(b: BallState, n: number, f: (i: number, b: BallState) => boolean | void): void {
  for (let i = 1; i <= n; i++) {
    ballStepTick(b, null);
    if (f(i, b) === true) return;
  }
}

/** Make slot the controlled player of human controller 0. */
export function control(s: SimState, slot: number, assist: AssistLevel = AssistLevel.ASSISTED): void {
  const c = s.ctrl[0]!;
  c.kind = ControllerKind.HUMAN;
  c.side = s.players[slot]!.team;
  c.slot = slot;
  c.assist = assist;
  s.players[slot]!.ctrl = 0;
}
