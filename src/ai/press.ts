/**
 * [TAI-05] Pressing, cover, marking, tracking runners: press with the nearest man (team.pressSlot), cover with
 * the next (team.coverSlot), track runners, honour team.teamPress and the called second defender
 * (ctrl.secondDef); PRESS / COVER / TRACK_RUNNER jobs. Intensity from style + difficulty (TAI-12).
 *
 * Runs in the team AI pipeline (ai/index.ts) after the chaser (TAI-07) and the defensive shape (TAI-04: line,
 * zonal MARK, lane COVER) and before transitions (TAI-06 RECOVER). Job priorities (AiJob order) do the layering:
 * PRESS (10) beats everything but CHASE_LOOSE / RECEIVE / SET_PIECE; COVER (8) and TRACK_RUNNER (7) beat TAI-04's
 * MARK (6); in TRANSITION_DEFEND players caught upfield are left to TAI-06's RECOVER runs (9), which run after this
 * module, so a cover or tracker chosen here is never overridden.
 *
 * When it applies (IN_PLAY only; otherwise pressSlot = coverSlot = -1 and no jobs):
 *  - the opponents own the ball: the carrier is pressed (not a keeper holding it in his hands: then only runners
 *    are tracked);
 *  - an opponent pass is in flight (ball loose, last touch theirs, intended receiver theirs): the receiver is
 *    pressed at the reception point (ball.passX/Z), so the press arrives with the ball. Our loose-ball chaser
 *    (TAI-07 CHASE_LOOSE) is never a presser.
 *  Our ball, or a loose ball that is nobody's pass: nothing (TAI-07 chases it).
 *
 * Intensity I (0..1, teamPressIntensity): base = TAI-12 levelParams(cpu.level).pressIntensity for a CPU-driven team,
 * LOCAL_TUNING.humanPressIntensity otherwise; x the style factor styleBase + styleGain * styleWeights(style).press
 * (0.5 = neutral = 1); x focus pressScale, + team-press pressAdd (data/tactics resolveTactics, as pressIntensity());
 * + counterPressAdd in TRANSITION_DEFEND (counter-press right after losing the ball). I sets the standoff
 * (standoffMax .. standoffMin), the engage radius and the closing speed.
 *
 * Press (all in the defending team's frame through world vectors: positions mirror exactly with team.dir):
 *  - Reference point r = the carrier led by his velocity x pressLead (pass: the reception point). Goal-side unit g
 *    from r toward the centre of our goal, lateral unit l = g rotated 90 degrees.
 *  - Front spot = r + g * standoff (1.5..2.5 m): the presser stops goal-side of the carrier and jockeys facing the
 *    ball (TAI-07 steer turns lookAt on near a PRESS target; SIM-04 jockeys). A presser not yet goal-side aims
 *    arcStep (60 degrees) round from his bearing toward goal-side, tangent to the standoff circle, so he circles
 *    round the carrier at the standoff instead of running through him (frontSpot).
 *  - Primary presser P1 = the job-driven outfielder with the best arrival time (SIM-04 ticksToReach) at the front
 *    spot, x (1 + pressDutyPenalty * (1 - press duty)), the current team.pressSlot favoured by pressHystTicks.
 *    Human- or CPU-controlled players (p.ctrl >= 0) are never pressers: their controller moves them.
 *  - A controlled team-mate engaging the carrier (within ctlEngageDist and no further than P1 + ctlMargin) is the
 *    front presser: P1 then supports on the other side of the carrier (side spot, supportDist away; with team press
 *    at the standoff: two on the carrier). The AI presser is "the next, as a support".
 *  - Second defender: a teammate called by a controller of this team (ctrl.secondDef, SIM-15 MOD_R / 2ND DEF) is
 *    P1 regardless of arrival time and presses hard: hardStandoff goal-side of the ball itself (side spot when a
 *    controlled team-mate is engaging), always engaged, top speed. A second called defender (two humans) is P2.
 *  - Team press (team.teamPress; TacticParams.pressers = 2): P2 = the next best arrival at his own side spot (the
 *    side opposite P1's when P1 is on a side), standoff away: two pressers on the carrier. Otherwise at most one
 *    AI presser is ever on the carrier.
 *  - Engagement: an AI presser presses only within the engage radius R = T_AI.pressDistance x pressDistanceScale x
 *    (engageBase + engageGain * I) of the carrier (x dangerScale with the carrier in our defensive third; the
 *    current pressSlot keeps it up to engageKeep x R). team.pressSlot = the engaged P1, else -1.
 * Cover (with an engaged front presser, AI or controlled): team.coverSlot = best arrival (x cover duty penalty,
 *  current coverSlot favoured) at r + g * (standoff + coverGap) — behind the presser on the carrier's path to goal —
 *  outside our goal area and never deeper than our line (team.lineX, TAI-04) while the ball is in front of it
 *  (offside on), so a cover never plays anyone onside. Back-liners cover only at / behind the line (coverLineSlack);
 *  a TAI-04 lane cover is taken only at a penalty; roles below coverDutyMin never cover. In TRANSITION_DEFEND a
 *  player caught upfield (at or ahead of ball u - caughtMargin) is left to TAI-06's RECOVER run: never a cover or a
 *  tracker (TAI-06 runs after this module and would override COVER / TRACK_RUNNER on him).
 * Track runners (whenever the opponents have the ball or a pass in flight): opponents other than the carrier
 *  running toward our goal (>= runStart m/s, or >= runKeep while somebody is already running with them) whose
 *  position trackLook s ahead is in our defensive third and not flagged offside at the last pass (RUL-08) — most
 *  advanced first, at most trackMax — each get the best free midfielder / forward (track duty >= trackDutyMin,
 *  within trackRange): cost = distance to the track point / duty, minus alignBonus x his speed along the run
 *  (whoever is already running with the runner keeps him), with a bonus for the player TAI-04 had marking that
 *  runner and a penalty for leaving another mark. TRACK_RUNNER target:
 *  goal-side of the runner (led by trackLead) by trackGap, never deeper than our line while the ball is in front of
 *  it (offside on): a run from midfield is followed up to our line, where the back line (TAI-04: zonal MARK, line
 *  drops for onside runners) takes over; a zonal mark from the line never releases the tracker. Back-liners never
 *  track (the line is TAI-04's).
 * Speeds: pressers top x (speedMin .. 1 by I), hard pressers / covers / trackers top speed.
 * Determinism: + - * / sqrt only, slot-order loops with strict-< tie breaks, module scratch rewritten every call,
 * no allocation per tick. Hysteresis lives in SimState only (team.pressSlot / coverSlot; velocities for trackers).
 */
