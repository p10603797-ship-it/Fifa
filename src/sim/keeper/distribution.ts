/**
 * [GKP-04] Distribution AI for keepers not controlled by a human: throw, roll, drop kick, driven kick, and a
 * quick release when a counter-attack is on. Picks targets with SIM-08 selectReceiver / TAI-09 scoring and
 * starts releases through GKP-05 startKeeperRelease. Releases well within 6 s.
 *
 * HOW IT WORKS (called by keeper/index.ts keeperTick, IN_PLAY, for a keeper holding the ball whom no human drives)
 *  Stateless: every decision is recomputed from SimState each tick (nothing persists in this module, so clones,
 *  replays and lockstep peers agree). The only per-possession "randomness" is a hash of (config seed, pickup tick,
 *  slot) — no s.rng draws, so the RNG stream is untouched while he holds the ball.
 *  1. Wait (the team spreads; TAI handles that): waitMin..waitMax ticks (0.9..1.6 s) by the hash jitter, or
 *     counterWaitMin..Max (0.5..0.75 s) when a counter-attack is on (isCounterOn: TAI-06 team phase
 *     TRANSITION_ATTACK, or the opponents have at most counterRestMax outfield players in their own half and one of
 *     our players up the pitch is free).
 *  2. Evaluate (after the wait, every evalInterval ticks; always at the deadline) every active teammate between
 *     minTargetDist and maxTargetDist m who is not stunned and not in an offside position at the release contact
 *     (offside on): kind by distance (roll <= rollMaxUse, overarm throw <= throwMaxUse — driven throw from
 *     drivenThrowMinUse for midfielders and on a counter — driven throw <= drivenThrowMaxUse, driven kick
 *     <= drivenKickMaxUse, else drop kick); class SHORT (roll / throw), MID (driven throw) or LONG (kicks).
 *     Safety 0..1: TAI-09 laneSafety when it is available (any candidate > 0), else the own model: reception
 *     (opponent time to the reception point vs the ball's flight, and his distance from it; LONG balls: the space
 *     around the receiver only) and, for rolls, the lane (opponent time to the closest lane point vs the ball).
 *     Score = wSafety * safety + wProgress * progress (x counterProgressMul on a counter) + style bias (TeamStyle)
 *     + high-press bias (isPressHigh: >= pressHighCount opponents within pressZoneDepth of our goal line) + counter
 *     bias + wing-play width bonus + a small per-possession decision noise (CPU level x noiseScale).
 *  3. Decide: release the best ACCEPTABLE option (safety >= its class minimum); a LONG option only when the press
 *     is high, the style is DIRECT, a counter is on, or after patienceTicks (otherwise the best acceptable short /
 *     mid option, or keep waiting so the team can spread). At deadlineTicks (2.5 s) he always releases: the best
 *     acceptable option, else the best long ball, else the best of anything, else an untargeted drop kick upfield.
 *  4. startKeeperRelease(kind, request with the receiver as targetSlot, aim toward his led position, power for the
 *     distance). GKP-05 resolves the receiver again at contact and leads him. If a start fails (stunned) it is
 *     retried next tick; GKP-05's forced release at T_GK.autoReleaseTicks and drop at T_GK.maxHoldTicks remain the
 *     backstop, so the ball is never held for 6 s (glitch "Keeper: holds the ball forever").
 * Determinism / cost: slot-order loops, plain arithmetic (Math.sqrt / Math.imul only), module scratch typed arrays,
 * no allocation per tick; O(10 x 11) per evaluation, one evaluation per evalInterval ticks per holding keeper.
 */
import { DT, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM } from '../../contracts/constants';
import { ActionKind, AssistLevel, Difficulty, KickKind, MatchPhase, Role, TeamPhase, TeamStyle } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import { createActionRequest } from '../../contracts/systems';
import { T_LEVEL } from '../../contracts/tuning';
import { laneSafety } from '../../ai/cpu/passing';
import { isHumanSlot, nearestDistOfTeam, otherTeam, secondLastDefenderX, teamEnd, teamStart } from '../core/query';
import { maxSpeed } from '../players/locomotion';
// Only the GKP-05 contract export (tests replace keeper/handling with contract doubles that have nothing else).
import { startKeeperRelease } from './handling';

