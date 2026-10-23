/**
 * [GKP-05] Keeper with the ball: pick-up into hands (only inside his own area; not from a deliberate pass from a
 * teammate's foot — isFootPassKind(ball.lastKickKind) && lastKickTeam === team), GK_HOLD carrying the ball
 * (positions the ball in his hands each tick), releases (throw, driven throw, roll, drop kick, driven kick, drop
 * at feet), the 6-second release rule (auto release for humans at T_GK.autoReleaseTicks), user control of throws
 * and kicks. Handlers GK_HOLD, GK_THROW, GK_KICK. Emits KEEPER_HANDS.
 *
 * HOW IT WORKS
 *  canHandle (pure): an active keeper, live phase (IN_PLAY / SHOOT_OUT / a restart already taken), nobody else owns
 *   or holds the ball, the ball inside his own penalty area (lines count: BALL_RADIUS slack, never wholly over the
 *   goal line) with the keeper's centre at most handleKeeperSlack outside it, and neither
 *    - back-pass rule: the last kick was a deliberate foot kick (isFootPassKind) by a teammate (or himself) and no
 *      player other than the kicker and the keeper has touched the ball since (each player's lastTouchTick), so a
 *      keeper who traps a back-pass with his feet still may not pick it up; nor
 *    - released this possession: the keeper's own last kick was a release from his hands or any other deliberate
 *      play (pass, clearance, skill / dribble touch), and nobody else has touched the ball since (saves — parry,
 *      punch, tip, deflection, tackle poke, first touch — do not count). So after a drop at his feet he can dribble
 *      or pass but never pick the ball up again until another player touches it (no 6-second reset).
 *  keeperPickUp: refuses unless canHandle and the ball is within pickUpReach; ends any other action, zeroes the ball,
 *   takePossession (POSSESSION when the team changes), heldBy = keeper, KEEPER_HANDS(1), GK_HOLD with actB = pickup
 *   tick and actDur = maxHoldTicks + 2 (the dispatcher can only end it after the hard limit).
 *  GK_HOLD (every tick): ends at once if the ball was taken out of his hands (rules / tackle); keeps the ball at
 *   holdHeight, holdAhead in front of him (one tick of his velocity ahead so it does not lag), clamped inside the
 *   area and in front of the goal line; caps his walk at holdWalkSpeed and keeps his centre inside the hold box
 *   (holdLineMargin from the goal line, holdEdgeMargin from the other area lines): outward intent and velocity are
 *   removed and a keeper outside the box is eased back in at holdRecoverSpeed. So he never carries the ball over his
 *   own line or out of the area. 6-second rule (IN_PLAY): at T_GK.autoReleaseTicks held (humans: auto release;
 *   AI: forced release if GKP-04 has not released yet) a default release goes to the nearest open teammate (roll
 *   when near, overarm throw, drop kick when nobody is within throw range); at T_GK.maxHoldTicks he drops it at his
 *   feet on the spot.
 *  startKeeperRelease: from GK_HOLD (ball in his hands) starts GK_THROW (GK_THROW, GK_DRIVEN_THROW, GK_ROLL,
 *   GK_RELEASE) or GK_KICK (GK_DROP_KICK, GK_DRIVEN_KICK); movement LOCKED, he turns toward the aim during the
 *   wind-up while the ball moves from his chest to the release point. A GK_THROW to a target nearer than
 *   throwRollBelow becomes a roll. Power charges while the resolver holds actCharging (a charge still running
 *   chargeCapTicks after the contact tick is ended here, in case its power-bar owner was lost).
 *  Contact (actT >= actContact, not charging; or the 6-second hard limit reached, which cuts a charge or wind-up
 *   short): the ball is placed at the release point and solveKeeperRelease's launch is applied through applyKick
 *   (KEEPER_HANDS(0) + KICK with the KickKind); he cannot regain it for releaseNoTouchTicks (p.noTouchT).
 *   GK_RELEASE drops the ball at his feet, gives him possession and ends the action that tick (he dribbles at once).
 *  solveKeeperRelease: receiver = actSlot, explicit point (actA = 1) or SIM-08 selectReceiver from the stick with a
 *   cone fallback, led by his velocity; then per kind
 *    GK_THROW        overarm from throwReleaseHeight at throwSpeedMin..Max (faster for longer throws and power),
 *                    elevation solved for the landing point (drag-exact speed via SIM-01 solveLaunchSpin, clamped);
 *    GK_DRIVEN_THROW the same with drivenThrowSpeedMin..Max: flatter and faster;
 *    GK_ROLL         along the ground at rollSpeedMin..Max (SIM-01 groundPassSpeed for the arrival speed);
 *    GK_DROP_KICK    lands clamp(d, dropKickMinDist, dropKickRangeMin..Max by power) away at dropKickAngle;
 *    GK_DRIVEN_KICK  lower (drivenKickAngle) and shorter band;
 *    GK_RELEASE      a gentle push at his feet.
 *   Horizontal (and for kicks distance) error from gkHandling / gkKicking and power (s.rng, fixed draw count).
 *
 * ACTION FIELDS
 *  GK_HOLD:          actB = pickup tick; actT = ticks held; actA = stick magnitude that gives holdWalkSpeed.
 *  GK_THROW/GK_KICK: actKick = KickKind; actPower = 0..1; actSlot = explicit receiver (-1 = choose at contact);
 *                    actA = 1 explicit target point (actX, actZ); actDirX/Z = unit aim; actX/actZ = aim point for the
 *                    wind-up turn; actB = pickup tick (6-second hard limit); actDone = 1 after the release.
 *
 * IMPORT CYCLE: actions/registry reads this module's handlers / solver while building its tables and this module
 * imports actions/dispatch (-> registry). The registry-facing exports are shells from handlingHooks.ts (no runtime
 * imports), re-exported FIRST below; the implementation is bound at the end of this file.
 */
