/**
 * [SIM-13] Skill moves and fake shot. Eight to start: ball roll, step-over, body feint, drag-back, fake shot,
 * roulette, heel flick, knock-on (+ STOP_BALL, STOP_FACE_GOAL, HARD_STOP utility touches). Each has a fixed
 * duration (T_SKILL.duration), an exit direction and a window where the ball can be won (T_SKILL.vulnStart/
 * vulnEnd). The skill-star rating (attrs.skillMoves) gates the harder ones (T_SKILL.minStars). Emits SKILL.
 *
 * STARTING (startSkill / startFake). A move starts only IN_PLAY, for a free player (isFree) who owns the ball at his
 * feet (ball.owner === slot, not in hands, low: <= T_DRIBBLE.controlHeight, within startReach; knockStartReach for a
 * knock-on, whose ball may run further ahead at a sprint) and has at least T_SKILL.minStars[move] skill stars.
 * startFake converts a KICK / SHOT wind-up (actDone 0, also while the power bar is charging) of a player who owns the
 * ball into ActionKind.FAKE: the kick's handler is ended (interrupted) and the fake-shot cut is played instead (no ball
 * is struck). Both emit SKILL (a = slot, b = SkillMove; FAKE_SHOT for a fake).
 *
 * EXIT DIRECTION from the request direction (dirX, dirZ; pitch space; 0,0 = facing) relative to the start facing f0
 * (right of f0 = (-f0z, f0x)): the side is the sign of the request's lateral component (|lateral| <= sideDead, or no
 * request: the preferred foot's side, right foot -> right). Exit = f0 turned toward that side by exitAngle[move]:
 * ball roll 90 (pure sideways), step-over 45, body feint 60, fake shot 80, roulette 45, drag-back 180 (straight back,
 * turning through that side), heel flick 0 (25 with a lateral request). Knock-on: the request direction itself (any
 * direction; facing if none). Stop ball / hard stop: f0. Stop and face goal: toward the centre of the attacked goal.
 *
 * SCRIPTS (skillHandler / fakeHandler, called by the dispatcher every tick with actT = 1..actDur). The player is
 * LOCKED (SIM-04 integrates the velocity this module sets; the resolver and team AI leave him alone). With
 * u = actT / actDur, each move scripts
 *  - the body: a target velocity built from the entry speed along f0 (carry), sideways feints / bursts and the run
 *    along the exit (exitSpeed, x agility 0.85..1.15), reached at no more than skillAccel (stops: a deceleration that
 *    kills the entry speed within stopFrac of the move), and the facing (an angle from f0: lean of a feint, the 180
 *    turn of a drag-back, the 405 degree spin of a roulette; stop and face goal turns at faceTurnRate);
 *  - the ball, until the exit touch: an offset from the body (at the feet, footAhead, along f0; rolled sideways; pulled
 *    back under the body; carried round the spin; then exitLead along the exit). The ball keeps its own physics: each
 *    tick its velocity is set so that it reaches body + offset at the end of the tick (relative speed capped at
 *    ballMaxRel), spin cleared, never lifted;
 *  - the exit touch at releaseFrac (recordTouch + KICK event, KickKind.SKILL_TOUCH): the ball keeps the body's velocity
 *    across the exit and runs along it pushSpeed faster than the body will be running when the move ends (his speed
 *    along the exit, accelerating toward exitSpeed for the remaining ticks; the heel flick also lifts it, lift m/s up,
 *    forward over the player). It then rolls free (still owned) while the body accelerates after it, so the move ends
 *    with the ball just ahead of the player in the exit direction and SIM-06 dribbling takes over (touchCd = remaining
 *    ticks + exitTouchCd). SIM-04 takes its LOCKED friction off the velocity set here; it is added back on top.
 *  At the end of a completed move the controller's stick (if any, and not released) drives him for the rest of that
 *  tick (DIRECT intent), so he does not brake for a tick before the resolver runs again.
 *  Stop moves hold the ball at the feet throughout (sole touch at actT 1) and leave it dead relative to the body.
 *  Knock-on: the body bursts toward the exit (top speed, accel x knockAccelMul, turn knockTurnRate); at knockTouchTick
 *  (or the first later tick the ball is in reach) solveSkillTouch + applyKick(KNOCK_ON) push it far ahead into space
 *  (loose; ball.passTarget = the knocker so he runs onto it). Before that touch SIM-06 holds the ball on his kicking spot.
 *
 * WINNING THE BALL. inSkillVulnerableWindow(slot) is true while T_SKILL.vulnStart <= actT < vulnEnd of the player's
 * SKILL (FAKE: the FAKE_SHOT window); SIM-14 tackles query it (outside the window the ball is protected: SIM-06 never
 * steals from a SKILL / FAKE player). In the window an opponent standing on the ball's path also wins it here: the
 * nearest eligible opponent (active, not stunned, noTouchT expired, act NONE / SHIELD / FIRST_TOUCH) with the low ball
 * within stealRadius (x 1.15..0.85 by the skiller's dribbling + ball control) takes possession, the skiller gets
 * T_DRIBBLE.dispossessedNoTouch and his move ends.
 *
 * ABORTS (end(interrupted = 1); the dispatcher's clearAction frees the movement): phase no longer IN_PLAY, the ball no
 * longer his (tackled, stolen, picked up; for a knock-on only before the touch), or a corrupt move (index or stored
 * parameters, e.g. a SKILL set up by hand rather than by startSkill).
 *
 * STATE used by SKILL / FAKE: actSkill = move (FAKE: FAKE_SHOT); actX/actZ = start facing f0; actDirX/actDirZ = exit
 * direction (unit); actA = side (-1 left / +1 right of f0); actB = entry speed (stop moves: |v|; others: speed along f0,
 * >= 0); actDone = 1 after the exit touch / knock-on touch; actContact = knockTouchTick for a knock-on, else -1;
 * actKick = KNOCK_ON for a knock-on (read by solveSkillTouch), else NONE; actPower = knockPower for a knock-on. end()
 * zeroes actX/actZ/actDirX/actDirZ (clearAction resets the rest).
 *
 * solveSkillTouch (KICK_SOLVERS for KNOCK_ON / SKILL_TOUCH / DRIBBLE_TOUCH, used by the knock-on above and by any KICK
 * action of those kinds): ball in reach (controlRadius + speed x touchLookahead, low, not in hands); direction actDir
 * (facing if none) with an s.rng error (one draw) up to errMax x (1 - control quality); speed = the player's speed along
 * it + rel x (0.5 + actPower), clamped per kind; target = the toucher himself, tx/tz = where the roll stops (SIM-02
 * rolling model).
 *
 * Determinism / cost: plain arithmetic + Math.sqrt / Math.round per tick (the facing angle goes through a range-reduced
 * polynomial, |error| < 1e-7; dmath trig only when a move starts and in the solver), s.rng only in the solver,
 * slot-order scans with strict tie breaks. No per-tick allocation: V8 boxes a double passed to or returned from a call
 * it does not inline, so the per-tick path keeps its arithmetic inline (script weights from precomputed smoothstep
 * intervals) and hands numbers to its helpers through module scratch (F, BV, W). Per skiller per tick: about a hundred
 * flops, plus an O(11) scan in the window.
 */