import {
  GOAL_AREA_DEPTH, HALF_LENGTH, HALF_WIDTH, NUM_CONTROLLERS, NUM_SLOTS, PLAYERS_PER_TEAM, TICK_HZ,
} from '../contracts/constants';
import { AiJob, ControllerKind, MatchPhase, TeamPhase } from '../contracts/enums';
import type { EventSink } from '../contracts/events';
import type { SimState, TeamState } from '../contracts/state';
import { T_AI, T_PLAYER } from '../contracts/tuning';
import { ShapeLine } from '../data/formations';
import { createTacticParams, phaseOffset, resolveTactics, rolePreset, slotLineFor, slotRole, tacticFlags } from '../data/tactics';
import { otherTeam, teamEnd, teamStart } from '../sim/core/query';
import { ticksToReach } from '../sim/players/locomotion';
import { levelParams, styleWeights } from './cpu/levels';
import { assignJob, isJobDriven } from './jobs';

export const LOCAL_TUNING = {
  // ---- intensity (0..1)
  /** Base press intensity of a team without a CPU brain (human sides): T_LEVEL.pressIntensity of Professional. */
  humanPressIntensity: 0.75,
  /** Style factor on the base: styleBase + styleGain * StyleWeights.press (TAI-12; 0.5 = neutral = x1), clamped. */
  styleBase: 0.5,
  styleGain: 1,
  styleMin: 0.6,
  styleMax: 1.4,
  /** Added intensity while the team is in TRANSITION_DEFEND (counter-press). */
  counterPressAdd: 0.1,
  // ---- engagement
  /** Engage radius = T_AI.pressDistance x pressDistanceScale x (engageBase + engageGain * I), multipliers. */
  engageBase: 0.6,
  engageGain: 0.8,
  /** Engage radius multiplier with the carrier in our defensive third. */
  dangerScale: 1.5,
  /** Our defensive third: within this distance of our goal line, m. */
  dangerDepth: 35,
  /** The current pressSlot keeps engaging up to this multiple of the engage radius (hysteresis). */
  engageKeep: 1.25,
  // ---- presser choice
  /** Arrival-time bonus of the current presser / cover (hysteresis), ticks. */
  pressHystTicks: 10,
  coverHystTicks: 15,
  /** Arrival time x (1 + penalty * (1 - duty)) for low press / cover duty (data/tactics duties). */
  pressDutyPenalty: 0.3,
  coverDutyPenalty: 0.5,
  // ---- press spots
  /** Standoff goal-side of the carrier: standoffMax at intensity 0 .. standoffMin at 1, m. */
  standoffMax: 2.5,
  standoffMin: 1.5,
  /** Hard press (called second defender): this far goal-side of the ball, m. */
  hardStandoff: 0.7,
  /** The carrier is led by his velocity times this, s. */
  pressLead: 0.25,
  /** Presser speed cap: top speed x (speedMin at intensity 0 .. 1 at 1). */
  speedMin: 0.8,
  /** A presser more than arcStep (cos, sin: 60 degrees) round from goal-side of the carrier aims arcStep further
   *  round toward goal-side, tangent to the standoff circle (he circles round the carrier, never through him). */
  arcStepCos: 0.5,
  arcStepSin: 0.8660254037844386,
  /** Side spot direction from the carrier: goal-side x sideAlong + lateral x sideLat (unit length). */
  sideAlong: 0.5,
  sideLat: 0.8660254037844386,
  /** Support presser (a controlled team-mate is the front presser): distance from the carrier, m. */
  supportDist: 4.5,
  /** A controlled team-mate engages the carrier within this distance, m ... */
  ctlEngageDist: 5,
  /** ... and no further from him than the AI presser + ctlMargin, m. */
  ctlMargin: 1.5,
  // ---- cover
  /** Cover point: standoff + coverGap from the carrier toward our goal, m. */
  coverGap: 5,
  /** Roles whose cover duty (x phase and focus duty scales) is below this never cover. */
  coverDutyMin: 0.3,
  /** Back-liners cover only when the cover point is at most this far in front of our line, m. */
  coverLineSlack: 3,
  /** The cover point stays this far outside our goal area, m. */
  coverBoxMargin: 1,
  /** Max arrival time of a cover, ticks. */
  coverMaxTicks: 240,
  /** Extra cost for taking a player off a TAI-04 lane cover (COVER), ticks. */
  laneCoverPenalty: 30,
  /** In TRANSITION_DEFEND a player at or ahead of (ball u - caughtMargin) is caught upfield: TAI-06's RECOVER run
   *  (its goalSideMargin), never a cover or a tracker here, m. */
  caughtMargin: 1,
  // ---- track runners
  /** Max runners tracked at once. */
  trackMax: 3,
  /** Speed toward our goal that makes a run, m/s; a run already being tracked stays one down to runKeep. */
  runStart: 3.5,
  runKeep: 2,
  /** A run counts when the runner's position this far ahead is in our defensive third, s. */
  trackLook: 0.6,
  /** Track point: the runner led by trackLead s, then trackGap m goal-side of that. */
  trackLead: 0.4,
  trackGap: 1.5,
  /** Trackers come from within this distance of the runner, m. */
  trackRange: 12,
  /** Roles whose track duty (x scales) is below this never track. */
  trackDutyMin: 0.4,
  /** Cost bonus per m/s of a candidate's speed along the run (keeps the tracker who runs with him), s. */
  alignBonus: 0.5,
  /** A candidate within this of the runner running with him at >= runKeep keeps a slowing run tracked, m. */
  trackKeepDist: 4,
  /** Cost bonus for the player TAI-04 had marking this runner / penalty for leaving another mark, m. */
  markBonus: 4,
  markPenalty: 6,
  // ---- geometry
  /** Targets stay this far inside the touchlines and goal lines, m. */
  edge: 0.5,
  /** Lower-bound slack for skipping hopeless arrival-time evaluations, m (> SIM-04 reachRadius). */
  lbSlack: 1.5,
} as const; // TUNING-CR

