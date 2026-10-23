/**
 * [QF-10] Shared foot-kick contact rules for SIM-08's KICK handler (kicks/pass.ts: passes, lobs, crosses, through
 * balls, clearances) and SIM-11's SHOT handler (kicks/shot.ts). Pure arithmetic on state, no allocation.
 *
 * CHARGED RELEASE (QF-4 CR, tests/scenario/qf-4-cr-charged-strike.test.ts). The clip of a charged kick is held at the
 * top of its backswing while the power bar fills (GFX-12 ACTION_HOLD); a strike on the very tick the bar was released
 * could only be drawn after the ball had gone. So:
 *  - while the handler sees the bar charging it marks the action (CHARGE_SEEN, bit 8 of p.actA: KICK / SHOT starters
 *    keep their ReqFlag bits in 0..7);
 *  - on the first handler tick after the release (the resolver, a hand-off, or the handler's own backstop cleared
 *    p.actCharging) the contact is re-planned to T_PASS.releaseStrikeTicks after now (never earlier than planned) and
 *    the planned recovery moves with it. SIM-06 keeps holding an owned ball on the kicking spot until the contact (it
 *    holds while actDone is 0), and a dead set-piece ball stays where it lies.
 *  - A first-time kick of a loose ball still arriving keeps its tick: the resolver releases it the tick the ball comes
 *    into reach (resolveActions chargeTick), and a delay would let the ball run past.
 *
 * REACH (QF-1 CR, tests/scenario/qf-1-cr-kick-reach.test.ts). A foot can strike the ball only when it is low (centre
 * at most reachHeight), within reachRadius of the body centre and within T_KICK.spotReach of the kicking spot
 * (T_KICK.spotAhead in front of the feet along the facing: where SIM-06 holds an owned ball through the wind-up
 * and where the kick clips meet it; render/anim/reach.ts reaches up to ~0.9 m from it). The owner's own ball no longer
 * counts as in reach wherever it is: a sprint touch 2 m ahead, a ball still dropping from a chest trap or rolling
 * behind him waits (the handlers' grace, bounded by the planned recovery) while SIM-06 pulls it onto the spot.
 *
 * TURN-AND-KICK [FIN-K]. A kick of his own ball never launches it through his body: while the ball lies behind him
 * for the kick direction (ownLaunchBlocked: the launch ray from the ball passes within T_POSSESSION.holdBodyClear of
 * his centre) the KICK / SHOT handler turns him toward the kick (turnToKick: SIM-04 look point along the kick, from the
 * wind-up on) and does not strike; SIM-06 holds the ball on his (turning) kicking spot, round his body (holdOn), and
 * the contact moves on a tick at a time for it (turnKickWait), at most T_KICK.turnKickMaxTicks.
 *
 * SET-PIECE LINE-UP. A restart taker's kick of the dead ball (restart phase, not yet taken, ball loose) may go in any
 * direction (the set-piece modules turn him along the request): while the kick winds up (or charges) and the ball is
 * not within takerLinedUp of his kicking spot, he side-steps around it (T_KICK.takerStep per tick, never closer to it
 * than spotAhead) toward the spot behind it along his facing, instead of kicking it through his own body. [FIN-K] He
 * first turns toward the ball (approachDeadBall: at most T_KICK.takerApproachMaxDeg off the kick direction, his approach
 * angle, T_KICK.takerTurnStepDeg a tick), so he side-steps only for what that angle cannot take; the contact is never
 * re-planned for it: at the planned contact he strikes from his current approach, so input-to-contact at set pieces is
 * the normal kick timing (the old re-line-up delayed the strike 6-14 ticks in a frozen kick pose).
 */
import { MatchPhase } from '../../contracts/enums';
import { MoveMode, type SimState } from '../../contracts/state';
import { RESTART_PHASES } from '../../contracts/transitions';
import { T_PASS, T_KICK, T_POSSESSION } from '../../contracts/tuning';
import { dcos, dsin } from '../core/dmath';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_KICK. */
export const KICK_TUNING = T_KICK;

/** p.actA bit: the KICK / SHOT handler saw the power bar charging (a release is still to be handled). */
export const CHARGE_SEEN = 1 << 8;


const KT = T_KICK;
const REST2 = KT.restingBallSpeed * KT.restingBallSpeed;
const SPOT_R2 = KT.spotReach * KT.spotReach;
const LINED2 = KT.takerLinedUp * KT.takerLinedUp;
/** [FIN-K] Max approach angle (facing vs kick direction) of a dead-ball taker at the strike: cos / sin, once at load. */
const APPROACH_COS = dcos((KT.takerApproachMaxDeg * Math.PI) / 180);
const APPROACH_SIN = dsin((KT.takerApproachMaxDeg * Math.PI) / 180);
const TURN_COS = dcos((KT.takerTurnStepDeg * Math.PI) / 180);
const TURN_SIN = dsin((KT.takerTurnStepDeg * Math.PI) / 180);

