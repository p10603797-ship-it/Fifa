/**
 * [TAI-03] Attacking runs: in behind while staying onside (time the run against the offside line), overlaps
 * from full-back when there is cover, late arrivals in the box from midfield; RUN_IN_BEHIND / OVERLAP /
 * LATE_RUN jobs. Trigger-run input (L1 tap / THROUGH swipe down) sends the best runner (triggerRun).
 *
 * Design (BRIEF §7 "run in behind while staying onside, overlap from full-back when there is cover, and arrive
 * late in the box from midfield. Trigger-run and call-for-support inputs override."; §9/§10 trigger run; SIM-08
 * pass and go). All maths in the team frame u = dir * x (progress toward the opposition goal), v = dir * z, so one
 * code path serves both attack directions and the result is mirrored exactly.
 *  - Anchor: our ball owner (the carrier), or, while our pass / cross is in flight, its reception point (the next
 *    pass is played from there). Opponent ball -> explicit runs are cancelled, no jobs. Loose ball that is not our
 *    pass -> no jobs.
 *  - Onside limit (u): max(offside line, anchor, halfway) - onsideMargin, where the offside line is the opponents'
 *    second-last defender (query.secondLastDefenderX, keeper included) and also its position predicted
 *    lineLookahead ahead from the defenders' velocities (the deeper of the two: a line stepping up never catches a
 *    runner). Every automatic target before the pass is clamped to it; a runner caught beyond it hurries back.
 *    With offside switched off (config.offside = 0) the limit is lifted to the behind-the-line target.
 *  - Runs in behind (roles with an in-behind tendency, weights from data/tactics.ts x phase x tactic): when a
 *    through ball is on (space behind the line, the run's lane within throughRange of the ball) the runner
 *      waiting:  holds on the line (launchDepth behind the onside target, at his home lane) at jog speed;
 *      running:  when the carrier looks up (facing forward, not pressed, or winding up a pass) he sprints to the
 *                line in his lane: the gap between back-line defenders (CB-FB, CB-CB) nearest to him, so the run
 *                curves across the line instead of straight into a defender; two runners keep their lanes apart;
 *      released: once the carrier is in a pass wind-up (KICK with a pass kind, not charging) and the runner,
 *                accelerating flat out, provably cannot pass the limit before the contact tick, the target moves
 *                beyond the line (behindDepth, lane bent in toward goal by curveIn). He crosses the line just as
 *                the ball is played: onside at the pass, at speed, and SIM-10 leads him into space.
 *    Hysteresis without memory: a runner already moving forward (>= commitSpeed) keeps running on a relaxed
 *    look-up test. During our pass in flight the line is judged against the reception point (next pass).
 *    A midfielder (non-forward role) making the run from behind the ball respects the rest defence (below).
 *  - Overlaps: a full-back / wing-back on the ball side runs outside and beyond the carrier when the ball is in the
 *    wide channel ahead of him, a teammate covers behind him (deeper, on his flank) and the rest defence holds
 *    (TacticParams.restDefenders behind the ball). Target overlapAhead beyond the ball, overlapWide outside it.
 *  - Box attack: with the ball in the crossing zone (or our cross in flight) the BOX_SPOTS (near post, far post,
 *    penalty spot, back post, edge) are filled: forwards attack them (RUN_IN_BEHIND), midfielders arrive late
 *    (LATE_RUN): they stage just outside the box and sprint in when the cross is imminent (carrier near the byline
 *    or in a cross / lob wind-up) or played. Onside clamp until the cross. Rest defence respected.
 *  - Budget: at most min(TacticParams.maxRunners, maxRunnersHard) runners (in behind + overlaps; 2 with the
 *    defending focus, 3 otherwise); runner jobs other modules gave this tick (TAI-06 counters) count too. Best
 *    weights first; the others hold (shape / support). Attacking the box: max(that, boxRunners) box attackers
 *    (default 3, GET_IN_BOX 4) plus at most one overlap outside the winger (so an overlap in progress is not
 *    abandoned when the ball enters the crossing zone). A TAI-02 supporter whose role prefers support over runs
 *    stays a supporter.
 *  - Explicit runs override: pass and go (SIM-08 sets team.passGoSlot/passGoT at contact): the passer sprints
 *    forward (passGoAhead) and away from the receiver, onside-clamped, released like a run in behind;
 *    triggerRun (human L1 tap): the best-placed runner (role tendency, near the line and the ball) gets
 *    team.runSlot / runCallT = runCallSeconds and runs in behind IMMEDIATELY (no waiting, not clamped: the human
 *    asked for the run and times the pass, as on a console). Both are cancelled when the opponents win the ball,
 *    when the runner receives it, and (stale) on the first IN_PLAY tick after a stoppage; they count down here.
 * Evaluation runs every tick and is a pure function of the current state (no memory outside SimState: snapshot
 * resync, replays and interleaved matches stay bit-identical). Module scratch is rewritten before every use;
 * doubles go through the Float64Array scratch so per-tick code allocates nothing. No events (no run event type).
 */
import { CROSS_ZONE_DEPTH, CROSS_ZONE_MIN_Z, DT, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, secToTicks } from '../contracts/constants';
import { ActionKind, AiJob, KickKind, MatchPhase, Role, TeamPhase } from '../contracts/enums';
import type { EventSink } from '../contracts/events';
import type { SimState, TeamState } from '../contracts/state';
import { T_RULES } from '../contracts/tuning';
import { BOX_SPOTS, createTacticParams, phaseOffset, resolveTactics, rolePreset, tacticFlags } from '../data/tactics';
import { otherTeam, secondLastDefenderX, teamEnd, teamStart } from '../sim/core/query';
import { assignJob, isJobDriven } from './jobs';

