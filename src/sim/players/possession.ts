/**
 * [SIM-06] Possession and dribbling (section 6). The ball stays its own physics object: the owner guides it
 * with touches ahead of his feet (closer at a jog, further at a sprint; close control when strafing/jockey-
 * dribbling), so it can be poked away between touches. Picks up loose balls that come within control range
 * (when no higher-priority contact happened this tick), and drops possession when the ball gets away.
 * Uses sim/core/kick.ts helpers (takePossession, releasePossession, recordTouch). Constants: T_DRIBBLE.
 * Runs LAST in the contact phase.
 *
 * WHAT dribbleTick DOES (IN_PLAY only; other phases belong to the rules / restart modules):
 *  1. Possession loss (always, even after another contact this tick): the owner is inactive, stunned (stunT > 0), in
 *     a non-ball action (tackles, STUMBLE / FALLEN / GET_UP, dives, punches, rushes, celebrations, wall jumps: see
 *     BALL_ACT), or the ball is more than T_DRIBBLE.loseRadius from him (horizontal) -> releasePossession. A ball in a
 *     keeper's hands (heldBy) is GKP-05's: nothing is done to it (defensively, a holder who is not the owner is given
 *     possession through takePossession).
 *  2. Owner control (skipped when another stage already touched the ball this tick: one contact per tick). The
 *     owner's reach is controlRadius + his speed x reachLookahead (a running player meets a ball up to a stride ahead;
 *     standing: controlRadius), and the ball must be low (controlHeight).
 *     - KICK / SHOT wind-up (actDone 0): the ball is held at the kicking spot (holdAhead in front of his feet along
 *       his facing): its velocity is set to his velocity plus a pull onto the spot (time constant holdTau, capped at
 *       holdMaxRel), so it slows to the spot and the contact tick finds it in reach. SKILL / FAKE: the same before
 *       their contact tick only (afterwards SIM-13 scripts the ball).
 *     - SHIELD with an opponent in range (SIM-05 isShielding + shieldBallSpot): held the same way on the shield spot,
 *       on the far side of the body from the opponent.
 *     - Free (NONE / SHIELD with nobody near): dribble touches (below). FIRST_TOUCH: SIM-07's window, no touches.
 *     - Steal between touches (NONE / SHIELD / FIRST_TOUCH / KICK / SHOT wind-up; never during SKILL / FAKE, whose
 *       vulnerable window is SIM-14's): while the ball is out of the owner's reach ([FEEL-1] or, NONE / SHIELD /
 *       FIRST_TOUCH, beyond his controlRadius with the opponent nearer to it than he is: pokeTick), the nearest pick-up-eligible
 *       opponent within controlRadius of it (ties: closest, then lower slot; a shielding owner's shieldBlocks() keeps a
 *       challenger off) takes it when it is slow relative to him (stealMaxRelSpeed; takePossession), or blocks it
 *       (deflects it off his feet: the ball becomes loose, recordTouch + KICK event with KickKind.DEFLECTION) when it
 *       comes at him faster. The dribbler gets noTouchT = T_DRIBBLE.dispossessedNoTouch either way. This is the
 *       poke-away window: a sprint touch runs well beyond the owner's reach for most of its cycle.
 *     - [QF-16 third attempt] Under an opponent's feet (NONE / SHIELD): while the owner walks or jogs (slower than
 *       underMaxSpeed) a ball within underRadius of the nearest eligible opponent and nearer to him than to the owner by
 *       underMargin is his to steal (or block) the same way, even inside the owner's reach: a walker ran his ball under
 *       a CPU defender standing in front of him and kept it there for seconds. Only when the owner or that opponent is
 *       human-controlled (bot-v-bot possession unchanged).
 *  3. Loose ball (no owner, not in hands, no contact this tick, not in the net, low (<= controlHeight), horizontal
 *     speed < pickUpMaxSpeed): the nearest pick-up-eligible player within controlRadius takes possession (ties:
 *     closest, then lower slot) and controls it at once (a dribble touch, or the wind-up hold). Eligible
 *     (pickUpEligible): active, stunT <= 0, noTouchT <= 0, and act NONE / SHIELD / FIRST_TOUCH or a KICK / SHOT
 *     wind-up before contact (a first-time kick then finds the ball on the kicking spot). Tackles, dives, rushes,
 *     punches, skills, fakes and down states are excluded (their owners resolve their own contacts), and so is the
 *     player who kicked the ball (ball.lastKickBy) within selfKickTicks of his kick. Keepers pick up with their feet
 *     like anyone (GKP-05 keeperPickUp takes a ball at his feet into his hands).
 *  4. Stuck ball (glitch list "Ball stuck: between two players / under a sliding player"): a loose, low ball slower
 *     than stuckSpeed that nobody could take this tick, untouched for stuckTicks (ball.idleT) with an active player
 *     within stuckRadius (so the ball lies under / between bodies whose players cannot take it) squirts out at
 *     squirtSpeed, away from the nearby bodies (inverse-square repulsion over squirtScan; exactly symmetric: at right
 *     angles to the nearest body, or along his facing when the ball lies under his centre). recordTouch(nearest
 *     body) so the last touch is right for out-of-play decisions.
 *  5. Every tick, every phase: p.touchCd and p.noTouchT count down by one for every player (SIM-06 owns the countdowns;
 *     SIM-13 / SIM-14 / GKP-05 may set noTouchT), and ball.ownerT counts up while someone owns the ball.
 *
 * DRIBBLE TOUCHES. With the ball in his reach, the free owner touches it when touchCd has run out, or earlier (at
 * least turnMinGap ticks after the last touch) for
 *  - a sharp turn: the wanted direction is more than acos(turnCos) away from the ball's travel (a slow ball: from
 *    where it lies) -> the extra small touch (touchAheadClose, next touch after turnInterval);
 *  - a hard stop: planned speed below brakeFrac of his speed and the ball would roll to rest beyond controlRadius ahead
 *    of where he stops -> a small stopping touch (same as a turn touch);
 *  - a ball drifting out of his reach (within escapeMargin of its edge, moving away from him; not at a sprint) on a
 *    curving run -> a regular touch.
 * A standing owner leaves a ball at rest at his feet alone (settleSpeed); a rolling one gets a stopping touch.
 *  - Direction u and planned speed: from the movement intent (DIRECT stick: jog * |stick| or a sprint; ARRIVE: toward
 *    the target), else his velocity, else his facing. Strafe / jockey caps and the SHIELD speed cap follow SIM-04 (its
 *    T_LOCOMOTION and staminaFactor are imported, so the two models cannot drift apart).
 *  - Lead (how far ahead of the feet the ball runs at the peak of the touch): touchAheadClose when standing, strafing /
 *    jockey-dribbling, shielding, turning or stopping; touchAheadClose..touchAheadJog up to jog speed; touchAheadJog..
 *    touchAheadSprint from jog to top speed (sprint touches are heavier). Opponents near the owner (pressureNear..
 *    pressureFar) pull non-sprint touches toward touchAheadClose. Clamped to minLead..loseRadius - loseMargin.
 *  - Quality q (0..1) = weighted dribbling / ballControl / agility x SIM-04 staminaFactor: poor q pushes further
 *    (leadQualityScale), waits longer between touches (intervalQualityScale), and errs more: two s.rng draws per touch
 *    give a direction error of the push (relative to his run) up to errAngleMax and a lead error up to errLeadMax
 *    (x (1 - q), sprint x (1 + errSprintMul)).
 *  - Push speed: a fixed-step 1-D model along u (SIM-02 rolling: rollDecel + rollDamping * v; the player accelerating
 *    / braking toward his planned speed with SIM-04's accelerations) is bisected for the ball speed whose lead peaks at
 *    the wanted lead (counted from when the ball stops dropping back, so a stopping touch rests the ball that far
 *    ahead of where he stops). The sideways offset is closed by the next touch: the interval while the lead stays
 *    within his reach (jog, close control), else the time the ball takes to come back (sprint); latMinTime, capped
 *    at latMaxSpeed and at latTravelFrac of the forward speed.
 *  - touchCd = the interval (T_DRIBBLE.touchIntervalJog..touchIntervalSprint by speed, quality-scaled). It is the
 *    spacing while the ball stays in reach (jog, close control); a sprint touch comes back later (rolling physics).
 *  - WHY NOT applyKick(DRIBBLE_TOUCH): applyKick releases possession and rewrites lastKick* / passTarget / shot data,
 *    and RUL-08 snapshots offside on every lastKickTick, so a dribble would look like a stream of passes (offside
 *    judged on every touch, pass targets wiped, the back-pass rule tainted). A dribble touch is recordTouch (last touch,
 *    idleT, the player's lastTouchTick) plus the new ball velocity, and ball.owner is kept. A KICK event with
 *    KickKind.DRIBBLE_TOUCH and a small power is still emitted for audio and animation (stats count only
 *    isFootPassKind kicks).
 *
 * canTouchBall: physical eligibility only (active, not stunned or down, noTouchT expired, ball not in another
 * player's hands, ball low and within controlRadius); contact-phase callers check ballTouchedThisTick themselves.
 *
 * Determinism / cost: plain arithmetic + Math.sqrt, s.rng only (two draws per dribble touch), slot-order loops with
 * strict-< tie breaks, no allocation (module scratch; numbers cross helper calls through a Float64Array). Per tick:
 * O(22) countdowns plus O(11..22) scans; the push solver (<= ~1100 tiny steps) runs only on touch ticks.
 */
