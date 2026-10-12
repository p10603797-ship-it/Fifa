/**
 * [TAI-04] Defensive shape and back-line control: stay compact (T_AI.lineSpacingMax), hold and step the back line
 * together (team.lineX), offside trap when team.offsideTrap, mark zones and passing lanes; MARK / COVER jobs.
 *
 * Runs in the team AI pipeline after the chaser (ai/index.ts) and before pressing / transition / support, so a
 * presser (PRESS), cover (COVER), tracker (TRACK_RUNNER) or recovery run (RECOVER) of TAI-05/06 overrides what this
 * module assigns (ai/jobs.ts priority order). All maths in the team frame (u = dir * x toward the opposition goal,
 * v = dir * z), so both attack directions are exact mirror images.
 *
 * When it applies (IN_PLAY only): the opponent owns the ball, or an opponent pass is in flight (last touch and
 * intended receiver theirs), or the ball is loose and the nearest opponent is closer to it than our nearest player.
 * Otherwise team.lineX just tracks where the back line actually stands (so it is continuous when the ball is lost)
 * and no jobs are given.
 *
 * Members (rebuilt every call, from formation data + quick tactics):
 *  - back line: active outfielders whose formation slot is in the DEF line (data/formations); vacated DEF slots
 *    (red card) are filled by the deepest-homed other outfielders TAI-01 moved down (home within fillTol of the
 *    deepest defender's home);
 *  - midfield (DM / MID / AM lines) and forwards (FWD line): everybody else except the keeper.
 *
 * Line height (team.lineX: the back line stands on it, ball-side defenders up to `stagger` higher, so it is our
 * offside line give or take the stagger):
 *  1. Base: the formation's neutral back line + lineSlope * ball u (a backward ball in flight is predicted
 *     stepLookahead ahead) + the tactic offset (data/tactics resolveTactics lineNx: focus, offside trap, team press).
 *  2. Step up together when the ball goes back or sideways: the opponents' last kick went backward (receiver /
 *     reception point at least QUICK_TACTICS.offsideTrap.triggerBackM further from our goal than the kicker) or
 *     square (squareLatM across), for stepTicks after the kick then fading over stepFadeTicks; or the carrier dribbles
 *     back. Step = stepUpM, or QUICK_TACTICS.offsideTrap.stepUpM with the offside trap (at sprint pace: trapUpRate,
 *     the line leading the players by up to trapLead, everybody sprinting).
 *     The stepped line stays stepBallGap goal-side of the ball.
 *  3. Drop when the carrier faces our goal unpressured (dropUnpressured, scaled by facing and pressure; the step is
 *     cancelled by the same amount; trapDropScale with the trap); stay goal-side of every opponent who cannot be
 *     offside whatever the line does (offside off, ball level with / behind him, his own half); without the trap,
 *     drop with an onside runner breaking the line while the carrier is free (an attacker who is onside only
 *     because the line is still stepping past him is not followed: that leaves him offside); drop goal-side of the
 *     ball when it is level with / behind the line or played long toward our goal. Opponents flagged offside at
 *     the last pass (match.offside, RUL-08) are ignored. The offside trap is ignored when offside is off.
 *  4. Clamp to [floor, ceil]: never deeper than the 6-yard box edge while the ball is far (floorFar), down to
 *     floorNear as the ball nears our goal.
 *  5. Rate limit (lineUpRate / lineDownRate m/s) from the stored line, which is first pulled to within anchorSlack
 *     of where the back line actually stands (median of the AI back-liners), so a stale value after a restart or a
 *     possession change never drags the players.
 *
 * Jobs:
 *  - back line: HOLD_SHAPE at (lineX + small stagger toward the ball side, home z) — level line;
 *  - midfield 8..14 m ahead of the line (AM up to +amExtra, forwards up to 2 * lineSpacingMax), never pushed in
 *    front of the ball: HOLD_SHAPE at the home clamped into that band;
 *  - zonal marking: an attacker inside a defender's zone (disc of the role's zoneRadius round his line/band spot,
 *    roles with duties.mark >= markDutyMin) gets the defender goal-side of him (MARK, jobSlot = attacker), greedy
 *    by normalised distance, back line first then midfield, one attacker per defender and vice versa; back-liners
 *    stay on the line (at most
 *    markStepOut in front, never behind it: an attacker behind the line stays offside), midfielders stay
 *    midMarkMinGap in front of it;
 *  - passing lanes into the box: with the carrier within laneCarrierRange of our goal line, the most dangerous
 *    opponents in / near our penalty area whose lane from the carrier is open get the nearest free midfielder on
 *    the lane (COVER, jobSlot = receiver), at most laneMax.
 * Speeds: jog, top speed when far (hurryDist), dropping or stepping with the trap; markers and lane covers top.
 * Determinism: + - * / sqrt only, slot-order loops, module scratch rewritten every call, no allocation per tick.
 * Pure function of the state apart from team.lineX and the jobs it writes.
 */