// Re-export the registry-facing shells FIRST: see skillsHooks.ts (import-cycle safety with actions/registry).
export { fakeHandler, skillHandler, solveSkillTouch } from './skillsHooks';
import { bindSkillsImpl } from './skillsHooks';
import { beginAction, endAction, isFree } from '../actions/dispatch';
import { DT, HALF_LENGTH, NUM_CONTROLLERS, NUM_SLOTS, PLAYERS_PER_TEAM } from '../../contracts/constants';
import { ActionKind, Foot, KickKind, MatchPhase, SkillMove } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { Btn } from '../../contracts/input';
import { MoveMode, type PlayerState, type SimState } from '../../contracts/state';
import { createKickLaunch, type KickLaunch } from '../../contracts/systems';
import { T_BALL, T_DRIBBLE, T_PLAYER, T_SKILL, T_SKILL_MOVES, T_LOCOMOTION } from '../../contracts/tuning';
import { applyKick, ballTouchedThisTick, recordTouch, takePossession } from '../core/kick';
import { clamp01, dcos, dlog, dsin, HALF_PI, PI, TWO_PI } from '../core/dmath';
import { rngRange } from '../core/rng';
import { createV2 } from '../core/vec';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_SKILL_MOVES. */
export const LOCAL_TUNING = T_SKILL_MOVES;


const L = T_SKILL_MOVES;
const CTRL_H = T_DRIBBLE.controlHeight;
const NUM_MOVES = SkillMove.HARD_STOP + 1;
/** Max smoothstep intervals in one move script. */
const MAX_IV = 8;
const INV_TWO_PI = 1 / TWO_PI;

// ---------------------------------------------------------------- module scratch (no per-tick allocation)

const KL = createKickLaunch();
const DIR = createV2();
/** Body velocity this tick (what he moves with; before SIM-04's LOCKED friction compensation). */
const BV = createV2();
/** Numbers handed to the per-tick helpers (see the header: no double crosses a call boundary). */
const F = new Float64Array(10);
/** F slots: target body velocity and acceleration limit; ball offset; exit speed; angle in, cos / sin out. */
const F_TVX = 0, F_TVZ = 1, F_ACC = 2, F_OX = 3, F_OZ = 4, F_EXITV = 5, F_TH = 6, F_COS = 7, F_SIN = 8;
/** Smoothstep weights of this tick's script (W[i] for the move's interval i). */
const W = new Float64Array(MAX_IV);
/** Script intervals per move: [a, b] = IV[(k * MAX_IV + i) * 2 + 0 / 1]; IVN[k] = their count. */
const IV = new Float64Array(NUM_MOVES * MAX_IV * 2);
const IVN = new Uint8Array(NUM_MOVES);
/** cos / sin of one tick's turn of the knock-on and of stop-and-face-goal. */
const KNOCK_C = dcos(L.knockTurnRate * DT), KNOCK_S = dsin(L.knockTurnRate * DT);
const FACE_C = dcos(L.faceTurnRate * DT), FACE_S = dsin(L.faceTurnRate * DT);

function iv(k: number, i: number, a: number, b: number): void {
  const j = (k * MAX_IV + i) * 2;
  IV[j] = a;
  IV[j + 1] = b;
  if (IVN[k]! < i + 1) IVN[k] = i + 1;
}