// Re-export the handler shells FIRST (import-cycle safety with actions/registry; see handlingHooks.ts).
export { gkKickHandler, holdHandler, solveKeeperRelease, throwHandler } from './handlingHooks';
import { bindHandlingImpl } from './handlingHooks';
import {
  BALL_RADIUS, DT, HALF_LENGTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH,
} from '../../contracts/constants';
import { ActionKind, AssistLevel, KickKind, MatchPhase, isFootPassKind } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { MoveMode, type PlayerState, type SimState } from '../../contracts/state';
import { createActionRequest, createKickLaunch, type ActionRequest, type KickLaunch } from '../../contracts/systems';
import { RESTART_PHASES } from '../../contracts/transitions';
import { T_BALL, T_GK, T_PASS, T_GK_HANDLING } from '../../contracts/tuning';
import { beginAction, clearAction, endAction } from '../actions/dispatch';
import { createLaunchSolution, groundPassSpeed, solveLaunchSpin } from '../ball/flight';
import { applyKick, takePossession } from '../core/kick';
import { clamp, clamp01, datan, dcos, dsin, lerp } from '../core/dmath';
import { nearestDistOfTeam, otherTeam, teamEnd, teamStart } from '../core/query';
import { rngRange } from '../core/rng';
import { createV2, rotate2 } from '../core/vec';
import { selectReceiver } from '../kicks/pass';
import { clampToPitch } from '../pitch/geometry';
import { maxSpeed } from '../players/locomotion';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_GK_HANDLING. */
export const LOCAL_TUNING = T_GK_HANDLING;

const L = T_GK_HANDLING;

// ---------------------------------------------------------------- scratch (module level, reused; no per-tick allocation)

const LAUNCH = createKickLaunch();
const SOL = createLaunchSolution();
const REQ = createActionRequest();
const V = createV2();
/** Ball centre depth limit while in hands (the whole ball in front of the goal line), m. */
const BALL_MIN_DEPTH = BALL_RADIUS + L.ballLineMargin;
/** Release / hands point. */
const RP = { x: 0, y: 0, z: 0 };
/** Target point (clampToPitch output). */
const TP = { x: 0, z: 0 };
/** Resolved target of a release: receiver slot (-1 none) and point. */
const TGT = { slot: -1, x: 0, z: 0 };

// ---------------------------------------------------------------- small helpers

/** True for the KickKinds a keeper releases from his hands. */
export function isKeeperReleaseKind(k: KickKind): boolean {
  return (k >= KickKind.GK_THROW && k <= KickKind.GK_DRIVEN_KICK) || k === KickKind.GK_RELEASE;
}

function isKickKind(k: KickKind): boolean {
  return k === KickKind.GK_DROP_KICK || k === KickKind.GK_DRIVEN_KICK;
}

/** Wind-up ticks (= contact tick) of a keeper release kind. */
export function releaseWindupTicks(k: KickKind): number {
  switch (k) {
    case KickKind.GK_THROW: return L.throwWindup;
    case KickKind.GK_DRIVEN_THROW: return L.drivenThrowWindup;
    case KickKind.GK_ROLL: return L.rollWindup;
    case KickKind.GK_DROP_KICK: return L.dropKickWindup;
    case KickKind.GK_DRIVEN_KICK: return L.drivenKickWindup;
    default: return L.dropWindup;
  }
}

function releaseRecoveryTicks(k: KickKind): number {
  switch (k) {
    case KickKind.GK_THROW: return L.throwRecovery;
    case KickKind.GK_DRIVEN_THROW: return L.drivenThrowRecovery;
    case KickKind.GK_ROLL: return L.rollRecovery;
    case KickKind.GK_DROP_KICK: return L.dropKickRecovery;
    case KickKind.GK_DRIVEN_KICK: return L.drivenKickRecovery;
    default: return L.dropRecovery;
  }
}

/** Shortest carry of a kind (targets nearer than this are pushed out to it; throws/rolls: no minimum), m. */
function minDistOf(k: KickKind): number {
  if (k === KickKind.GK_DROP_KICK) return L.dropKickMinDist;
  if (k === KickKind.GK_DRIVEN_KICK) return L.drivenKickMinDist;
  return 0;
}

/** Longest carry of a kind at power 0..1, m. */
function maxDistOf(k: KickKind, power: number): number {
  switch (k) {
    case KickKind.GK_THROW: return L.throwMaxDist;
    case KickKind.GK_DRIVEN_THROW: return L.drivenThrowMaxDist;
    case KickKind.GK_ROLL: return L.rollMaxDist;
    case KickKind.GK_DROP_KICK: return lerp(L.dropKickRangeMin, L.dropKickRangeMax, clamp01(power));
    case KickKind.GK_DRIVEN_KICK: return lerp(L.drivenKickRangeMin, L.drivenKickRangeMax, clamp01(power));
    default: return 0;
  }
}

/** Distance a release of kind k at power aims for when there is no receiver, m. */
function wantDistOf(k: KickKind, power: number): number {
  if (isKickKind(k)) return maxDistOf(k, power);
  const hi = maxDistOf(k, 1);
  return lerp(hi * L.wantMinFrac, hi, clamp01(power));
}

/** Rough horizontal ball speed of a kind for lead estimates, m/s. */
function leadSpeedOf(k: KickKind): number {
  switch (k) {
    case KickKind.GK_THROW: return (L.throwSpeedMin + L.throwSpeedMax) * 0.5;
    case KickKind.GK_DRIVEN_THROW: return (L.drivenThrowSpeedMin + L.drivenThrowSpeedMax) * 0.5;
    case KickKind.GK_ROLL: return (L.rollSpeedMin + L.rollSpeedMax) * 0.5;
    default: return L.kickLeadSpeed;
  }
}

/** Depth of x from the goal line team (attack direction dir) defends: 0 on the line, + into the pitch. */
function depthOf(dir: number, x: number): number {
  return dir * x + HALF_LENGTH;
}

