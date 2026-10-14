/**
 * [SIM-09 / SIM-10] Shared setup for the lob / cross / through-ball tests: a quiet IN_PLAY state (everyone parked in a
 * far strip), a kicker with the ball at his feet, request building, solver calls and sim-physics ball flight.
 */
import { BALL_RADIUS, NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, AssistLevel, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { createBallState, MoveMode, type BallState, type SimState } from '../../src/contracts/state';
import { createActionRequest, createKickLaunch, type ActionRequest, type KickLaunch } from '../../src/contracts/systems';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState } from '../../src/sim/ball/flight';
import { NULL_SINK } from '../../src/sim/core/events';
import { rngSeed } from '../../src/sim/core/rng';
import { solveCross, solveLob, startLob } from '../../src/sim/kicks/lob';
import { solveThrough, startThrough } from '../../src/sim/kicks/through';
import { makeScenario } from '../harness/scenario';

/** Team 0 kicker and teammates; team 1 opponents (15 and 16 outfield, 11 the keeper). */
export const KICKER = 6;
export const MATE_A = 9;
export const MATE_B = 10;
export const MATE_C = 7;
export const OPP_GK = 11;
export const OPP_A = 15;
export const OPP_B = 16;

/** Put slot at (x, z), idle, uncontrolled, facing (fx, fz), moving with (vx, vz). */
export function place(s: SimState, slot: number, x: number, z: number, fx = 1, fz = 0, vx = 0, vz = 0): void {
  const p = s.players[slot]!;
  p.active = 1;
  p.x = x; p.z = z; p.vx = vx; p.vz = vz; p.fx = fx; p.fz = fz;
  p.moveMode = MoveMode.STOP; p.ix = 0; p.iz = 0; p.tgtX = x; p.tgtZ = z; p.tgtSpeed = 0; p.wantSprint = 0;
  p.lookAt = 0; p.sprinting = 0; p.jockeying = 0; p.shielding = 0;
  p.act = ActionKind.NONE; p.actT = 0; p.actDur = 0; p.actContact = -1; p.actDone = 0; p.actKick = KickKind.NONE;
  p.actSkill = SkillMove.NONE; p.actPower = 0; p.actCharging = 0; p.actA = 0; p.actB = 0; p.actSlot = -1;
  p.actDirX = 0; p.actDirZ = 0; p.actX = 0; p.actZ = 0; p.actCurve = 0;
  p.ctrl = -1; p.stunT = 0; p.noTouchT = 0; p.touchCd = 0; p.stamina = 1;
}

/** Every attribute that matters for lobs, crosses and through balls set to v (weakFoot / foot separately). */
export function skill(s: SimState, slot: number, v: number, weakFoot = 5, foot = 0): void {
  const a = s.attrs[slot]!;
  a.shortPassing = v; a.longPassing = v; a.vision = v; a.ballControl = v; a.crossing = v; a.curve = v;
  a.weakFoot = weakFoot; a.foot = foot;
}

/**
 * IN_PLAY at tick 100: everybody parked in a far strip (x = -46 / -43, z spread; team 1 attacks -x so that is
 * behind team 0's own goal... far from the action), no chasers or controllers; the kicker at (kx, kz) facing
 * (fx, fz) with the ball at his feet.
 */
export function quiet(seed = 1, kx = 0, kz = 0, fx = 1, fz = 0): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed });
  for (let i = 0; i < NUM_SLOTS; i++) place(s, i, -46 + (i % 2) * 3, -30 + i * 2.8);
  for (let t = 0; t < 2; t++) { s.teams[t]!.chaser = -1; s.teams[t]!.cornerTactic = 0; }
  s.teams[0]!.dir = 1; s.teams[1]!.dir = -1;
  for (let c = 0; c < s.ctrl.length; c++) s.ctrl[c]!.slot = -1;
  s.tick = 100;
  const l = Math.hypot(fx, fz) || 1;
  place(s, KICKER, kx, kz, fx / l, fz / l);
  skill(s, KICKER, 80);
  giveBall(s, KICKER);
  return s;
}

/** Ball at slot's kicking spot (0.5 m ahead along his facing), owned by him, at rest. */
export function giveBall(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  b.x = p.x + p.fx * 0.5; b.z = p.z + p.fz * 0.5; b.y = BALL_RADIUS;
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
  curve?: number;
  assist?: AssistLevel;
  flags?: number;
}

/** A filled ActionRequest (default: power 0.5, stick idle = facing). */
export function req(o: ReqOpts = {}): ActionRequest {
  const r = createActionRequest();
  r.power = o.power ?? 0.5;
  r.charging = o.charging ?? 0;
  r.dirX = o.dirX ?? 0;
  r.dirZ = o.dirZ ?? 0;
  r.targetSlot = o.targetSlot ?? -1;
  r.hasTarget = o.hasTarget ?? 0;
  r.targetX = o.targetX ?? 0;
  r.targetZ = o.targetZ ?? 0;
  r.curve = o.curve ?? 0;
  r.assist = o.assist ?? AssistLevel.ASSISTED;
  r.flags = o.flags ?? 0;
  return r;
}

/** startLob then its solver (as at contact) with the rng reseeded; the launch, or null if refused. */
export function solveLobKick(s: SimState, kind: KickKind, o: ReqOpts = {}, seed = 7, slot = KICKER): KickLaunch | null {
  if (startLob(s, slot, kind, req(o), NULL_SINK) !== 1) return null;
  rngSeed(s.rng, seed);
  const out = createKickLaunch();
  const k = s.players[slot]!.actKick;
  const cross = k === KickKind.CROSS || k === KickKind.GROUND_CROSS || k === KickKind.LOW_CROSS;
  return (cross ? solveCross(s, slot, out) : solveLob(s, slot, out)) === 1 ? out : null;
}

/** startThrough then solveThrough with the rng reseeded; the launch, or null if refused. */
export function solveThroughKick(s: SimState, kind: KickKind, o: ReqOpts = {}, seed = 7, slot = KICKER): KickLaunch | null {
  if (startThrough(s, slot, kind, req(o), NULL_SINK) !== 1) return null;
  rngSeed(s.rng, seed);
  const out = createKickLaunch();
  return solveThrough(s, slot, out) === 1 ? out : null;
}

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

/** First landing of a launched ball (position where its centre first comes down to the ground) and its tick. */
export function landing(s: SimState, l: KickLaunch): { x: number; z: number; tick: number } {
  const b = launched(s, l);
  let px = b.x, py = b.y, pz = b.z;
  let res = { x: NaN, z: NaN, tick: -1 };
  fly(b, 600, (i, bb) => {
    if (bb.bounces > 0 || (bb.y <= BALL_RADIUS + 1e-6 && bb.vy <= 0 && i > 1)) {
      // Interpolate the crossing of the ground between the last two samples.
      const f = py > bb.y ? (py - BALL_RADIUS) / (py - bb.y) : 1;
      const g = f < 0 ? 0 : f > 1 ? 1 : f;
      res = { x: px + (bb.x - px) * g, z: pz + (bb.z - pz) * g, tick: i };
      return true;
    }
    px = bb.x; py = bb.y; pz = bb.z;
    return false;
  });
  return res;
}

/** Ball height when its horizontal position passes closest to (x, z) during the first flight. */
export function heightNear(s: SimState, l: KickLaunch, x: number, z: number): number {
  const b = launched(s, l);
  let best = Infinity, h = NaN;
  fly(b, 600, (_i, bb) => {
    const d = Math.hypot(bb.x - x, bb.z - z);
    if (d < best) { best = d; h = bb.y; }
    return bb.bounces > 0;
  });
  return h;
}