import { CPU_CONTROLLER_BASE, DT, NUM_SLOTS } from '../../contracts/constants';
import { ActionKind, KickKind, MatchPhase } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { MoveMode, type PlayerState, type SimState } from '../../contracts/state';
import { T_BALL, T_DRIBBLE, T_FEEL, T_PLAYER, T_POSSESSION, T_LOCOMOTION } from '../../contracts/tuning';
import { Btn } from '../../contracts/input';
import { ballTouchedThisTick, recordTouch, releasePossession, takePossession } from '../core/kick';
import { rngRange } from '../core/rng';
import { isShielding, shieldBallSpot, shieldBlocks } from './bodies';
import { staminaFactor } from './locomotion';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_POSSESSION. */
export const LOCAL_TUNING = T_POSSESSION;


const L = T_POSSESSION;
/** SIM-04 movement tuning the dribble model follows (sprint stick, high-speed acceleration, ARRIVE braking, jockey cap). */
const SPRINT_STICK_FULL = T_LOCOMOTION.sprintStickFull;
const HIGH_SPEED_ACCEL_MUL = T_LOCOMOTION.highSpeedAccelMul;
const ARRIVE_BRAKE_FRAC = T_LOCOMOTION.arriveDecelFrac;
const JOCKEY_FORWARD_FRAC = T_LOCOMOTION.jockeyForwardFraction;
const CR2 = T_DRIBBLE.controlRadius * T_DRIBBLE.controlRadius;
const LOSE2 = T_DRIBBLE.loseRadius * T_DRIBBLE.loseRadius;
const CTRL_H = T_DRIBBLE.controlHeight;
const HALF_NS = NUM_SLOTS / 2;

// ---------------------------------------------------------------- action tables (indexed by ActionKind)