function xOfDepth(dir: number, u: number): number {
  return dir * (u - HALF_LENGTH);
}

/** Inside the area team (attack direction dir) defends, with slack m on every side (behind the line too). */
function inOwnArea(dir: number, x: number, z: number, slack: number): boolean {
  const u = depthOf(dir, x);
  return u >= -slack && u <= PENALTY_AREA_DEPTH + slack && z >= -PENALTY_AREA_HALF_WIDTH - slack &&
    z <= PENALTY_AREA_HALF_WIDTH + slack;
}

function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS && slot === Math.floor(slot);
}

function finite(v: number): boolean {
  return v - v === 0;
}

/** Ball contact phase is live (same rule as the GKP-02 contacts). */
function livePhase(s: SimState): boolean {
  const ph = s.match.phase;
  if (ph === MatchPhase.IN_PLAY || ph === MatchPhase.SHOOT_OUT) return true;
  for (let i = 0; i < RESTART_PHASES.length; i++) if (RESTART_PHASES[i] === ph) return s.match.restart.taken === 1;
  return false;
}

/** True when a player other than a and b has touched the ball after tick t. */
function touchedByOtherSince(s: SimState, a: number, b: number, t: number): boolean {
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === a || i === b) continue;
    if (s.players[i]!.lastTouchTick > t) return true;
  }
  return false;
}

/** Saves and accidental contacts by the keeper that do not stop him handling the ball afterwards. */
function isSaveContact(k: KickKind): boolean {
  return k === KickKind.NONE || k === KickKind.GK_PARRY || k === KickKind.GK_PUNCH || k === KickKind.GK_TIP ||
    k === KickKind.DEFLECTION || k === KickKind.TACKLE_POKE || k === KickKind.FIRST_TOUCH;
}

/**
 * Back-pass rule: the last kick was a deliberate foot kick by slot's team (a teammate or himself) and only the kicker
 * and the keeper have touched the ball since.
 */
export function isBackPassTainted(s: SimState, slot: number): boolean {
  const b = s.ball;
  const k = b.lastKickBy;
  if (!validSlot(k) || b.lastKickTeam !== s.players[slot]!.team || !isFootPassKind(b.lastKickKind)) return false;
  return !touchedByOtherSince(s, k, slot, b.lastKickTick);
}

/** The keeper released / played the ball himself and nobody else has touched it since (no second handling). */
export function releasedThisPossession(s: SimState, slot: number): boolean {
  const b = s.ball;
  if (b.lastKickBy !== slot || isSaveContact(b.lastKickKind)) return false;
  return !touchedByOtherSince(s, slot, slot, b.lastKickTick);
}

/** Ticks the ball has been in slot's hands (0 if he does not hold it). Pure. */
export function keeperHeldTicks(s: SimState, slot: number): number {
  if (!validSlot(slot) || s.ball.heldBy !== slot) return 0;
  const p = s.players[slot]!;
  if (p.act !== ActionKind.GK_HOLD && p.act !== ActionKind.GK_THROW && p.act !== ActionKind.GK_KICK) return 0;
  return s.tick - p.actB;
}

// ---------------------------------------------------------------- canHandle / pick-up

/** May slot handle the ball now (keeper, inside own area, back-pass rule)? Pure. */
export function canHandle(s: SimState, slot: number): boolean {
  if (!validSlot(slot)) return false;
  const p = s.players[slot]!;
  if (p.isKeeper !== 1 || p.active !== 1) return false;
  const b = s.ball;
  if (b.heldBy >= 0) return b.heldBy === slot;
  if (b.owner >= 0 && b.owner !== slot) return false;
  if (!livePhase(s)) return false;
  const dir = s.teams[p.team]!.dir;
  if (!inOwnArea(dir, b.x, b.z, BALL_RADIUS)) return false;
  if (!inOwnArea(dir, p.x, p.z, L.handleKeeperSlack)) return false;
  if (isBackPassTainted(s, slot)) return false;
  if (releasedThisPossession(s, slot)) return false;
  return true;
}

/** Take the ball into the keeper's hands (heldBy, owner) and start GK_HOLD. */
export function keeperPickUp(s: SimState, slot: number, ev: EventSink): void {
  if (!validSlot(slot)) return;
  const b = s.ball;
  if (b.heldBy >= 0) return;
  if (!canHandle(s, slot)) return;
  const p = s.players[slot]!;
  const dx = b.x - p.x, dz = b.z - p.z;
  if (dx * dx + dz * dz > L.pickUpReach * L.pickUpReach || b.y > L.pickUpMaxHeight) return;
  if (p.act !== ActionKind.NONE) endAction(s, slot, 1);
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  takePossession(s, slot, ev);
  b.heldBy = slot;
  b.owner = slot;
  b.inNet = 0;
  b.bounces = 0;
  b.shotBy = -1;
  ev.emit(EventType.KEEPER_HANDS, slot, 1, 0, 0, b.x, b.y, b.z);
  beginAction(p, ActionKind.GK_HOLD, T_GK.maxHoldTicks + 2, -1);
  p.actKick = KickKind.NONE;
  p.actPower = 0;
  p.actSlot = -1;
  const jog = maxSpeed(s, slot, false);
  p.actA = jog > 1e-6 ? clamp01(L.holdWalkSpeed / jog) : 0;
  p.actB = s.tick;
  p.actX = p.x; p.actZ = p.z;
  p.actDirX = 0; p.actDirZ = 0;
  p.actCurve = 0;
  p.moveMode = MoveMode.STOP;
  p.ix = 0; p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
  placeBallInHands(s, slot, -1, 0);
}

// ---------------------------------------------------------------- ball in hands / release point