/** TUNING-CR: move into contracts/tuning.ts as T_RUNS. */
export const LOCAL_TUNING = {
  /** Hard cap on simultaneous runners (in behind + overlaps); the tactic's maxRunners is clamped to it, count. */
  maxRunnersHard: 3,
  /** Box attackers on a cross when the tactic sets none (GET_IN_BOX sets 4), count. */
  boxRunnersDefault: 3,
  /** Minimum run weight (role tendency x phase runScale x tactic runScale) for an automatic run, 0..1. */
  minRunWeight: 0.3,
  /** Targets before the pass stay this far behind the onside limit, m. */
  onsideMargin: 1.0,
  /** Release: the runner's furthest possible position at the pass contact stays this far behind the limit, m. */
  releaseMargin: 0.3,
  /** Safety factor on the acceleration used to bound a runner's progress until the contact (>= 1). */
  releaseAccelSafety: 1.25,
  /** The offside line is also predicted this far ahead from the defenders' velocities (deeper one used), s. */
  lineLookahead: 0.3,
  /** A through ball is on when the run's lane point on the line is within this distance of the ball, m ... */
  throughRange: 42,
  /** ... and at least this much room lies between the line and the goal-line margin (behindGoalMargin), m. */
  minSpaceBehind: 6,
  /** Released / triggered run target this far beyond the line, m, but not closer to the goal line than
   *  behindGoalMargin, m. */
  behindDepth: 11,
  behindGoalMargin: 6,
  /** Lane v behind the line as a fraction of the lane v at the line (< 1 bends the run in toward goal). */
  curveIn: 0.6,
  /** Waiting runners hold this far behind the onside target (room to start the run), m. */
  launchDepth: 2.5,
  /** Carrier looks up: facing . attack direction >= lookUpCos and nearest opponent >= lookUpSpace, m. */
  lookUpCos: 0.5,
  lookUpSpace: 3.5,
  /** Relaxed look-up test for a runner already on his way (hysteresis without memory). */
  commitLookUpCos: 0.1,
  commitLookUpSpace: 2.0,
  /** Forward speed from which a runner counts as already running, m/s. */
  commitSpeed: 2.0,
  /** Back line: non-keeper opponents within this depth of the offside line, m. Lanes are gaps at least minGap
   *  wide, m, inside +-laneMaxV, m; lanes of two runners at least laneSep apart (soft, crowdPenalty per m), m; a
   *  lane outside the outermost defender costs edgeLanePenalty, m. */
  backLineBand: 7,
  minGap: 4,
  laneMaxV: 24,
  laneSep: 7,
  crowdPenalty: 2,
  edgeLanePenalty: 4,
  /** Overlap: ball at least this wide on the full-back's side, m; ball ahead of him by overlapAheadMin ..
   *  overlapAheadMax, m; ball u at least overlapMinBallU, m; target overlapAhead beyond and overlapWide outside the
   *  ball, m; slack on the channel / ahead tests for a full-back already overlapping, m. */
  wideChannelV: 12,
  overlapAheadMin: 2,
  overlapAheadMax: 35,
  overlapMinBallU: -10,
  overlapAhead: 8,
  overlapWide: 4,
  commitSlack: 3,
  /** Cover: a teammate at least coverDepth deeper than the full-back within coverLateral of his home lane, m. */
  coverDepth: 2,
  coverLateral: 16,
  /** A teammate this far behind the ball counts as rest defence, m. */
  restBehind: 1,
  /** Cross imminent when the ball is within this distance of the byline, m. */
  crossReadyDepth: 12,
  /** Late runners stage at u = HALF_LENGTH - lateStageDepth (3 m outside the box) until the cross is imminent, m. */
  lateStageDepth: 19.5,
  /** Box spot pick: cost = distance (m) - boxWeightBonus * run weight. */
  boxWeightBonus: 10,
  /** Trigger run duration, s; pass-and-go run: target this far ahead and this far away from the receiver, m. */
  runCallSeconds: 2.5,
  passGoAhead: 14,
  passGoSide: 3,
  /** Trigger-run pick: score = in-behind tendency - lineCost * m behind the line - carrierCost * m from the ball
   *  - offsidePenalty when already beyond the limit. */
  triggerLineCost: 0.02,
  triggerCarrierCost: 0.005,
  triggerOffsidePenalty: 0.5,
  /** Speed caps as a fraction of the player's top speed: holding the line jogs, runs sprint. */
  speedHold: 0.6,
  speedRun: 1.0,
  /** Targets stay this far inside the touchlines and goal lines, m. */
  edgeMargin: 1.5,
} as const; // TUNING-CR

const T = LOCAL_TUNING;
/** Ticks a triggered run lasts. */
export const RUN_CALL_TICKS = secToTicks(T.runCallSeconds);
const STAGE_U = HALF_LENGTH - T.lateStageDepth;
const CROSS_ZONE_U = HALF_LENGTH - CROSS_ZONE_DEPTH;

// ---------------------------------------------------------------- per-call scratch (rewritten before every use)

/**
 * Double scratch. Helpers take and return no doubles (a double crossing a call V8 does not inline, or stored in a
 * module `let`, boxes a heap number); they read and write these slots instead.
 */
const G = new Float64Array(24);
/** Anchor (team frame); offside line now; effective line (min now / predicted); onside target limit. */
const G_AU = 0, G_AV = 1, G_LINE = 2, G_LEFF = 3, G_ON = 4;
/** Release: limit at the contact and time to contact (s). Behind-the-line target u. */
const G_REL_LIM = 5, G_TC = 6, G_BEHIND_U = 7;
/** Carrier: nearest opponent distance and facing along the attack direction. */
const G_NEAR = 8, G_FWD = 9;
/** Target handed to give(); lane chosen by chooseLane(). */
const G_TU = 10, G_TV = 11, G_LANE_V = 12;
/** Run weight scales: phase x tactic for runs, for late runs. */
const G_RUN_SCALE = 13, G_LATE_SCALE = 14;