/** The script intervals, in the order the scripts in scriptedUpdate read W. */
(function buildScripts(): void {
  const R = L.releaseFrac;
  const r = L.ballRoll;
  iv(SkillMove.BALL_ROLL, 0, r.sideIn, r.ballBackEnd);
  iv(SkillMove.BALL_ROLL, 1, r.sideIn, r.ballSideEnd);
  iv(SkillMove.BALL_ROLL, 2, 0, r.carryEnd);
  iv(SkillMove.BALL_ROLL, 3, r.sideIn, r.sideFull);
  const so = L.stepOver;
  iv(SkillMove.STEP_OVER, 0, so.feintIn[0]!, so.feintIn[1]!);
  iv(SkillMove.STEP_OVER, 1, so.feintOut[0]!, so.feintOut[1]!);
  iv(SkillMove.STEP_OVER, 2, so.exitIn[0]!, so.exitIn[1]!);
  iv(SkillMove.STEP_OVER, 3, so.ballIn, R[SkillMove.STEP_OVER]!);
  iv(SkillMove.STEP_OVER, 4, so.turnIn[0]!, so.turnIn[1]!);
  iv(SkillMove.STEP_OVER, 5, 0, so.feintOut[1]!);
  const bf = L.bodyFeint;
  iv(SkillMove.BODY_FEINT, 0, bf.dipIn[0]!, bf.dipIn[1]!);
  iv(SkillMove.BODY_FEINT, 1, bf.dipOut[0]!, bf.dipOut[1]!);
  iv(SkillMove.BODY_FEINT, 2, bf.exitIn[0]!, bf.exitIn[1]!);
  iv(SkillMove.BODY_FEINT, 3, bf.ballIn, R[SkillMove.BODY_FEINT]!);
  iv(SkillMove.BODY_FEINT, 4, bf.turnIn[0]!, bf.turnIn[1]!);
  iv(SkillMove.BODY_FEINT, 5, 0, bf.carryEnd);
  const db = L.dragBack;
  iv(SkillMove.DRAG_BACK, 0, 0, db.stopEnd);
  iv(SkillMove.DRAG_BACK, 1, db.backIn[0]!, db.backIn[1]!);
  iv(SkillMove.DRAG_BACK, 2, db.ballPull[0]!, db.ballPull[1]!);
  iv(SkillMove.DRAG_BACK, 3, db.turnIn[0]!, db.turnIn[1]!);
  const fs = L.fakeShot;
  iv(SkillMove.FAKE_SHOT, 0, fs.exitIn[0]!, fs.exitIn[1]!);
  iv(SkillMove.FAKE_SHOT, 1, fs.ballIn, R[SkillMove.FAKE_SHOT]!);
  iv(SkillMove.FAKE_SHOT, 2, 0, fs.plantEnd);
  iv(SkillMove.FAKE_SHOT, 3, fs.turnIn[0]!, fs.turnIn[1]!);
  const ro = L.roulette;
  iv(SkillMove.ROULETTE, 0, ro.spinIn[0]!, ro.spinIn[1]!);
  iv(SkillMove.ROULETTE, 1, ro.spinOut[0]!, ro.spinOut[1]!);
  iv(SkillMove.ROULETTE, 2, ro.exitIn[0]!, ro.exitIn[1]!);
  iv(SkillMove.ROULETTE, 3, ro.sideIn[0]!, ro.sideIn[1]!);
  iv(SkillMove.ROULETTE, 4, ro.ballIn, R[SkillMove.ROULETTE]!);
  iv(SkillMove.ROULETTE, 5, 0, ro.plantEnd);
  iv(SkillMove.ROULETTE, 6, ro.turn[0]!, ro.turn[1]!);
  const hf = L.heelFlick;
  iv(SkillMove.HEEL_FLICK, 0, hf.exitIn[0]!, hf.exitIn[1]!);
  iv(SkillMove.HEEL_FLICK, 1, 0, hf.plantEnd);
  iv(SkillMove.HEEL_FLICK, 2, 0, R[SkillMove.HEEL_FLICK]!);
  iv(SkillMove.HEEL_FLICK, 3, hf.turnIn[0]!, hf.turnIn[1]!);
})();

// ---------------------------------------------------------------- small helpers

function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS && slot === Math.floor(slot);
}

function validMove(k: number): boolean {
  return k >= SkillMove.BALL_ROLL && k <= SkillMove.HARD_STOP && k === Math.floor(k);
}

function isStop(k: number): boolean {
  return k === SkillMove.STOP_BALL || k === SkillMove.STOP_FACE_GOAL || k === SkillMove.HARD_STOP;
}

/** SkillMove whose tables drive the player's SKILL / FAKE action (0 = none or corrupt). */
function moveOf(p: Readonly<PlayerState>): number {
  if (p.act === ActionKind.FAKE) return SkillMove.FAKE_SHOT;
  if (p.act === ActionKind.SKILL && validMove(p.actSkill)) return p.actSkill;
  return 0;
}

/**
 * Are the move's stored parameters usable (unit start facing and exit, side +-1, finite entry speed)? A SKILL / FAKE
 * set up by hand (not by startSkill / startFake) or a corrupt state is ended instead of scripted with NaNs.
 */
function paramsOk(p: Readonly<PlayerState>): boolean {
  const f2 = p.actX * p.actX + p.actZ * p.actZ, e2 = p.actDirX * p.actDirX + p.actDirZ * p.actDirZ;
  return f2 > 0.98 && f2 < 1.02 && e2 > 0.98 && e2 < 1.02 && (p.actA === 1 || p.actA === -1) && p.actB >= 0 &&
    p.actB < 1e3 && p.actDur > 0;
}

function inWindow(p: Readonly<PlayerState>, k: number): boolean {
  return p.actT >= T_SKILL.vulnStart[k]! && p.actT < T_SKILL.vulnEnd[k]!;
}

/** Does slot own the low ball at his feet, within reach (m)? */
function ballAtFeet(s: SimState, slot: number, reach: number): boolean {
  const b = s.ball;
  if (b.owner !== slot || b.heldBy >= 0 || !(b.y <= CTRL_H)) return false;
  const p = s.players[slot]!;
  const dx = b.x - p.x, dz = b.z - p.z;
  return dx * dx + dz * dz <= reach * reach;
}

/** Rolling distance of a ground ball launched at v m/s (SIM-02 roll: dv/dt = -(rollDecel + rollDamping v)), m. */
function rollDistance(v: number): number {
  if (!(v > 0)) return 0;
  const a = T_BALL.rollDecel, c = T_BALL.rollDamping;
  if (!(c > 0)) return v * v / (2 * a);
  return (v - (a / c) * dlog(1 + (c * v) / a)) / c;
}

/**
 * cos / sin of the angle F[F_TH] (rad, a few turns at most) into F[F_COS] / F[F_SIN]: reduced to [-PI/2, PI/2],
 * then Taylor to x^12 / x^11 (|error| < 1e-7). Deterministic arithmetic, no call.
 */