const LT = LOCAL_TUNING;
const N = PLAYERS_PER_TEAM;
const BIG = 1e9;
const X_MAX = HALF_LENGTH - LT.edge;
const Z_MAX = HALF_WIDTH - LT.edge;

// ---------------------------------------------------------------- scratch (rewritten every call; never state)

const TP = createTacticParams();
/** 1 = job-driven outfielder of the team being processed. */
const ELIG = new Uint8Array(NUM_SLOTS);
/** 1 = already given a job by this module this call. */
const USED = new Uint8Array(NUM_SLOTS);
/** 1 = back-line member (formation DEF line under the active quick tactics). */
const BACK = new Uint8Array(NUM_SLOTS);
/** 1 = caught upfield in TRANSITION_DEFEND (TAI-06 sends him on a RECOVER run): no cover / track job. */
const CAUGHT = new Uint8Array(NUM_SLOTS);
/** Press / cover / track duty (x phase and focus duty scales). */
const DP = new Float64Array(NUM_SLOTS);
const DC = new Float64Array(NUM_SLOTS);
const DTR = new Float64Array(NUM_SLOTS);
/** Runners (opponent slots) sorted by u ascending, and their u. */
const RUN = new Int32Array(N);
const RUNU = new Float64Array(N);
let runN = 0;
/**
 * Numbers handed between helpers (V8 boxes doubles crossing a call it does not inline): GEO holds the press
 * geometry of the current call, SPOT the point written by spot helpers.
 */