const N = PLAYERS_PER_TEAM;
/** Active opponents (team frame): u, v, forward velocity du, keeper flag. */
const OPP_U = new Float64Array(N);
const OPP_V = new Float64Array(N);
const OPP_DU = new Float64Array(N);
const OPP_GK = new Uint8Array(N);
let oppN = 0;
/** Back-line defenders' v (sorted) and the lanes (gap midpoints) between them. */
const BL_V = new Float64Array(N);
const LANE_V = new Float64Array(N + 1);
const LANE_EDGE = new Uint8Array(N + 1);
let laneN = 0;
/** Lanes already taken by runners this tick (v). */
const TAKEN_V = new Float64Array(NUM_SLOTS);
let takenVN = 0;
/** 1 = slot already handled (anchor, runner, other module's runner) this tick. */
const taken = new Uint8Array(NUM_SLOTS);
/** Automatic run candidates: slot, kind (job), score. */
const CAND_SLOT = new Int32Array(N);
const CAND_JOB = new Int32Array(N);
const CAND_SCORE = new Float64Array(N);
let candN = 0;

/** Context of the current evaluation (integers only). */
let ctxDir = 1;
let ctxAnchor = -1;
let ctxCrossFlight = 0;
/** Rest defenders that may still leave (behind-the-ball count minus TacticParams.restDefenders). */
let restLeft = 0;

/** Anchor modes. */
const M_NONE = 0, M_OWNED = 1, M_FLIGHT = 2, M_OPP = 3;
/** Carrier look-up state: 0 no, 1 relaxed only (committed runners), 2 strict. */
const LOOK_NONE = 0, LOOK_RELAXED = 1, LOOK_STRICT = 2;
/** Speed kinds for give() (Smi codes so no double crosses the call). */
const SPEED_HOLD = 0, SPEED_RUN = 1;

/** Resolved focus + quick tactics (rewritten every call). */
const TP = createTacticParams();

// ---------------------------------------------------------------- role helpers

function isFwdRole(r: Role): boolean {
  return r === Role.ST || r === Role.CF || r === Role.RW || r === Role.LW;
}
function isFullBackRole(r: Role): boolean {
  return r === Role.RB || r === Role.LB || r === Role.RWB || r === Role.LWB;
}
function isPassKick(k: KickKind): boolean {
  return k >= KickKind.GROUND_PASS && k <= KickKind.THROUGH_DINKED;
}
/** Crosses and lofted balls into the box. */
function isCrossKick(k: KickKind): boolean {
  return k >= KickKind.LOB_PASS && k <= KickKind.LOW_CROSS;
}
function isCrossFlightKick(k: KickKind): boolean {
  return k === KickKind.CROSS || k === KickKind.GROUND_CROSS || k === KickKind.LOW_CROSS;
}

// ---------------------------------------------------------------- explicit run bookkeeping

function cancelRun(t: TeamState): void { t.runSlot = -1; t.runCallT = 0; }
function cancelPassGo(t: TeamState): void { t.passGoSlot = -1; t.passGoT = 0; }

/** Drop explicit runs that are invalid now (bad slot, runner off the pitch, runner has the ball). */
function validateCalls(s: SimState, t: TeamState, team: number): void {
  const start = teamStart(team), end = teamEnd(team);
  const o = s.ball.owner;
  const r = t.runSlot;
  if (t.runCallT <= 0 || r < start || r >= end || s.players[r]!.active !== 1 || o === r) {
    if (t.runSlot !== -1 || t.runCallT !== 0) cancelRun(t);
  }
  const g = t.passGoSlot;
  if (t.passGoT <= 0 || g < start || g >= end || s.players[g]!.active !== 1 || o === g) {
    if (t.passGoSlot !== -1 || t.passGoT !== 0) cancelPassGo(t);
  }
}

/**
 * First IN_PLAY tick after a stoppage: requests from before it are stale (runCallT is only full on the tick it was
 * set; a pass and go survives only if it was the restart kick itself).
 */
function clearStale(s: SimState, t: TeamState): void {
  const m = s.match;
  if (m.phase !== MatchPhase.IN_PLAY || m.prevPhase === MatchPhase.IN_PLAY || m.phaseT > 1) return;
  if (t.runCallT > 0 && t.runCallT < RUN_CALL_TICKS) cancelRun(t);
  if (t.passGoT > 0 && s.ball.lastKickBy !== t.passGoSlot) cancelPassGo(t);
}

function countDown(t: TeamState): void {
  if (t.runCallT > 0) {
    t.runCallT--;
    if (t.runCallT === 0) t.runSlot = -1;
  }
  if (t.passGoT > 0) {
    t.passGoT--;
    if (t.passGoT === 0) t.passGoSlot = -1;
  }
}

// ---------------------------------------------------------------- anchor and opponents

/**
 * Anchor mode for `team`: M_OWNED (our ball owner; G_AU/G_AV = ball), M_FLIGHT (our pass with a target, or our
 * cross, in flight; G_AU/G_AV = reception point), M_OPP (opponent ball) or M_NONE. Sets ctxAnchor (owner / pass
 * target, -1 none) and ctxCrossFlight.
 */