const ACT_N = ActionKind.SHIELD + 1;
/** 1 = the owner keeps possession in this action. */
const BALL_ACT = new Uint8Array(ACT_N);
/** 1 = a player in this action may pick up a loose ball / steal (KICK / SHOT only before contact). */
const PICK_ACT = new Uint8Array(ACT_N);
/** 1 = on the ground or losing balance (cannot touch the ball). */
const DOWN_ACT = new Uint8Array(ACT_N);
(() => {
  const keep = [
    ActionKind.NONE, ActionKind.KICK, ActionKind.SHOT, ActionKind.HEADER, ActionKind.VOLLEY, ActionKind.FIRST_TOUCH,
    ActionKind.SKILL, ActionKind.FAKE, ActionKind.SHIELD, ActionKind.GK_HOLD, ActionKind.GK_THROW, ActionKind.GK_KICK,
    ActionKind.GK_CATCH, ActionKind.THROW_IN, ActionKind.SET_PIECE,
  ];
  for (const a of keep) BALL_ACT[a] = 1;
  for (const a of [ActionKind.NONE, ActionKind.SHIELD, ActionKind.FIRST_TOUCH, ActionKind.KICK, ActionKind.SHOT]) PICK_ACT[a] = 1;
  for (const a of [ActionKind.STUMBLE, ActionKind.FALLEN, ActionKind.GET_UP]) DOWN_ACT[a] = 1;
})();

// ---------------------------------------------------------------- module scratch (no per-tick allocation)

/** Numbers passed between the helpers (a double returned from a call V8 does not inline would be boxed). */
const F = new Float64Array(16);
const F_UX = 0, F_UZ = 1, F_VT = 2, F_JOG = 3, F_ACC = 4, F_UB = 5, F_TPK = 6, F_SF = 7, F_Q = 8;
/** Push-solver inputs: current lead, player speed along u, wanted peak lead, return lead, trial ball speed. */
const F_D0 = 9, F_V0 = 10, F_TGT = 11, F_BACK = 12, F_UBT = 13;
/** The owner's reach this tick (m). */
const F_REACH = 14;
/** [FEEL-1] 1 = R1 controlled sprint (MOD_R held without SPRINT by the owner's controller, sprinting). */
const F_CS = 15;
/** shieldBallSpot output. */
const SPOT = { x: 0, z: 0 };

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ---------------------------------------------------------------- eligibility

/** May p pick up a loose ball / steal one now (ignores distance)? */
function pickUpEligible(p: Readonly<PlayerState>): boolean {
  if (p.active !== 1 || p.stunT > 0 || p.noTouchT > 0) return false;
  const a = p.act;
  if (PICK_ACT[a] !== 1) return false;
  return (a !== ActionKind.KICK && a !== ActionKind.SHOT) || p.actDone === 0;
}

/** True if `slot` could touch the ball this tick (distance, height, not stunned, noTouchT expired). */
export function canTouchBall(s: SimState, slot: number): boolean {
  if (!(slot >= 0 && slot < NUM_SLOTS)) return false;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.stunT > 0 || p.noTouchT > 0 || DOWN_ACT[p.act] === 1) return false;
  const b = s.ball;
  if (b.heldBy >= 0 && b.heldBy !== slot) return false;
  if (!(b.y <= CTRL_H)) return false;
  const dx = b.x - p.x, dz = b.z - p.z;
  return dx * dx + dz * dz <= CR2;
}

// ---------------------------------------------------------------- intent, quality, pressure

/**
 * Movement direction (F_UX, F_UZ) and planned speed F_VT of slot from his intent (SIM-04 semantics), plus his
 * stamina-scaled jog speed and acceleration (F_JOG, F_ACC), the sprint fraction F_SF (0 at jog or below, 1 at top
 * speed) and the touch quality F_Q.
 */
function intentOf(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const sfac = staminaFactor(p);
  const top = (a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin) * sfac;
  const jog = top * T_PLAYER.jogFraction;
  const acc = (a.accel > 0 ? a.accel : T_PLAYER.accelMin) * sfac;
  let ux = 0, uz = 0, vt = 0, dirOk = 0;
  if (p.moveMode === MoveMode.DIRECT) {
    const ix = Number.isFinite(p.ix) ? p.ix : 0;
    const iz = Number.isFinite(p.iz) ? p.iz : 0;
    const mag = Math.sqrt(ix * ix + iz * iz);
    if (mag > L.stickDead) {
      ux = ix / mag; uz = iz / mag; dirOk = 1;
      const m = mag < 1 ? mag : 1;
      if (p.wantSprint === 1) { const f = m / SPRINT_STICK_FULL; vt = top * (f < 1 ? f : 1); } else vt = jog * m;
    }
  } else if (p.moveMode === MoveMode.ARRIVE) {
    const dx = (Number.isFinite(p.tgtX) ? p.tgtX : p.x) - p.x;
    const dz = (Number.isFinite(p.tgtZ) ? p.tgtZ : p.z) - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > T_PLAYER.arriveStop) {
      ux = dx / d; uz = dz / d; dirOk = 1;
      const cap = Number.isFinite(p.tgtSpeed) && p.tgtSpeed > 0 ? p.tgtSpeed : 0;
      const brake = Math.sqrt(2 * ARRIVE_BRAKE_FRAC * T_PLAYER.decel * (d - T_PLAYER.arriveStop));
      vt = cap < top ? cap : top;
      if (brake < vt) vt = brake;
    }
  }
  if (p.act === ActionKind.SHIELD) {
    const cap = jog * T_PLAYER.shieldSpeedFraction;
    if (vt > cap) vt = cap;
  } else if (p.lookAt === 1 && vt > 0) {
    // SIM-04's strafe cap: by the move direction relative to the look direction (sideways / backward slowest).
    let lx = p.fx, lz = p.fz;
    const fl = Math.sqrt(lx * lx + lz * lz);
    if (fl > 1e-9) { lx /= fl; lz /= fl; } else { lx = 0; lz = 0; }
    const ox = Number.isFinite(p.lookX) ? p.lookX - p.x : 0;
    const oz = Number.isFinite(p.lookZ) ? p.lookZ - p.z : 0;
    const ol = Math.sqrt(ox * ox + oz * oz);
    if (ol > 0.01) { lx = ox / ol; lz = oz / ol; }
    const c = ux * lx + uz * lz;
    const fr = c > 0 ? T_PLAYER.jockeySpeedFraction + (JOCKEY_FORWARD_FRAC - T_PLAYER.jockeySpeedFraction) * c
      : T_PLAYER.jockeySpeedFraction;
    const cap = (p.wantSprint === 1 ? top : jog) * fr;
    if (vt > cap) vt = cap;
  }
  if (dirOk === 0 || vt < L.standSpeed) {
    // No (or a standing) intent: keep to the way he is moving, else the way he faces.
    const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    if (dirOk === 0 || sp > L.standSpeed) {
      if (sp > L.standSpeed) { ux = p.vx / sp; uz = p.vz / sp; } else {
        const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz);
        if (fl > 1e-9) { ux = p.fx / fl; uz = p.fz / fl; } else { ux = s.teams[p.team]!.dir; uz = 0; }
      }
    }
  }
  F[F_UX] = ux; F[F_UZ] = uz; F[F_VT] = vt; F[F_JOG] = jog; F[F_ACC] = acc;
  // [FEEL-1] R1 controlled sprint: the owner's controller (human or CPU brain) holds MOD_R without SPRINT and he runs.
  let cs = 0;
  const c = p.ctrl;
  if (c >= 0 && c < s.ctrl.length && p.wantSprint === 1 && vt > jog) {
    const bt = s.ctrl[c]!.buttons;
    if ((bt & Btn.MOD_R) !== 0 && (bt & Btn.SPRINT) === 0) cs = 1;
  }
  F[F_CS] = cs;
  F[F_SF] = vt > jog && top > jog + 1e-9 ? clamp01((vt - jog) / (top - jog)) : 0;
  // Touch quality.
  const wsum = L.qDribbling + L.qBallControl + L.qAgility;
  const q = (L.qDribbling * clamp01((a.dribbling - 1) / 98) + L.qBallControl * clamp01((a.ballControl - 1) / 98) +
    L.qAgility * clamp01((a.agility - 1) / 98)) / wsum;
  F[F_Q] = clamp01(q * sfac);
}