import {
  DT, GOAL_AREA_DEPTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PLAYERS_PER_TEAM,
} from '../contracts/constants';
import { AiJob, MatchPhase } from '../contracts/enums';
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';
import { T_AI, T_PLAYER } from '../contracts/tuning';
import { FORMATIONS, ShapeLine, slotLine } from '../data/formations';
import {
  createTacticParams, QUICK_TACTICS, resolveTactics, rolePreset, slotLineFor, slotRole, TacticFlag, tacticFlags,
} from '../data/tactics';
import { otherTeam, pressureOn, teamEnd, teamStart } from '../sim/core/query';
import { assignJob, isJobDriven } from './jobs';

export const LOCAL_TUNING = {
  // ---- line height (team frame u, m from the centre spot toward the opposition goal)
  /** The line follows the ball: neutral back line + lineSlope * ball u, m/m. */
  lineSlope: 0.55,
  /** Highest line, m (team frame; + the tactic offset when it is positive). */
  lineCeil: 2,
  /** Lowest line with the ball far (= 6-yard box edge) / near our goal, m from the own goal line. */
  floorFar: GOAL_AREA_DEPTH,
  floorNear: 1.5,
  /** Ball distance from our goal line at which the floor is floorNear / floorFar (linear in between), m. */
  ballNearDist: 20,
  ballFarDist: 30,
  /** The line stays this far goal-side of a ball level with / behind it, m. */
  behindBallGap: 2,
  /** A loose ball the opponents played toward our goal faster than this is anticipated (long ball), m/s. */
  longBallSpeed: 8,
  // ---- drop: carrier facing our goal, unpressured
  /** Drop with the carrier facing our goal under no pressure, m. */
  dropUnpressured: 5,
  /** query.pressureOn below which the carrier counts as free: drop x1 at 0 .. x0 at pressFree. */
  pressFree: 0.6,
  /** Carrier facing toward our goal (cosine): no drop at faceFwdMin, full drop at faceFwdFull. */
  faceFwdMin: 0.2,
  faceFwdFull: 0.7,
  /** Drop multiplier while the offside trap is on (a trap side holds a high line). */
  trapDropScale: 0.3,
  // ---- drop: runners
  /** A runner within this distance in front of the line ... m ... */
  runnerLead: 3,
  /** ... running toward our goal faster than this is breaking it, m/s. */
  runnerSpeed: 3.5,
  /** A breaking runner is anticipated this far ahead, s. */
  runnerLookahead: 0.6,
  /** The line drops this far goal-side of a runner, m. */
  runnerMargin: 1,
  // ---- step up on a backward / square ball
  /** Step-up without the offside trap, m (with it: QUICK_TACTICS.offsideTrap.stepUpM). */
  stepUpM: 3,
  /** A square pass: at least this far across, m, and at most squareFwdTol toward our goal, m. */
  squareLatM: 8,
  squareFwdTol: 2,
  /** The step-up fades out over this many ticks after QUICK_TACTICS.offsideTrap.stepTicks. */
  stepFadeTicks: 60,
  /** A loose ball moving away from our goal is predicted this far ahead for the base line, s. */
  stepLookahead: 0.5,
  /** Carrier dribbling away from our goal: step starts / is full at this speed, m/s. */
  dribbleBackMin: 1.5,
  dribbleBackFull: 4,
  /** A stepped line stays this far goal-side of the ball, m. */
  stepBallGap: 4,
  // ---- rate
  /** Max speed of the line target moving up / down, m/s. */
  lineUpRate: 4.5,
  lineDownRate: 6.5,
  /** The stored line is first pulled to within this of the back line's median position, m. */
  anchorSlack: 5,
  /** Offside-trap step: the line moves up at this rate (sprint pace), m/s, leading the players by up to trapLead,
   *  m (far enough ahead that arrival braking does not cap their sprint). */
  trapUpRate: 9,
  trapLead: 8,
  // ---- back line
  /** Ball-side defenders stand up to this much higher (stagger toward the ball side), m ... */
  stagger: 1,
  /** ... fading to 0 at this lateral distance from the ball, m. */
  staggerRange: 20,
  /** Max height of any back-line target above the line (stagger + marking step-out), m. */
  maxStepOut: 2,
  /** Max step out of the line to mark an attacker in front of it, m. */
  markStepOut: 1.5,
  /** A non-defender whose home is within this of the deepest defender's home fills a vacated back-line slot, m. */
  fillTol: 3,
  // ---- marking
  /** Goal-side marking distance for back-liners / midfielders, m. */
  markGap: 1.5,
  markGapMid: 2.5,
  /** Roles with duties.mark (x focus dutyScale) below this do not mark. */
  markDutyMin: 0.5,
  /** Zone radius = role zoneRadius x zoneScale, m. */
  zoneScale: 1,
  /** A marking midfielder stays at least this far in front of the line, m. */
  midMarkMinGap: 4,
  // ---- midfield compactness
  /** Midfield line at least this far in front of the back line, m (at most T_AI.lineSpacingMax). */
  midGapMin: 8,
  /** Attacking midfielders may stand this much further up than the midfield band, m. */
  amExtra: 4,
  // ---- passing lanes into the box
  /** Max lane covers per team. */
  laneMax: 2,
  /** Receivers within the penalty area grown by this margin count, m. */
  laneBoxMargin: 3,
  /** Lanes are covered while the carrier is within this distance of our goal line, m. */
  laneCarrierRange: 40,
  /** Cover point: projection onto the lane clamped to this fraction range (carrier 0 .. receiver 1). */
  laneTMin: 0.3,
  laneTMax: 0.7,
  /** A team-mate within this distance of the lane (fractions 0.15..0.9) already blocks it, m. */
  laneBlock: 1.5,
  /** Max distance from a midfielder's spot to his cover point, m. */
  laneReach: 14,
  // ---- speeds
  /** Beyond this distance from the target players move at top speed (else jog), m. */
  hurryDist: 5,
} as const; // TUNING-CR