function findAnchor(s: SimState, team: number, dir: number): number {
  const b = s.ball;
  ctxAnchor = -1;
  ctxCrossFlight = 0;
  const o = b.owner >= 0 ? b.owner : b.heldBy;
  if (o >= 0 && o < NUM_SLOTS) {
    const p = s.players[o]!;
    if (p.team !== team) return M_OPP;
    if (p.active !== 1) return M_NONE;
    ctxAnchor = o;
    G[G_AU] = dir * b.x;
    G[G_AV] = dir * b.z;
    return M_OWNED;
  }
  if (b.lastKickTeam !== team || b.lastTouchTeam !== team || b.lastKickBy < 0) return M_NONE;
  const r = b.passTarget;
  const hasTarget = r >= teamStart(team) && r < teamEnd(team) && s.players[r]!.active === 1;
  const cross = isCrossFlightKick(b.lastKickKind);
  if (!hasTarget && !cross) return M_NONE;
  ctxAnchor = hasTarget ? r : -1;
  ctxCrossFlight = cross ? 1 : 0;
  let px = hasTarget ? b.passX : b.x, pz = hasTarget ? b.passZ : b.z;
  px = px > HALF_LENGTH ? HALF_LENGTH : px < -HALF_LENGTH ? -HALF_LENGTH : px;
  pz = pz > HALF_WIDTH ? HALF_WIDTH : pz < -HALF_WIDTH ? -HALF_WIDTH : pz;
  G[G_AU] = dir * px;
  G[G_AV] = dir * pz;
  return M_FLIGHT;
}

/**
 * Load the active opponents (team frame), the offside line now (query.secondLastDefenderX) into G_LINE, the
 * effective line (deeper of now and lineLookahead ahead) into G_LEFF, and the nearest opponent to the carrier
 * into G_NEAR (owned ball only).
 */
function loadOpponents(s: SimState, team: number, dir: number, carrier: number): void {
  const opp = otherTeam(team);
  const end = teamEnd(opp);
  const tau = T.lineLookahead;
  let cx = 0, cz = 0;
  if (carrier >= 0) { cx = s.players[carrier]!.x; cz = s.players[carrier]!.z; }
  let near2 = 1e18;
  let f = -1e9, sc = -1e9;
  oppN = 0;
  for (let i = teamStart(opp); i < end; i++) {
    const o = s.players[i]!;
    if (o.active !== 1) continue;
    const u = dir * o.x, du = dir * o.vx;
    OPP_U[oppN] = u;
    OPP_V[oppN] = dir * o.z;
    OPP_DU[oppN] = du;
    OPP_GK[oppN] = o.isKeeper === 1 ? 1 : 0;
    oppN++;
    const up = u + du * tau;
    if (up > f) { sc = f; f = up; } else if (up > sc) sc = up;
    if (carrier >= 0) {
      const dx = o.x - cx, dz = o.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < near2) near2 = d2;
    }
  }
  const line = oppN > 0 ? dir * secondLastDefenderX(s, opp) : -HALF_LENGTH;
  const pred = sc <= -1e9 ? (f <= -1e9 ? line : f) : sc;
  G[G_LINE] = line;
  G[G_LEFF] = pred < line ? pred : line;
  G[G_NEAR] = near2 < 1e18 ? Math.sqrt(near2) : 1e9;
}

/**
 * Onside target limit (u) into G_ON: max(effective line, anchor, halfway) - onsideMargin; the behind-the-line
 * target into G_BEHIND_U. Offside switched off (config.offside = 0): no limit short of the behind target.
 */
function computeOnside(offside: number): void {
  let lim = G[G_LEFF]!;
  const au = G[G_AU]!;
  if (au > lim) lim = au;
  if (lim < 0) lim = 0;
  G[G_ON] = lim - T.onsideMargin;
  let bu = G[G_LINE]! + T.behindDepth;
  const cap = HALF_LENGTH - T.behindGoalMargin;
  if (bu > cap) bu = cap;
  G[G_BEHIND_U] = bu;
  if (offside === 0 && bu > G[G_ON]!) G[G_ON] = bu;
}

/** Back-line defenders (non-keepers within backLineBand of the line), sorted by v, and the lanes between them. */
function buildLanes(): void {
  let n = 0;
  const band = G[G_LINE]! - T.backLineBand;
  for (let k = 0; k < oppN; k++) {
    if (OPP_GK[k] === 1 || OPP_U[k]! < band) continue;
    // insertion sort by v
    const v = OPP_V[k]!;
    let j = n;
    while (j > 0 && BL_V[j - 1]! > v) { BL_V[j] = BL_V[j - 1]!; j--; }
    BL_V[j] = v;
    n++;
  }
  laneN = 0;
  if (n === 0) return;
  let prev = -T.laneMaxV;
  for (let i = 0; i <= n; i++) {
    const v = i < n ? BL_V[i]! : T.laneMaxV;
    if (v - prev >= T.minGap) {
      LANE_V[laneN] = 0.5 * (prev + v);
      // Outside the outermost defender on either side (between him and the lane limit).
      LANE_EDGE[laneN] = i === n || prev <= -T.laneMaxV ? 1 : 0;
      laneN++;
    }
    if (v > prev) prev = v;
    if (prev >= T.laneMaxV) break;
  }
}

/**
 * Lane (gap) for a runner whose reference v is in G_LANE_V on entry, avoiding lanes taken this tick; writes the
 * chosen lane's v to G_LANE_V (unchanged when there is no back line).
 */
function chooseLane(): void {
  if (laneN === 0) return;
  const refV = G[G_LANE_V]!;
  let best = 0, bestC = 1e18;
  for (let l = 0; l < laneN; l++) {
    const lv = LANE_V[l]!;
    let c = lv > refV ? lv - refV : refV - lv;
    if (LANE_EDGE[l] === 1) c += T.edgeLanePenalty;
    for (let k = 0; k < takenVN; k++) {
      const d = lv > TAKEN_V[k]! ? lv - TAKEN_V[k]! : TAKEN_V[k]! - lv;
      if (d < T.laneSep) c += T.crowdPenalty * (T.laneSep - d);
    }
    if (c < bestC) { bestC = c; best = l; }
  }
  G[G_LANE_V] = LANE_V[best]!;
}

function takeLane(): void {
  if (takenVN < NUM_SLOTS) TAKEN_V[takenVN++] = G[G_LANE_V]!;
}

// ---------------------------------------------------------------- carrier