function cosSin(): void {
  let a = F[F_TH]!;
  a -= TWO_PI * Math.round(a * INV_TWO_PI);
  let sc = 1;
  if (a > HALF_PI) { a = PI - a; sc = -1; } else if (a < -HALF_PI) { a = -PI - a; sc = -1; }
  const a2 = a * a;
  F[F_SIN] = a * (1 - (a2 / 6) * (1 - (a2 / 20) * (1 - (a2 / 42) * (1 - (a2 / 72) * (1 - a2 / 110)))));
  F[F_COS] = sc * (1 - (a2 / 2) * (1 - (a2 / 12) * (1 - (a2 / 30) * (1 - (a2 / 56) * (1 - (a2 / 90) * (1 - a2 / 132))))));
}

/** Turn p's facing one step toward his exit (actDir) without overshooting (knock = 1: knock-on rate, else face goal). */
function turnToExit(p: PlayerState, knock: number): void {
  const c = knock === 1 ? KNOCK_C : FACE_C;
  const sn0 = knock === 1 ? KNOCK_S : FACE_S;
  const ex = p.actDirX, ez = p.actDirZ;
  let fx = p.fx, fz = p.fz;
  const fl = Number.isFinite(fx) && Number.isFinite(fz) ? Math.sqrt(fx * fx + fz * fz) : 0;
  if (!(fl > 1e-9)) { p.fx = ex; p.fz = ez; return; }
  fx /= fl;
  fz /= fl;
  if (fx * ex + fz * ez >= c) { p.fx = ex; p.fz = ez; return; }
  const sn = fx * ez - fz * ex >= 0 ? sn0 : -sn0;
  const rx = fx * c - fz * sn, rz = fx * sn + fz * c;
  const rl = Math.sqrt(rx * rx + rz * rz);
  p.fx = rx / rl;
  p.fz = rz / rl;
}

/**
 * Body velocity for this tick: p's velocity moved toward (F[F_TVX], F[F_TVZ]) by at most F[F_ACC] * DT, into BV (the
 * velocity he moves with this tick), and written to p as SIM-04 LOCKED input: SIM-04 takes lockedFriction * DT off a
 * LOCKED player's speed before integrating, so that much is added on top while the move continues (not on its last
 * tick, when the dispatcher frees the movement before locomotion runs).
 */
function steerBody(p: PlayerState, last: boolean): void {
  let vx = Number.isFinite(p.vx) ? p.vx : 0;
  let vz = Number.isFinite(p.vz) ? p.vz : 0;
  let dvx = F[F_TVX]! - vx, dvz = F[F_TVZ]! - vz;
  const dv = Math.sqrt(dvx * dvx + dvz * dvz);
  const lim = F[F_ACC]! * DT;
  if (dv > lim) { dvx *= lim / dv; dvz *= lim / dv; }
  vx += dvx;
  vz += dvz;
  BV.x = vx;
  BV.z = vz;
  const sp = Math.sqrt(vx * vx + vz * vz);
  if (!last && sp > 1e-9) {
    const k = (sp + T_LOCOMOTION.lockedFriction * DT) / sp;
    vx *= k;
    vz *= k;
  }
  p.vx = vx;
  p.vz = vz;
}

// ---------------------------------------------------------------- starting

/** Fill and begin the SKILL / FAKE action for move k with request direction (dirX, dirZ) (0,0 = facing). */
function setupMove(s: SimState, slot: number, k: number, dirX: number, dirZ: number, act: ActionKind): void {
  const p = s.players[slot]!;
  let fx = p.fx, fz = p.fz;
  let fl = Number.isFinite(fx) && Number.isFinite(fz) ? Math.sqrt(fx * fx + fz * fz) : 0;
  if (!(fl > 1e-9)) { fx = s.teams[p.team]!.dir; fz = 0; fl = 1; }
  fx /= fl;
  fz /= fl;
  const rx = -fz, rz = fx;
  const m = Math.sqrt(dirX * dirX + dirZ * dirZ);
  let dx = 0, dz = 0, has = 0;
  if (m > L.dirDead) { dx = dirX / m; dz = dirZ / m; has = 1; }
  const lat = dx * rx + dz * rz;
  const lateral = lat > L.sideDead || lat < -L.sideDead;
  const side = lateral ? (lat > 0 ? 1 : -1) : s.attrs[slot]!.foot === Foot.LEFT ? -1 : 1;
  let ex = fx, ez = fz;
  if (k === SkillMove.KNOCK_ON) {
    if (has === 1) { ex = dx; ez = dz; }
  } else if (k === SkillMove.STOP_FACE_GOAL) {
    const gx = s.teams[p.team]!.dir * HALF_LENGTH - p.x, gz = -p.z;
    const gl = Math.sqrt(gx * gx + gz * gz);
    if (gl > 1e-6) { ex = gx / gl; ez = gz / gl; }
  } else if (k === SkillMove.DRAG_BACK) {
    ex = -fx; ez = -fz;
  } else {
    const ang = k === SkillMove.HEEL_FLICK && !lateral ? 0 : L.exitAngle[k]! * side;
    if (ang !== 0) {
      F[F_TH] = ang;
      cosSin();
      const c = F[F_COS]!, sn = F[F_SIN]!;
      ex = fx * c - fz * sn;
      ez = fx * sn + fz * c;
      const el = Math.sqrt(ex * ex + ez * ez);
      ex /= el; ez /= el;
    }
  }
  const vx = Number.isFinite(p.vx) ? p.vx : 0;
  const vz = Number.isFinite(p.vz) ? p.vz : 0;
  const along = vx * fx + vz * fz;
  beginAction(p, act, T_SKILL.duration[k]!, k === SkillMove.KNOCK_ON ? L.knockTouchTick : -1);
  p.actSkill = k as SkillMove;
  p.actKick = k === SkillMove.KNOCK_ON ? KickKind.KNOCK_ON : KickKind.NONE;
  p.actPower = k === SkillMove.KNOCK_ON ? L.knockPower : 0;
  p.actX = fx; p.actZ = fz;
  p.actDirX = ex; p.actDirZ = ez;
  p.actA = side;
  p.actB = isStop(k) ? Math.sqrt(vx * vx + vz * vz) : along > 0 ? along : 0;
  p.actSlot = -1;
  p.actCurve = 0;
  p.moveMode = MoveMode.LOCKED;
}