/** Unit facing of p into V (falls back to his attack direction). */
function facingInto(s: SimState, p: Readonly<PlayerState>): void {
  const l = Math.sqrt(p.fx * p.fx + p.fz * p.fz);
  if (l > 1e-6 && finite(l)) { V.x = p.fx / l; V.z = p.fz / l; } else { V.x = s.teams[p.team]!.dir; V.z = 0; }
}

/** Clamp (RP.x, RP.z) inside team's own area, the whole ball in front of the goal line. */
function clampBallIntoArea(dir: number): void {
  let u = depthOf(dir, RP.x);
  if (!(u >= BALL_MIN_DEPTH)) u = BALL_MIN_DEPTH;
  else if (u > PENALTY_AREA_DEPTH) u = PENALTY_AREA_DEPTH;
  RP.x = xOfDepth(dir, u);
  if (!(RP.z >= -PENALTY_AREA_HALF_WIDTH)) RP.z = -PENALTY_AREA_HALF_WIDTH;
  else if (RP.z > PENALTY_AREA_HALF_WIDTH) RP.z = PENALTY_AREA_HALF_WIDTH;
}

function releaseAhead(k: KickKind): number {
  switch (k) {
    case KickKind.GK_THROW:
    case KickKind.GK_DRIVEN_THROW: return L.throwReleaseAhead;
    case KickKind.GK_ROLL: return L.rollReleaseAhead;
    case KickKind.GK_DROP_KICK:
    case KickKind.GK_DRIVEN_KICK: return L.dropKickAhead;
    default: return L.dropAhead;
  }
}

function releaseHeight(k: KickKind): number {
  switch (k) {
    case KickKind.GK_THROW: return L.throwReleaseHeight;
    case KickKind.GK_DRIVEN_THROW: return L.drivenThrowReleaseHeight;
    case KickKind.GK_DROP_KICK: return L.dropKickHeight;
    case KickKind.GK_DRIVEN_KICK: return L.drivenKickHeight;
    default: return BALL_RADIUS;
  }
}

/** Release point of kind k for keeper slot (in front of him, inside his area) into RP. Pure. */
export function keeperReleasePoint(s: SimState, slot: number, k: KickKind, out: { x: number; y: number; z: number }): void {
  const p = s.players[slot]!;
  facingInto(s, p);
  const a = releaseAhead(k);
  RP.x = p.x + V.x * a;
  RP.z = p.z + V.z * a;
  clampBallIntoArea(s.teams[p.team]!.dir);
  out.x = RP.x;
  out.y = releaseHeight(k);
  out.z = RP.z;
}

/**
 * Put the held ball in slot's hands: windT < 0 = the hold point; during a release wind-up windT = p.actT blends
 * toward the release point of p.actKick, reached at the contact tick. lead = 1 adds one tick of his velocity (called
 * before locomotion moves him, so the ball does not trail his hands). Velocity zero, inside his area, in front of the
 * goal line. (Integer arguments only: a double argument would be boxed on every call.)
 */
function placeBallInHands(s: SimState, slot: number, windT: number, lead: number): void {
  // Hot per-tick path: plain arithmetic only (no helper calls taking / returning doubles, which V8 may box).
  const p = s.players[slot]!;
  const b = s.ball;
  const dir = s.teams[p.team]!.dir;
  let fx = p.fx, fz = p.fz;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl > 1e-6 && fl - fl === 0) { fx /= fl; fz /= fl; } else { fx = dir; fz = 0; }
  let ahead: number = L.holdAhead;
  let y: number = L.holdHeight;
  if (windT > 0) {
    const k = p.actKick;
    const c = p.actContact > 0 ? p.actContact : 1;
    const t = windT >= c ? 1 : windT / c;
    const ra = releaseAhead(k);
    const rh = releaseHeight(k);
    ahead += (ra - ahead) * t;
    y += (rh - y) * t;
  }
  let x = p.x + lead * p.vx * DT + fx * ahead;
  let z = p.z + lead * p.vz * DT + fz * ahead;
  if (!(x - x === 0) || !(z - z === 0)) { x = p.x; z = p.z; }
  // Inside his area, the whole ball in front of the goal line.
  // (Math.min / max keep the values unboxed; x and z are finite here.)
  const u = Math.min(Math.max(dir * x + HALF_LENGTH, BALL_MIN_DEPTH), PENALTY_AREA_DEPTH);
  x = dir * (u - HALF_LENGTH);
  z = Math.min(Math.max(z, -PENALTY_AREA_HALF_WIDTH), PENALTY_AREA_HALF_WIDTH);
  b.x = x; b.y = y; b.z = z;
  b.px = x; b.py = y; b.pz = z;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = y > BALL_RADIUS + 1e-6 ? 0 : 1;
}

/** Let go of the ball without an event (handler end paths have no sink): it falls from where it is. */
function dropSilently(s: SimState, slot: number): void {
  const b = s.ball;
  if (b.heldBy !== slot) return;
  b.heldBy = -1;
  if (b.owner === slot) { b.owner = -1; b.ownerT = 0; }
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.grounded = b.y > BALL_RADIUS + 1e-6 ? 0 : 1;
}

// ---------------------------------------------------------------- movement while holding / releasing

/**
 * Keep the keeper inside the hold box: ease him back in when outside, remove outward velocity and (unless locked)
 * outward intent; cap his walking intent at holdWalkSpeed, no sprint.
 */