/** 1 = an opponent at pressureNear or closer .. 0 = none within pressureFar. Result in F[F_TPK] (scratch reuse). */
function pressureOf(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const first = p.team === 0 ? HALF_NS : 0;
  let best = 1e18;
  for (let j = first; j < first + HALF_NS; j++) {
    const q = s.players[j]!;
    if (q.active !== 1) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  F[F_TPK] = clamp01((L.pressureFar - d) / (L.pressureFar - L.pressureNear));
}

// ---------------------------------------------------------------- push solver

/**
 * Does the ball's lead along u reach F_TGT, for the trial ball speed F_UBT (ball lead F_D0 now; the player moving at
 * F_V0 along u, accelerating (F_ACC, above F_JOG x highSpeedAccelMul) / braking toward F_VT)? The lead counts only from
 * the moment the ball stops falling back (ball at least as fast as the player): for a braking player a soft touch first
 * drops back, then rolls on to rest ahead of where he stops, and that resting lead is what counts. The answer is
 * increasing in the ball speed (bisection). With early = 1 it stops as soon as the answer is known. With early = 0 it
 * runs on until the lead is back down to F_BACK after its peak and leaves that return time in F[F_TPK] (the horizon if
 * it never comes back). Inputs come through F (no double arguments: V8 would box them per call).
 */
function peakReaches(early: number): number {
  const h = L.solveStep;
  const n = Math.ceil(L.solveHorizon / h);
  const ra = T_BALL.rollDecel, rc = T_BALL.rollDamping, rest = T_BALL.restSpeed;
  const dec = T_PLAYER.decel;
  const d0 = F[F_D0]!, vt = F[F_VT]!, acc = F[F_ACC]!, jog = F[F_JOG]!, tgt = F[F_TGT]!, back = F[F_BACK]!;
  const accHi = acc * HIGH_SPEED_ACCEL_MUL;
  let vb = F[F_UBT]!, vp = F[F_V0]!, xb = 0, xp = 0;
  let rising = vb >= vp ? 1 : 0;
  let best = rising === 1 ? d0 : -1e9;
  let tret = n * h;
  let falling = 0;
  for (let k = 1; k <= n; k++) {
    let nvb = vb - (ra + rc * vb) * h;
    if (nvb < rest) nvb = 0;
    xb += 0.5 * (vb + nvb) * h;
    vb = nvb;
    let nvp: number;
    if (vp < vt) { nvp = vp + (vp >= jog ? accHi : acc) * h; if (nvp > vt) nvp = vt; } else { nvp = vp - dec * h; if (nvp < vt) nvp = vt; }
    xp += 0.5 * (vp + nvp) * h;
    vp = nvp;
    const lead = d0 + xb - xp;
    if (rising === 0 && vb >= vp) rising = 1;
    if (rising === 1 && lead > best) best = lead;
    // Ball no faster than the player, who is no longer braking: the lead only falls from here.
    const done = vb <= vp && vp <= vt + 1e-9;
    if (early === 1) {
      if (best >= tgt) return 1;
      if (done) break;
    } else {
      if (rising === 1 && lead < best) falling = 1;
      if (falling === 1 && lead <= back) { tret = k * h; break; }
      if (done && vp === 0) break; // both at rest: it never comes back
    }
  }
  F[F_TPK] = tret;
  return best >= tgt ? 1 : 0;
}

/**
 * Ball speed along u (F[F_UB]) whose lead peaks at F_TGT (see peakReaches; inputs in F), and the time the ball takes
 * to come back to the owner's feet (lead back down to F_D0, clamped to minLead..controlRadius) (F[F_TPK]).
 */
function solvePush(): void {
  const d0 = F[F_D0]!, v0 = F[F_V0]!, vt = F[F_VT]!;
  F[F_BACK] = d0 < L.minLead ? L.minLead : d0 > T_DRIBBLE.controlRadius ? T_DRIBBLE.controlRadius : d0;
  let lo = 0;
  let hi = (vt > v0 ? vt : v0) + L.solveHiExtra;
  if (hi > T_BALL.maxSpeed) hi = T_BALL.maxSpeed;
  F[F_UBT] = lo;
  if (peakReaches(1) === 1) hi = lo;
  else {
    F[F_UBT] = hi;
    if (peakReaches(1) === 1) {
      for (let i = 0; i < L.solveIters; i++) {
        const mid = 0.5 * (lo + hi);
        F[F_UBT] = mid;
        if (peakReaches(1) === 1) hi = mid; else lo = mid;
      }
    }
  }
  F[F_UBT] = hi;
  peakReaches(0);
  F[F_UB] = hi;
}

// ---------------------------------------------------------------- ball control

/** holdOn's spot (x, z), written by its callers. */
const HOLD = new Float64Array(2);

/**
 * Hold the (low) ball on the spot (HOLD: sx, sz) next to slot's feet: his velocity + a capped pull onto the spot. [FIN-K]
 * Round his body, never through it: when the straight way from the ball to the spot passes closer than holdBodyClear
 * to his centre (a sharp turn left the ball behind him, the kicking spot is in front), the pull heads for a waypoint
 * beside him (holdBodyClear out, or the ball's own distance when further, at right angles to the chord's closest
 * point) with the speed for the whole way round, so the ball circles his body onto the spot.
 */
function holdOn(s: SimState, slot: number): void {
  const b = s.ball;
  if (!(b.y <= CTRL_H)) return;
  const p = s.players[slot]!;
  const sx = HOLD[0]!, sz = HOLD[1]!; // the spot crosses the call in scratch: double arguments get boxed
  let tx = sx, tz = sz;
  let way = 0;
  const ax = b.x - p.x, az = b.z - p.z;
  const dx = sx - b.x, dz = sz - b.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > 1e-12) {
    const t = -(ax * dx + az * dz) / d2;
    if (t > 0 && t < 1) {
      let cx = ax + dx * t, cz = az + dz * t;
      const cl = Math.sqrt(cx * cx + cz * cz);
      const clr = L.holdBodyClear;
      if (cl < clr) {
        if (cl < 1e-6) { cx = -dz; cz = dx; } else { cx /= cl; cz /= cl; }
        const nl = Math.sqrt(cx * cx + cz * cz);
        const al = Math.sqrt(ax * ax + az * az);
        const rad = al > clr ? al : clr;
        tx = p.x + (cx / nl) * rad;
        tz = p.z + (cz / nl) * rad;
        const wx = tx - b.x, wz = tz - b.z, vx2 = sx - tx, vz2 = sz - tz;
        way = Math.sqrt(wx * wx + wz * wz) + Math.sqrt(vx2 * vx2 + vz2 * vz2);
      }
    }
  }
  let rx = (tx - b.x) / L.holdTau;
  let rz = (tz - b.z) / L.holdTau;
  let r = Math.sqrt(rx * rx + rz * rz);
  if (way > 0 && r > 1e-9) {
    // Toward the waypoint at the speed for the whole way round (no slow-down at the waypoint).
    const want = way / L.holdTau;
    rx *= want / r; rz *= want / r; r = want;
  }
  if (r > L.holdMaxRel) { rx *= L.holdMaxRel / r; rz *= L.holdMaxRel / r; }
  b.vx = p.vx + rx;
  b.vz = p.vz + rz;
  if (b.vy > 0) b.vy = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
}