/** 1 for restart phases (index = MatchPhase). */
const RESTART_PHASE = new Uint8Array(MatchPhase.POST_MATCH + 1);
for (const ph of RESTART_PHASES) RESTART_PHASE[ph] = 1;

// ---------------------------------------------------------------- charged release

/** Mark a charging kick (call while p.actCharging is 1). */
export function noteCharging(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  p.actA = (p.actA | CHARGE_SEEN) >>> 0;
}

/**
 * Handle a release seen for the first time (p.actCharging now 0 with CHARGE_SEEN set): move the contact to
 * T_PASS.releaseStrikeTicks after now (and the recovery with it), unless the ball is a loose one still arriving.
 * Returns 1 when the contact moved.
 */
export function releaseStrike(s: SimState, slot: number): number {
  const p = s.players[slot]!;
  if ((p.actA & CHARGE_SEEN) === 0 || p.actCharging === 1) return 0;
  p.actA = (p.actA & ~CHARGE_SEEN) >>> 0;
  if (p.actDone !== 0 || p.actContact < 0) return 0;
  const b = s.ball;
  if (b.owner !== slot) {
    if (b.owner >= 0 || b.heldBy >= 0) return 0;
    if (b.vx * b.vx + b.vz * b.vz > REST2) return 0; // first time: strike as it arrives
  }
  const c = p.actT + T_PASS.releaseStrikeTicks;
  if (!(c > p.actContact)) return 0;
  const shift = c - p.actContact;
  p.actContact = c;
  p.actDur += shift;
  return 1;
}

// ---------------------------------------------------------------- reach

/**
 * The ball is his to strike with a foot now: not held / owned by anyone else, centre at most reachHeight high, within
 * reachRadius of his body centre and within T_KICK.spotReach of his kicking spot.
 */
export function footCanStrike(s: SimState, slot: number, reachRadius: number, reachHeight: number): boolean {
  if (!(slot >= 0 && slot < s.players.length)) return false;
  const b = s.ball;
  if (b.heldBy >= 0) return false;
  if (b.owner >= 0 && b.owner !== slot) return false;
  if (!(b.y <= reachHeight)) return false;
  const p = s.players[slot]!;
  const dx = b.x - p.x, dz = b.z - p.z;
  if (!(dx * dx + dz * dz <= reachRadius * reachRadius)) return false;
  let fx = p.fx, fz = p.fz;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (!(fl > 1e-9)) return true; // no facing: the body distance decides
  fx /= fl; fz /= fl;
  const sx = dx - fx * KT.spotAhead, sz = dz - fz * KT.spotAhead;
  return sx * sx + sz * sz <= SPOT_R2;
}

// ---------------------------------------------------------------- set-piece line-up

/** slot is the taker of a restart not yet taken, kicking the dead (loose, resting) ball. */
export function isDeadBallTaker(s: SimState, slot: number): boolean {
  const m = s.match;
  const ph = m.phase;
  if (!(ph >= 0 && ph < RESTART_PHASE.length) || RESTART_PHASE[ph] !== 1) return false;
  if (m.restart.taken !== 0 || m.restart.taker !== slot) return false;
  const b = s.ball;
  return b.owner < 0 && b.heldBy < 0 && b.vx * b.vx + b.vz * b.vz <= REST2;
}

/** The dead ball lies within T_KICK.takerLinedUp of slot's kicking spot (or he has no facing). */
export function linedUpOnDeadBall(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  const b = s.ball;
  const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz);
  if (!(fl > 1e-9)) return true;
  const a = KT.spotAhead / fl;
  const ex = b.x - (p.x + p.fx * a), ez = b.z - (p.z + p.fz * a);
  return ex * ex + ez * ez <= LINED2;
}

/**
 * A dead-ball taker whose ball is not at his kicking spot (linedUpOnDeadBall) side-steps one step around it toward
 * the spot behind it along his facing (never closer to it than spotAhead) and stands still otherwise (STOP, no
 * velocity). Returns 1 when he is lined up after the step.
 */
export function lineUpOnDeadBall(s: SimState, slot: number): number {
  if (linedUpOnDeadBall(s, slot)) return 1;
  const p = s.players[slot]!;
  const b = s.ball;
  const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz);
  const fx = p.fx / fl, fz = p.fz / fl;
  const a = KT.spotAhead;
  const tx = b.x - fx * a, tz = b.z - fz * a;
  const dx = tx - p.x, dz = tz - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const st = KT.takerStep;
  if (d <= st) { p.x = tx; p.z = tz; } else { p.x += (dx / d) * st; p.z += (dz / d) * st; }
  // Around the ball, not through it.
  const bx = p.x - b.x, bz = p.z - b.z;
  const bd = Math.sqrt(bx * bx + bz * bz);
  if (bd > 1e-6 && bd < a) { p.x = b.x + (bx / bd) * a; p.z = b.z + (bz / bd) * a; }
  p.vx = 0; p.vz = 0;
  p.moveMode = MoveMode.STOP;
  p.wantSprint = 0;
  return linedUpOnDeadBall(s, slot) ? 1 : 0;
}