export const LOCAL_TUNING = { // TUNING-CR (GKP-04): move into T_GK as distribution*
  // ---- timing, ticks at 60 Hz
  /** Normal wait before the first release decision (0.9..1.6 s, per-possession jitter), ticks. */
  waitMinTicks: 54,
  waitMaxTicks: 96,
  /** Wait when a counter-attack is on (0.5..0.75 s), ticks. */
  counterWaitMinTicks: 30,
  counterWaitMaxTicks: 45,
  /** A long ball without press / direct style / counter only after this hold time (2.0 s), ticks. */
  patienceTicks: 120,
  /** He always releases at this hold time (2.5 s; GKP-05's forced release is at T_GK.autoReleaseTicks), ticks. */
  deadlineTicks: 150,
  /** Options are re-evaluated every this many ticks after the wait, ticks. */
  evalInterval: 4,
  // ---- situation
  /** Counter-attack also when the opponents have at most this many outfield players in their own half ... */
  counterRestMax: 2,
  /** ... and a teammate is a free outlet: at least this far up the pitch (team frame x, 0 = halfway), m ... */
  counterOutletX: -10,
  /** ... with no opponent within this distance, m. */
  counterOutletSpace: 8,
  /** Opponent outfield players within this depth of our goal line count as pressing, m. */
  pressZoneDepth: 32,
  /** High press: at least this many pressing opponents. */
  pressHighCount: 4,
  // ---- candidates
  /** Teammates nearer than this (m) are not targets. */
  minTargetDist: 7,
  /** Teammates further than this (m) are not targets. */
  maxTargetDist: 64,
  /** Kind by distance, m: roll up to rollMaxUse, overarm throw up to throwMaxUse (driven throw from
   *  drivenThrowMinUse for midfielders / on a counter), driven throw up to drivenThrowMaxUse, driven kick up to
   *  drivenKickMaxUse, drop kick beyond. */
  rollMaxUse: 18,
  throwMaxUse: 34,
  drivenThrowMinUse: 20,
  drivenThrowMaxUse: 42,
  drivenKickMaxUse: 50,
  /** Offside: skip receivers within this distance behind the offside line at the release contact, m. */
  offsideSafety: 0.5,
  /** Offside: receivers are judged where they will be after this many ticks (>= GKP-05's longest release wind-up,
   *  the drop kick's 22 ticks). */
  offsideLookAheadTicks: 22,
  /** Receiver lead used for the aim / evaluation: fraction of his velocity x flight time, capped at leadMaxTime s. */
  leadFrac: 0.8,
  leadMaxTime: 2,
  /** Aim points stay this far inside the pitch lines, m. */
  pitchMargin: 1,
  // ---- powers 0..1
  rollPower: 0.4,
  throwPower: 0.5,
  drivenThrowPower: 0.6,
  /** Throws on a counter (faster). */
  counterThrowPower: 0.75,
  /** Kicks: the power whose carry band reaches the target (+ kickPowerMargin), at least kickPowerMin. */
  kickPowerMin: 0.3,
  kickPowerMargin: 0.05,
  /** Carry band (first landing) at power 0 / 1 of GKP-05's drop kick and driven kick (mirrors its
   *  dropKickRangeMin/Max and drivenKickRangeMin/Max; a GKP-04 test keeps them equal), m. */
  dropKickCarryMin: 50,
  dropKickCarryMax: 60,
  drivenKickCarryMin: 40,
  drivenKickCarryMax: 50,
  /** Untargeted drop kick upfield (deadline with nobody to aim at). */
  blindKickPower: 0.6,
  // ---- own safety model (used while TAI-09 laneSafety is unavailable)
  /** Average horizontal ball speed by kind for timing, m/s. */
  rollSpeed: 10,
  throwSpeed: 15,
  drivenThrowSpeed: 19,
  kickSpeed: 17,
  /** Opponent reaction before moving to intercept, s. */
  reactTime: 0.25,
  /** Opponent reach for a lane interception / at the reception point, m. */
  laneReach: 1.0,
  endReach: 1.5,
  /** Lane (rolls): safety = (opponent time - ball time + pathSlack) / pathWindow, s. */
  pathSlack: 0.1,
  pathWindow: 0.5,
  /** Reception: safety = (opponent time - ball time + endSlack) / endWindow (the receiver is already there), s. */
  endSlack: 1.0,
  endWindow: 0.8,
  /** Reception: space term (distance of the nearest opponent from the reception point - min) / range, m. */
  spaceMin: 2,
  spaceRange: 8,
  /** LONG balls: safety = (space - longSpaceMin) / longSpaceRange only (always a duel), m. */
  longSpaceMin: 1.5,
  longSpaceRange: 8,
  // ---- scoring
  wSafety: 1.0,
  wProgress: 0.6,
  /** Progress (m toward the opposition goal) that counts 1. */
  progressRef: 60,
  /** Progress weight multiplier on a counter. */
  counterProgressMul: 2,
  /** Acceptable safety per class (normal / on a counter). */
  minSafetyShort: 0.6,
  minSafetyMid: 0.55,
  minSafetyLong: 0.2,
  counterMinSafety: 0.45,
  /** Class biases per TeamStyle (POSSESSION, COUNTER, DIRECT, HIGH_PRESS, WING_PLAY). */
  styleShort: [0.35, 0, -0.25, 0.1, 0.15] as readonly number[],
  styleMid: [0.05, 0.1, 0, 0.1, 0.05] as readonly number[],
  styleLong: [-0.3, 0, 0.35, -0.1, -0.1] as readonly number[],
  /** Wing play: bonus for a short / mid target at least this wide (|z|), m. */
  wingWideZ: 15,
  wingBonus: 0.15,
  /** High press class biases. */
  pressShort: -0.4,
  pressMid: -0.1,
  pressLong: 0.4,
  /** Counter class biases. */
  counterMid: 0.15,
  counterLong: 0.1,
  /** Decision noise amplitude = T_LEVEL.decisionNoise[level] x noiseScale (CPU teams; others use PROFESSIONAL). */
  noiseScale: 0.25,
} as const;
const L = LOCAL_TUNING;
/** offsideLookAheadTicks in seconds. */
const OFFSIDE_LOOKAHEAD_S = L.offsideLookAheadTicks * DT;