/** Carrier look-up state (owned ball only). A carrier winding up a pass is looking up by definition. */
function lookUpState(s: SimState, mode: number): number {
  if (mode !== M_OWNED || ctxAnchor < 0) return LOOK_NONE;
  const c = s.players[ctxAnchor]!;
  if (c.act === ActionKind.KICK) return isPassKick(c.actKick) ? LOOK_STRICT : LOOK_NONE;
  if (c.act !== ActionKind.NONE || c.stunT > 0) return LOOK_NONE;
  const fl = Math.sqrt(c.fx * c.fx + c.fz * c.fz);
  G[G_FWD] = fl > 1e-9 ? (ctxDir * c.fx) / fl : 0;
  const fwd = G[G_FWD]!, near = G[G_NEAR]!;
  if (fwd >= T.lookUpCos && near >= T.lookUpSpace) return LOOK_STRICT;
  if (fwd >= T.commitLookUpCos && near >= T.commitLookUpSpace) return LOOK_RELAXED;
  return LOOK_NONE;
}

/**
 * Ticks until the carrier's pass contact (wind-up of a pass kind, not charging, not yet struck), or 0 when no pass
 * is committed. Fills G_TC and G_REL_LIM (the onside limit at the contact, minus releaseMargin).
 */
function releaseTicks(s: SimState, mode: number): number {
  if (mode !== M_OWNED || ctxAnchor < 0) return 0;
  const c = s.players[ctxAnchor]!;
  if (c.act !== ActionKind.KICK || c.actDone !== 0 || c.actCharging !== 0 || !isPassKick(c.actKick)) return 0;
  let n = c.actContact - c.actT;
  if (n < 1) n = 1;
  const tc = n * DT;
  G[G_TC] = tc;
  // Offside line at the contact (deeper of now and predicted), ball at the contact (carrier or ball, deeper).
  let f = -1e9, sc = -1e9;
  for (let k = 0; k < oppN; k++) {
    const up = OPP_U[k]! + OPP_DU[k]! * tc;
    if (up > f) { sc = f; f = up; } else if (up > sc) sc = up;
  }
  let line = G[G_LINE]!;
  const pred = sc <= -1e9 ? f : sc;
  if (pred > -1e9 && pred < line) line = pred;
  let au = G[G_AU]!;
  const cu = ctxDir * c.x;
  if (cu < au) au = cu;
  let lim = line > au ? line : au;
  if (lim < 0) lim = 0;
  G[G_REL_LIM] = lim - T.releaseMargin;
  return n;
}

/** True if the runner, accelerating flat out in any direction, stays behind the release limit until the contact. */
function canRelease(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  const tc = G[G_TC]!;
  const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  const top = a.topSpeed > 0 ? a.topSpeed : 9.6;
  const acc = (a.accel > 0 ? a.accel : 8) * T.releaseAccelSafety;
  let vmax = sp + acc * tc;
  if (vmax > top && sp <= top) vmax = top;
  return ctxDir * p.x + vmax * tc <= G[G_REL_LIM]!;
}

// ---------------------------------------------------------------- jobs

/** Give `slot` a run job at (G_TU, G_TV) (team frame, clamped to the pitch); marks him taken. True if applied. */
function give(s: SimState, slot: number, job: AiJob, speedKind: number): boolean {
  taken[slot] = 1;
  const lim = HALF_LENGTH - T.edgeMargin, limV = HALF_WIDTH - T.edgeMargin;
  let u = G[G_TU]!, v = G[G_TV]!;
  u = u > lim ? lim : u < -lim ? -lim : u;
  v = v > limV ? limV : v < -limV ? -limV : v;
  const frac = speedKind === SPEED_RUN ? T.speedRun : T.speedHold;
  return assignJob(s, slot, job, ctxDir * u, ctxDir * v, s.attrs[slot]!.topSpeed * frac, ctxAnchor);
}

/** Eligible for an automatic run: AI-driven, not handled yet, holding shape or supporting (not another job). */
function isFree(s: SimState, slot: number): boolean {
  if (taken[slot] === 1 || !isJobDriven(s, slot)) return false;
  const p = s.players[slot]!;
  if (p.job > AiJob.SUPPORT) return false;
  // A supporter whose role prefers support over runs stays a supporter (TAI-02's triangle).
  if (p.job === AiJob.SUPPORT) {
    const r = rolePreset(p.role).runs;
    const run = r.inBehind > r.lateRun ? r.inBehind : r.lateRun;
    if (r.support >= run) return false;
  }
  return true;
}

/** Is `slot` currently behind the anchor (rest defence)? */
function isBehindBall(s: SimState, slot: number): boolean {
  return ctxDir * s.players[slot]!.x < G[G_AU]! - T.restBehind;
}

/** restLeft = outfield teammates behind the ball (not taken) - restDefenders. */
function countRest(s: SimState, team: number): void {
  let n = 0;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1 || taken[i] === 1) continue;
    if (isBehindBall(s, i)) n++;
  }
  restLeft = n - TP.restDefenders;
}

/**
 * Run in behind for `slot` (see the header): waiting / running / released. `look` is the carrier's look-up state,
 * `rel` the ticks to a committed pass contact (0 none), `mode` the anchor mode.
 */
function runInBehind(s: SimState, slot: number, look: number, rel: number, mode: number): boolean {
  const p = s.players[slot]!;
  const u = ctxDir * p.x, v = ctxDir * p.z, hv = ctxDir * p.homeZ;
  G[G_LANE_V] = 0.5 * (v + hv);
  chooseLane();
  takeLane();
  const committed = ctxDir * p.vx >= T.commitSpeed;
  if (rel > 0 && canRelease(s, slot)) {
    G[G_TU] = G[G_BEHIND_U]!;
    G[G_TV] = G[G_LANE_V]! * T.curveIn;
    return give(s, slot, AiJob.RUN_IN_BEHIND, SPEED_RUN);
  }
  const on = G[G_ON]!;
  if (look === LOOK_STRICT || (committed && (look === LOOK_RELAXED || mode === M_FLIGHT))) {
    G[G_TU] = on;
    G[G_TV] = G[G_LANE_V]!;
    return give(s, slot, AiJob.RUN_IN_BEHIND, SPEED_RUN);
  }
  G[G_TU] = on - T.launchDepth;
  G[G_TV] = hv;
  // Caught beyond the limit (the line stepped up): hurry back.
  return give(s, slot, AiJob.RUN_IN_BEHIND, u > on ? SPEED_RUN : SPEED_HOLD);
}