/** Hold the ball on slot's kicking spot (holdAhead along his facing). */
function holdKickSpot(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  let fx = p.fx, fz = p.fz;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl > 1e-9) { fx /= fl; fz /= fl; } else { fx = s.teams[p.team]!.dir; fz = 0; }
  HOLD[0] = p.x + fx * L.holdAhead;
  HOLD[1] = p.z + fz * L.holdAhead;
  holdOn(s, slot);
}

/** A dribble touch by slot (intent already in F via intentOf). turn = 1: the extra small touch of a sharp turn. */
function touchBall(s: SimState, slot: number, turn: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const b = s.ball;
  const ux = F[F_UX]!, uz = F[F_UZ]!, vt = F[F_VT]!, jog = F[F_JOG]!, sf = F[F_SF]!, q = F[F_Q]!;
  const close = T_DRIBBLE.touchAheadClose;
  // [FEEL-1] A human-controlled dribbler has close control (T_FEEL.human*); CPU dribblers keep the calibrated touches.
  const hc = p.ctrl >= 0 && p.ctrl < CPU_CONTROLLER_BASE;
  const jogLead = hc ? T_FEEL.humanTouchAheadJog : T_DRIBBLE.touchAheadJog;
  const sprintLead = hc ? T_FEEL.humanTouchAheadSprint : T_DRIBBLE.touchAheadSprint;
  let lead: number;
  if (turn === 1 || p.jockeying === 1 || p.act === ActionKind.SHIELD || vt <= L.standSpeed) lead = close;
  else if (F[F_CS] === 1) lead = T_FEEL.touchAheadControlled;
  else if (vt <= jog) lead = jog > L.standSpeed ? close + (jogLead - close) * clamp01((vt - L.standSpeed) / (jog - L.standSpeed)) : jogLead;
  else lead = jogLead + (sprintLead - jogLead) * sf;
  if (lead > close && sf < 1) {
    pressureOf(s, slot);
    lead += (close - lead) * F[F_TPK]! * (1 - sf);
  }
  // [FEEL-1] A human's dribbling / control / agility show more at pace (sf): walking touches stay the calibrated ones.
  lead *= 1 + (hc ? L.leadQualityScale + (T_FEEL.humanLeadQualityScale - L.leadQualityScale) * sf : L.leadQualityScale) * (0.5 - q);
  const r1 = rngRange(s.rng, -1, 1);
  const r2 = rngRange(s.rng, -1, 1);
  const err = (1 - q) * (1 + L.errSprintMul * sf);
  lead *= 1 + L.errLeadMax * err * r2;
  const maxLead = T_DRIBBLE.loseRadius - L.loseMargin;
  if (lead > maxLead) lead = maxLead;
  if (lead < L.minLead) lead = L.minLead;
  // Geometry along u (d0 ahead, e0 to the side n = (-uz, ux)).
  const rx = b.x - p.x, rz = b.z - p.z;
  const d0 = rx * ux + rz * uz;
  const e0 = rz * ux - rx * uz;
  const v0 = p.vx * ux + p.vz * uz;
  F[F_D0] = d0; F[F_V0] = v0; F[F_TGT] = lead;
  solvePush();
  const ub = F[F_UB]!;
  // Next touch: after the interval while the ball stays within his reach, else when it comes back (F_TPK). The
  // sideways offset is closed by then.
  let iv: number;
  if (turn === 1) iv = L.turnInterval;
  else if (F[F_CS] === 1) iv = Math.round(T_FEEL.touchIntervalControlled * (1 + L.intervalQualityScale * (0.5 - q)));
  else {
    const ivJ = hc ? T_FEEL.humanTouchIntervalJog : T_DRIBBLE.touchIntervalJog;
    const ivS = hc ? T_FEEL.humanTouchIntervalSprint : T_DRIBBLE.touchIntervalSprint;
    iv = ivJ + (ivS - ivJ) * sf;
    iv = Math.round(iv * (1 + L.intervalQualityScale * (0.5 - q)));
  }
  if (iv < 1) iv = 1;
  let tl = lead > T_DRIBBLE.controlRadius + vt * L.reachLookahead ? F[F_TPK]! : iv * DT;
  if (tl < L.latMinTime) tl = L.latMinTime;
  // Sideways correction, capped absolutely and by the forward speed (the ball's own heading stays within 45 degrees
  // of u, so it never reads as a turn to the next tick's turn test).
  let vl = -e0 / tl;
  let vlMax = ub * L.latTravelFrac;
  if (vlMax > L.latMaxSpeed) vlMax = L.latMaxSpeed;
  if (vl > vlMax) vl = vlMax; else if (vl < -vlMax) vl = -vlMax;
  // The push relative to the player's run (ub - v0 along u, vl sideways) gets the direction error: rotate it by a
  // small angle (Taylor sin/cos, |th| <= errAngleMax * 1.5). The error is in the touch, not in his running speed.
  const vb0 = v0 > 0 ? v0 : 0;
  const pa = ub - vb0;
  const th = L.errAngleMax * err * r1;
  const t2 = th * th;
  const c = 1 - t2 * 0.5 * (1 - t2 / 12);
  const sn = th * (1 - t2 / 6 * (1 - t2 / 20));
  const ra = pa * c - vl * sn;
  const rl = pa * sn + vl * c;
  const vx = ux * (vb0 + ra) - uz * rl;
  const vz = uz * (vb0 + ra) + ux * rl;
  b.vx = vx;
  b.vz = vz;
  if (b.vy > 0) b.vy = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  recordTouch(s, slot);
  p.touchCd = iv;
  const rvx = vx - p.vx, rvz = vz - p.vz;
  ev.emit(EventType.KICK, slot, KickKind.DRIBBLE_TOUCH, clamp01(Math.sqrt(rvx * rvx + rvz * rvz) / L.touchPowerRef), 0, b.x, b.y, b.z);
}