/** Option class: SHORT (roll, throw to a defender), MID (driven throw), LONG (drop kick / driven kick). */
export enum DistClass {
  NONE = 0,
  SHORT = 1,
  MID = 2,
  LONG = 3,
}

/** Result of planDistribution (module scratch or a caller-provided object; plain numbers). */
export interface DistributionPlan {
  /** 1 = release now with this plan; 0 = keep holding. */
  release: number;
  /** Receiver slot, -1 = untargeted. */
  slot: number;
  kind: KickKind;
  /** 0..1 */
  power: number;
  /** Unit aim toward the receiver's led position (or upfield). */
  dirX: number;
  dirZ: number;
  cls: DistClass;
  /** Safety 0..1 and score of the chosen option. */
  safety: number;
  score: number;
  /** Situation flags (0/1) and the wait in ticks used for this possession. */
  counter: number;
  press: number;
  wait: number;
  /** Ticks the ball has been held. */
  held: number;
}

export function createDistributionPlan(): DistributionPlan {
  return {
    release: 0, slot: -1, kind: KickKind.NONE, power: 0, dirX: 0, dirZ: 0, cls: DistClass.NONE, safety: 0, score: 0,
    counter: 0, press: 0, wait: 0, held: 0,
  };
}

function resetPlan(o: DistributionPlan): void {
  o.release = 0; o.slot = -1; o.kind = KickKind.NONE; o.power = 0; o.dirX = 0; o.dirZ = 0; o.cls = DistClass.NONE;
  o.safety = 0; o.score = 0; o.counter = 0; o.press = 0; o.wait = 0; o.held = 0;
}

// ---------------------------------------------------------------- scratch (module level, rewritten before every use)

const N = PLAYERS_PER_TEAM;
const C_SLOT = new Int32Array(N);
const C_KIND = new Int32Array(N);
const C_CLS = new Int32Array(N);
const C_D = new Float64Array(N);
const C_TX = new Float64Array(N);
const C_TZ = new Float64Array(N);
const C_OWN = new Float64Array(N);
const C_TAI = new Float64Array(N);
/** Opponents' sprint speed (m/s, by slot), filled once per evaluation by fillOppSpeeds. */
const OPP_V = new Float64Array(NUM_SLOTS);
const PLAN = createDistributionPlan();
const REQ = createActionRequest();