/** Pass and go: the passer sprints forward and away from the receiver, onside until the next pass. */
function passGoRun(s: SimState, slot: number, rel: number): boolean {
  const p = s.players[slot]!;
  const u = ctxDir * p.x, v = ctxDir * p.z;
  const side = v >= G[G_AV]! ? 1 : -1;
  G[G_LANE_V] = v + side * T.passGoSide;
  takeLane();
  if (rel > 0 && canRelease(s, slot)) {
    const bu = G[G_BEHIND_U]!;
    G[G_TU] = bu > u + T.passGoAhead ? bu : u + T.passGoAhead;
    G[G_TV] = G[G_LANE_V]!;
    return give(s, slot, AiJob.RUN_IN_BEHIND, SPEED_RUN);
  }
  const on = G[G_ON]!;
  let tu = u + T.passGoAhead;
  if (tu > on) tu = on;
  G[G_TU] = tu;
  G[G_TV] = G[G_LANE_V]!;
  return give(s, slot, AiJob.RUN_IN_BEHIND, SPEED_RUN);
}

/** Triggered run: in behind immediately (not clamped; the human times the pass). */
function triggeredRun(s: SimState, slot: number): boolean {
  G[G_LANE_V] = ctxDir * s.players[slot]!.z;
  chooseLane();
  takeLane();
  G[G_TU] = G[G_BEHIND_U]!;
  G[G_TV] = G[G_LANE_V]! * T.curveIn;
  return give(s, slot, AiJob.RUN_IN_BEHIND, SPEED_RUN);
}

// ---------------------------------------------------------------- overlaps

/** Overlap conditions for full-back `slot` (wide channel ahead, cover behind him, rest defence). */
function overlapOk(s: SimState, slot: number, team: number): boolean {
  const p = s.players[slot]!;
  const hv = ctxDir * p.homeZ;
  if (hv < 1 && hv > -1) return false;
  const side = hv > 0 ? 1 : -1;
  const bu = G[G_AU]!, bv = G[G_AV]!;
  if (bu < T.overlapMinBallU) return false;
  const u = ctxDir * p.x, v = ctxDir * p.z;
  const committed = u >= bu - T.overlapAheadMin && side * v >= T.wideChannelV - T.commitSlack;
  if (side * bv < (committed ? T.wideChannelV - T.commitSlack : T.wideChannelV)) return false;
  const ahead = bu - u;
  if (committed) {
    if (-ahead > T.overlapAhead + T.commitSlack) return false;
  } else if (ahead < T.overlapAheadMin || ahead > T.overlapAheadMax) return false;
  // Cover: a teammate deeper than him on his flank.
  let covered = false;
  const end = teamEnd(team);
  for (let j = teamStart(team); j < end; j++) {
    if (j === slot || j === ctxAnchor || taken[j] === 1) continue;
    const q = s.players[j]!;
    if (q.active !== 1 || q.isKeeper === 1) continue;
    const qv = ctxDir * q.z;
    const lat = qv > hv ? qv - hv : hv - qv;
    if (ctxDir * q.x <= u - T.coverDepth && lat <= T.coverLateral) { covered = true; break; }
  }
  if (!covered) return false;
  return !(isBehindBall(s, slot) && restLeft <= 0);
}

function overlapRun(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  const side = ctxDir * p.homeZ > 0 ? 1 : -1;
  if (isBehindBall(s, slot)) restLeft--;
  let tu = G[G_AU]! + T.overlapAhead;
  if (tu > G[G_ON]!) tu = G[G_ON]!;
  let w = side * G[G_AV]! + T.overlapWide;
  const lim = HALF_WIDTH - T.edgeMargin;
  if (w > lim) w = lim;
  G[G_TU] = tu;
  G[G_TV] = side * w;
  return give(s, slot, AiJob.OVERLAP, SPEED_RUN);
}

// ---------------------------------------------------------------- box attack (crossing zone)

/** True if the anchor is in the attacking crossing zone (constants CROSS_ZONE_*). */
function anchorInCrossZone(): boolean {
  const v = G[G_AV]!;
  return G[G_AU]! >= CROSS_ZONE_U && (v < 0 ? -v : v) >= CROSS_ZONE_MIN_Z;
}

/** Cross imminent: our cross in flight, carrier in a cross / lob wind-up, or the ball near the byline. */
function crossImminent(s: SimState, mode: number): boolean {
  if (mode === M_FLIGHT) return true;
  if (ctxAnchor >= 0) {
    const c = s.players[ctxAnchor]!;
    if (c.act === ActionKind.KICK && isCrossKick(c.actKick)) return true;
  }
  return G[G_AU]! >= HALF_LENGTH - T.crossReadyDepth;
}