const LT = LOCAL_TUNING;
const N = PLAYERS_PER_TEAM;
const BIG = 1e9;

// ---------------------------------------------------------------- formation tables (built once at load)

const NF = FORMATIONS.length;
/** Neutral back-line height per formation (deepest DEF slot), team frame u, m. */
const F_BACK_U = new Float64Array(NF);
/** Number of DEF-line slots per formation. */
const F_BACK_N = new Int32Array(NF);
for (let fi = 0; fi < NF; fi++) {
  const slots = FORMATIONS[fi]!.slots;
  let back = BIG, n = 0;
  for (let k = 0; k < slots.length; k++) {
    if (slotLine(FORMATIONS[fi]!.id, k) !== ShapeLine.DEF) continue;
    n++;
    const u = slots[k]!.nx * HALF_LENGTH;
    if (u < back) back = u;
  }
  F_BACK_U[fi] = n > 0 ? back : -26.5;
  F_BACK_N[fi] = n;
}

function formationIndex(id: number): number {
  return id >= 0 && id < NF && (id | 0) === id ? id : 0;
}

// ---------------------------------------------------------------- scratch (rewritten every call; never state)

const TP = createTacticParams();
/** Back-line member slots and their count. */
const backS = new Int32Array(N);
let backN = 0;
/** Other outfield members (midfield + forwards) and their ShapeLine. */
const midS = new Int32Array(N);
const midL = new Int32Array(N);
let midN = 0;
/** Per-slot member flag: 1 back line, 2 midfield/forward. */
const role = new Uint8Array(NUM_SLOTS);
/** Per-slot planned target this call (team frame) for members, and whether it is set. */
const planU = new Float64Array(NUM_SLOTS);
const planV = new Float64Array(NUM_SLOTS);
/** Sort scratch. */
const tmp = new Float64Array(N);
/** Marking: defenders (slot, zone centre, radius, back flag), attackers (slot), cost matrix, taken flags. */
const dS = new Int32Array(N);
const dU = new Float64Array(N);
const dV = new Float64Array(N);
const dR = new Float64Array(N);
const dB = new Uint8Array(N);
const dT = new Uint8Array(N);
let dN = 0;
const aS = new Int32Array(N);
const aT = new Uint8Array(N);
let aN = 0;
const cost = new Float64Array(N * N);
/** Lane covers placed this call (team frame points) to count as blockers. */
const lcU = new Float64Array(N);
const lcV = new Float64Array(N);
let lcN = 0;
const laneDone = new Uint8Array(NUM_SLOTS);

/**
 * Numeric results of helpers. V8 boxes a double passed to or returned from a call it does not inline, so helpers
 * that run every tick hand their numbers over through this array (OUT_*) instead of return values / parameters.
 */
const OUT = new Float64Array(4);
const OUT_MED = 0;
const OUT_SL = 1;
/** Lane under test (carrier point and carrier->receiver vector, team frame) and a point to test against it. */
const LANE = new Float64Array(6);

/** Results of the latest evaluateLine (team frame). */
const EVAL = {
  /** Unlimited line target, current (anchored) line, the rate-limited new line, floor and ceiling, m. */
  target: 0, cur: 0, next: 0, floor: 0, ceil: 0,
  /** Back line actual median position (NaN-free; = cur when no member stands), m. */
  anchor: 0,
  /** 0..1 step-up factor applied, 1 = the trap is stepping (faster rate, sprint). */
  step: 0, trapStep: 0,
  /** 1 = the target is below the current line because of a threat (drop: hurry). */
  drop: 0,
};

// ---------------------------------------------------------------- helpers

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function absv(v: number): number { return v < 0 ? -v : v; }
/** v if finite, else d. */
function fin(v: number, d: number): number { return v - v === 0 ? v : d; }
/** (v - a) / (b - a) clamped to [0, 1]. */
function ramp(a: number, b: number, v: number): number { return b === a ? (v >= b ? 1 : 0) : clamp01((v - a) / (b - a)); }

/** Quick-tactic flags of a team; the offside trap means nothing (no higher line, no step) with offside off. */
function teamFlags(s: SimState, team: number): number {
  const f = tacticFlags(s.teams[team]!);
  return s.config.offside === 1 ? f : f & ~TacticFlag.OFFSIDE_TRAP;
}