/**
 * Free owner with the ball within his reach (F[F_REACH], m): touch it when due (cooldown run out), or earlier for a
 * sharp turn, a hard stop, or a ball drifting out of reach.
 */
function dribbleControl(s: SimState, slot: number, ev: EventSink): void {
  const reach = F[F_REACH]!;
  const p = s.players[slot]!;
  const b = s.ball;
  intentOf(s, slot);
  const ux = F[F_UX]!, uz = F[F_UZ]!, vt = F[F_VT]!;
  const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  if (vt < L.standSpeed && sp < L.standSpeed) {
    const rvx = b.vx - p.vx, rvz = b.vz - p.vz;
    if (rvx * rvx + rvz * rvz < L.settleSpeed * L.settleSpeed) return; // ball at rest at his feet
  }
  // Sharp turn: the wanted direction is more than acos(turnCos) away from the way the ball travels (a slow ball:
  // from where it lies). Braking hard (planned speed well below his speed) with the ball running on also takes the
  // small (stopping) touch.
  const dx = b.x - p.x, dz = b.z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  let turn = 0;
  let early = 0;
  if (vt < L.brakeFrac * sp && sp > L.standSpeed) {
    // Braking: a stopping touch when the ball would come to rest out of reach ahead of where he stops (rolling
    // distance over-estimated without the speed damping, so a ball already on a stopping course is left alone).
    const along = b.vx * ux + b.vz * uz;
    const ballRun = along > 0 ? along * along / (2 * T_BALL.rollDecel) : 0;
    const playerRun = (sp * sp - vt * vt) / (2 * T_PLAYER.decel);
    if (dx * ux + dz * uz + ballRun - playerRun > T_DRIBBLE.controlRadius) turn = 1;
  } else if (vt >= L.standSpeed) {
    const bs = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
    if (bs > L.travelSpeed) {
      if ((b.vx * ux + b.vz * uz) / bs < L.turnCos) turn = 1;
    } else if (d > L.turnOffsetMin && (dx * ux + dz * uz) / d < L.turnCos) turn = 1;
    // Not sprinting and the ball drifting out of his reach (a curving run): touch it back early.
    if (turn === 0 && F[F_SF]! < L.escapeSprintMax && d > reach - L.escapeMargin &&
      (b.vx - p.vx) * dx + (b.vz - p.vz) * dz > 0) early = 1;
  }
  if (p.touchCd > 0 && !((turn === 1 || early === 1) && s.tick - p.lastTouchTick >= L.turnMinGap)) return;
  touchBall(s, slot, turn, ev);
}

/** Control right after gaining possession this tick (pick-up / steal): wind-up hold, else a touch. */
function controlAfterTake(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  p.touchCd = 0;
  if (p.act === ActionKind.KICK || p.act === ActionKind.SHOT) { holdKickSpot(s, slot); return; }
  if (p.act !== ActionKind.NONE && p.act !== ActionKind.SHIELD) return;
  intentOf(s, slot);
  touchBall(s, slot, 0, ev);
}