/** Start a skill toward (dirX, dirZ) (pitch space; 0,0 = facing). Returns 1 if started. */
export function startSkill(s: SimState, slot: number, skill: SkillMove, dirX: number, dirZ: number, ev: EventSink): number {
  if (!validSlot(slot) || !validMove(skill) || s.match.phase !== MatchPhase.IN_PLAY) return 0;
  const p = s.players[slot]!;
  if (!isFree(p)) return 0;
  if (!(s.attrs[slot]!.skillMoves >= T_SKILL.minStars[skill]!)) return 0;
  if (!ballAtFeet(s, slot, skill === SkillMove.KNOCK_ON ? L.knockStartReach : L.startReach)) return 0;
  setupMove(s, slot, skill, Number.isFinite(dirX) ? dirX : 0, Number.isFinite(dirZ) ? dirZ : 0, ActionKind.SKILL);
  ev.emit(EventType.SKILL, slot, skill);
  return 1;
}

/** Direction for a fake's cut: the controller's stick, else a DIRECT intent, else none (DIR). */
function fakeDirInto(s: SimState, p: Readonly<PlayerState>): void {
  DIR.x = 0; DIR.z = 0;
  const c = p.ctrl;
  if (c >= 0 && c < NUM_CONTROLLERS) {
    const ctl = s.ctrl[c]!;
    if (ctl.slot === p.slot && ctl.stickIdleT <= 0 && Number.isFinite(ctl.mx) && Number.isFinite(ctl.mz)) {
      const m = Math.sqrt(ctl.mx * ctl.mx + ctl.mz * ctl.mz);
      if (m > L.dirDead) { DIR.x = ctl.mx / m; DIR.z = ctl.mz / m; return; }
    }
  }
  if (p.moveMode === MoveMode.DIRECT && Number.isFinite(p.ix) && Number.isFinite(p.iz)) {
    const m = Math.sqrt(p.ix * p.ix + p.iz * p.iz);
    if (m > L.dirDead) { DIR.x = p.ix / m; DIR.z = p.iz / m; }
  }
}

/** Cancel a KICK/SHOT wind-up into a fake (B or X then A). Returns 1 if converted. */
export function startFake(s: SimState, slot: number, ev: EventSink): number {
  if (!validSlot(slot) || s.match.phase !== MatchPhase.IN_PLAY) return 0;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.stunT > 0) return 0;
  if ((p.act !== ActionKind.KICK && p.act !== ActionKind.SHOT) || p.actDone !== 0) return 0;
  if (!(s.attrs[slot]!.skillMoves >= T_SKILL.minStars[SkillMove.FAKE_SHOT]!)) return 0;
  if (!ballAtFeet(s, slot, L.startReach)) return 0;
  fakeDirInto(s, p);
  const dx = DIR.x, dz = DIR.z;
  endAction(s, slot, 1);
  if ((p.act as ActionKind) !== ActionKind.NONE) return 0; // defensive: the kick's cleanup started something else
  setupMove(s, slot, SkillMove.FAKE_SHOT, dx, dz, ActionKind.FAKE);
  ev.emit(EventType.SKILL, slot, SkillMove.FAKE_SHOT);
  return 1;
}

/** True while slot is in the vulnerable window of a skill (ball can be won). */
export function inSkillVulnerableWindow(s: SimState, slot: number): boolean {
  if (!validSlot(slot)) return false;
  const p = s.players[slot]!;
  if (p.active !== 1) return false;
  const k = moveOf(p);
  return k !== 0 && inWindow(p, k);
}

// ---------------------------------------------------------------- the ball can be won (vulnerable window)

/** Opponent eligible to win the ball from a skiller (physically able, not in an action of his own). */
function stealEligible(q: Readonly<PlayerState>): boolean {
  if (q.active !== 1 || q.stunT > 0 || q.noTouchT > 0) return false;
  return q.act === ActionKind.NONE || q.act === ActionKind.SHIELD || q.act === ActionKind.FIRST_TOUCH;
}

/** In the window: the nearest eligible opponent with the low ball in reach takes it. Returns true if it was won. */
function windowSteal(s: SimState, slot: number, ev: EventSink): boolean {
  const b = s.ball;
  if (!(b.y <= CTRL_H) || ballTouchedThisTick(s)) return false;
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  let qd = (a.dribbling - 1) / 98, qc = (a.ballControl - 1) / 98;
  qd = qd < 0 ? 0 : qd > 1 ? 1 : qd === qd ? qd : 0.5;
  qc = qc < 0 ? 0 : qc > 1 ? 1 : qc === qc ? qc : 0.5;
  const r = L.stealRadius * (L.stealCtrlMax - (L.stealCtrlMax - L.stealCtrlMin) * 0.5 * (qd + qc));
  let best = -1;
  let bestD2 = r * r;
  const first = p.team === 0 ? PLAYERS_PER_TEAM : 0;
  for (let j = first; j < first + PLAYERS_PER_TEAM; j++) {
    const q = s.players[j]!;
    if (!stealEligible(q)) continue;
    const dx = b.x - q.x, dz = b.z - q.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > bestD2 || (d2 === bestD2 && best >= 0)) continue;
    best = j;
    bestD2 = d2;
  }
  if (best < 0) return false;
  const q = s.players[best]!;
  takePossession(s, best, ev);
  b.vx = Number.isFinite(q.vx) ? q.vx : 0;
  b.vz = Number.isFinite(q.vz) ? q.vz : 0;
  if (b.vy > 0) b.vy = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  q.touchCd = 0;
  if (p.noTouchT < T_DRIBBLE.dispossessedNoTouch) p.noTouchT = T_DRIBBLE.dispossessedNoTouch;
  endAction(s, slot, 1);
  return true;
}

// ---------------------------------------------------------------- ball

