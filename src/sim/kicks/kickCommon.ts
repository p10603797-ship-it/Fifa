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
 * at most reachHeight), within reachRadius of the body centre and within KICK_TUNING.spotReach of the kicking spot
 * (KICK_TUNING.spotAhead in front of the feet along the facing: where SIM-06 holds an owned ball through the wind-up
 * and where the kick clips meet it; render/anim/reach.ts reaches up to ~0.9 m from it). The owner's own ball no longer
 * counts as in reach wherever it is: a sprint touch 2 m ahead, a ball still dropping from a chest trap or rolling
 * behind him waits (the handlers' grace, bounded by the planned recovery) while SIM-06 pulls it onto the spot.
 *
 * SET-PIECE LINE-UP. A restart taker's kick of the dead ball (restart phase, not yet taken, ball loose) may go in any
 * direction (the set-piece modules turn him along the request): if the ball is not within takerLinedUp of his kicking
 * spot he side-steps around it (KICK_TUNING.takerStep per tick, never closer to it than spotAhead) to the spot behind
 * it along his facing before the strike, instead of kicking it through his own body; the contact is re-planned one
 * tick at a time, at most KICK_TUNING.takerLineUpMaxTicks into the action.
 */
import { MatchPhase } from '../../contracts/enums';
import { MoveMode, type SimState } from '../../contracts/state';
import { RESTART_PHASES } from '../../contracts/transitions';
import { T_PASS } from '../../contracts/tuning';
import { LOCAL_TUNING as POSSESSION_TUNING } from '../players/possession';

/** p.actA bit: the KICK / SHOT handler saw the power bar charging (a release is still to be handled). */
export const CHARGE_SEEN = 1 << 8;

/** TUNING-CR (QF-10). */
export const KICK_TUNING = { // TUNING-CR
  /** A loose ball slower than this (horizontal, m/s) is a dead / resting ball: its charged kick waits for the strike. */
  restingBallSpeed: 1.0,
  /** The kicking spot: this far in front of the feet along the facing, m (SIM-06 holds an owned ball there). */
  spotAhead: POSSESSION_TUNING.holdAhead,
  /** The ball can be struck within this distance of the kicking spot (horizontal), m. */
  spotReach: 0.9,
  /** A restart taker lining up on the dead ball side-steps at most this far per tick, m (4.8 m/s), until the ball is
   *  within takerLinedUp of his kicking spot, m. */
  takerStep: 0.08,
  takerLinedUp: 0.4,
  /** ... and strikes anyway once his kick action is this old, ticks. */
  takerLineUpMaxTicks: 45,
} as const;

const KT = KICK_TUNING;
const REST2 = KT.restingBallSpeed * KT.restingBallSpeed;
const SPOT_R2 = KT.spotReach * KT.spotReach;
const LINED2 = KT.takerLinedUp * KT.takerLinedUp;

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
 * reachRadius of his body centre and within KICK_TUNING.spotReach of his kicking spot.
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

/** The dead ball lies within KICK_TUNING.takerLinedUp of slot's kicking spot (or he has no facing). */
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