/** nearestTaker's search radius squared (controlRadius; pokeTick widens it for its call). */
let takerR2 = CR2;
const POKE2 = T_FEEL.pokeReach * T_FEEL.pokeReach;

/** Nearest pick-up-eligible player of slots [from, to) within controlRadius of the ball (ties: lower slot); -1 none. */
function nearestTaker(s: SimState, from: number, to: number, owner: number): number {
  const b = s.ball;
  let best = -1;
  let bestD2 = takerR2;
  const shield = owner >= 0 && isShielding(s, owner);
  const selfKick = owner < 0 && s.tick - b.lastKickTick < L.selfKickTicks ? b.lastKickBy : -1;
  for (let j = from; j < to; j++) {
    const q = s.players[j]!;
    if (j === selfKick || !pickUpEligible(q)) continue;
    const dx = b.x - q.x, dz = b.z - q.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > bestD2 || (d2 === bestD2 && best >= 0)) continue;
    if (shield && shieldBlocks(s, owner, j)) continue;
    best = j;
    bestD2 = d2;
  }
  return best;
}

/** Owner out of reach: an opponent at the ball steals (slow) or blocks (fast) it. Returns 1 if the ball changed. */
function stealTick(s: SimState, owner: number, ev: EventSink): number {
  const b = s.ball;
  if (!(b.y <= CTRL_H)) return 0;
  const o = s.players[owner]!;
  const first = o.team === 0 ? HALF_NS : 0;
  const j = nearestTaker(s, first, first + HALF_NS, owner);
  if (j < 0) return 0;
  return stealBy(s, owner, j, ev);
}

/** [FEEL-1] The ball beyond the owner's controlRadius (still in his running reach): the nearest eligible opponent within
 *  T_FEEL.pokeReach of it (a stretched leg) and nearer to it than the owner steals or blocks it, as between touches.
 *  1 if the ball changed. */
function pokeTick(s: SimState, owner: number, ev: EventSink): number {
  const b = s.ball;
  if (!(b.y <= CTRL_H)) return 0;
  const o = s.players[owner]!;
  const first = o.team === 0 ? HALF_NS : 0;
  takerR2 = POKE2;
  const j = nearestTaker(s, first, first + HALF_NS, owner);
  takerR2 = CR2;
  if (j < 0) return 0;
  const q = s.players[j]!;
  const qx = b.x - q.x, qz = b.z - q.z, ox = b.x - o.x, oz = b.z - o.z;
  if (!(qx * qx + qz * qz < ox * ox + oz * oz)) return 0;
  return stealBy(s, owner, j, ev);
}

/**
 * [QF-16] The owner can reach the ball, but it lies under an opponent's feet (the nearest eligible one within
 * underRadius of it, nearer to it than the owner by underMargin; a shielding owner's shieldBlocks() keeps him off): he
 * steals or blocks it as between touches. Returns 1 if the ball changed.
 */
function underTick(s: SimState, owner: number, ev: EventSink): number {
  const b = s.ball;
  if (!(b.y <= CTRL_H)) return 0;
  const o = s.players[owner]!;
  if (!(o.vx * o.vx + o.vz * o.vz < L.underMaxSpeed * L.underMaxSpeed)) return 0;
  const first = o.team === 0 ? HALF_NS : 0;
  const j = nearestTaker(s, first, first + HALF_NS, owner);
  if (j < 0) return 0;
  const q = s.players[j]!;
  // A human owner or a human opponent only (bot-v-bot possession is calibrated on the old rule).
  if (!(o.ctrl >= 0 && o.ctrl < CPU_CONTROLLER_BASE) && !(q.ctrl >= 0 && q.ctrl < CPU_CONTROLLER_BASE)) return 0;
  const qx = b.x - q.x, qz = b.z - q.z, ox = b.x - o.x, oz = b.z - o.z;
  const dq = Math.sqrt(qx * qx + qz * qz);
  if (!(dq <= L.underRadius) || !(dq + L.underMargin <= Math.sqrt(ox * ox + oz * oz))) return 0;
  return stealBy(s, owner, j, ev);
}

/** Opponent j steals (slow relative to him) or blocks (coming at him faster) the owner's ball. 1 if it changed. */
function stealBy(s: SimState, owner: number, j: number, ev: EventSink): number {
  const b = s.ball;
  const o = s.players[owner]!;
  const q = s.players[j]!;
  const rvx = b.vx - q.vx, rvz = b.vz - q.vz;
  const rel2 = rvx * rvx + rvz * rvz;
  if (rel2 <= L.stealMaxRelSpeed * L.stealMaxRelSpeed) {
    takePossession(s, j, ev);
    if (o.noTouchT < T_DRIBBLE.dispossessedNoTouch) o.noTouchT = T_DRIBBLE.dispossessedNoTouch;
    controlAfterTake(s, j, ev);
    return 1;
  }
  // Too fast to control: it hits his feet (only if it is coming at him) and deflects; the ball is loose.
  let nx = b.x - q.x, nz = b.z - q.z;
  let nl = Math.sqrt(nx * nx + nz * nz);
  if (nl < 1e-6) { nx = -rvx; nz = -rvz; nl = Math.sqrt(rel2); }
  nx /= nl; nz /= nl;
  const vn = rvx * nx + rvz * nz;
  if (vn >= 0) return 0;
  const tx = rvx - vn * nx, tz = rvz - vn * nz;
  const ox = tx * L.blockTangentKeep - vn * L.blockRestitution * nx;
  const oz = tz * L.blockTangentKeep - vn * L.blockRestitution * nz;
  b.vx = q.vx + ox;
  b.vz = q.vz + oz;
  if (b.vy > 0) b.vy = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  releasePossession(s, ev);
  recordTouch(s, j);
  if (o.noTouchT < T_DRIBBLE.dispossessedNoTouch) o.noTouchT = T_DRIBBLE.dispossessedNoTouch;
  ev.emit(EventType.KICK, j, KickKind.DEFLECTION, clamp01(Math.sqrt(rel2) / L.touchPowerRef), 0, b.x, b.y, b.z);
  return 1;
}

