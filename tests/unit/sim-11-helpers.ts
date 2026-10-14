/**
 * [SIM-11] Shared setup for the shooting tests: a quiet IN_PLAY state (everyone parked far away), a team-0 shooter
 * (attacking +x) with the ball at his feet, the team-1 keeper on his line, request building, solver calls and
 * scratch-ball flights with the sim's ball physics.
 */
import { GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, AssistLevel, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { createBallState, MoveMode, type BallState, type SimState } from '../../src/contracts/state';
import { createActionRequest, createKickLaunch, type ActionRequest, type KickLaunch } from '../../src/contracts/systems';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState } from '../../src/sim/ball/flight';
import { NULL_SINK } from '../../src/sim/core/events';
import { rngSeed } from '../../src/sim/core/rng';
import { solveShot, startShot } from '../../src/sim/kicks/shot';
import { makeScenario } from '../harness/scenario';

export const GX = HALF_LENGTH;
export const GHW = GOAL_HALF_WIDTH;
export const GH = GOAL_HEIGHT;
/** Team 0 shooter (attacks +x), a team-0 mate, team-1 keeper and a defender. */
export const SHOOTER = 9;
export const MATE = 10;
export const KEEPER = 11;
export const DEF = 15;

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

/** Shooting attributes of slot set to v (weakFoot / foot separately). */
export function skill(s: SimState, slot: number, v: number, weakFoot = 5, foot = 0): void {
  const a = s.attrs[slot]!;
  a.finishing = v; a.longShots = v; a.shotPower = v; a.curve = v; a.composure = v; a.ballControl = v;
  a.weakFoot = weakFoot; a.foot = foot;
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

/**
 * IN_PLAY at tick 100: everybody parked in a far strip (x = -46 / -43), no chasers or controllers, the shooter at
 * (x, z) facing the goal centre with the ball at his feet, the keeper (unless `keeper` is false) on his line.
 */
export function shootScene(x = 36, z = 0, seed = 1, keeper = true): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed });
  for (let i = 0; i < NUM_SLOTS; i++) place(s, i, -46 + (i % 2) * 3, -30 + i * 2.8);
  for (let t = 0; t < 2; t++) s.teams[t]!.chaser = -1;
  for (let c = 0; c < s.ctrl.length; c++) s.ctrl[c]!.slot = -1;
  s.tick = 100;
  let fx = GX - x, fz = -z;
  const l = Math.sqrt(fx * fx + fz * fz);
  fx /= l; fz /= l;
  place(s, SHOOTER, x, z, fx, fz);
  skill(s, SHOOTER, 80);
  giveBall(s, SHOOTER);
  if (keeper) place(s, KEEPER, GX - 0.5, 0, -1, 0);
  else s.players[KEEPER]!.active = 0;
  return s;
}

export interface ShotOpts {
  power?: number;
  charging?: number;
  dirX?: number;
  dirZ?: number;
  hasTarget?: number;
  targetX?: number;
  targetZ?: number;
  curve?: number;
  assist?: AssistLevel;
  flags?: number;
}

/** A filled ActionRequest (default: power 0.7, stick toward +x, Assisted). */
export function shotReq(o: ShotOpts = {}): ActionRequest {
  const r = createActionRequest();
  r.power = o.power ?? 0.7;
  r.charging = o.charging ?? 0;
  r.dirX = o.dirX ?? 1;
  r.dirZ = o.dirZ ?? 0;
  r.hasTarget = o.hasTarget ?? 0;
  r.targetX = o.targetX ?? 0;
  r.targetZ = o.targetZ ?? 0;
  r.curve = o.curve ?? 0;
  r.assist = o.assist ?? AssistLevel.ASSISTED;
  r.flags = o.flags ?? 0;
  return r;
}

/** startShot then the solver (as at contact) with the rng reseeded; returns the launch (or null if refused). */
export function solveKind(s: SimState, kind: KickKind, o: ShotOpts = {}, seed = 7, slot = SHOOTER): KickLaunch | null {
  if (startShot(s, slot, kind, shotReq(o), NULL_SINK) !== 1) return null;
  rngSeed(s.rng, seed);
  const out = createKickLaunch();
  return solveShot(s, slot, out) === 1 ? out : null;
}

/** Launch speed. */
export function speedOf(l: KickLaunch): number { return Math.sqrt(l.vx * l.vx + l.vy * l.vy + l.vz * l.vz); }

/** Copy of the ball launched with l (as applyKick would set it). */
export function launched(s: SimState, l: KickLaunch): BallState {
  const b = createBallState();
  copyBallState(b, s.ball);
  b.vx = l.vx; b.vy = l.vy; b.vz = l.vz; b.sx = l.sx; b.sy = l.sy; b.sz = l.sz;
  b.grounded = l.vy > 0.5 ? 0 : b.grounded; b.owner = -1; b.bounces = 0;
  return b;
}

/** Where a flight first crosses x = lineX (interpolated), plus its peak height before that; null if it never does. */
export interface Crossing { y: number; z: number; t: number; peak: number }

export function crossAt(b: BallState, lineX: number, maxTicks = 300): Crossing | null {
  let peak = b.y;
  for (let i = 1; i <= maxTicks; i++) {
    const px = b.x, py = b.y, pz = b.z;
    ballStepTick(b, null);
    if (b.y > peak) peak = b.y;
    if ((px - lineX) * (b.x - lineX) <= 0 && b.x !== px) {
      const f = (lineX - px) / (b.x - px);
      return { y: py + (b.y - py) * f, z: pz + (b.z - pz) * f, t: i - 1 + f, peak };
    }
  }
  return null;
}

/** Highest ball-centre height of a flight before it reaches x = lineX or turns back (post / bar), m. */
export function peakBefore(b: BallState, lineX: number, maxTicks = 300): number {
  let peak = b.y;
  const dir = Math.sign(lineX - b.x);
  for (let i = 1; i <= maxTicks; i++) {
    ballStepTick(b, null);
    if ((lineX - b.x) * dir <= 0 || b.vx * dir <= 0) break;
    if (b.y > peak) peak = b.y;
  }
  return peak;
}

/** Unit direction from the ball to (x, z). */
export function dirTo(s: SimState, x: number, z: number): { x: number; z: number } {
  const dx = x - s.ball.x, dz = z - s.ball.z;
  const l = Math.sqrt(dx * dx + dz * dz);
  return { x: dx / l, z: dz / l };
}

/** Shot flight of a launch from the current ball to the goal line. */
export function flightToGoal(s: SimState, l: KickLaunch, lineX = GX): Crossing | null {
  return crossAt(launched(s, l), lineX);
}

/** True if a crossing is inside the mouth (ball centre within the posts and under the bar). */
export function inMouth(c: Crossing | null): boolean {
  return c !== null && c.z < GHW && c.z > -GHW && c.y < GH;
}