/** Fill the box spots with up to `budget` attackers. Returns the number of runners assigned. */
function boxRuns(s: SimState, team: number, mode: number, budget: number): number {
  let side = G[G_AV]! >= 0 ? 1 : -1;
  if (mode === M_FLIGHT) {
    const k = s.ball.lastKickBy;
    if (k >= 0 && k < NUM_SLOTS) side = ctxDir * s.players[k]!.z >= 0 ? 1 : -1;
  }
  const imminent = crossImminent(s, mode);
  const flight = mode === M_FLIGHT;
  const end = teamEnd(team);
  let n = 0;
  for (let k = 0; k < BOX_SPOTS.length && n < budget; k++) {
    const su = BOX_SPOTS[k]!.nx * HALF_LENGTH, sv = BOX_SPOTS[k]!.nzSide * HALF_WIDTH * side;
    let best = -1, bestC = 1e18, bestFwd = false;
    for (let i = teamStart(team); i < end; i++) {
      if (!isFree(s, i)) continue;
      const p = s.players[i]!;
      const r = rolePreset(p.role).runs;
      const fwd = isFwdRole(p.role);
      let w = r.lateRun * G[G_LATE_SCALE]!;
      if (fwd) { const wf = r.inBehind * G[G_RUN_SCALE]!; if (wf > w) w = wf; }
      if (w < T.minRunWeight) continue;
      if (!fwd && isBehindBall(s, i) && restLeft <= 0) continue;
      const dx = ctxDir * p.x - su, dz = ctxDir * p.z - sv;
      const c = Math.sqrt(dx * dx + dz * dz) - T.boxWeightBonus * w;
      if (c < bestC) { bestC = c; best = i; bestFwd = fwd; }
    }
    if (best < 0) break;
    const p = s.players[best]!;
    if (!bestFwd && isBehindBall(s, best)) restLeft--;
    let tu = su;
    if (!bestFwd && !imminent && ctxDir * p.x < STAGE_U && STAGE_U < tu) tu = STAGE_U;
    if (!flight && tu > G[G_ON]!) tu = G[G_ON]!;
    G[G_TU] = tu;
    G[G_TV] = sv;
    give(s, best, bestFwd ? AiJob.RUN_IN_BEHIND : AiJob.LATE_RUN, imminent ? SPEED_RUN : SPEED_HOLD);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- open play (in behind + overlaps)

/** Collect overlap and (unless overlapsOnly) in-behind candidates, sorted by score then slot, into CAND_*. */
function collectCandidates(s: SimState, team: number, overlapsOnly: boolean): void {
  candN = 0;
  const throughOn = !overlapsOnly && HALF_LENGTH - T.behindGoalMargin - G[G_LINE]! >= T.minSpaceBehind;
  const au = G[G_AU]!, av = G[G_AV]!, on = G[G_ON]!;
  const r2 = T.throughRange * T.throughRange;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    if (!isFree(s, i)) continue;
    const p = s.players[i]!;
    const r = rolePreset(p.role).runs;
    let job = AiJob.NONE;
    let sc = 0;
    if (isFullBackRole(p.role)) {
      const w = r.overlap * G[G_RUN_SCALE]!;
      if (w >= T.minRunWeight && overlapOk(s, i, team)) { job = AiJob.OVERLAP; sc = w; }
    }
    if (job === AiJob.NONE && throughOn) {
      const w = r.inBehind * G[G_RUN_SCALE]!;
      // A midfielder making the run from behind the ball must not take the rest defence with him.
      if (w >= T.minRunWeight && (isFwdRole(p.role) || !isBehindBall(s, i) || restLeft > 0)) {
        const dx = on - au, dz = ctxDir * p.z - av;
        if (dx * dx + dz * dz <= r2) { job = AiJob.RUN_IN_BEHIND; sc = w; }
      }
    }
    if (job === AiJob.NONE) continue;
    let j = candN;
    while (j > 0 && CAND_SCORE[j - 1]! < sc) {
      CAND_SCORE[j] = CAND_SCORE[j - 1]!; CAND_SLOT[j] = CAND_SLOT[j - 1]!; CAND_JOB[j] = CAND_JOB[j - 1]!; j--;
    }
    CAND_SCORE[j] = sc; CAND_SLOT[j] = i; CAND_JOB[j] = job;
    candN++;
  }
}

function openPlayRuns(s: SimState, team: number, mode: number, budget: number, look: number, rel: number, overlapsOnly: boolean): void {
  if (budget <= 0) return;
  collectCandidates(s, team, overlapsOnly);
  let n = 0;
  for (let c = 0; c < candN && n < budget; c++) {
    const i = CAND_SLOT[c]!;
    if (CAND_JOB[c] === AiJob.OVERLAP) {
      // Re-check: an earlier pick may have used the rest defence or the cover.
      if (!overlapOk(s, i, team)) continue;
      if (overlapRun(s, i)) n++;
    } else {
      const p = s.players[i]!;
      if (!isFwdRole(p.role) && isBehindBall(s, i)) {
        if (restLeft <= 0) continue;
        restLeft--;
      }
      if (runInBehind(s, i, look, rel, mode)) n++;
    }
  }
}

// ---------------------------------------------------------------- main pass

export function assignRuns(s: SimState, team: number, ev: EventSink): void {
  const t = s.teams[team]!;
  const dir = t.dir >= 0 ? 1 : -1;
  ctxDir = dir;
  clearStale(s, t);
  const mode = findAnchor(s, team, dir);
  if (mode === M_OPP) {
    if (t.runSlot !== -1 || t.runCallT !== 0) cancelRun(t);
    if (t.passGoSlot !== -1 || t.passGoT !== 0) cancelPassGo(t);
    return;
  }
  validateCalls(s, t, team);
  if (mode !== M_NONE) plan(s, team, t, mode);
  countDown(t);
}

function plan(s: SimState, team: number, t: TeamState, mode: number): void {
  const start = teamStart(team), end = teamEnd(team);
  for (let i = start; i < end; i++) taken[i] = 0;
  if (ctxAnchor >= 0) taken[ctxAnchor] = 1;
  loadOpponents(s, team, ctxDir, mode === M_OWNED ? ctxAnchor : -1);
  computeOnside(s.config.offside);
  buildLanes();
  takenVN = 0;
  resolveTactics(t.focus, tacticFlags(t), TP);
  let phaseScale = phaseOffset(t.phase).runScale;
  if (!(phaseScale > 0)) phaseScale = phaseOffset(TeamPhase.BUILD_UP).runScale; // phase lagging possession
  G[G_RUN_SCALE] = phaseScale * TP.runScale;
  G[G_LATE_SCALE] = phaseScale * TP.lateRunScale;
  let cap = TP.maxRunners;
  if (cap > T.maxRunnersHard) cap = T.maxRunnersHard;
  if (cap < 1) cap = 1;
  const rel = releaseTicks(s, mode);
  const look = lookUpState(s, mode);
  let runners = 0;

  // 1. Explicit requests override: pass and go, then the triggered run.
  const g = t.passGoSlot;
  if (t.passGoT > 0 && g >= 0 && g !== ctxAnchor && taken[g] === 0 && isJobDriven(s, g)) {
    if (passGoRun(s, g, rel)) runners++;
  }
  const r = t.runSlot;
  if (t.runCallT > 0 && r >= 0 && r !== ctxAnchor && taken[r] === 0 && isJobDriven(s, r)) {
    if (triggeredRun(s, r)) runners++;
  }

  // 2. Runner jobs other modules gave this tick (TAI-06 counter-attack runs) count toward the budget.
  for (let i = start; i < end; i++) {
    if (taken[i] === 1) continue;
    const j = s.players[i]!.job;
    if (j === AiJob.RUN_IN_BEHIND || j === AiJob.OVERLAP || j === AiJob.LATE_RUN) { taken[i] = 1; runners++; }
  }

  countRest(s, team);
  // 3. Box attack on crosses, else open play.
  if ((mode === M_OWNED && anchorInCrossZone()) || (mode === M_FLIGHT && ctxCrossFlight === 1)) {
    let boxCap = TP.boxRunners > 0 ? TP.boxRunners : T.boxRunnersDefault;
    if (boxCap < cap) boxCap = cap;
    boxRuns(s, team, mode, boxCap - runners);
    // One overlap may join the box attackers: the crossing option outside the winger (an overlap in progress is
    // not abandoned because the ball entered the crossing zone).
    openPlayRuns(s, team, mode, 1, look, rel, true);
  } else {
    openPlayRuns(s, team, mode, cap - runners, look, rel, false);
  }
}

// ---------------------------------------------------------------- trigger run

/**
 * The runner a trigger-run request would send (pure): the AI-driven teammate (not the ball owner / receiver, not
 * the keeper) with the best in-behind tendency, near the offside line and the ball, preferring onside players.
 * -1 when the team has no ball (owner or pass in flight) or nobody qualifies.
 */
export function pickTriggerRunner(s: SimState, team: number): number {
  const dir = s.teams[team]!.dir >= 0 ? 1 : -1;
  const mode = findAnchor(s, team, dir);
  if (mode !== M_OWNED && mode !== M_FLIGHT) return -1;
  const opp = otherTeam(team);
  const line = dir * secondLastDefenderX(s, opp);
  const au = G[G_AU]!, av = G[G_AV]!;
  let lim = line > au ? line : au;
  if (lim < 0) lim = 0;
  let best = -1, bestSc = -1e18;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    if (i === ctxAnchor || !isJobDriven(s, i)) continue;
    const p = s.players[i]!;
    const u = dir * p.x, v = dir * p.z;
    const behind = line - u;
    const dx = u - au, dz = v - av;
    let sc = rolePreset(p.role).runs.inBehind - T.triggerLineCost * (behind > 0 ? behind : 0) -
      T.triggerCarrierCost * Math.sqrt(dx * dx + dz * dz);
    if (u > lim + T_RULES.offsideMargin) sc -= T.triggerOffsidePenalty;
    if (sc > bestSc) { bestSc = sc; best = i; }
  }
  return best;
}