function restrictMovement(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const dir = s.teams[p.team]!.dir;
  const uMin = L.holdLineMargin;
  const uMax = PENALTY_AREA_DEPTH - L.holdEdgeMargin;
  const zMax = PENALTY_AREA_HALF_WIDTH - L.holdEdgeMargin;
  const step = L.holdRecoverSpeed * DT;
  // Hot per-tick path: plain arithmetic only (no helper calls taking / returning doubles, which V8 may box).
  // Position: ease back into the box.
  let u = dir * p.x + HALF_LENGTH;
  if (u < uMin) u = u + step < uMin ? u + step : uMin;
  else if (u > uMax) u = u - step > uMax ? u - step : uMax;
  let z = p.z;
  if (z > zMax) z = z - step > zMax ? z - step : zMax;
  else if (z < -zMax) z = z + step < -zMax ? z + step : -zMax;
  if (u - u === 0 && z - z === 0) { p.x = dir * (u - HALF_LENGTH); p.z = z; }
  // Velocity: nothing outward at (or beyond) a box edge; never step past it this tick.
  let vu = dir * p.vx;
  let vz = p.vz;
  if (u + vu * DT < uMin && vu < 0) vu = u > uMin ? (uMin - u) / DT : 0;
  else if (u + vu * DT > uMax && vu > 0) vu = u < uMax ? (uMax - u) / DT : 0;
  if (z + vz * DT > zMax && vz > 0) vz = z < zMax ? (zMax - z) / DT : 0;
  else if (z + vz * DT < -zMax && vz < 0) vz = z > -zMax ? (-zMax - z) / DT : 0;
  p.vx = dir * vu;
  p.vz = vz;
  if (p.moveMode === MoveMode.LOCKED) return;
  p.wantSprint = 0;
  const edge = L.holdEdgeEps;
  if (p.moveMode === MoveMode.DIRECT) {
    let iu = dir * p.ix;
    let iz = p.iz;
    if (u <= uMin + edge && iu < 0) iu = 0;
    else if (u >= uMax - edge && iu > 0) iu = 0;
    if (z >= zMax - edge && iz > 0) iz = 0;
    else if (z <= -zMax + edge && iz < 0) iz = 0;
    const m = Math.sqrt(iu * iu + iz * iz);
    // GK_HOLD actA = stick magnitude giving holdWalkSpeed (from his jog speed at the pick-up).
    const cap = p.act === ActionKind.GK_HOLD && p.actA > 0 && p.actA <= 1 ? p.actA : 0;
    if (m > cap && m > 0) { iu *= cap / m; iz *= cap / m; }
    p.ix = dir * iu;
    p.iz = iz;
  } else if (p.moveMode === MoveMode.ARRIVE) {
    let tu = dir * p.tgtX + HALF_LENGTH;
    let tz = p.tgtZ;
    if (!(tu - tu === 0) || !(tz - tz === 0)) { tu = u; tz = z; }
    if (tu < uMin) tu = uMin; else if (tu > uMax) tu = uMax;
    if (tz < -zMax) tz = -zMax; else if (tz > zMax) tz = zMax;
    p.tgtX = dir * (tu - HALF_LENGTH);
    p.tgtZ = tz;
    if (!(p.tgtSpeed <= L.holdWalkSpeed)) p.tgtSpeed = L.holdWalkSpeed;
  }
}

/** cos / sin of the per-tick release turn (releaseTurnRate * DT), computed once with deterministic trig. */
const TURN_C = dcos(L.releaseTurnRate * DT);
const TURN_S = dsin(L.releaseTurnRate * DT);

/**
 * Turn the keeper's facing toward (actX, actZ) by at most releaseTurnRate * DT (same result as vec.rotateToward2,
 * written out so the per-tick path makes no calls with double arguments).
 */
function turnToAim(p: PlayerState): void {
  let dx = p.actX - p.x, dz = p.actZ - p.z;
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (!(dl > 1e-3)) return;
  dx /= dl; dz /= dl;
  let fx = p.fx, fz = p.fz;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (!(fl > 1e-6) || !(fl - fl === 0)) { p.fx = dx; p.fz = dz; return; }
  fx /= fl; fz /= fl;
  if (fx * dx + fz * dz >= TURN_C) { p.fx = dx; p.fz = dz; return; }
  const sn = fx * dz - fz * dx >= 0 ? TURN_S : -TURN_S;
  const rx = fx * TURN_C - fz * sn;
  const rz = fx * sn + fz * TURN_C;
  const rl = Math.sqrt(rx * rx + rz * rz);
  p.fx = rx / rl;
  p.fz = rz / rl;
}

// ---------------------------------------------------------------- target selection

/** Openness of teammate q 0..1 from the nearest opponent's distance. */
function openness(s: SimState, q: Readonly<PlayerState>): number {
  return clamp01(nearestDistOfTeam(s, otherTeam(q.team), q.x, q.z) / L.openDist);
}

/**
 * Fallback receiver for a stick-aimed release when SIM-08 selectReceiver has none: teammates inside the pass cone
 * (T_PASS.coneHalfAngle) around (dirX, dirZ) within the kind's range, scored by angle, openness and how well their
 * distance matches the power-implied distance. -1 if none.
 */