// ---------------------------------------------------------------- small helpers

/**
 * Doubles passed between the internal helpers (written here, so no boxed double crosses a call that V8 does not
 * inline: a double argument or return value would be allocated as a heap number on every call).
 */
const RES = new Float64Array(7);
const RES_POWER = 0;
const RES_SAFETY = 1;
const RES_D = 2;
/** Segment of a safety query: from (X0, Z0) to (TX, TZ). */
const RES_X0 = 3;
const RES_Z0 = 4;
const RES_TX = 5;
const RES_TZ = 6;

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function finite(v: number): boolean { return v - v === 0; }

/** 2^-30: scales hash30 to [0, 1). */
const HASH_SCALE = 1 / 1073741824;

/**
 * Deterministic hash of three integers to 0..2^30-1 (integer ops only; no RNG draw). Returns a small integer (no
 * boxed double crosses the call), callers scale it by HASH_SCALE.
 */
function hash30(a: number, b: number, c: number): number {
  let h = (a | 0) ^ 0x2c1b3c6d;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = (h + Math.imul(b | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h + Math.imul(c | 0, 0x27d4eb2f)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= h >>> 15;
  return h >>> 2;
}

/** Deterministic hash of three integers to [0, 1) (integer ops only; no RNG draw). */
export function distributionHash01(a: number, b: number, c: number): number {
  return hash30(a, b, c) * HASH_SCALE;
}

function isMidfieldRole(r: Role): boolean {
  return r === Role.CDM || r === Role.CM || r === Role.CAM || r === Role.RM || r === Role.LM;
}

function classOf(k: KickKind): DistClass {
  if (k === KickKind.GK_ROLL || k === KickKind.GK_THROW) return DistClass.SHORT;
  if (k === KickKind.GK_DRIVEN_THROW) return DistClass.MID;
  if (k === KickKind.GK_DROP_KICK || k === KickKind.GK_DRIVEN_KICK) return DistClass.LONG;
  return DistClass.NONE;
}

/** Release kind for a receiver d metres away (KickKind.NONE = not a target). */
export function distributionKindFor(d: number, midfielder: boolean, counter: boolean): KickKind {
  RES[RES_D] = d;
  return kindForResD(midfielder, counter);
}

/** distributionKindFor with d read from RES[RES_D] (no double argument crosses the call). */
function kindForResD(midfielder: boolean, counter: boolean): KickKind {
  const d = RES[RES_D]!;
  if (!(d >= L.minTargetDist) || d > L.maxTargetDist) return KickKind.NONE;
  if (d <= L.rollMaxUse) return KickKind.GK_ROLL;
  if (d <= L.throwMaxUse) return (midfielder || counter) && d >= L.drivenThrowMinUse ? KickKind.GK_DRIVEN_THROW : KickKind.GK_THROW;
  if (d <= L.drivenThrowMaxUse) return KickKind.GK_DRIVEN_THROW;
  if (d <= L.drivenKickMaxUse) return KickKind.GK_DRIVEN_KICK;
  return KickKind.GK_DROP_KICK;
}

/** Average horizontal ball speed of a kind (timing model), m/s. */
function speedOf(k: KickKind): number {
  switch (k) {
    case KickKind.GK_ROLL: return L.rollSpeed;
    case KickKind.GK_THROW: return L.throwSpeed;
    case KickKind.GK_DRIVEN_THROW: return L.drivenThrowSpeed;
    default: return L.kickSpeed;
  }
}

/** Power for a release of kind k to a target d metres away into RES[RES_POWER]. */
function powerInto(k: KickKind, d: number, counter: boolean): void {
  let p = 0;
  let lo = 0, hi = 0;
  switch (k) {
    case KickKind.GK_ROLL: p = L.rollPower; break;
    case KickKind.GK_THROW: p = counter ? L.counterThrowPower : L.throwPower; break;
    case KickKind.GK_DRIVEN_THROW: p = counter ? L.counterThrowPower : L.drivenThrowPower; break;
    case KickKind.GK_DROP_KICK: lo = L.dropKickCarryMin; hi = L.dropKickCarryMax; break;
    case KickKind.GK_DRIVEN_KICK: lo = L.drivenKickCarryMin; hi = L.drivenKickCarryMax; break;
    default: break;
  }
  if (k === KickKind.GK_DROP_KICK || k === KickKind.GK_DRIVEN_KICK) {
    p = hi > lo ? (d - lo) / (hi - lo) + L.kickPowerMargin : 1;
    if (!(p > L.kickPowerMin)) p = L.kickPowerMin;
    if (p > 1) p = 1;
  }
  RES[RES_POWER] = p;
}

/** Power for a release of kind k to a target d metres away (0 for other kinds). */
export function distributionPowerFor(k: KickKind, d: number, counter: boolean): number {
  powerInto(k, d, counter);
  return RES[RES_POWER]!;
}

// ---------------------------------------------------------------- situation

/**
 * Counter-attack on for team: TAI-06 says TRANSITION_ATTACK, or the opponents have at most counterRestMax active
 * outfield players in their own half (they committed forward) while a teammate up the pitch (team frame x >=
 * counterOutletX) has no opponent within counterOutletSpace (a free outlet; man-marking all over the pitch is a
 * press, not a counter). Pure.
 */
export function isCounterOn(s: SimState, team: number): boolean {
  const t = s.teams[team]!;
  if (t.phase === TeamPhase.TRANSITION_ATTACK) return true;
  const opp = otherTeam(team);
  const dir = t.dir;
  let rest = 0;
  const oEnd = teamEnd(opp);
  for (let i = teamStart(opp); i < oEnd; i++) {
    const o = s.players[i]!;
    if (o.active !== 1 || o.isKeeper === 1) continue;
    if (dir * o.x > 0) rest++;
  }
  if (rest > L.counterRestMax) return false;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    const q = s.players[i]!;
    if (q.active !== 1 || q.isKeeper === 1 || dir * q.x < L.counterOutletX) continue;
    if (nearestDistOfTeam(s, opp, q.x, q.z) >= L.counterOutletSpace) return true;
  }
  return false;
}

/** High press on team's keeper: at least pressHighCount opponent outfield players within pressZoneDepth of its goal line. Pure. */
export function isPressHigh(s: SimState, team: number): boolean {
  const dir = s.teams[team]!.dir;
  const opp = otherTeam(team);
  let n = 0;
  const end = teamEnd(opp);
  for (let i = teamStart(opp); i < end; i++) {
    const o = s.players[i]!;
    if (o.active !== 1 || o.isKeeper === 1) continue;
    if (dir * o.x + HALF_LENGTH < L.pressZoneDepth) n++;
  }
  return n >= L.pressHighCount;
}

/** Wait (ticks) before keeper slot's first release decision for this possession (pickup tick p.actB). Pure. */
export function distributionWait(s: SimState, slot: number, counter: boolean): number {
  const j = hash30(s.config.seed, s.players[slot]!.actB, slot) * HASH_SCALE;
  const lo = counter ? L.counterWaitMinTicks : L.waitMinTicks;
  const hi = counter ? L.counterWaitMaxTicks : L.waitMaxTicks;
  const w = lo + Math.floor((hi - lo + 1) * j);
  return w > hi ? hi : w;
}

// ---------------------------------------------------------------- safety model

/**
 * Own safety 0..1 of a release of kind k from (x0, z0) to the reception point (tx, tz) for team: min over the active
 * opponents of the reception term (LONG: space only; else min(time, space)) and, for rolls, the lane term. Pure.
 */
export function ownReleaseSafety(s: SimState, team: number, x0: number, z0: number, tx: number, tz: number, k: KickKind): number {
  fillOppSpeeds(s, team);
  RES[RES_X0] = x0; RES[RES_Z0] = z0; RES[RES_TX] = tx; RES[RES_TZ] = tz;
  ownSafetyInto(s, team, k);
  return RES[RES_SAFETY]!;
}

/** OPP_V[i] = sprint speed (SIM-04 maxSpeed, at least 0.5 m/s) of every active opponent i of team. */
function fillOppSpeeds(s: SimState, team: number): void {
  const opp = otherTeam(team);
  const end = teamEnd(opp);
  for (let i = teamStart(opp); i < end; i++) {
    if (s.players[i]!.active !== 1) continue;
    const v = maxSpeed(s, i, true);
    OPP_V[i] = v > 0.5 ? v : 0.5;
  }
}

/** ownReleaseSafety for the segment in RES[RES_X0..RES_TZ] (OPP_V filled), into RES[RES_SAFETY]. */
function ownSafetyInto(s: SimState, team: number, k: KickKind): void {
  const x0 = RES[RES_X0]!, z0 = RES[RES_Z0]!, tx = RES[RES_TX]!, tz = RES[RES_TZ]!;
  const opp = otherTeam(team);
  const dx = tx - x0, dz = tz - z0;
  const len2 = dx * dx + dz * dz;
  const len = Math.sqrt(len2);
  const speed = speedOf(k);
  const tb = len / speed;
  const ground = k === KickKind.GK_ROLL;
  const long = classOf(k) === DistClass.LONG;
  let safety = 1;
  const end = teamEnd(opp);
  for (let i = teamStart(opp); i < end; i++) {
    const o = s.players[i]!;
    if (o.active !== 1) continue;
    const v = OPP_V[i]!;
    const ex = o.x - tx, ez = o.z - tz;
    const de = Math.sqrt(ex * ex + ez * ez);
    let se: number;
    if (long) {
      se = (de - L.longSpaceMin) / L.longSpaceRange;
    } else {
      const te = L.reactTime + (de > L.endReach ? (de - L.endReach) / v : 0);
      const st = (te - tb + L.endSlack) / L.endWindow;
      const ss = (de - L.spaceMin) / L.spaceRange;
      se = st < ss ? st : ss;
    }
    if (se < safety) safety = se;
    if (ground && len2 > 1e-6) {
      const u = ((o.x - x0) * dx + (o.z - z0) * dz) / len2;
      if (u > 0 && u < 1) {
        const px = o.x - (x0 + dx * u), pz = o.z - (z0 + dz * u);
        const dp = Math.sqrt(px * px + pz * pz);
        const tp = L.reactTime + (dp > L.laneReach ? (dp - L.laneReach) / v : 0);
        const sl = (tp - tb * u + L.pathSlack) / L.pathWindow;
        if (sl < safety) safety = sl;
      }
    }
  }
  RES[RES_SAFETY] = safety - safety === 0 ? (safety < 0 ? 0 : safety > 1 ? 1 : safety) : 0;
}

// ---------------------------------------------------------------- evaluation

/** Best options of the last evaluation: indices into the candidate arrays (-1 = none). */
const BEST = { ok: -1, okScore: -1e18, okShort: -1, okShortScore: -1e18, long: -1, longScore: -1e18, any: -1, anyScore: -1e18 };
const SCORE = new Float64Array(N);
const SAFE = new Float64Array(N);

/** Fill the candidate arrays and BEST for keeper slot k of team. Returns the number of candidates. */
function evaluate(s: SimState, team: number, k: number, counter: boolean, press: boolean): number {
  const p = s.players[k]!;
  const t = s.teams[team]!;
  const dir = t.dir;
  const kx = p.x, kz = p.z;
  // Offside line in the team frame (u = dir * x): second-last defender, ball, halfway; none with offside off.
  let offU = 1e9;
  if (s.config.offside === 1) {
    offU = dir * secondLastDefenderX(s, otherTeam(team));
    const bu = dir * s.ball.x;
    if (bu > offU) offU = bu;
    if (offU < 0) offU = 0;
  }
  fillOppSpeeds(s, team);
  let n = 0;
  let anyTai = 0;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    if (i === k) continue;
    const q = s.players[i]!;
    if (q.active !== 1 || q.isKeeper === 1 || q.stunT > 0) continue;
    const dx = q.x - kx, dz = q.z - kz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (!finite(d)) continue;
    RES[RES_D] = d;
    const kind = kindForResD(isMidfieldRole(q.role), counter);
    if (kind === KickKind.NONE) continue;
    // Offside position at the release contact (where he will be after the wind-up).
    if (dir * (q.x + q.vx * OFFSIDE_LOOKAHEAD_S) > offU - L.offsideSafety) continue;
    // Reception point: his position led by his velocity over the flight.
    let lt = d / speedOf(kind);
    if (lt > L.leadMaxTime) lt = L.leadMaxTime;
    let tx = q.x + q.vx * lt * L.leadFrac;
    let tz = q.z + q.vz * lt * L.leadFrac;
    if (!finite(tx) || !finite(tz)) { tx = q.x; tz = q.z; }
    const xm = HALF_LENGTH - L.pitchMargin, zm = HALF_WIDTH - L.pitchMargin;
    if (tx > xm) tx = xm; else if (tx < -xm) tx = -xm;
    if (tz > zm) tz = zm; else if (tz < -zm) tz = -zm;
    C_SLOT[n] = i;
    C_KIND[n] = kind;
    C_CLS[n] = classOf(kind);
    C_D[n] = d;
    C_TX[n] = tx;
    C_TZ[n] = tz;
    RES[RES_X0] = kx; RES[RES_Z0] = kz; RES[RES_TX] = tx; RES[RES_TZ] = tz;
    ownSafetyInto(s, team, kind);
    C_OWN[n] = RES[RES_SAFETY]!;
    const ts = laneSafety(s, team, kx, kz, tx, tz, speedOf(kind), kind === KickKind.GK_ROLL ? 0 : 1);
    C_TAI[n] = finite(ts) ? clamp01(ts) : 0;
    if (C_TAI[n]! > 0) anyTai = 1;
    n++;
  }
  // Scoring.
  const style = t.style >= 0 && t.style < L.styleShort.length ? t.style : TeamStyle.POSSESSION;
  const level = t.cpu.active === 1 && t.cpu.level >= 0 && t.cpu.level < T_LEVEL.decisionNoise.length
    ? t.cpu.level : Difficulty.PROFESSIONAL;
  const noise = T_LEVEL.decisionNoise[level]! * L.noiseScale;
  const wProg = counter ? L.wProgress * L.counterProgressMul : L.wProgress;
  BEST.ok = -1; BEST.okScore = -1e18; BEST.okShort = -1; BEST.okShortScore = -1e18;
  BEST.long = -1; BEST.longScore = -1e18; BEST.any = -1; BEST.anyScore = -1e18;
  for (let c = 0; c < n; c++) {
    const cls = C_CLS[c]!;
    const safety = anyTai === 1 ? C_TAI[c]! : C_OWN[c]!;
    let prog = (dir * C_TX[c]! - dir * kx) / L.progressRef;
    prog = clamp01(prog);
    let bias: number;
    let minSafe: number;
    if (cls === DistClass.SHORT) {
      bias = L.styleShort[style]! + (press ? L.pressShort : 0);
      minSafe = counter ? L.counterMinSafety : L.minSafetyShort;
    } else if (cls === DistClass.MID) {
      bias = L.styleMid[style]! + (press ? L.pressMid : 0) + (counter ? L.counterMid : 0);
      minSafe = counter ? L.counterMinSafety : L.minSafetyMid;
    } else {
      bias = L.styleLong[style]! + (press ? L.pressLong : 0) + (counter ? L.counterLong : 0);
      minSafe = L.minSafetyLong;
    }
    if (style === TeamStyle.WING_PLAY && cls !== DistClass.LONG) {
      const az = C_TZ[c]! < 0 ? -C_TZ[c]! : C_TZ[c]!;
      if (az >= L.wingWideZ) bias += L.wingBonus;
    }
    const j = hash30(s.config.seed, s.players[k]!.actB, 101 + C_SLOT[c]!) * HASH_SCALE;
    const score = L.wSafety * safety + wProg * prog + bias + (j * 2 - 1) * noise;
    SCORE[c] = score;
    SAFE[c] = safety;
    if (score > BEST.anyScore) { BEST.anyScore = score; BEST.any = c; }
    if (cls === DistClass.LONG && score > BEST.longScore) { BEST.longScore = score; BEST.long = c; }
    if (safety >= minSafe) {
      if (score > BEST.okScore) { BEST.okScore = score; BEST.ok = c; }
      if (cls !== DistClass.LONG && score > BEST.okShortScore) { BEST.okShortScore = score; BEST.okShort = c; }
    }
  }
  return n;
}