/** Human (or CPU) trigger-run request: the best-placed runner starts a run in behind now, for RUN_CALL_TICKS. */
export function triggerRun(s: SimState, team: number, ev: EventSink): void {
  if (s.match.phase !== MatchPhase.IN_PLAY) return;
  const r = pickTriggerRunner(s, team);
  if (r < 0) return;
  const t = s.teams[team]!;
  t.runSlot = r;
  t.runCallT = RUN_CALL_TICKS;
}

// ---------------------------------------------------------------- pure helpers (tests, other AI modules)

/**
 * x of the furthest onside point for `team`'s attackers right now (RUL-08 geometry without the margin): the most
 * advanced, in the attack direction, of the opponents' second-last defender, the ball and the halfway line.
 */
export function onsideLimitX(s: SimState, team: number): number {
  const dir = s.teams[team]!.dir >= 0 ? 1 : -1;
  const line = dir * secondLastDefenderX(s, otherTeam(team));
  const bu = dir * s.ball.x;
  let lim = line > bu ? line : bu;
  if (lim < 0) lim = 0;
  return dir * lim;
}

/**
 * Own mirror of RUL-08's offside-position test (used by this module's tests; RUL-08 isOffsidePosition is
 * authoritative): in the opponents' half, beyond the ball and beyond the second-last defender, each by more than
 * T_RULES.offsideMargin.
 */
export function inOffsidePosition(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  if (p.active !== 1 || s.config.offside === 0) return false;
  const dir = s.teams[p.team]!.dir >= 0 ? 1 : -1;
  const u = dir * p.x;
  const m = T_RULES.offsideMargin;
  if (u <= m) return false;
  if (u <= dir * s.ball.x + m) return false;
  return u > dir * secondLastDefenderX(s, otherTeam(p.team)) + m;
}

/** Carrier look-up as this module sees it: 2 strict (facing forward, not pressed, or winding up a pass), 1 relaxed, 0 no. */
export function carrierLookUp(s: SimState, team: number): number {
  const dir = s.teams[team]!.dir >= 0 ? 1 : -1;
  ctxDir = dir;
  const mode = findAnchor(s, team, dir);
  if (mode !== M_OWNED) return LOOK_NONE;
  loadOpponents(s, team, dir, ctxAnchor);
  return lookUpState(s, mode);
}