/** Slot may take a job from this module: driven by jobs and not already on a higher job (chaser). */
function free(s: SimState, slot: number): boolean {
  return isJobDriven(s, slot) && s.players[slot]!.job <= AiJob.HOLD_SHAPE;
}

/** Collect back line and other members of `team` into the scratch. */
function collectMembers(s: SimState, team: number, dir: number, flags: number): void {
  const t = s.teams[team]!;
  const fi = formationIndex(t.formation);
  const start = teamStart(team), end = teamEnd(team);
  backN = 0;
  midN = 0;
  let minHome = BIG;
  for (let i = start; i < end; i++) {
    role[i] = 0;
    const p = s.players[i]!;
    const f = p.formIdx;
    if (p.active !== 1 || p.isKeeper === 1 || !(f >= 0 && f < N) || (f | 0) !== f) continue;
    if (slotLineFor(fi, f, flags) !== ShapeLine.DEF) continue;
    role[i] = 1;
    backS[backN++] = i;
    const hu = dir * fin(p.homeX, 0);
    if (hu < minHome) minHome = hu;
  }
  // Vacated back-line slots (sent off): TAI-01 moves the laterally nearest players down; take the deepest-homed
  // other outfielders whose home is at back-line depth.
  const want = F_BACK_N[fi]!;
  while (backN > 0 && backN < want) {
    let best = -1, bestU = BIG;
    for (let i = start; i < end; i++) {
      const p = s.players[i]!;
      const f = p.formIdx;
      if (role[i] !== 0 || p.active !== 1 || p.isKeeper === 1 || !(f >= 0 && f < N) || (f | 0) !== f) continue;
      const hu = dir * fin(p.homeX, 0);
      if (hu <= minHome + LT.fillTol && hu < bestU) { bestU = hu; best = i; }
    }
    if (best < 0) break;
    role[best] = 1;
    backS[backN++] = best;
  }
  for (let i = start; i < end; i++) {
    if (role[i] !== 0) continue;
    const p = s.players[i]!;
    const f = p.formIdx;
    if (p.active !== 1 || p.isKeeper === 1 || !(f >= 0 && f < N) || (f | 0) !== f) continue;
    role[i] = 2;
    midL[midN] = slotLineFor(fi, f, flags);
    midS[midN++] = i;
  }
}

/** Median team-frame u of the back-liners driven by AI (all back-liners if none) into OUT[OUT_MED]; NaN if none. */
function backMedian(s: SimState, dir: number): void {
  let m = 0;
  for (let pass = 0; pass < 2 && m === 0; pass++) {
    for (let k = 0; k < backN; k++) {
      const i = backS[k]!;
      if (pass === 0 && !free(s, i)) continue;
      const u = dir * fin(s.players[i]!.x, 0);
      let j = m++;
      while (j > 0 && tmp[j - 1]! > u) { tmp[j] = tmp[j - 1]!; j--; }
      tmp[j] = u;
    }
  }
  OUT[OUT_MED] = m === 0 ? NaN : (m & 1) === 1 ? tmp[m >> 1]! : (tmp[(m >> 1) - 1]! + tmp[m >> 1]!) * 0.5;
}

/** Team-frame u of our second-last player (incl. keeper) = the offside line opponents play against -> OUT[OUT_SL]. */
function secondLastU(s: SimState, team: number, dir: number): void {
  let first = BIG, second = BIG;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const u = dir * p.x;
    if (u < first) { second = first; first = u; } else if (u < second) second = u;
  }
  OUT[OUT_SL] = second >= BIG ? first : second;
}

/**
 * True when `team` is out of possession for shape purposes: the opponent owns the ball, an opponent pass is in
 * flight (last touch theirs, intended receiver theirs), or the ball is loose and the nearest opponent is closer to
 * it than our nearest player. Pure.
 */
export function isDefending(s: SimState, team: number): boolean {
  const b = s.ball;
  const opp = otherTeam(team);
  const o = b.owner >= 0 && b.owner < NUM_SLOTS ? b.owner : b.heldBy >= 0 && b.heldBy < NUM_SLOTS ? b.heldBy : -1;
  if (o >= 0) return s.players[o]!.team === opp;
  if (b.lastTouchTeam === opp && b.passTarget >= 0 && b.passTarget < NUM_SLOTS && s.players[b.passTarget]!.team === opp) return true;
  let dOwn = BIG, dOpp = BIG;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const dx = p.x - b.x, dz = p.z - b.z;
    const d = dx * dx + dz * dz;
    if (p.team === team) { if (d < dOwn) dOwn = d; } else if (d < dOpp) dOpp = d;
  }
  return dOpp < dOwn;
}

/**
 * Evaluate the line for `team` into EVAL (team frame) without writing state. Requires collectMembers and TP for
 * the team. The opponent ball / runner model is described in the file header.
 */