const GEO = new Float64Array(10);
const G_RX = 0; // reference point (world)
const G_RZ = 1;
const G_GX = 2; // goal-side unit
const G_GZ = 3;
const G_LX = 4; // lateral unit (g rotated +90 degrees)
const G_LZ = 5;
const G_HX = 6; // hard-press base point (the ball; the reception point for a pass)
const G_HZ = 7;
const G_SO = 8; // standoff, m
const SPOT = new Float64Array(2);

// ---------------------------------------------------------------- helpers

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clampAbs(v: number, lim: number): number { return v > lim ? lim : v < -lim ? -lim : v; }
function finite(v: number): boolean { return v - v === 0; }
/** +1 for >= 0, -1 otherwise (a deterministic side for ties). */
function sideOf(v: number): number { return v >= 0 ? 1 : -1; }

function clearSlots(t: TeamState): void {
  t.pressSlot = -1;
  t.coverSlot = -1;
}

/**
 * Press intensity 0..1 of a team (see the header): TAI-12 level (CPU team) or the human default, x the style
 * factor, x focus pressScale, + team-press pressAdd, + counterPressAdd in TRANSITION_DEFEND.
 */
export function teamPressIntensity(s: SimState, team: number): number {
  const t = s.teams[team]!;
  resolveTactics(t.focus, tacticFlags(t), TP);
  return intensityFromTP(t);
}

/** Intensity with TP already resolved for team t. */
function intensityFromTP(t: TeamState): number {
  const brain = t.cpu;
  let base = brain.active === 1 ? levelParams(brain.level).pressIntensity : LT.humanPressIntensity;
  if (!finite(base)) base = LT.humanPressIntensity;
  let sk = LT.styleBase + LT.styleGain * styleWeights(t.style).press;
  sk = finite(sk) ? (sk < LT.styleMin ? LT.styleMin : sk > LT.styleMax ? LT.styleMax : sk) : 1;
  let v = base * sk * TP.pressScale + TP.pressAdd;
  if (t.phase === TeamPhase.TRANSITION_DEFEND) v += LT.counterPressAdd;
  return finite(v) ? clamp01(v) : clamp01(base);
}

/** Engage radius of the press for intensity I, with the carrier in our defensive third or not, m. */
export function pressEngageRadius(intensity: number, danger: boolean, distanceScale: number): number {
  const r = T_AI.pressDistance * distanceScale * (LT.engageBase + LT.engageGain * clamp01(intensity));
  return danger ? r * LT.dangerScale : r;
}

/** Standoff goal-side of the carrier for intensity I, m. */
export function pressStandoff(intensity: number): number {
  return LT.standoffMax + (LT.standoffMin - LT.standoffMax) * clamp01(intensity);
}

/** SPOT = (bx, bz) + (g * sideAlong + l * side * sideLat) * dist, clamped to the pitch. */
function sideSpot(bx: number, bz: number, side: number, dist: number): void {
  const ux = GEO[G_GX]! * LT.sideAlong + GEO[G_LX]! * side * LT.sideLat;
  const uz = GEO[G_GZ]! * LT.sideAlong + GEO[G_LZ]! * side * LT.sideLat;
  SPOT[0] = clampAbs(bx + ux * dist, X_MAX);
  SPOT[1] = clampAbs(bz + uz * dist, Z_MAX);
}

/**
 * SPOT = the press spot for the player at slot round (bx, bz) at `dist`: goal-side (g) once he is goal-side. A
 * presser whose bearing round the reference point is more than arcStep from goal-side aims at his bearing rotated
 * arcStep toward goal-side (on the side he is on) at radius dist / cos(arcStep); within arcStep, at the g ray at
 * radius dist / cos(bearing angle). From any point of the standoff circle that aim is tangent to the circle, so he
 * circles round the carrier at the standoff (pure pursuit of a point on the circle would spiral inward) and arrives
 * on the goal-side spot.
 */