/**
 * [FIN-K] Strike from the current approach: a dead-ball taker who is not lined up turns toward the ball (so it comes
 * onto his kicking spot), at most T_KICK.takerApproachMaxDeg off his kick direction (p.actDirX/Z, else his facing) and
 * at most T_KICK.takerTurnStepDeg per tick; the kick itself keeps its direction. The handlers call it every tick of the
 * wind-up (before lineUpOnDeadBall, which side-steps only for what the approach angle cannot take) and at the contact,
 * which is never delayed for it. Facing only. Returns 1 when he faces the wanted direction after the step.
 */
export function approachDeadBall(s: SimState, slot: number): number {
  if (linedUpOnDeadBall(s, slot)) return 1;
  const p = s.players[slot]!;
  const b = s.ball;
  let ux = b.x - p.x, uz = b.z - p.z;
  const ul = Math.sqrt(ux * ux + uz * uz);
  if (!(ul > 1e-6)) return 1;
  ux /= ul; uz /= ul;
  let kx = p.actDirX, kz = p.actDirZ;
  let kl = Math.sqrt(kx * kx + kz * kz);
  if (!(kl > 1e-6)) { kx = p.fx; kz = p.fz; kl = Math.sqrt(kx * kx + kz * kz); }
  if (kl > 1e-6) {
    kx /= kl; kz /= kl;
    if (kx * ux + kz * uz < APPROACH_COS) {
      // The ball direction clamped to the limit: the kick direction rotated toward it by takerApproachMaxDeg
      // (R(t) k = (kx cos t - kz sin t, kx sin t + kz cos t)).
      const sn = kx * uz - kz * ux >= 0 ? APPROACH_SIN : -APPROACH_SIN;
      ux = kx * APPROACH_COS - kz * sn;
      uz = kx * sn + kz * APPROACH_COS;
    }
  }
  // Turn the facing toward (ux, uz) by at most one step.
  let fx = p.fx, fz = p.fz;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (!(fl > 1e-6) || (fx * ux + fz * uz) / fl >= TURN_COS) { p.fx = ux; p.fz = uz; return 1; }
  fx /= fl; fz /= fl;
  const st = fx * uz - fz * ux >= 0 ? TURN_SIN : -TURN_SIN;
  p.fx = fx * TURN_COS - fz * st;
  p.fz = fx * st + fz * TURN_COS;
  return 0;
}

const CLEAR = T_POSSESSION.holdBodyClear;

/** Unit kick direction of slot's KICK / SHOT action into KDIR (p.actDirX/Z, else his facing); false if none. */
function kickDir(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  let kx = p.actDirX, kz = p.actDirZ;
  let kl = Math.sqrt(kx * kx + kz * kz);
  if (!(kl > 1e-6)) { kx = p.fx; kz = p.fz; kl = Math.sqrt(kx * kx + kz * kz); }
  if (!(kl > 1e-6)) return false;
  KDIR.x = kx / kl;
  KDIR.z = kz / kl;
  return true;
}
const KDIR = { x: 0, z: 0 };

/**
 * [FIN-K] slot's own ball (ball.owner) lies behind him for his kick: launched along the kick direction from where it
 * is, it would pass within T_POSSESSION.holdBodyClear of his centre (through his body).
 */
export function ownLaunchBlocked(s: SimState, slot: number): boolean {
  const b = s.ball;
  if (b.owner !== slot || !kickDir(s, slot)) return false;
  const p = s.players[slot]!;
  const rx = b.x - p.x, rz = b.z - p.z;
  if (rx * KDIR.x + rz * KDIR.z >= 0) return false; // in front for the kick: it leaves him
  const side = rx * KDIR.z - rz * KDIR.x;
  return side < CLEAR && side > -CLEAR;
}

/** [FIN-K] p.actA bits 9..14: ticks a KICK / SHOT contact has waited for turn-and-kick (ReqFlag bits are 0..7). */
const TURN_SHIFT = 9;
const TURN_MASK = 0x3f << TURN_SHIFT;

/**
 * [FIN-K] Turn-and-kick wait at the contact: while T_KICK.turnKickMaxTicks have not passed, count one more tick, move
 * the contact to the next tick (and the planned recovery with it) and return 1; else return 0 (the kick is dropped).
 */
export function turnKickWait(s: SimState, slot: number): number {
  const p = s.players[slot]!;
  const n = (p.actA & TURN_MASK) >>> TURN_SHIFT;
  if (n >= KT.turnKickMaxTicks || n >= 0x3f) return 0;
  p.actA = ((p.actA & ~TURN_MASK) | ((n + 1) << TURN_SHIFT)) >>> 0;
  p.actContact = p.actT + 1;
  p.actDur += 1;
  return 1;
}

/** [FIN-K] Turn slot toward his kick direction (SIM-04 turns him to the look point this tick). */
export function turnToKick(s: SimState, slot: number): void {
  if (!kickDir(s, slot)) return;
  const p = s.players[slot]!;
  p.lookAt = 1;
  p.lookX = p.x + KDIR.x * 10;
  p.lookZ = p.z + KDIR.z * 10;
}