function coneReceiver(s: SimState, slot: number, dirX: number, dirZ: number, k: KickKind, power: number): number {
  const p = s.players[slot]!;
  const range = maxDistOf(k, 1) * L.rangeSlack;
  const want = wantDistOf(k, power);
  const coneCos = dcos(T_PASS.coneHalfAngle);
  let best = -1;
  let bestScore = -1e18;
  const end = teamEnd(p.team);
  for (let i = teamStart(p.team); i < end; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1 || d > range) continue;
    const c = (dx * dirX + dz * dirZ) / d;
    if (c < coneCos) continue;
    const diff = d > want ? d - want : want - d;
    const score = c + T_PASS.opennessWeight * openness(s, q) - L.distanceWeight * diff / range;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** Teammate of slot (not himself, active) or -1. */
function teammateOrNone(s: SimState, slot: number, t: number): number {
  if (!validSlot(t) || t === slot) return -1;
  const q = s.players[t]!;
  return q.active === 1 && q.team === s.players[slot]!.team ? t : -1;
}

/** Aim of a stick-driven release: receiver (selectReceiver, cone fallback) or -1. */
function stickReceiver(s: SimState, slot: number, dirX: number, dirZ: number, k: KickKind, power: number): number {
  const p = s.players[slot]!;
  const assist = p.ctrl >= 0 && p.ctrl < s.ctrl.length ? s.ctrl[p.ctrl]!.assist : AssistLevel.ASSISTED;
  const lofted = k === KickKind.GK_ROLL ? 0 : 1;
  let r = teammateOrNone(s, slot, selectReceiver(s, slot, dirX, dirZ, power, assist, lofted));
  if (r < 0) r = coneReceiver(s, slot, dirX, dirZ, k, power);
  return r;
}

/**
 * Resolve the release target of slot's current action into TGT (receiver led by his velocity, explicit point, or
 * the power-implied distance along the aim), clamped inside the pitch.
 */
function resolveTarget(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const k = p.actKick;
  let r = teammateOrNone(s, slot, p.actSlot);
  let x: number;
  let z: number;
  if (r < 0 && p.actA === 1) {
    x = p.actX; z = p.actZ;
  } else {
    if (r < 0) r = stickReceiver(s, slot, p.actDirX, p.actDirZ, k, p.actPower);
    if (r >= 0) {
      const q = s.players[r]!;
      const dx = q.x - p.x, dz = q.z - p.z;
      let t = Math.sqrt(dx * dx + dz * dz) / leadSpeedOf(k);
      if (t > L.leadMaxTime) t = L.leadMaxTime;
      x = q.x + q.vx * t * L.receiverLead;
      z = q.z + q.vz * t * L.receiverLead;
    } else {
      const d = wantDistOf(k, p.actPower);
      x = p.x + p.actDirX * d;
      z = p.z + p.actDirZ * d;
    }
  }
  if (!finite(x) || !finite(z)) { x = p.x + s.teams[p.team]!.dir * 10; z = p.z; }
  clampToPitch(x, z, L.pitchMargin, TP);
  TGT.slot = r;
  TGT.x = TP.x;
  TGT.z = TP.z;
}

// ---------------------------------------------------------------- solver

/**
 * Low elevation (clamped to [throwAngleMin, throwAngleMax]) of a drag-free launch at speed v from h metres above the
 * landing height that lands d metres away: with T = tan(theta) and a = g d^2 / (2 v^2), a T^2 - d T + (a - h) = 0.
 * Out of reach -> throwAngleMax (close to the longest throw).
 */
function throwAngle(v: number, d: number, h: number): number {
  if (!(d > 0) || !(v > 0)) return L.throwAngleMin;
  const a = T_BALL.gravity * d * d / (2 * v * v);
  const disc = d * d - 4 * a * (a - h);
  if (!(disc >= 0)) return L.throwAngleMax;
  const th = datan((d - Math.sqrt(disc)) / (2 * a));
  return th < L.throwAngleMin ? L.throwAngleMin : th > L.throwAngleMax ? L.throwAngleMax : th;
}

/** Scale out's velocity to a speed inside [lo, hi]. */
function clampSpeed(out: KickLaunch, lo: number, hi: number): void {
  const sp = Math.sqrt(out.vx * out.vx + out.vy * out.vy + out.vz * out.vz);
  if (!(sp > 1e-9)) return;
  const t = sp < lo ? lo / sp : sp > hi ? hi / sp : 1;
  out.vx *= t; out.vy *= t; out.vz *= t;
}

/** KickSolver for keeper releases (exported as solveKeeperRelease through the handlingHooks shell). */
function solveRelease(s: SimState, slot: number, out: KickLaunch): number {
  if (!validSlot(slot)) return 0;
  const p = s.players[slot]!;
  const k = p.actKick;
  if (!isKeeperReleaseKind(k)) return 0;
  keeperReleasePoint(s, slot, k, RP);
  const x0 = RP.x, y0 = RP.y, z0 = RP.z;
  out.sx = 0; out.sy = 0; out.sz = 0;
  out.kind = k;
  out.onTarget = 0;
  if (k === KickKind.GK_RELEASE) {
    facingInto(s, p);
    out.vx = p.vx + V.x * L.dropPushSpeed;
    out.vy = 0;
    out.vz = p.vz + V.z * L.dropPushSpeed;
    out.target = -1;
    out.tx = x0; out.tz = z0;
    return finite(out.vx) && finite(out.vz) ? 1 : 0;
  }
  resolveTarget(s, slot);
  let dx = TGT.x - x0, dz = TGT.z - z0;
  let d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-3) {
    facingInto(s, p);
    dx = V.x; dz = V.z; d = 1;
  }
  let ux = dx / d, uz = dz / d;
  // Error (always two draws).
  const power = clamp01(p.actPower);
  const kick = isKickKind(k);
  const a = s.attrs[slot]!;
  const q = clamp01(((kick ? a.gkKicking : a.gkHandling) - 1) / 98);
  let pm = 1;
  if (power > L.errPowerKnee) pm = 1 + (L.errPowerMul - 1) * (power - L.errPowerKnee) / (1 - L.errPowerKnee);
  const angErr = (kick ? lerp(L.kickErrWorst, L.kickErrBest, q) : lerp(L.throwErrWorst, L.throwErrBest, q)) * pm;
  const distErr = kick ? lerp(L.kickDistErrWorst, L.kickDistErrBest, q) * pm : 0;
  const ea = rngRange(s.rng, -angErr, angErr);
  const ed = rngRange(s.rng, -1, 1) * distErr;
  rotate2(V, ux, uz, ea);
  ux = V.x; uz = V.z;
  // Carry along the aim.
  let carry = d;
  const lo = minDistOf(k);
  const hi = maxDistOf(k, power);
  if (carry < lo) carry = lo;
  if (carry > hi) carry = hi;
  carry *= 1 + ed;
  out.target = TGT.slot;
  out.tx = x0 + ux * carry;
  out.tz = z0 + uz * carry;
  if (k === KickKind.GK_ROLL) {
    const arrive = lerp(L.rollArriveMin, L.rollArriveMax, power);
    const v = clamp(groundPassSpeed(carry, arrive), L.rollSpeedMin, L.rollSpeedMax);
    out.vx = ux * v; out.vy = 0; out.vz = uz * v;
    return 1;
  }
  if (kick) {
    const ang = k === KickKind.GK_DROP_KICK ? L.dropKickAngle : L.drivenKickAngle;
    solveLaunchSpin(ux * carry, uz * carry, ang, y0, 0, 0, SOL);
  } else {
    const driven = k === KickKind.GK_DRIVEN_THROW;
    const vMin = driven ? L.drivenThrowSpeedMin : L.throwSpeedMin;
    const vMax = driven ? L.drivenThrowSpeedMax : L.throwSpeedMax;
    const ref = driven ? L.drivenThrowRefDist : L.throwRefDist;
    const mix = clamp01((1 - L.throwPowerShare) * carry / ref + L.throwPowerShare * power);
    const vt = lerp(vMin, vMax, mix);
    const th = throwAngle(vt, carry * (1 + L.throwDragComp * carry), y0 - BALL_RADIUS);
    solveLaunchSpin(ux * carry, uz * carry, th, y0, 0, 0, SOL);
    out.vx = SOL.vx; out.vy = SOL.vy; out.vz = SOL.vz;
    clampSpeed(out, vMin, vMax);
    return finite(out.vx) && finite(out.vy) && finite(out.vz) ? 1 : 0;
  }
  out.vx = SOL.vx; out.vy = SOL.vy; out.vz = SOL.vz;
  return finite(out.vx) && finite(out.vy) && finite(out.vz) && SOL.speed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------- release start / contact

/** Start a release of the given KickKind (GK_THROW, GK_DRIVEN_THROW, GK_ROLL, GK_DROP_KICK, GK_DRIVEN_KICK, GK_RELEASE = drop at feet). */
export function startKeeperRelease(s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  if (!validSlot(slot) || !isKeeperReleaseKind(kind)) return 0;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.isKeeper !== 1 || p.stunT > 0) return 0;
  if (s.ball.heldBy !== slot) return 0;
  if (p.act !== ActionKind.NONE && p.act !== ActionKind.GK_HOLD) return 0;
  const pickup = p.act === ActionKind.GK_HOLD ? p.actB : s.tick;
  // Aim: stick / request direction, else facing.
  let dx = finite(req.dirX) ? req.dirX : 0;
  let dz = finite(req.dirZ) ? req.dirZ : 0;
  let m = Math.sqrt(dx * dx + dz * dz);
  if (!(m > 1e-6)) { facingInto(s, p); dx = V.x; dz = V.z; m = 1; }
  dx /= m; dz /= m;
  const power = finite(req.power) ? clamp01(req.power) : 0;
  const target = teammateOrNone(s, slot, req.targetSlot);
  const explicitPoint = target < 0 && req.hasTarget === 1 && finite(req.targetX) && finite(req.targetZ) ? 1 : 0;
  let k = kind;
  // Aim point for the wind-up turn (the receiver is resolved again at contact).
  let ax: number;
  let az: number;
  let est = -1;
  if (target >= 0) {
    ax = s.players[target]!.x; az = s.players[target]!.z;
  } else if (explicitPoint === 1) {
    clampToPitch(req.targetX, req.targetZ, L.pitchMargin, TP);
    ax = TP.x; az = TP.z;
  } else {
    est = k === KickKind.GK_RELEASE ? -1 : stickReceiver(s, slot, dx, dz, k, power);
    if (est >= 0) { ax = s.players[est]!.x; az = s.players[est]!.z; } else {
      const d = k === KickKind.GK_RELEASE ? 1 : wantDistOf(k, power);
      ax = p.x + dx * d; az = p.z + dz * d;
    }
  }
  if (k === KickKind.GK_THROW && (target >= 0 || explicitPoint === 1 || est >= 0)) {
    const ex = ax - p.x, ez = az - p.z;
    if (ex * ex + ez * ez < L.throwRollBelow * L.throwRollBelow) k = KickKind.GK_ROLL;
  }
  const act = isKickKind(k) ? ActionKind.GK_KICK : ActionKind.GK_THROW;
  const windup = releaseWindupTicks(k);
  beginAction(p, act, windup + 1 + releaseRecoveryTicks(k), windup);
  p.actKick = k;
  p.actPower = power;
  p.actCharging = 0;
  p.actSlot = target;
  p.actA = explicitPoint;
  p.actB = pickup;
  p.actX = ax; p.actZ = az;
  p.actDirX = dx; p.actDirZ = dz;
  p.actCurve = 0;
  p.moveMode = MoveMode.LOCKED;
  p.ix = 0; p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
  return 1;
}