function frontSpot(s: SimState, slot: number, bx: number, bz: number, dist: number): void {
  const p = s.players[slot]!;
  const gx = GEO[G_GX]!, gz = GEO[G_GZ]!;
  let ux = gx, uz = gz;
  let r = dist;
  let ax = p.x - GEO[G_RX]!, az = p.z - GEO[G_RZ]!;
  const al = Math.sqrt(ax * ax + az * az);
  if (al > 1e-6) {
    ax /= al;
    az /= al;
    const c = ax * gx + az * gz;
    if (c < LT.arcStepCos) {
      // Rotate the bearing toward g (cross(a, g) > 0: g lies on the +90 degree side of a).
      const cr = ax * gz - az * gx;
      const sg = cr > 0 ? 1 : cr < 0 ? -1 : sideOf(ax * GEO[G_LX]! + az * GEO[G_LZ]!);
      ux = ax * LT.arcStepCos - az * LT.arcStepSin * sg;
      uz = az * LT.arcStepCos + ax * LT.arcStepSin * sg;
      r = dist / LT.arcStepCos;
    } else {
      r = dist / c;
    }
  }
  SPOT[0] = clampAbs(bx + ux * r, X_MAX);
  SPOT[1] = clampAbs(bz + uz * r, Z_MAX);
}

function topOf(s: SimState, slot: number): number {
  const v = s.attrs[slot]!.topSpeed;
  return v > 0 ? v : T_PLAYER.topSpeedMin;
}

/**
 * Arrival-time cost of slot at (x, z) or BIG when a straight-line lower bound already reaches `limit`
 * (cost = (ticksToReach + stun) * pen - bonus).
 */
function arrivalCost(s: SimState, slot: number, x: number, z: number, pen: number, bonus: number, limit: number): number {
  const p = s.players[slot]!;
  const dx = x - p.x, dz = z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  const top = topOf(s, slot);
  const vmax = (sp > top ? sp : top) * 1.05;
  const lb = d > LT.lbSlack ? ((d - LT.lbSlack) / vmax) * TICK_HZ : 0;
  if (lb * pen - bonus >= limit) return BIG;
  const stun = p.stunT > 0 ? p.stunT : 0;
  const t = ticksToReach(s, slot, x, z) + stun;
  return (t < BIG ? t : BIG) * pen - bonus;
}

// ---------------------------------------------------------------- main