function evaluateLine(s: SimState, team: number, dir: number, trapOn: boolean): void {
  const t = s.teams[team]!;
  const b = s.ball;
  const opp = otherTeam(team);
  const oppStart = teamStart(opp), oppEnd = teamEnd(opp);
  const bu = dir * fin(b.x, 0), bv = dir * fin(b.z, 0);
  const vu = dir * fin(b.vx, 0), vv = dir * fin(b.vz, 0);
  const loose = b.owner < 0 && b.heldBy < 0;
  const carrier = !loose && b.owner >= 0 && b.owner < NUM_SLOTS && s.players[b.owner]!.team === opp ? b.owner : -1;
  const fi = formationIndex(t.formation);
  const lineOff = TP.lineNx * HALF_LENGTH;
  const ceil = LT.lineCeil + (lineOff > 0 ? lineOff : 0);
  const floor = -HALF_LENGTH + LT.floorNear + (LT.floorFar - LT.floorNear) * ramp(LT.ballNearDist, LT.ballFarDist, bu + HALF_LENGTH);

  // 1. Base.
  const ballBase = loose && vu > 0 ? bu + vu * LT.stepLookahead : bu;
  const base = F_BACK_U[fi]! + LT.lineSlope * ballBase + lineOff;

  // 2. Step up on a backward / square ball.
  let step = 0;
  const kb = b.lastKickBy;
  if (b.lastKickTeam === opp && kb >= oppStart && kb < oppEnd) {
    const since = s.tick - b.lastKickTick;
    const hold = QUICK_TACTICS.offsideTrap.stepTicks;
    if (since >= 0 && since <= hold + LT.stepFadeTicks) {
      const k = s.players[kb]!;
      const ku = dir * k.x, kv = dir * k.z;
      let ru = 0, rv = 0, have = false;
      if (carrier >= 0 && carrier !== kb) {
        const r = s.players[carrier]!;
        ru = dir * r.x; rv = dir * r.z; have = true;
      } else if (loose && b.passTarget >= 0) {
        ru = dir * fin(b.passX, b.x); rv = dir * fin(b.passZ, b.z); have = true;
      } else if (loose) {
        ru = bu + vu * LT.stepLookahead; rv = bv + vv * LT.stepLookahead; have = true;
      }
      if (have) {
        const back = ru - ku;
        const lat = absv(rv - kv);
        const went = back >= QUICK_TACTICS.offsideTrap.triggerBackM || (lat >= LT.squareLatM && back >= -LT.squareFwdTol);
        if (went) step = since <= hold ? 1 : 1 - (since - hold) / LT.stepFadeTicks;
      }
    }
  }
  if (carrier >= 0) {
    const d = ramp(LT.dribbleBackMin, LT.dribbleBackFull, dir * s.players[carrier]!.vx);
    if (d > step) step = d;
  }
  const stepM = trapOn ? QUICK_TACTICS.offsideTrap.stepUpM : LT.stepUpM;
  let bonus = stepM * step;
  if (bonus > 0) {
    // The stepped line stays goal-side of the ball (never below the base for it).
    const cap = bu - LT.stepBallGap;
    const room = cap > base ? cap - base : 0;
    if (bonus > room) bonus = room;
  }
  // The trap steps at sprint pace: the line may lead the players by trapLead instead of anchorSlack.
  const trapStep = trapOn && bonus > 0 ? 1 : 0;

  // Current line: the stored value pulled to within the slack of where the back line stands.
  backMedian(s, dir);
  const med = OUT[OUT_MED]!;
  let cur = fin(dir * t.lineX, NaN);
  if (cur !== cur) cur = med === med ? med : F_BACK_U[fi]!;
  const anchor = med === med ? med : cur;
  cur = clamp(cur, anchor - LT.anchorSlack, anchor + (trapStep === 1 ? LT.trapLead : LT.anchorSlack));

  // 3. Drops.
  let freeK = 0;
  let dropK = 0;
  if (carrier >= 0) {
    const c = s.players[carrier]!;
    freeK = clamp01(1 - pressureOn(s, carrier) / LT.pressFree);
    dropK = freeK * ramp(LT.faceFwdMin, LT.faceFwdFull, -dir * c.fx);
  }
  const dropM = LT.dropUnpressured * dropK * (trapOn ? LT.trapDropScale : 1);
  let target = base + bonus * (1 - dropK) - dropM;
  let threat = dropM > 0 ? 1 : 0;

  // Runners: an onside runner behind the line, or breaking it while the carrier is free (not with the trap).
  const offsideOn = s.config.offside === 1;
  secondLastU(s, team, dir);
  const sl = OUT[OUT_SL]!;
  const of = s.match.offside;
  const flagged = of.passTeam === opp ? of.flags : 0;
  for (let i = oppStart; i < oppEnd; i++) {
    if (i === carrier) continue;
    const r = s.players[i]!;
    if (r.active !== 1 || r.isKeeper === 1) continue;
    if ((flagged >>> i) & 1) continue; // flagged offside at the last pass: never play him onside
    const ur = dir * r.x;
    // Never offside whatever the line does (no offside rule, ball level with / behind him, own half): the line
    // stays goal-side of him. Onside only because our players have not stepped past him yet: no drop (stepping
    // past him leaves him offside, which is the point).
    const always = !offsideOn || ur >= bu || ur >= 0;
    if (always) {
      const cap = ur - LT.runnerMargin;
      if (cap < target) { target = cap; threat = 1; }
      continue;
    }
    if (ur < sl) continue; // in an offside position now: keep him there
    if (!trapOn && carrier >= 0 && freeK > 0 && ur < cur + LT.runnerLead) {
      const vr = dir * r.vx;
      if (vr < -LT.runnerSpeed) {
        const cap = cur + (ur + vr * LT.runnerLookahead - LT.runnerMargin - cur) * freeK;
        if (cap < target) { target = cap; threat = 1; }
      }
    }
  }

  // The ball: stay goal-side of a ball level with / behind the line, and of a long ball played toward our goal.
  if (bu - LT.behindBallGap < target) { target = bu - LT.behindBallGap; threat = 1; }
  if (loose && b.lastTouchTeam === opp && vu < -LT.longBallSpeed) {
    const land = bu + vu * LT.runnerLookahead - LT.behindBallGap;
    if (land < target) { target = land; threat = 1; }
  }

  // 4. Floor and ceiling.
  target = clamp(target, floor, ceil);

  // 5. Rate limit.
  const up = (trapStep === 1 ? LT.trapUpRate : LT.lineUpRate) * DT;
  const down = LT.lineDownRate * DT;
  let next = target > cur ? (target < cur + up ? target : cur + up) : (target > cur - down ? target : cur - down);
  next = clamp(next, floor, ceil);

  EVAL.target = target;
  EVAL.cur = cur;
  EVAL.next = next;
  EVAL.floor = floor;
  EVAL.ceil = ceil;
  EVAL.anchor = anchor;
  EVAL.step = step;
  EVAL.trapStep = trapStep;
  EVAL.drop = threat === 1 && target < cur - 1e-9 ? 1 : 0;
}