/** Contact: put the ball at the release point and launch it (KEEPER_HANDS(0) + KICK via applyKick). */
function release(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const b = s.ball;
  const k = p.actKick;
  p.actCharging = 0;
  p.actDone = 1;
  const rec = releaseRecoveryTicks(k);
  if (p.actDur < p.actT + rec) p.actDur = p.actT + rec;
  keeperReleasePoint(s, slot, k, RP);
  b.x = RP.x; b.y = RP.y; b.z = RP.z;
  b.px = RP.x; b.py = RP.y; b.pz = RP.z;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = RP.y > BALL_RADIUS + 1e-6 ? 0 : 1;
  if (solveRelease(s, slot, LAUNCH) !== 1) {
    // Never keep the ball: fall back to a drop at his feet.
    p.actKick = KickKind.GK_RELEASE;
    keeperReleasePoint(s, slot, KickKind.GK_RELEASE, RP);
    b.x = RP.x; b.y = RP.y; b.z = RP.z;
    b.px = RP.x; b.py = RP.y; b.pz = RP.z;
    b.grounded = 1;
    if (solveRelease(s, slot, LAUNCH) !== 1) {
      LAUNCH.vx = 0; LAUNCH.vy = 0; LAUNCH.vz = 0;
      LAUNCH.kind = KickKind.GK_RELEASE; LAUNCH.target = -1; LAUNCH.tx = RP.x; LAUNCH.tz = RP.z;
    }
  }
  applyKick(s, slot, LAUNCH, clamp01(p.actPower), ev);
  if (LAUNCH.kind === KickKind.GK_RELEASE) {
    // Dropped at his feet: his ball, and the action ends this tick (the dispatcher ends it after this update).
    takePossession(s, slot, ev);
    p.actDur = p.actT;
  } else if (p.noTouchT < L.releaseNoTouchTicks) {
    p.noTouchT = L.releaseNoTouchTicks;
  }
}