/**
 * Set the ball's velocity so that it reaches body + (F[F_OX], F[F_OZ]) at the end of this tick (speed relative to the
 * body capped at ballMaxRel); the body moves with BV this tick. Spin cleared, never lifted.
 */
function trackBall(s: SimState, p: Readonly<PlayerState>): void {
  const b = s.ball;
  const tx = p.x + BV.x * DT + F[F_OX]!;
  const tz = p.z + BV.z * DT + F[F_OZ]!;
  let rvx = (tx - b.x) / DT - BV.x;
  let rvz = (tz - b.z) / DT - BV.z;
  const r = Math.sqrt(rvx * rvx + rvz * rvz);
  if (r > L.ballMaxRel) { rvx *= L.ballMaxRel / r; rvz *= L.ballMaxRel / r; }
  b.vx = BV.x + rvx;
  b.vz = BV.z + rvz;
  if (b.vy > 0) b.vy = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
}

/**
 * The exit touch of move k: the ball runs along the exit (lifted for the heel flick) and rolls free from here. It keeps
 * the body's velocity across the exit; along it, it runs pushSpeed faster than the body will be running when the move
 * ends (his speed along the exit, accelerating at F[F_ACC] toward the exit speed F[F_EXITV] for the remaining ticks).
 */
function exitTouch(s: SimState, slot: number, k: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const b = s.ball;
  const ex = p.actDirX, ez = p.actDirZ;
  const exitV = F[F_EXITV]!;
  const along = BV.x * ex + BV.z * ez;
  const px = BV.x - along * ex, pz = BV.z - along * ez;
  let fin = along + F[F_ACC]! * (p.actDur - p.actT) * DT;
  if (fin > exitV) fin = along > exitV ? along : exitV;
  const run = (fin > 0 ? fin : 0) + L.pushSpeed[k]!;
  b.vx = px + ex * run;
  b.vz = pz + ez * run;
  const lift = L.lift[k]!;
  if (lift > 0) { b.vy = lift; b.grounded = 0; } else if (b.vy > 0) b.vy = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  recordTouch(s, slot);
  p.actDone = 1;
  p.touchCd = (p.actDur - p.actT) + L.exitTouchCd;
  const rel = run - along;
  ev.emit(EventType.KICK, slot, KickKind.SKILL_TOUCH, clamp01((rel > 0 ? rel : 0) / L.touchPowerRef), 0, b.x, b.y, b.z);
}

// ---------------------------------------------------------------- per-tick scripts

/**
 * One tick of a scripted move (every move but the knock-on). The script gives, from the weights W (smoothsteps of
 * u = actT / actDur over the move's intervals, built in buildScripts), the ball offset from the body (bF along f0, bR
 * toward the side, bE along the exit, m), the body's target velocity on the same axes (vF / vR / vE, m/s), its facing
 * angle from f0 (th, rad) and acceleration limit (acc, m/s^2).
 */