export function assignPressing(s: SimState, team: number, ev: EventSink): void {
  const t = s.teams[team]!;
  if (s.match.phase !== MatchPhase.IN_PLAY) { clearSlots(t); return; }
  const opp = otherTeam(team);
  const b = s.ball;
  const P = s.players;

  // ---- who has the ball: carrier (or pass receiver), reference point, hard-press base
  let carrier: number;
  let pressable = 0;
  let cx: number, cz: number;
  const owner = b.owner;
  if (owner >= 0 && owner < NUM_SLOTS && (owner | 0) === owner) {
    const o = P[owner]!;
    if (o.team !== opp) { clearSlots(t); return; }
    carrier = owner;
    cx = o.x;
    cz = o.z;
    if (b.heldBy < 0) {
      pressable = 1;
      let vx = o.vx, vz = o.vz;
      if (!finite(vx) || !finite(vz)) { vx = 0; vz = 0; }
      GEO[G_RX] = cx + vx * LT.pressLead;
      GEO[G_RZ] = cz + vz * LT.pressLead;
      GEO[G_HX] = b.x;
      GEO[G_HZ] = b.z;
    }
  } else if (owner === -1 && b.heldBy < 0 && b.lastTouchTeam === opp) {
    const r = b.passTarget;
    if (!(r >= 0 && r < NUM_SLOTS && (r | 0) === r) || P[r]!.team !== opp || P[r]!.active !== 1) { clearSlots(t); return; }
    carrier = r;
    pressable = 1;
    cx = b.passX;
    cz = b.passZ;
    if (!finite(cx) || !finite(cz)) { cx = P[r]!.x; cz = P[r]!.z; }
    GEO[G_RX] = cx;
    GEO[G_RZ] = cz;
    GEO[G_HX] = cx;
    GEO[G_HZ] = cz;
  } else {
    clearSlots(t);
    return;
  }
  if (!finite(cx) || !finite(cz) || !finite(GEO[G_RX]!) || !finite(GEO[G_RZ]!) || !finite(GEO[G_HX]!) || !finite(GEO[G_HZ]!)) {
    clearSlots(t);
    return;
  }
  cx = clampAbs(cx, X_MAX);
  cz = clampAbs(cz, Z_MAX);
  GEO[G_RX] = clampAbs(GEO[G_RX]!, X_MAX);
  GEO[G_RZ] = clampAbs(GEO[G_RZ]!, Z_MAX);

  const dir = t.dir < 0 ? -1 : 1;
  const flags = tacticFlags(t);
  resolveTactics(t.focus, flags, TP);
  const I = intensityFromTP(t);
  const dutyK = phaseOffset(t.phase).dutyScale * TP.dutyScale;
  let lineU = dir * t.lineX;
  if (!finite(lineU)) lineU = -BIG;
  let bu = dir * b.x;
  if (!finite(bu)) bu = dir * cx;
  const offsideOn = s.config.offside === 1;
  /** Our line is the offside line that matters: nobody of ours drops deeper than it. */
  const holdLine = offsideOn && bu > lineU;
  const recovering = t.phase === TeamPhase.TRANSITION_DEFEND;
  const caughtU = bu - LT.caughtMargin;

  // ---- members: job-driven outfielders and their duties; the nearest controlled team-mate
  const start = teamStart(team);
  const end = teamEnd(team);
  const fi = t.formation;
  let ctl = -1;
  let ctlD = BIG;
  for (let i = start; i < end; i++) {
    ELIG[i] = 0;
    USED[i] = 0;
    BACK[i] = 0;
    CAUGHT[i] = 0;
    const p = P[i]!;
    if (p.active !== 1 || p.isKeeper === 1) continue;
    if (p.ctrl >= 0) {
      const dx = p.x - cx, dz = p.z - cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < ctlD) { ctlD = d; ctl = i; }
      continue;
    }
    if (!isJobDriven(s, i)) continue;
    ELIG[i] = 1;
    const f = p.formIdx;
    const duties = rolePreset(slotRole(fi, f, flags)).duties;
    DP[i] = duties.press * dutyK;
    DC[i] = duties.cover * dutyK;
    DTR[i] = duties.track * dutyK;
    BACK[i] = slotLineFor(fi, f, flags) === ShapeLine.DEF ? 1 : 0;
    if (recovering && !(dir * p.x < caughtU)) CAUGHT[i] = 1;
  }

  let pressSlot = -1;
  let coverSlot = -1;
  if (pressable === 1) {
    // ---- geometry
    const rx = GEO[G_RX]!, rz = GEO[G_RZ]!;
    let gx = -dir * HALF_LENGTH - rx;
    let gz = -rz;
    const gl = Math.sqrt(gx * gx + gz * gz);
    if (gl > 1e-6) { gx /= gl; gz /= gl; } else { gx = -dir; gz = 0; }
    GEO[G_GX] = gx;
    GEO[G_GZ] = gz;
    GEO[G_LX] = -gz;
    GEO[G_LZ] = gx;
    const so = pressStandoff(I);
    GEO[G_SO] = so;
    const fx = clampAbs(rx + gx * so, X_MAX);
    const fz = clampAbs(rz + gz * so, Z_MAX);
    const cu = dir * cx;
    const R = pressEngageRadius(I, cu <= -HALF_LENGTH + LT.dangerDepth, TP.pressDistanceScale);
    const softFrac = LT.speedMin + (1 - LT.speedMin) * I;

    // ---- called second defenders (controllers of this team)
    let sd1 = -1;
    let sd2 = -1;
    for (let c = 0; c < NUM_CONTROLLERS; c++) {
      const k = s.ctrl[c]!;
      if (k.kind === ControllerKind.NONE) continue;
      const sd = k.secondDef;
      if (!(sd >= start && sd < end && (sd | 0) === sd) || ELIG[sd] !== 1 || P[sd]!.job > AiJob.PRESS) continue;
      if (sd1 < 0) sd1 = sd;
      else if (sd !== sd1 && sd2 < 0) sd2 = sd;
    }

    // ---- primary presser: best arrival at the front spot (current presser favoured)
    let best = -1;
    let bestC = BIG;
    for (let i = start; i < end; i++) {
      if (ELIG[i] !== 1 || P[i]!.job > AiJob.PRESS) continue;
      const pen = 1 + LT.pressDutyPenalty * (1 - clamp01(DP[i]!));
      const c = arrivalCost(s, i, fx, fz, pen, i === t.pressSlot ? LT.pressHystTicks : 0, bestC);
      if (c < bestC) { bestC = c; best = i; }
    }
    const hard1 = sd1 >= 0;
    const p1 = hard1 ? sd1 : best;

    // ---- a controlled team-mate engaging the carrier is the front presser
    let humanFront = false;
    if (ctl >= 0 && ctlD <= LT.ctlEngageDist) {
      if (hard1 || p1 < 0) humanFront = true;
      else {
        const q = P[p1]!;
        const dx = q.x - cx, dz = q.z - cz;
        humanFront = ctlD <= Math.sqrt(dx * dx + dz * dz) + LT.ctlMargin;
      }
    }

    // ---- P1 spot and engagement
    let side1 = 0;
    let eng1 = false;
    if (p1 >= 0) {
      const q = P[p1]!;
      if (humanFront) {
        const c = P[ctl]!;
        side1 = -sideOf((c.x - rx) * GEO[G_LX]! + (c.z - rz) * GEO[G_LZ]!);
        if (hard1) sideSpot(GEO[G_HX]!, GEO[G_HZ]!, side1, LT.hardStandoff);
        else sideSpot(rx, rz, side1, TP.pressers >= 2 ? so : LT.supportDist);
      } else if (hard1) {
        frontSpot(s, p1, GEO[G_HX]!, GEO[G_HZ]!, LT.hardStandoff);
      } else {
        frontSpot(s, p1, rx, rz, so);
      }
      if (hard1) eng1 = true;
      else {
        const dx = q.x - cx, dz = q.z - cz;
        eng1 = Math.sqrt(dx * dx + dz * dz) <= R * (p1 === t.pressSlot ? LT.engageKeep : 1);
      }
      if (eng1) {
        const top = topOf(s, p1);
        if (assignJob(s, p1, AiJob.PRESS, SPOT[0]!, SPOT[1]!, hard1 ? top : top * softFrac, carrier)) {
          USED[p1] = 1;
          pressSlot = p1;
        } else eng1 = false;
      }
    }

    // ---- second presser: another called defender, or team press
    const wantAi = humanFront ? 1 : TP.pressers;
    let p2 = -1;
    let side2 = 0;
    let hard2 = false;
    if (sd2 >= 0 && USED[sd2] !== 1) {
      p2 = sd2;
      hard2 = true;
      side2 = side1 !== 0 ? -side1 : sideOf((P[sd2]!.x - rx) * GEO[G_LX]! + (P[sd2]!.z - rz) * GEO[G_LZ]!);
    } else if (wantAi >= 2 && eng1) {
      let c2 = BIG;
      for (let i = start; i < end; i++) {
        if (ELIG[i] !== 1 || USED[i] === 1 || P[i]!.job > AiJob.PRESS) continue;
        const q = P[i]!;
        const sd = side1 !== 0 ? -side1 : sideOf((q.x - rx) * GEO[G_LX]! + (q.z - rz) * GEO[G_LZ]!);
        sideSpot(rx, rz, sd, so);
        const pen = 1 + LT.pressDutyPenalty * (1 - clamp01(DP[i]!));
        const c = arrivalCost(s, i, SPOT[0]!, SPOT[1]!, pen, 0, c2);
        if (c < c2) { c2 = c; p2 = i; side2 = sd; }
      }
    }
    if (p2 >= 0) {
      const q = P[p2]!;
      let eng2 = hard2;
      if (!eng2) {
        const dx = q.x - cx, dz = q.z - cz;
        eng2 = Math.sqrt(dx * dx + dz * dz) <= R;
      }
      if (eng2) {
        if (hard2) sideSpot(GEO[G_HX]!, GEO[G_HZ]!, side2, LT.hardStandoff);
        else sideSpot(rx, rz, side2, so);
        const top = topOf(s, p2);
        if (assignJob(s, p2, AiJob.PRESS, SPOT[0]!, SPOT[1]!, hard2 ? top : top * softFrac, carrier)) USED[p2] = 1;
      }
    }

    // ---- cover behind the front presser on the carrier's path to goal
    if (eng1 || humanFront) {
      const cd = so + LT.coverGap;
      let ku = dir * (rx + gx * cd);
      const kv = dir * (rz + gz * cd);
      const kuMin = -HALF_LENGTH + GOAL_AREA_DEPTH + LT.coverBoxMargin;
      if (ku < kuMin) ku = kuMin;
      if (holdLine && ku < lineU) ku = lineU;
      const kx = clampAbs(dir * ku, X_MAX);
      const kz = clampAbs(dir * kv, Z_MAX);
      const backOk = ku <= lineU + LT.coverLineSlack;
      let cBest: number = LT.coverMaxTicks;
      for (let i = start; i < end; i++) {
        if (ELIG[i] !== 1 || USED[i] === 1 || CAUGHT[i] === 1) continue;
        const q = P[i]!;
        if (q.job > AiJob.COVER || DC[i]! < LT.coverDutyMin || (BACK[i] === 1 && !backOk)) continue;
        const pen = 1 + LT.coverDutyPenalty * (1 - clamp01(DC[i]!));
        const bonus = (i === t.coverSlot ? LT.coverHystTicks : 0) - (q.job === AiJob.COVER ? LT.laneCoverPenalty : 0);
        const c = arrivalCost(s, i, kx, kz, pen, bonus, cBest);
        if (c < cBest) { cBest = c; coverSlot = i; }
      }
      if (coverSlot >= 0) {
        if (assignJob(s, coverSlot, AiJob.COVER, kx, kz, topOf(s, coverSlot), carrier)) USED[coverSlot] = 1;
        else coverSlot = -1;
      }
    }
  }
  t.pressSlot = pressSlot;
  t.coverSlot = coverSlot;

  trackRunners(s, team, opp, carrier, dir, lineU, holdLine);
}