/** The owned (feet) ball: possession loss, then control (holds, touches, steals). */
function ownerTick(s: SimState, ev: EventSink): void {
  const b = s.ball;
  const o = b.owner;
  if (!(o < NUM_SLOTS)) { releasePossession(s, ev); return; }
  const p = s.players[o]!;
  if (p.active !== 1 || p.stunT > 0 || BALL_ACT[p.act] !== 1) { releasePossession(s, ev); return; }
  const dx = b.x - p.x, dz = b.z - p.z;
  const d2 = dx * dx + dz * dz;
  if (!(d2 <= LOSE2)) { releasePossession(s, ev); return; }
  if (ballTouchedThisTick(s)) return;
  const r = T_DRIBBLE.controlRadius + Math.sqrt(p.vx * p.vx + p.vz * p.vz) * L.reachLookahead;
  F[F_REACH] = r;
  const reach = d2 <= r * r && b.y <= CTRL_H;
  const act = p.act;
  if (act === ActionKind.KICK || act === ActionKind.SHOT) {
    if (p.actDone !== 0) return;
    if (!reach && stealTick(s, o, ev) === 1) return;
    holdKickSpot(s, o);
    return;
  }
  if (act === ActionKind.SKILL || act === ActionKind.FAKE) {
    if (p.actDone === 0 && p.actContact >= 0 && p.actT < p.actContact) holdKickSpot(s, o);
    return;
  }
  if (act !== ActionKind.NONE && act !== ActionKind.SHIELD && act !== ActionKind.FIRST_TOUCH) return;
  if (!reach && stealTick(s, o, ev) === 1) return;
  // [FEEL-1] Poke window: a human dribbler's shorter sprint touch stays inside his running reach, but while it is beyond
  // his controlRadius between touches (about a stride ahead) an opponent nearer to it can still poke it away (section 6:
  // "so it can be poked away between touches"; a CPU dribbler's longer touch runs out of his reach: stealTick).
  if (reach && d2 > CR2 && p.ctrl >= 0 && p.ctrl < CPU_CONTROLLER_BASE && pokeTick(s, o, ev) === 1) return;
  if (act === ActionKind.FIRST_TOUCH) return;
  if (reach && underTick(s, o, ev) === 1) return;
  if (act === ActionKind.SHIELD && shieldBallSpot(s, o, SPOT)) { HOLD[0] = SPOT.x; HOLD[1] = SPOT.z; holdOn(s, o); return; }
  if (reach) dribbleControl(s, o, ev);
}

/** Loose ball: pick-up by the nearest eligible player in reach, else the stuck-ball squirt. */
function looseTick(s: SimState, ev: EventSink): void {
  const b = s.ball;
  if (ballTouchedThisTick(s) || b.inNet !== 0 || !(b.y <= CTRL_H)) return;
  const hs2 = b.vx * b.vx + b.vz * b.vz;
  if (hs2 < L.pickUpMaxSpeed * L.pickUpMaxSpeed) {
    const j = nearestTaker(s, 0, NUM_SLOTS, -1);
    if (j >= 0) {
      takePossession(s, j, ev);
      controlAfterTake(s, j, ev);
      return;
    }
  }
  if (hs2 < L.stuckSpeed * L.stuckSpeed && b.idleT >= L.stuckTicks) squirt(s);
}

/** Squirt a stuck ball out from under / between bodies (see header, step 4). */
function squirt(s: SimState): void {
  const b = s.ball;
  let near = -1;
  let nearD2 = L.stuckRadius * L.stuckRadius;
  let sx = 0, sz = 0;
  const scan2 = L.squirtScan * L.squirtScan;
  for (let j = 0; j < NUM_SLOTS; j++) {
    const q = s.players[j]!;
    if (q.active !== 1) continue;
    const dx = b.x - q.x, dz = b.z - q.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > scan2) continue;
    if (d2 < nearD2 || (d2 === nearD2 && near < 0)) { near = j; nearD2 = d2; }
    const w = 1 / (d2 > 0.01 ? d2 : 0.01);
    sx += dx * w;
    sz += dz * w;
  }
  if (near < 0) return;
  let len = Math.sqrt(sx * sx + sz * sz);
  if (len < 1e-6) {
    const q = s.players[near]!;
    const dx = b.x - q.x, dz = b.z - q.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-6) { sx = -dz / d; sz = dx / d; } else {
      sx = q.fx; sz = q.fz;
      if (!(sx * sx + sz * sz > 1e-12)) { sx = s.teams[q.team]!.dir; sz = 0; }
    }
    len = Math.sqrt(sx * sx + sz * sz);
  }
  b.vx = sx / len * L.squirtSpeed;
  b.vz = sz / len * L.squirtSpeed;
  if (b.vy > 0) b.vy = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  recordTouch(s, near);
}

/** Countdowns (every tick, every phase): touchCd and noTouchT for every player; ownerT while owned. */
function countdowns(s: SimState): void {
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.touchCd = p.touchCd > 1 ? p.touchCd - 1 : 0;
    p.noTouchT = p.noTouchT > 1 ? p.noTouchT - 1 : 0;
  }
  const b = s.ball;
  if (b.owner >= 0) b.ownerT++;
}

export function dribbleTick(s: SimState, ev: EventSink): void {
  const b = s.ball;
  if (s.match.phase === MatchPhase.IN_PLAY) {
    if (b.heldBy >= 0) {
      // In a keeper's hands (GKP-05, which takes possession itself). Defensive: the holder is the owner, through
      // takePossession so the POSSESSION event and the touch bookkeeping stay right.
      if (b.owner !== b.heldBy && b.heldBy < NUM_SLOTS) takePossession(s, b.heldBy, ev);
    } else {
      if (b.owner >= 0) ownerTick(s, ev);
      if (b.owner < 0) looseTick(s, ev);
    }
  }
  countdowns(s);
}