function scriptedUpdate(s: SimState, slot: number, k: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const b = s.ball;
  if (b.owner !== slot || b.heldBy >= 0) { endAction(s, slot, 1); return; }
  if (inWindow(p, k) && windowSteal(s, slot, ev)) return;
  const d = p.actDur > 0 ? p.actDur : 1;
  const t = p.actT;
  const u = t >= d ? 1 : t > 0 ? t / d : 0;
  const n = IVN[k]!;
  for (let i = 0; i < n; i++) {
    const j = (k * MAX_IV + i) * 2;
    const a0 = IV[j]!, a1 = IV[j + 1]!;
    let x = a1 > a0 ? (u - a0) / (a1 - a0) : u >= a1 ? 1 : 0; // a degenerate interval is a step
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    W[i] = x * x * (3 - 2 * x);
  }
  const f0x = p.actX, f0z = p.actZ, side = p.actA;
  const rx = -f0z * side, rz = f0x * side;
  const ex = p.actDirX, ez = p.actDirZ;
  const v0 = p.actB;
  let ag = (s.attrs[slot]!.agility - 1) / 98;
  ag = ag < 0 ? 0 : ag > 1 ? 1 : ag === ag ? ag : 0.5;
  const exitV = L.exitSpeed[k]! * (L.agilityMin + (L.agilityMax - L.agilityMin) * ag);
  const fa = L.footAhead, lead = L.exitLead, ang = L.exitAngle[k]!;
  let bF: number = fa, bR = 0, bE = 0, vF = 0, vR = 0, vE = 0, th = 0, acc: number = L.skillAccel;
  switch (k) {
    case SkillMove.BALL_ROLL: { // W: back, across, carry, side run
      const c = L.ballRoll;
      bF = fa - c.ballBack * W[0]!;
      bR = lead * W[1]!;
      vF = v0 * c.carry * (1 - W[2]!);
      vR = exitV * W[3]!;
      break;
    }
    case SkillMove.STEP_OVER: { // W: feint in, feint out, exit run, ball onto the exit, turn, carry
      const c = L.stepOver;
      const feint = W[0]! * (1 - W[1]!), w = W[2]!, w2 = W[3]!, w3 = W[4]!;
      vF = v0 * c.carry * (1 - W[5]!) * (1 - w);
      vR = -c.feintSpeed * feint * (1 - w);
      vE = exitV * w;
      bF = fa * (1 - w2);
      bE = lead * w2;
      th = side * (ang * w3 - c.feintLean * feint * (1 - w3));
      break;
    }
    case SkillMove.BODY_FEINT: { // W: dip in, dip out, exit burst, ball onto the exit, turn, carry
      const c = L.bodyFeint;
      const dip = W[0]! * (1 - W[1]!), w = W[2]!, w2 = W[3]!, w3 = W[4]!;
      vF = v0 * c.carry * (1 - W[5]!) * (1 - w);
      vR = -c.dipSpeed * dip * (1 - w);
      vE = exitV * w;
      bF = fa * (1 - w2);
      bE = lead * w2;
      th = side * (ang * w3 - c.dipLean * dip * (1 - w3));
      break;
    }
    case SkillMove.DRAG_BACK: { // W: stop, back run, ball pulled back, turn
      vF = v0 * (1 - W[0]!);
      vE = exitV * W[1]!;
      bF = fa - (fa + lead) * W[2]!;
      th = side * ang * W[3]!;
      break;
    }
    case SkillMove.FAKE_SHOT: { // W: exit cut, ball onto the exit, plant, turn
      const c = L.fakeShot;
      const w = W[0]!, w2 = W[1]!;
      vF = v0 * c.carry * (1 - W[2]!) * (1 - w);
      vE = exitV * w;
      bF = c.shapeAhead * (1 - w2);
      bE = lead * w2;
      th = side * ang * W[3]!;
      break;
    }
    case SkillMove.ROULETTE: { // W: spin in, spin out, exit run, ball round to the side, ball onto the exit, plant, turn
      const c = L.roulette;
      const spin = W[0]! * (1 - W[1]!), w = W[2]!, wa = W[3]!, wb = W[4]!;
      vF = v0 * (1 - W[5]!) * (1 - w);
      vR = c.spinSpeed * spin * (1 - w);
      vE = exitV * w;
      bF = (1 - wb) * (fa - c.sideBack * wa);
      bR = (1 - wb) * c.sideBall * wa;
      bE = lead * wb;
      th = side * (TWO_PI * c.spins + ang) * W[6]!;
      break;
    }
    case SkillMove.HEEL_FLICK: { // W: exit run, plant, ball back to the heel, turn
      const c = L.heelFlick;
      const w = W[0]!;
      vF = v0 * c.carry * (1 - W[1]!) * (1 - w);
      vE = exitV * w;
      bF = fa - (fa + c.heelBack) * W[2]!;
      th = f0x * ex + f0z * ez > 1 - 1e-9 ? 0 : side * ang * W[3]!;
      break;
    }
    default: { // stops: kill the entry speed within stopFrac of the move; the ball stays at the feet
      const hard = k === SkillMove.HARD_STOP;
      const dmin = hard ? L.hardStopDecelMin : L.stopDecelMin;
      const need = v0 / ((hard ? L.hardStopFrac : L.stopFrac) * d * DT);
      acc = need > dmin ? need : dmin;
      break;
    }
  }
  // Body.
  F[F_TVX] = vF * f0x + vR * rx + vE * ex;
  F[F_TVZ] = vF * f0z + vR * rz + vE * ez;
  F[F_ACC] = acc;
  steerBody(p, t >= d);
  if (k === SkillMove.STOP_FACE_GOAL) {
    turnToExit(p, 0);
  } else {
    F[F_TH] = th;
    cosSin();
    const c = F[F_COS]!, sn = F[F_SIN]!;
    const fx = f0x * c - f0z * sn, fz = f0x * sn + f0z * c;
    const fl = Math.sqrt(fx * fx + fz * fz);
    p.fx = fx / fl;
    p.fz = fz / fl;
  }
  p.moveMode = MoveMode.LOCKED;
  // Ball.
  if (p.actDone === 1) return; // rolling free after the exit touch
  const rf = L.releaseFrac[k]!;
  let rel = 0;
  if (rf < 1) {
    rel = Math.round(rf * d);
    if (rel < 1) rel = 1;
  }
  if (rel > 0 && t >= rel && !ballTouchedThisTick(s)) {
    F[F_EXITV] = exitV;
    exitTouch(s, slot, k, ev);
    return;
  }
  if (k === SkillMove.STOP_FACE_GOAL) {
    F[F_OX] = p.fx * L.faceAhead;
    F[F_OZ] = p.fz * L.faceAhead;
  } else {
    F[F_OX] = bF * f0x + bR * rx + bE * ex;
    F[F_OZ] = bF * f0z + bR * rz + bE * ez;
  }
  trackBall(s, p);
  if (rf >= 1) {
    if (t === 1 && !ballTouchedThisTick(s)) {
      recordTouch(s, slot);
      ev.emit(EventType.KICK, slot, KickKind.SKILL_TOUCH, 0, 0, b.x, b.y, b.z);
    }
    if (t >= d) { b.vx = BV.x; b.vz = BV.z; } // dead at his feet
  }
}

/** One tick of a knock-on: burst toward the exit; the touch pushes the ball far ahead into space. */
function knockUpdate(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const b = s.ball;
  if (p.actDone === 0) {
    if (b.owner !== slot || b.heldBy >= 0) { endAction(s, slot, 1); return; }
    if (inWindow(p, SkillMove.KNOCK_ON) && windowSteal(s, slot, ev)) return;
  }
  const a = s.attrs[slot]!;
  const st = p.stamina;
  const thr = T_PLAYER.staminaLowThreshold;
  const sf = st < thr ? T_PLAYER.staminaFloorMul + (1 - T_PLAYER.staminaFloorMul) * (st > 0 ? st / thr : 0) : 1;
  const top = (a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin) * sf;
  F[F_TVX] = p.actDirX * top;
  F[F_TVZ] = p.actDirZ * top;
  F[F_ACC] = (a.accel > 0 ? a.accel : T_PLAYER.accelMin) * sf * L.knockAccelMul;
  steerBody(p, p.actT >= p.actDur);
  turnToExit(p, 1);
  p.moveMode = MoveMode.LOCKED;
  if (p.actDone === 0 && p.actT >= p.actContact && !ballTouchedThisTick(s) && solveSkillTouchImpl(s, slot, KL) === 1) {
    applyKick(s, slot, KL, p.actPower, ev);
    p.actDone = 1;
  }
}

function skillUpdate(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const k = moveOf(p);
  if (k === 0 || s.match.phase !== MatchPhase.IN_PLAY || !paramsOk(p)) { endAction(s, slot, 1); return; }
  if (k === SkillMove.KNOCK_ON) knockUpdate(s, slot, ev);
  else scriptedUpdate(s, slot, k, ev);
}