/**
 * Immediate drop at his feet (6-second hard limit while still in GK_HOLD). Called from the GK_HOLD update: the hold is
 * replaced by a GK_THROW drop that is released at once and then cleared, so he is free (owner, no action) right away.
 */
function forceDrop(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  const pickup = p.actB;
  beginAction(p, ActionKind.GK_THROW, releaseRecoveryTicks(KickKind.GK_RELEASE) + 1, 0);
  p.actKick = KickKind.GK_RELEASE;
  p.actPower = 0;
  p.actSlot = -1;
  p.actA = 0;
  p.actB = pickup;
  p.actDirX = 0; p.actDirZ = 0;
  p.moveMode = MoveMode.LOCKED;
  p.ix = 0; p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
  release(s, slot, ev);
  clearAction(p);
}

/**
 * Default release for the 6-second rule: the nearest open teammate (no opponent within autoOpenRadius; else the
 * least pressed), rolled when near, thrown within throw range, else a drop kick upfield. Returns 1 if started.
 */
export function keeperAutoRelease(s: SimState, slot: number, ev: EventSink): number {
  const p = s.players[slot]!;
  const opp = otherTeam(p.team);
  let best = -1;
  let bestKey = 1e18;
  const end = teamEnd(p.team);
  for (let i = teamStart(p.team); i < end; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > L.autoMaxDist) continue;
    const near = nearestDistOfTeam(s, opp, q.x, q.z);
    // Open teammates first (by distance), then the least pressed.
    const key = near >= L.autoOpenRadius ? d : 1e6 - near;
    if (key < bestKey) { bestKey = key; best = i; }
  }
  const r = REQ;
  r.power = L.autoPower; r.charging = 0; r.curve = 0; r.assist = AssistLevel.ASSISTED; r.flags = 0;
  r.hasTarget = 0; r.targetX = 0; r.targetZ = 0; r.targetSlot = best;
  let kind: KickKind = KickKind.GK_DROP_KICK;
  if (best >= 0) {
    const q = s.players[best]!;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    r.dirX = d > 1e-6 ? dx / d : s.teams[p.team]!.dir;
    r.dirZ = d > 1e-6 ? dz / d : 0;
    kind = d < L.autoRollBelow ? KickKind.GK_ROLL : d <= L.throwMaxDist ? KickKind.GK_THROW : KickKind.GK_DROP_KICK;
  } else {
    r.targetSlot = -1;
    r.dirX = s.teams[p.team]!.dir;
    r.dirZ = 0;
  }
  return startKeeperRelease(s, slot, kind, r, ev);
}

// ---------------------------------------------------------------- handlers

function settle(p: PlayerState): void {
  p.ix = 0; p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 0;
  if (p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
}

/** GK_HOLD update: ball in hands, slow walk inside the hold box, 6-second rule. */
function holdUpdate(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  if (s.ball.heldBy !== slot) { p.actDur = p.actT; return; }
  if (s.match.phase === MatchPhase.IN_PLAY) {
    const held = s.tick - p.actB;
    if (held >= T_GK.maxHoldTicks) { forceDrop(s, slot, ev); return; }
    // Humans: automatic release; AI: forced release if GKP-04 has not released yet (same deadline).
    if (held >= T_GK.autoReleaseTicks && keeperAutoRelease(s, slot, ev) === 1) {
      windupTick(s, slot);
      return;
    }
  }
  restrictMovement(s, slot);
  placeBallInHands(s, slot, -1, 1);
}

/** GK_HOLD end: an interrupted hold lets the ball drop (no event: handler ends have no sink). */
function holdEnd(s: SimState, slot: number, interrupted: number): void {
  dropSilently(s, slot);
  settle(s.players[slot]!);
}

/** Per-tick work of a release action before contact (also run on its first tick). */
function windupTick(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  restrictMovement(s, slot);
  turnToAim(p);
  placeBallInHands(s, slot, p.actT, 1);
}

function releaseUpdate(s: SimState, slot: number, ev: EventSink): void {
  const p = s.players[slot]!;
  if (p.actDone === 1) return;
  if (s.ball.heldBy !== slot) { p.actCharging = 0; p.actDur = p.actT; return; }
  p.moveMode = MoveMode.LOCKED;
  p.ix = 0; p.iz = 0;
  p.wantSprint = 0;
  if (p.actCharging === 1 && p.actT >= p.actContact + L.chargeCapTicks) p.actCharging = 0;
  const limit = s.tick - p.actB >= T_GK.maxHoldTicks;
  if (limit || (p.actT >= p.actContact && p.actCharging === 0)) {
    release(s, slot, ev);
    return;
  }
  windupTick(s, slot);
}

function releaseEnd(s: SimState, slot: number, interrupted: number): void {
  dropSilently(s, slot);
  settle(s.players[slot]!);
}

// GK_THROW (throw, driven throw, roll, drop at feet) and GK_KICK (drop kick, driven kick) share releaseUpdate/End.
bindHandlingImpl({ holdUpdate, holdEnd, releaseUpdate, releaseEnd, solve: solveRelease });