/**
 * Give slot a HOLD_SHAPE move to (u, v) (team frame): jog when near, top speed when far or urgent. The speed is
 * decided after assignJob so no double crosses a call boundary twice.
 */
function holdAt(s: SimState, slot: number, dir: number, u: number, v: number, urgent: boolean): void {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const top = a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin;
  if (!assignJob(s, slot, AiJob.HOLD_SHAPE, dir * u + 0, dir * v + 0, top, -1) || urgent) return;
  const du = u - dir * p.x, dv = v - dir * p.z;
  if (du * du + dv * dv <= LT.hurryDist * LT.hurryDist) p.tgtSpeed = top * T_PLAYER.jogFraction;
}

// ---------------------------------------------------------------- main

export function assignDefensiveShape(s: SimState, team: number, ev: EventSink): void {
  if (s.match.phase !== MatchPhase.IN_PLAY) return;
  const t = s.teams[team]!;
  const dir = t.dir < 0 ? -1 : 1;
  const flags = teamFlags(s, team);
  resolveTactics(t.focus, flags, TP);
  collectMembers(s, team, dir, flags);
  if (!isDefending(s, team)) {
    // Track the back line so the value is continuous when the ball is lost.
    backMedian(s, dir);
    const med = OUT[OUT_MED]!;
    if (med === med) t.lineX = dir * med + 0;
    return;
  }
  const trapOn = (flags & TacticFlag.OFFSIDE_TRAP) !== 0;
  evaluateLine(s, team, dir, trapOn);
  t.lineX = dir * EVAL.next + 0;
  placeBackLine(s, dir);
  placeMidfield(s, dir);
  markZones(s, team, dir, flags);
  coverLanes(s, team, dir);
}

/** Back line: level at the line, ball-side defenders up to `stagger` higher. */
function placeBackLine(s: SimState, dir: number): void {
  const line = EVAL.next;
  const bv = dir * fin(s.ball.z, 0);
  const urgentAll = EVAL.drop === 1 || EVAL.trapStep === 1;
  for (let k = 0; k < backN; k++) {
    const i = backS[k]!;
    const p = s.players[i]!;
    const v = clamp(dir * fin(p.homeZ, p.z), -HALF_WIDTH + 1, HALF_WIDTH - 1);
    const u = line + LT.stagger * clamp01(1 - absv(v - bv) / LT.staggerRange);
    planU[i] = u;
    planV[i] = v;
    if (!free(s, i)) continue;
    holdAt(s, i, dir, u, v, urgentAll || u < dir * p.x - 1);
  }
}

/** Midfield 8..14 m in front of the line (AM a little higher, forwards up to two line spacings), not past the ball. */
function placeMidfield(s: SimState, dir: number): void {
  const line = EVAL.next;
  const bu = dir * fin(s.ball.x, 0);
  let lo = line + LT.midGapMin;
  const ballLo = bu > line ? bu : line;
  if (ballLo < lo) lo = ballLo;
  for (let k = 0; k < midN; k++) {
    const i = midS[k]!;
    const p = s.players[i]!;
    const l = midL[k]!;
    const hi = line + (l === ShapeLine.FWD ? 2 * T_AI.lineSpacingMax : l === ShapeLine.AM ? T_AI.lineSpacingMax + LT.amExtra : T_AI.lineSpacingMax);
    const hu = dir * fin(p.homeX, p.x);
    const v = dir * fin(p.homeZ, p.z);
    const u = clamp(hu, lo < hi ? lo : hi, hi);
    planU[i] = u;
    planV[i] = v;
    if (u === hu || !free(s, i)) continue;
    holdAt(s, i, dir, u, v, false);
  }
}