/**
 * End of a SKILL / FAKE. The dispatcher's clearAction frees the movement (LOCKED -> STOP); body and ball keep their
 * velocities. A move that runs to its end hands over to the controller's stick for the rest of this tick (the resolver
 * writes intents only before the actions stage, so the player would otherwise brake for a tick and SIM-06 would kill the
 * exit run with a stopping touch); a released stick leaves him stopping. A move cut short must not leave a long dribble
 * cooldown behind. The move's direction fields are cleared.
 */
function skillEnd(s: SimState, slot: number, interrupted: number): void {
  const p = s.players[slot]!;
  // The move's parameters (clearAction leaves the direction fields alone): never leave a corrupt value behind.
  p.actX = 0; p.actZ = 0; p.actDirX = 0; p.actDirZ = 0;
  if (interrupted === 1) {
    if (p.touchCd > L.exitTouchCd) p.touchCd = L.exitTouchCd;
    return;
  }
  const c = p.ctrl;
  if (!(c >= 0 && c < NUM_CONTROLLERS)) return;
  const ctl = s.ctrl[c]!;
  if (ctl.slot !== slot || ctl.stickIdleT > 0 || !Number.isFinite(ctl.mx) || !Number.isFinite(ctl.mz)) return;
  if (ctl.mx * ctl.mx + ctl.mz * ctl.mz < L.dirDead * L.dirDead) return;
  p.moveMode = MoveMode.DIRECT;
  p.ix = ctl.mx;
  p.iz = ctl.mz;
  p.wantSprint = (ctl.buttons & Btn.SPRINT) !== 0 ? 1 : 0;
  p.lookAt = 0;
}

// ---------------------------------------------------------------- kick solver

/** KickSolver for KNOCK_ON, SKILL_TOUCH, DRIBBLE_TOUCH touches started as KICK actions. */
function solveSkillTouchImpl(s: SimState, slot: number, out: KickLaunch): number {
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  const kind = p.actKick;
  let rel: number, vmin: number, vmax: number, errMax: number;
  if (kind === KickKind.KNOCK_ON) { rel = L.knockRel; vmin = L.knockMin; vmax = L.knockMax; errMax = L.knockErrMax; } else if (kind === KickKind.SKILL_TOUCH) {
    rel = L.skillTouchRel; vmin = L.skillTouchMin; vmax = L.skillTouchMax; errMax = L.skillTouchErrMax;
  } else if (kind === KickKind.DRIBBLE_TOUCH) {
    rel = L.dribbleTouchRel; vmin = L.dribbleTouchMin; vmax = L.dribbleTouchMax; errMax = L.dribbleTouchErrMax;
  } else return 0;
  if (p.active !== 1) return 0;
  const b = s.ball;
  if (b.heldBy >= 0 || !(b.y <= CTRL_H)) return 0;
  const pvx = Number.isFinite(p.vx) ? p.vx : 0;
  const pvz = Number.isFinite(p.vz) ? p.vz : 0;
  const reach = T_DRIBBLE.controlRadius + Math.sqrt(pvx * pvx + pvz * pvz) * L.touchLookahead;
  const bx = b.x - p.x, bz = b.z - p.z;
  if (!(bx * bx + bz * bz <= reach * reach)) return 0;
  let dx = Number.isFinite(p.actDirX) ? p.actDirX : 0;
  let dz = Number.isFinite(p.actDirZ) ? p.actDirZ : 0;
  let dl = Math.sqrt(dx * dx + dz * dz);
  if (!(dl > L.dirDead)) {
    dx = p.fx; dz = p.fz;
    dl = Number.isFinite(dx) && Number.isFinite(dz) ? Math.sqrt(dx * dx + dz * dz) : 0;
    if (!(dl > 1e-9)) { dx = s.teams[p.team]!.dir; dz = 0; dl = 1; }
  }
  dx /= dl;
  dz /= dl;
  // Control quality 0..1 (dribbling + ball control, x SIM-04 stamina factor).
  const a = s.attrs[slot]!;
  let qd = (a.dribbling - 1) / 98, qc = (a.ballControl - 1) / 98;
  qd = qd < 0 ? 0 : qd > 1 ? 1 : qd === qd ? qd : 0.5;
  qc = qc < 0 ? 0 : qc > 1 ? 1 : qc === qc ? qc : 0.5;
  const st = p.stamina, thr = T_PLAYER.staminaLowThreshold;
  const sf = st < thr ? T_PLAYER.staminaFloorMul + (1 - T_PLAYER.staminaFloorMul) * (st > 0 ? st / thr : 0) : 1;
  let q = 0.5 * (qd + qc) * sf;
  q = q < 0 ? 0 : q > 1 ? 1 : q;
  F[F_TH] = errMax * (1 - q) * rngRange(s.rng, -1, 1);
  if (F[F_TH] !== 0) {
    cosSin();
    const c = F[F_COS]!, sn = F[F_SIN]!;
    const nx = dx * c - dz * sn;
    dz = dx * sn + dz * c;
    dx = nx;
  }
  const pw = Number.isFinite(p.actPower) ? clamp01(p.actPower) : L.knockPower;
  const along = pvx * dx + pvz * dz;
  let v = (along > 0 ? along : 0) + rel * (L.knockRelBase + pw);
  if (v < vmin) v = vmin;
  if (v > vmax) v = vmax;
  if (v > T_BALL.maxSpeed) v = T_BALL.maxSpeed;
  out.vx = dx * v; out.vy = 0; out.vz = dz * v;
  out.sx = 0; out.sy = 0; out.sz = 0;
  out.kind = kind;
  out.target = slot;
  const run = rollDistance(v);
  out.tx = b.x + dx * run;
  out.tz = b.z + dz * run;
  out.onTarget = 0;
  return 1;
}

bindSkillsImpl({
  skillUpdate, skillEnd, fakeUpdate: skillUpdate, fakeEnd: skillEnd, solveSkillTouch: solveSkillTouchImpl,
});