function fillChoice(s: SimState, k: number, c: number, counter: boolean, out: DistributionPlan): void {
  const p = s.players[k]!;
  const kind = C_KIND[c]! as KickKind;
  out.slot = C_SLOT[c]!;
  out.kind = kind;
  powerInto(kind, C_D[c]!, counter);
  out.power = RES[RES_POWER]!;
  out.cls = C_CLS[c]! as DistClass;
  out.safety = SAFE[c]!;
  out.score = SCORE[c]!;
  const dx = C_TX[c]! - p.x, dz = C_TZ[c]! - p.z;
  const l = Math.sqrt(dx * dx + dz * dz);
  if (l > 1e-6 && finite(l)) { out.dirX = dx / l; out.dirZ = dz / l; } else { out.dirX = s.teams[p.team]!.dir; out.dirZ = 0; }
}

/**
 * Decide keeper distribution for team this tick without changing the state: fills out and returns out.release
 * (1 = release now with out.kind to out.slot). 0 while waiting, between evaluations, or when the keeper is not
 * holding the ball in GK_HOLD in open play. Pure (scratch only).
 */
export function planDistribution(s: SimState, team: number, out: DistributionPlan): number {
  resetPlan(out);
  if (!(team === 0 || team === 1) || s.match.phase !== MatchPhase.IN_PLAY) return 0;
  const t = s.teams[team]!;
  const k = t.keeperSlot;
  if (!(k >= 0 && k < NUM_SLOTS)) return 0;
  const p = s.players[k]!;
  if (p.active !== 1 || p.team !== team || p.act !== ActionKind.GK_HOLD || s.ball.heldBy !== k) return 0;
  const held = s.tick - p.actB;
  const counter = isCounterOn(s, team);
  const press = isPressHigh(s, team);
  const wait = distributionWait(s, k, counter);
  out.held = held;
  out.counter = counter ? 1 : 0;
  out.press = press ? 1 : 0;
  out.wait = wait;
  if (!(held >= wait)) return 0;
  const deadline = held >= L.deadlineTicks;
  if (!deadline && (held - wait) % L.evalInterval !== 0) return 0;
  evaluate(s, team, k, counter, press);
  const longOk = press || counter || t.style === TeamStyle.DIRECT || held >= L.patienceTicks;
  let c = -1;
  if (BEST.ok >= 0 && (C_CLS[BEST.ok] !== DistClass.LONG || longOk)) c = BEST.ok;
  else if (BEST.okShort >= 0) c = BEST.okShort;
  else if (deadline) c = BEST.ok >= 0 ? BEST.ok : BEST.long >= 0 ? BEST.long : BEST.any;
  if (c >= 0) {
    fillChoice(s, k, c, counter, out);
  } else if (deadline) {
    // Nobody to aim at: a drop kick upfield (GKP-05 still picks a receiver in the cone at contact if there is one).
    out.slot = -1;
    out.kind = KickKind.GK_DROP_KICK;
    out.power = L.blindKickPower;
    out.cls = DistClass.LONG;
    out.dirX = t.dir;
    out.dirZ = 0;
  } else {
    return 0;
  }
  out.release = 1;
  return 1;
}

// ---------------------------------------------------------------- entry point

export function keeperDistributionAi(s: SimState, team: number, ev: EventSink): void {
  if (!(team === 0 || team === 1)) return;
  const k = s.teams[team]!.keeperSlot;
  if (!(k >= 0 && k < NUM_SLOTS) || isHumanSlot(s, k)) return;
  if (planDistribution(s, team, PLAN) !== 1) return;
  const r = REQ;
  r.power = PLAN.power;
  r.charging = 0;
  r.dirX = PLAN.dirX;
  r.dirZ = PLAN.dirZ;
  r.targetSlot = PLAN.slot;
  r.hasTarget = 0;
  r.targetX = 0;
  r.targetZ = 0;
  r.curve = 0;
  r.assist = AssistLevel.ASSISTED;
  r.flags = 0;
  startKeeperRelease(s, k, PLAN.kind, r, ev);
}