// ---------------------------------------------------------------- track runners

/** True if a job-driven candidate of `team` within trackKeepDist of runner j runs with him at >= runKeep. */
function runnerTracked(s: SimState, team: number, j: number, ux: number, uz: number): boolean {
  const q = s.players[j]!;
  const r2 = LT.trackKeepDist * LT.trackKeepDist;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    if (ELIG[i] !== 1) continue;
    const p = s.players[i]!;
    const dx = p.x - q.x, dz = p.z - q.z;
    if (dx * dx + dz * dz > r2) continue;
    if (p.vx * ux + p.vz * uz >= LT.runKeep) return true;
  }
  return false;
}

function trackRunners(s: SimState, team: number, opp: number, carrier: number, dir: number, lineU: number, holdLine: boolean): void {
  const P = s.players;
  const off = s.match.offside;
  const flagged = off.passTeam === opp ? off.flags : 0;
  const thirdU = -HALF_LENGTH + LT.dangerDepth;
  // ---- runners, most advanced (lowest u) first
  runN = 0;
  const oEnd = teamEnd(opp);
  for (let j = teamStart(opp); j < oEnd; j++) {
    const q = P[j]!;
    if (q.active !== 1 || q.isKeeper === 1 || j === carrier) continue;
    if (((flagged >>> j) & 1) === 1) continue;
    const u = dir * q.x;
    const vu = dir * q.vx;
    if (!finite(u) || !finite(vu) || !finite(q.z) || !finite(q.vz)) continue;
    const fs = -vu;
    if (fs < LT.runKeep) continue;
    if (u + vu * LT.trackLook > thirdU) continue;
    const sp = Math.sqrt(q.vx * q.vx + q.vz * q.vz);
    if (fs < LT.runStart && !runnerTracked(s, team, j, q.vx / sp, q.vz / sp)) continue;
    let k = runN++;
    while (k > 0 && RUNU[k - 1]! > u) { RUN[k] = RUN[k - 1]!; RUNU[k] = RUNU[k - 1]!; k--; }
    RUN[k] = j;
    RUNU[k] = u;
  }
  // ---- one tracker per runner
  const start = teamStart(team);
  const end = teamEnd(team);
  const range2 = LT.trackRange * LT.trackRange;
  let tracked = 0;
  for (let r = 0; r < runN && tracked < LT.trackMax; r++) {
    const j = RUN[r]!;
    const q = P[j]!;
    const sp = Math.sqrt(q.vx * q.vx + q.vz * q.vz);
    const ux = q.vx / sp, uz = q.vz / sp;
    // track point (team frame): runner led, then goal-side
    let lu = dir * (q.x + q.vx * LT.trackLead);
    let lv = dir * (q.z + q.vz * LT.trackLead);
    let gu = -HALF_LENGTH - lu;
    let gv = -lv;
    const gl = Math.sqrt(gu * gu + gv * gv);
    if (gl > 1e-6) { gu /= gl; gv /= gl; } else { gu = -1; gv = 0; }
    lu += gu * LT.trackGap;
    lv += gv * LT.trackGap;
    if (holdLine && lu < lineU) lu = lineU;
    const tx = clampAbs(dir * lu, X_MAX);
    const tz = clampAbs(dir * lv, Z_MAX);
    let best = -1;
    let bestC = BIG;
    for (let i = start; i < end; i++) {
      if (ELIG[i] !== 1 || USED[i] === 1 || BACK[i] === 1 || CAUGHT[i] === 1) continue;
      const p = P[i]!;
      if (p.job > AiJob.TRACK_RUNNER || DTR[i]! < LT.trackDutyMin) continue;
      const rdx = p.x - q.x, rdz = p.z - q.z;
      if (rdx * rdx + rdz * rdz > range2) continue;
      const dx = tx - p.x, dz = tz - p.z;
      let c = Math.sqrt(dx * dx + dz * dz) / DTR[i]!;
      const along = p.vx * ux + p.vz * uz;
      if (along > 0) c -= LT.alignBonus * along;
      if (p.job === AiJob.MARK) c += p.jobSlot === j ? -LT.markBonus : LT.markPenalty;
      if (c < bestC) { bestC = c; best = i; }
    }
    if (best >= 0 && assignJob(s, best, AiJob.TRACK_RUNNER, tx, tz, topOf(s, best), j)) {
      USED[best] = 1;
      tracked++;
    }
  }
}

/** Exposed for tests and tuning tools (read-only). */
export const PRESS_TUNING = LOCAL_TUNING;