/** Zonal marking: each attacker inside a defender's zone gets at most one defender goal-side of him. */
function markZones(s: SimState, team: number, dir: number, flags: number): void {
  const fi = formationIndex(s.teams[team]!.formation);
  const opp = otherTeam(team);
  const owner = s.ball.owner;
  dN = 0;
  for (let k = 0; k < backN + midN; k++) {
    const back = k < backN;
    const i = back ? backS[k]! : midS[k - backN]!;
    if (!back && midL[k - backN] === ShapeLine.FWD) continue;
    if (!free(s, i)) continue;
    const rp = rolePreset(slotRole(fi, s.players[i]!.formIdx, flags));
    if (rp.duties.mark * TP.dutyScale < LT.markDutyMin) continue;
    const r = rp.zoneRadius * LT.zoneScale;
    if (!(r > 0)) continue;
    dS[dN] = i; dU[dN] = planU[i]!; dV[dN] = planV[i]!; dR[dN] = r; dB[dN] = back ? 1 : 0; dT[dN] = 0;
    dN++;
  }
  aN = 0;
  const oe = teamEnd(opp);
  for (let i = teamStart(opp); i < oe; i++) {
    const a = s.players[i]!;
    if (a.active !== 1 || a.isKeeper === 1 || i === owner) continue;
    aS[aN] = i; aT[aN] = 0;
    aN++;
  }
  if (dN === 0 || aN === 0) return;
  for (let d = 0; d < dN; d++) {
    for (let a = 0; a < aN; a++) {
      const q = s.players[aS[a]!]!;
      const du = dir * q.x - dU[d]!, dv = dir * q.z - dV[d]!;
      const dist = Math.sqrt(du * du + dv * dv);
      cost[d * N + a] = dist <= dR[d]! ? dist / dR[d]! : BIG;
    }
  }
  // Back line first (the last line owns the attackers in its zones), then midfield for the rest.
  for (let pass = 1; pass >= 0; pass--) {
    for (let round = 0; round < dN; round++) {
      let bd = -1, ba = -1, bc = BIG;
      for (let d = 0; d < dN; d++) {
        if (dT[d] === 1 || dB[d] !== pass) continue;
        for (let a = 0; a < aN; a++) {
          if (aT[a] === 1) continue;
          const c = cost[d * N + a]!;
          if (c < bc) { bc = c; bd = d; ba = a; }
        }
      }
      if (bd < 0) break;
      dT[bd] = 1;
      aT[ba] = 1;
      markOne(s, dir, dS[bd]!, aS[ba]!, dB[bd] === 1);
    }
  }
}

/** Defender `i` marks attacker `slot`: goal-side of him on the line from him to our goal centre. */
function markOne(s: SimState, dir: number, i: number, slot: number, back: boolean): void {
  const line = EVAL.next;
  const q = s.players[slot]!;
  const qu = dir * q.x, qv = dir * q.z;
  const gx = -HALF_LENGTH - qu, gz = -qv;
  const gl = Math.sqrt(gx * gx + gz * gz);
  const gap = back ? LT.markGap : LT.markGapMid;
  let tu = gl > 1e-6 ? qu + (gx / gl) * gap : qu;
  let tv = gl > 1e-6 ? qv + (gz / gl) * gap : qv;
  if (back) {
    // Stay on the line: at most markStepOut in front, never behind it (an attacker behind the line stays offside).
    const hi = line + (LT.markStepOut < LT.maxStepOut ? LT.markStepOut : LT.maxStepOut);
    tu = clamp(tu, line, hi);
  } else if (tu < line + LT.midMarkMinGap) tu = line + LT.midMarkMinGap;
  tv = clamp(tv, -HALF_WIDTH + 1, HALF_WIDTH - 1);
  planU[i] = tu;
  planV[i] = tv;
  const top = s.attrs[i]!.topSpeed;
  assignJob(s, i, AiJob.MARK, dir * tu + 0, dir * tv + 0, top > 0 ? top : T_PLAYER.topSpeedMin, slot);
}

/** True if the point (LANE[4], LANE[5]) is within laneBlock of the lane in LANE[0..3] at fractions 0.15..0.9. */
function laneBlocked(): boolean {
  const cu = LANE[0]!, cv = LANE[1]!, lu = LANE[2]!, lv = LANE[3]!, pu = LANE[4]!, pv = LANE[5]!;
  const l2 = lu * lu + lv * lv;
  let f = l2 > 1e-9 ? ((pu - cu) * lu + (pv - cv) * lv) / l2 : 0;
  f = clamp(f, 0.15, 0.9);
  const du = cu + lu * f - pu, dv = cv + lv * f - pv;
  return du * du + dv * dv < LT.laneBlock * LT.laneBlock;
}

/** Cover open passing lanes from the carrier to the most dangerous opponents in / near our penalty area. */
function coverLanes(s: SimState, team: number, dir: number): void {
  const b = s.ball;
  const opp = otherTeam(team);
  const c = b.owner;
  if (b.heldBy >= 0 || !(c >= 0 && c < NUM_SLOTS) || s.players[c]!.team !== opp) return;
  const cp = s.players[c]!;
  const cu = dir * cp.x, cv = dir * cp.z;
  if (cu + HALF_LENGTH > LT.laneCarrierRange) return;
  const boxU = -HALF_LENGTH + PENALTY_AREA_DEPTH + LT.laneBoxMargin;
  const boxV = PENALTY_AREA_HALF_WIDTH + LT.laneBoxMargin;
  const os = teamStart(opp), oe = teamEnd(opp);
  for (let i = os; i < oe; i++) laneDone[i] = 0;
  lcN = 0;
  const ts = teamStart(team), te = teamEnd(team);
  for (let round = 0; round < LT.laneMax; round++) {
    // Most dangerous remaining receiver: the one nearest our goal line.
    let rs = -1, rBest = BIG;
    for (let i = os; i < oe; i++) {
      const r = s.players[i]!;
      if (i === c || laneDone[i] === 1 || r.active !== 1 || r.isKeeper === 1) continue;
      const ru = dir * r.x, rv = dir * r.z;
      if (ru > boxU || absv(rv) > boxV) continue;
      if (ru < rBest) { rBest = ru; rs = i; }
    }
    if (rs < 0) return;
    laneDone[rs] = 1;
    const r = s.players[rs]!;
    const ru = dir * r.x, rv = dir * r.z;
    // Already blocked by a team-mate (where he stands or is heading) or a cover placed this call?
    LANE[0] = cu; LANE[1] = cv; LANE[2] = ru - cu; LANE[3] = rv - cv;
    let blocked = false;
    for (let i = ts; i < te && !blocked; i++) {
      const p = s.players[i]!;
      if (p.active !== 1 || p.isKeeper === 1) continue;
      LANE[4] = dir * p.x; LANE[5] = dir * p.z;
      if (laneBlocked()) { blocked = true; break; }
      if (role[i] === 0 || p.job < AiJob.MARK) continue;
      LANE[4] = dir * p.tgtX; LANE[5] = dir * p.tgtZ;
      if (laneBlocked()) blocked = true;
    }
    for (let k = 0; k < lcN && !blocked; k++) {
      LANE[4] = lcU[k]!; LANE[5] = lcV[k]!;
      if (laneBlocked()) blocked = true;
    }
    if (blocked) { round--; continue; }
    // Nearest free midfielder (not a forward, not marking) to his cover point.
    const lu = ru - cu, lv = rv - cv;
    const l2 = lu * lu + lv * lv;
    let best = -1, bestD = LT.laneReach * LT.laneReach, bu = 0, bv = 0;
    for (let k = 0; k < midN; k++) {
      if (midL[k] === ShapeLine.FWD) continue;
      const i = midS[k]!;
      if (!free(s, i)) continue;
      const pu = planU[i]!, pv = planV[i]!;
      let f = l2 > 1e-9 ? ((pu - cu) * lu + (pv - cv) * lv) / l2 : 0;
      f = clamp(f, LT.laneTMin, LT.laneTMax);
      const xu = cu + lu * f, xv = cv + lv * f;
      const du = xu - pu, dv = xv - pv;
      const d = du * du + dv * dv;
      if (d < bestD) { bestD = d; best = i; bu = xu; bv = xv; }
    }
    if (best < 0) continue;
    lcU[lcN] = bu; lcV[lcN] = bv; lcN++;
    planU[best] = bu;
    planV[best] = bv;
    const top = s.attrs[best]!.topSpeed;
    assignJob(s, best, AiJob.COVER, dir * bu + 0, dir * bv + 0, top > 0 ? top : T_PLAYER.topSpeedMin, rs);
  }
}

/**
 * Line target for `team` in pitch x (before the rate limit), from the current state. Pure: writes nothing to state
 * (recomputes the members). For tests and tools; NaN outside IN_PLAY or when the team is not defending.
 */
export function defensiveLineTarget(s: SimState, team: number): number {
  if (s.match.phase !== MatchPhase.IN_PLAY || !isDefending(s, team)) return NaN;
  const t = s.teams[team]!;
  const dir = t.dir < 0 ? -1 : 1;
  const flags = teamFlags(s, team);
  resolveTactics(t.focus, flags, TP);
  collectMembers(s, team, dir, flags);
  evaluateLine(s, team, dir, (flags & TacticFlag.OFFSIDE_TRAP) !== 0);
  return dir * EVAL.target + 0;
}

/** Back-line member slots of `team` (formation DEF line + filled vacancies), written into `out`; returns count. */
export function backLineSlots(s: SimState, team: number, out: number[]): number {
  const t = s.teams[team]!;
  collectMembers(s, team, t.dir < 0 ? -1 : 1, teamFlags(s, team));
  for (let k = 0; k < backN; k++) out[k] = backS[k]!;
  return backN;
}

/** Exposed for tests and tuning tools (read-only). */
export const DEFSHAPE_TUNING = LOCAL_TUNING;
