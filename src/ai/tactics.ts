/**
 * [TAI-14] Tactics and focus effects (quick tactics: offside trap, team press, extra striker, get in the box;
 * tactical focus default/defending/attacking; formation changes) applied to shape and pressing parameters;
 * applyCommand handles Command.* from any controller (emits TACTIC). Receiver lock and teammate assist for human
 * sides: the intended receiver of a pass (ball.passTarget) gets a RECEIVE job to meet the ball until the human
 * switches to him / steers him.
 *
 * applyCommand(s, team, cmd, arg, ev) — called by SIM-15 for every Command except NONE / SKIP / SUBSTITUTE /
 * QUICK_SUB (those are routed elsewhere and ignored here). team must be 0 or 1; nothing is applied once the match is
 * finished. Every applied command emits TACTIC (a = team, b = Command, c = resulting value: 0/1 for a quick-tactic
 * toggle, the TacticalFocus, the FormationId, the CORNER_* command, or cmdArg for SWAP_POSITIONS). A refused command
 * (bad argument) changes nothing and emits nothing.
 *  - TACTIC_OFFSIDE_TRAP / TEAM_PRESS / EXTRA_STRIKER / GET_IN_BOX: toggle team.offsideTrap / teamPress /
 *    extraStriker / getInBox (0 <-> 1). Independent toggles; all may be on at once.
 *  - FOCUS_DEFAULT / DEFENDING / ATTACKING: team.focus.
 *  - SET_FORMATION (cmdArg = FormationId): team.formation, and every player re-mapped with data/formations
 *    remapFormation (Hungarian assignment on slot distance + role familiarity of the player's natural role from his
 *    squad entry): p.formIdx is a permutation over the 11 indices, the keeper (team.keeperSlot) always gets index 0
 *    and keeps role GK, every other active player takes the role of his new slot (never GK), and a team playing short
 *    leaves its least important slots empty. Inactive (sent-off) players holding a vacant index follow the
 *    permutation so indices stay consistent. The same formation again re-maps nothing (TAI-01 already re-balances a
 *    short side every shape update) but is acknowledged with TACTIC.
 *  - CORNER_FAR_POST / EDGE_OF_BOX / CROWD_KEEPER / NEAR_POST: team.cornerTactic = the command (a per-corner
 *    instruction: used for the team's next corner, reset when that corner is over, see tacticsTick).
 *  - SWAP_POSITIONS (cmdArg = rosterA | rosterB << 8, squad indices of two active outfield players of the team):
 *    swaps their formIdx and role (no substitution used; the keeper cannot be swapped).
 *  Any change that moves the shape calls TAI-01 invalidateShape so the new homes apply on this tick's shape update.
 *
 * What each tactic changes (all derived by the readers from the team fields through data/tactics resolveTactics /
 * tacticFlags, so this module stores nothing else and every module agrees on one number):
 *  - focus (FOCUS_MODIFIERS): TAI-01 block push and widths (+ its own focusLine / focusDepth / focusWidth), TAI-04
 *    line height (lineNx), TAI-03 run weights / max runners / rest defenders, TAI-05 press scale and duty scale,
 *    TAI-06 counter-run and recovery duty scales.
 *  - offsideTrap: TAI-04 line +offsideTrap.lineNx and the coordinated step-up (stepUpM over stepTicks at sprint pace)
 *    on backward / square passes; ignored with offside off.
 *  - teamPress: TAI-05 two pressers on the carrier, intensity +pressAdd, engage radius x pressDistanceScale; TAI-01
 *    block push out of possession +teamPress.pushNx; TAI-04 line +teamPress.lineNx.
 *  - extraStriker: TAI-01 the most central midfielder joins the forward line (EXTRA_STRIKER_SHAPES; half way out of
 *    possession); slotRole / slotLineFor report him as a ST in the FWD line (TAI-04/05/06 duties); TAI-03 run scale
 *    x1.15, one more runner, one fewer rest defender.
 *  - getInBox: TAI-01 the widest non-defenders attack the far post and penalty spot when crossing; TAI-03 four box
 *    runners and late-run weights x1.5.
 *  - cornerTactic: TAI-13 attacking corner spots (two tactic spots), SIM-09 cross-target bias.
 *
 * tacticsTick(s, team, ev) — every tick, every phase, O(1):
 *  - keeps the tactic fields valid (toggles exactly 0/1, focus / formation / cornerTactic in range; a corrupt value
 *    falls back to the default the readers already assume) and invalidates the shape when it had to fix one;
 *  - expires the temporary tactic: the corner tactic of the team whose corner it was is reset on the first tick after
 *    the CORNER phase is left (match.prevPhase CORNER, phaseT <= 1). Back in IN_PLAY that is restart.team (RUL-01
 *    keeps it, only restart.kind is cleared); any other exit (re-award, period end) resets both teams.
 *  Quick tactics and focus are persistent toggles (no time limit: TeamState has no timer field; see the report).
 *
 * receiverAssist(s, team, ev) — IN_PLAY, after the other off-ball modules (RECEIVE beats every open-play job):
 *  - The intended receiver r = ball.passTarget of a pass by this team still on its way (ball loose and not in hands,
 *    lastKickTeam and lastTouchTeam = team, so a deflection by an opponent ends the assist) who is job-driven (active
 *    outfielder with p.ctrl = -1) gets RECEIVE at the best interception point at top speed: he moves to collect the
 *    ball instead of waiting for it. A controlled receiver (the human or CPU brain switched to him: SIM-16 does that
 *    at once with auto-switch on) is SIM-15's (moveTick meets the ball while the stick is idle, the stick steers
 *    him), so the assist stops the moment a controller takes him. Possession (takePossession clears passTarget) or a
 *    restart ends it too.
 *  - Interception (findReception): SIM-01 predictBall over receivePredictTicks, cut at the first sample with the
 *    whole ball over a line; the FIRST sample the receiver can play (ball centre <= receiveMaxHeight, not before his
 *    locking action / stun / noTouchT ends) and reach in time with SIM-04 ticksToReach (sprint): busy + ticks <= the
 *    sample's tick. A straight-line lower bound skips hopeless samples, a Lipschitz skip bounds the ticksToReach
 *    calls (<= receiveMaxEvals per tick, shared by the scans). So a pass to feet is met as early as possible: he
 *    comes toward the ball. Through balls (THROUGH_*) are met in stride where the passer led him: the first reachable
 *    sample at or after the one nearest the intended reception point (ball.passX/Z, set by the kick solver) that is
 *    not more than throughBackTol behind him along the attack direction (he keeps running onto the ball instead of
 *    turning back); else the first such sample before it; else the earliest reachable sample at all. Nothing
 *    reachable in the horizon: the last in-play sample (he runs toward where the ball is going). For passes to feet
 *    this is the same model as TAI-07's chaser, which claims the receiver as its chaser, so nobody else goes.
 *  - ctrl.receiver of every controller on the team that is not driving him = r while the assist runs (HUD marker);
 *    a stale value this module wrote is cleared (SIM-15's own value, its controlled slot, is never touched).
 * Determinism / budget: + - * / sqrt / ceil only, slot-order loops, module scratch rewritten on every call, no
 * allocation per tick. One predictBall + <= receiveMaxEvals ticksToReach per tick, only while a job-driven
 * receiver exists (rare: auto-switch hands the receiver to the controller).
 */
import {
  BALL_RADIUS, BOARD_X, BOARD_Z, HALF_LENGTH, HALF_WIDTH, NUM_CONTROLLERS, PLAYERS_PER_TEAM, TICK_HZ, teamFirstSlot,
} from '../contracts/constants';
import { ActionKind, AiJob, Command, ControllerKind, KickKind, MatchPhase, Role, TacticalFocus } from '../contracts/enums';
import { EventType, type EventSink } from '../contracts/events';
import { MoveMode, type SimState, type TeamState } from '../contracts/state';
import { createBallPrediction, MAX_PREDICT_TICKS } from '../contracts/systems';
import { T_PLAYER } from '../contracts/tuning';
import { FORMATIONS, getFormation, remapFormation } from '../data/formations';
import { focusForCommand, TacticFlag, tacticFlagForCommand } from '../data/tactics';
import { predictBall } from '../sim/ball/flight';
import { ticksToReach } from '../sim/players/locomotion';
import { assignJob, isJobDriven } from './jobs';
import { invalidateShape } from './shape';
import { busyTicks } from './steer';

const LOCAL_TUNING = {
  /** Ball prediction horizon for the receiver's interception search, ticks (<= MAX_PREDICT_TICKS = 180). */
  receivePredictTicks: 120,
  /** Highest ball-centre height at which a receiver can play the ball (feet, chest, head), m. */
  receiveMaxHeight: 2.0,
  /** Lower-bound slack: ticksToReach may count a point as reached from up to this far away, m. */
  receiveReachSlack: 1.2,
  /** Safety factor (>= 1) on the Lipschitz sample skip after a failed ticksToReach (larger = fewer skips). */
  receiveSkipSafety: 2.0,
  /** Max ticksToReach evaluations per receiver per tick (budget guard; the end-of-horizon fallback follows). */
  receiveMaxEvals: 24,
  /** Through balls are met in stride: the meeting point may lie at most this far behind the receiver along the
   *  attack direction (unless no such point is reachable), m. */
  throughBackTol: 1.0,
} as const; // TUNING-CR

const LT = LOCAL_TUNING;
const N = PLAYERS_PER_TEAM;
const N_FORMATIONS = FORMATIONS.length;

/** The ball is out of play once its centre is a radius beyond a line (whole ball over the line). */
const OUT_X = HALF_LENGTH + BALL_RADIUS;
const OUT_Z = HALF_WIDTH + BALL_RADIUS;
/** Movement targets stay a body radius inside the boards (steer clamps the same way). */
const TGT_MAX_X = BOARD_X - T_PLAYER.bodyRadius;
const TGT_MAX_Z = BOARD_Z - T_PLAYER.bodyRadius;

// ---------------------------------------------------------------- module scratch (rewritten on every call)

/** Natural role per OLD formation index (-1 = vacant) for remapFormation. */
const NAT: number[] = new Array<number>(N).fill(-1);
/** Slot holding each OLD formation index among the active players (-1 = vacant). */
const HOLDER: number[] = new Array<number>(N).fill(-1);
/** OLD formation index used for each team-relative slot (-1 = not mapped). */
const OLD: number[] = new Array<number>(N).fill(-1);
/** remapFormation output: new index per old index. */
const OUT: number[] = new Array<number>(N).fill(0);

/** Receiver prediction (own scratch; one per call, never read across ticks). */
const PRED = createBallPrediction();
/** Cumulative horizontal path length of PRED up to sample i, m. */
const CUM = new Float64Array(MAX_PREDICT_TICKS);
/** findReception result: meeting point x, z. */
const RES = new Float64Array(2);

// ---------------------------------------------------------------- small helpers

function isInt(v: number, lo: number, hi: number): boolean {
  return v >= lo && v <= hi && Math.floor(v) === v;
}

function bit(v: number): number {
  return v === 0 || v !== v ? 0 : 1;
}

function isCornerTactic(v: number): boolean {
  return v === Command.CORNER_FAR_POST || v === Command.CORNER_EDGE_OF_BOX || v === Command.CORNER_CROWD_KEEPER ||
    v === Command.CORNER_NEAR_POST;
}

function isThroughKind(k: KickKind): boolean {
  return k === KickKind.THROUGH_GROUND || k === KickKind.THROUGH_LOBBED || k === KickKind.THROUGH_DINKED;
}

function clampTo(v: number, lim: number): number { return v > lim ? lim : v < -lim ? -lim : v; }

/** Toggle one TacticFlag on the team; returns the new value (0/1). */
function toggleTactic(t: TeamState, flag: number): number {
  switch (flag) {
    case TacticFlag.OFFSIDE_TRAP: t.offsideTrap = bit(t.offsideTrap) ^ 1; return t.offsideTrap;
    case TacticFlag.TEAM_PRESS: t.teamPress = bit(t.teamPress) ^ 1; return t.teamPress;
    case TacticFlag.EXTRA_STRIKER: t.extraStriker = bit(t.extraStriker) ^ 1; return t.extraStriker;
    case TacticFlag.GET_IN_BOX: t.getInBox = bit(t.getInBox) ^ 1; return t.getInBox;
    default: return 0;
  }
}

/** Natural role of the player in `slot` (his squad entry), falling back to his current role. */
function naturalRole(s: SimState, team: number, slot: number): number {
  const p = s.players[slot]!;
  const sq = s.squads[team];
  const d = sq === undefined ? undefined : sq[p.rosterIdx];
  const r = d === undefined ? p.role : d.pos;
  return isInt(r, Role.GK, Role.CF) ? r : Role.CM;
}

/** Active keeper of the team (team.keeperSlot if valid, else the first active isKeeper), -1 none. */
function activeKeeper(s: SimState, team: number): number {
  const first = teamFirstSlot(team);
  const ks = s.teams[team]!.keeperSlot;
  if (ks >= first && ks < first + N) {
    const k = s.players[ks]!;
    if (k.active === 1 && k.isKeeper === 1) return ks;
  }
  for (let i = first; i < first + N; i++) {
    const p = s.players[i]!;
    if (p.active === 1 && p.isKeeper === 1) return i;
  }
  return -1;
}

/** Record slot as the holder of his formIdx if it is valid and free; returns false otherwise. */
function claimIndex(s: SimState, team: number, slot: number): boolean {
  const fi = s.players[slot]!.formIdx;
  if (!isInt(fi, 0, N - 1) || HOLDER[fi] !== -1) return false;
  HOLDER[fi] = slot;
  NAT[fi] = naturalRole(s, team, slot);
  OLD[slot - teamFirstSlot(team)] = fi;
  return true;
}

/** Role a player takes on new formation index nf (keepers GK; outfielders never GK). */
function roleFor(to: number, nf: number, keeper: boolean, current: Role): Role {
  if (keeper) return Role.GK;
  const sl = getFormation(to).slots[nf];
  if (sl === undefined || sl.role === Role.GK) return current === Role.GK ? Role.CM : current;
  return sl.role;
}

// ---------------------------------------------------------------- commands

/** SET_FORMATION: re-map formIdx / role of the team for formation `arg`. Returns false for a bad argument. */
function setFormation(s: SimState, team: number, arg: number): boolean {
  if (!isInt(arg, 0, N_FORMATIONS - 1)) return false;
  const t = s.teams[team]!;
  const to = arg;
  const from = isInt(t.formation, 0, N_FORMATIONS - 1) ? t.formation : 0;
  if (to === t.formation) return true;
  const first = teamFirstSlot(team);
  for (let k = 0; k < N; k++) { NAT[k] = -1; HOLDER[k] = -1; OLD[k] = -1; }
  const keeper = activeKeeper(s, team);
  if (keeper >= 0 && !claimIndex(s, team, keeper)) {
    // Keeper without a usable index (corrupt state): he takes 0, whoever else claimed it is re-placed below.
    HOLDER[0] = keeper;
    NAT[0] = Role.GK;
    OLD[keeper - first] = 0;
  }
  for (let i = first; i < first + N; i++) {
    if (i === keeper || s.players[i]!.active !== 1) continue;
    claimIndex(s, team, i);
  }
  // Active players without a valid, unique index take the first free outfield index (deterministic slot order).
  for (let i = first; i < first + N; i++) {
    if (s.players[i]!.active !== 1 || OLD[i - first] >= 0) continue;
    let k = 1;
    while (k < N && HOLDER[k] !== -1) k++;
    if (k >= N) k = 0; // only reachable without a keeper (impossible in a legal match)
    if (HOLDER[k] !== -1) continue;
    HOLDER[k] = i;
    NAT[k] = naturalRole(s, team, i);
    OLD[i - first] = k;
  }
  let keeperIdx = 0;
  if (keeper >= 0) keeperIdx = OLD[keeper - first]!;
  else {
    // No keeper on the pitch: keep the GK slot vacant (a vacant old index goes to 0) when there is one.
    for (let k = 0; k < N; k++) if (HOLDER[k] === -1) { keeperIdx = k; break; }
  }
  remapFormation(from, to, NAT, keeperIdx, OUT);
  for (let i = first; i < first + N; i++) {
    const p = s.players[i]!;
    const old = OLD[i - first]!;
    if (old >= 0) {
      const nf = OUT[old]!;
      p.formIdx = nf;
      p.role = roleFor(to, nf, i === keeper, p.role);
    } else if (p.active !== 1 && isInt(p.formIdx, 0, N - 1) && HOLDER[p.formIdx] === -1) {
      // Off the pitch on a vacant index: follow the permutation onto the matching vacant index.
      const nf = OUT[p.formIdx]!;
      p.formIdx = nf;
      p.role = roleFor(to, nf, false, p.role);
    }
  }
  t.formation = to;
  invalidateShape(s, team);
  return true;
}

/** SWAP_POSITIONS: swap formIdx / role of two active outfield players (squad indices). False if refused. */
function swapPositions(s: SimState, team: number, arg: number): boolean {
  if (!isInt(arg, 0, 0xffff)) return false;
  const ra = arg & 255;
  const rb = (arg >> 8) & 255;
  if (ra === rb) return false;
  const first = teamFirstSlot(team);
  let a = -1;
  let b = -1;
  for (let i = first; i < first + N; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    if (p.rosterIdx === ra && a < 0) a = i;
    else if (p.rosterIdx === rb && b < 0) b = i;
  }
  if (a < 0 || b < 0) return false;
  const pa = s.players[a]!;
  const pb = s.players[b]!;
  if (pa.isKeeper === 1 || pb.isKeeper === 1 || a === s.teams[team]!.keeperSlot || b === s.teams[team]!.keeperSlot) {
    return false;
  }
  const fi = pa.formIdx;
  const ro = pa.role;
  pa.formIdx = pb.formIdx;
  pa.role = pb.role;
  pb.formIdx = fi;
  pb.role = ro;
  invalidateShape(s, team);
  return true;
}

export function applyCommand(s: SimState, team: number, cmd: Command, arg: number, ev: EventSink): void {
  if (team !== 0 && team !== 1) return;
  if (s.match.finished === 1) return;
  const t = s.teams[team]!;
  let value: number;
  switch (cmd) {
    case Command.TACTIC_OFFSIDE_TRAP:
    case Command.TACTIC_TEAM_PRESS:
    case Command.TACTIC_EXTRA_STRIKER:
    case Command.TACTIC_GET_IN_BOX:
      value = toggleTactic(t, tacticFlagForCommand(cmd));
      invalidateShape(s, team);
      break;
    case Command.FOCUS_DEFAULT:
    case Command.FOCUS_DEFENDING:
    case Command.FOCUS_ATTACKING: {
      const f = focusForCommand(cmd);
      t.focus = f >= 0 ? f : TacticalFocus.DEFAULT;
      value = t.focus;
      invalidateShape(s, team);
      break;
    }
    case Command.SET_FORMATION:
      if (!setFormation(s, team, arg)) return;
      value = t.formation;
      break;
    case Command.CORNER_FAR_POST:
    case Command.CORNER_EDGE_OF_BOX:
    case Command.CORNER_CROWD_KEEPER:
    case Command.CORNER_NEAR_POST:
      t.cornerTactic = cmd;
      value = cmd;
      break;
    case Command.SWAP_POSITIONS:
      if (!swapPositions(s, team, arg)) return;
      value = arg;
      break;
    default:
      return; // NONE, QUICK_SUB, SUBSTITUTE, SKIP and unknown values are not tactics
  }
  ev.emit(EventType.TACTIC, team, cmd, value);
}

// ---------------------------------------------------------------- per-tick upkeep

export function tacticsTick(s: SimState, team: number, ev: EventSink): void {
  if (team !== 0 && team !== 1) return;
  const t = s.teams[team]!;
  let dirty = false;
  let v = bit(t.offsideTrap);
  if (v !== t.offsideTrap) { t.offsideTrap = v; dirty = true; }
  v = bit(t.teamPress);
  if (v !== t.teamPress) { t.teamPress = v; dirty = true; }
  v = bit(t.extraStriker);
  if (v !== t.extraStriker) { t.extraStriker = v; dirty = true; }
  v = bit(t.getInBox);
  if (v !== t.getInBox) { t.getInBox = v; dirty = true; }
  if (!isInt(t.focus, TacticalFocus.DEFAULT, TacticalFocus.ATTACKING)) { t.focus = TacticalFocus.DEFAULT; dirty = true; }
  if (!isInt(t.formation, 0, N_FORMATIONS - 1)) { t.formation = 0; dirty = true; }
  if (t.cornerTactic !== 0 && !isCornerTactic(t.cornerTactic)) t.cornerTactic = 0;

  // Temporary tactic: the corner instruction lasts for one corner.
  const m = s.match;
  if (t.cornerTactic !== 0 && m.prevPhase === MatchPhase.CORNER && m.phase !== MatchPhase.CORNER && m.phaseT <= 1 &&
    (m.phase !== MatchPhase.IN_PLAY || m.restart.team === team)) {
    t.cornerTactic = 0;
  }
  if (dirty) invalidateShape(s, team);
}

// ---------------------------------------------------------------- receiver assist

/**
 * Scan parameters set by findReception for scanReach (module scratch, rewritten on every call):
 * [0] busy ticks, [1] busy ticks ticksToReach does not count, [2] earliest playable tick, [3] L = ticks per metre at
 * top speed, [4] Lipschitz constant K, [5] minimum forward coordinate (dir * x) for a through ball, [6] 1 = through
 * ball filter on, [7] team.dir.
 */
const SC = new Float64Array(8);
/** ticksToReach calls left in this findReception (shared by its scans). */
let scanBudget = 0;
/** Earliest reachable sample found that failed only the through-ball "not behind" filter (-1 none). */
let scanAny = -1;

/**
 * First predicted sample in [lo, hi) the receiver can play and reach in time (busy + ticksToReach <= its tick), and,
 * with the through filter on, that is not behind him. -1 if none (or the budget ran out). Reachable samples that
 * fail only the filter are recorded in scanAny (earliest wins).
 */
function scanReach(s: SimState, slot: number, lo: number, hi: number): number {
  const p = s.players[slot]!;
  const busy = SC[0]!;
  const extra = SC[1]!;
  const earliest = SC[2]!;
  const L = SC[3]!;
  const K = SC[4]!;
  const minFwd = SC[5]!;
  const through = SC[6] === 1;
  const dir = SC[7]!;
  const xs = PRED.x;
  const ys = PRED.y;
  const zs = PRED.z;
  let i = lo;
  while (i < hi) {
    const tick = i + 1;
    if (tick < earliest) { i = Math.ceil(earliest) - 1; continue; }
    if (ys[i]! > LT.receiveMaxHeight) { i++; continue; }
    const x = xs[i]!;
    const z = zs[i]!;
    const fwdOk = !through || dir * x >= minFwd;
    if (!fwdOk && scanAny >= 0 && scanAny <= i) { i++; continue; }
    const dx = x - p.x;
    const dz = z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const lb = busy + (d > LT.receiveReachSlack ? (d - LT.receiveReachSlack) * L : 0);
    if (lb > tick) { i++; continue; }
    if (scanBudget <= 0) return -1;
    scanBudget--;
    const tt = extra + ticksToReach(s, slot, x, z);
    if (tt <= tick) {
      if (fwdOk) return i;
      if (scanAny < 0 || i < scanAny) scanAny = i;
      i++;
      continue;
    }
    // Lipschitz skip: tt(j) >= tt - K * |P_j - P_i| >= tt - K * (CUM[j] - CUM[i]); skip while that exceeds j + 1.
    const ci = CUM[i]!;
    let j = i + 1;
    while (j < hi && tt - K * (CUM[j]! - ci) > j + 1) j++;
    i = j;
  }
  return -1;
}

/** Best interception point of the free ball for `slot` (see the header) into RES (x, z). */
function findReception(s: SimState, slot: number): void {
  const b = s.ball;
  const p = s.players[slot]!;
  predictBall(b, LT.receivePredictTicks, PRED);
  let n = PRED.count;
  if (!(n > 0)) n = 0;
  if (n > MAX_PREDICT_TICKS) n = MAX_PREDICT_TICKS;
  const xs = PRED.x;
  const zs = PRED.z;
  // Keep the samples while the ball is in play; cumulative path length for the Lipschitz skip.
  let px = b.x;
  let pz = b.z;
  let acc = 0;
  let m = 0;
  while (m < n) {
    const x = xs[m]!;
    const z = zs[m]!;
    if (!(x <= OUT_X && x >= -OUT_X && z <= OUT_Z && z >= -OUT_Z)) break;
    const dx = x - px;
    const dz = z - pz;
    acc += Math.sqrt(dx * dx + dz * dz);
    CUM[m] = acc;
    px = x;
    pz = z;
    m++;
  }
  n = m;
  if (n === 0) {
    RES[0] = b.x;
    RES[1] = b.z;
    return;
  }
  // Busy ticks: a locking action / stun; SIM-04 ticksToReach already counts the remaining ticks of a LOCKED action.
  const counted = p.moveMode === MoveMode.LOCKED && p.act !== ActionKind.NONE && p.actDur > p.actT ? p.actDur - p.actT : 0;
  const own = busyTicks(p);
  const top = s.attrs[slot]!.topSpeed > 1 ? s.attrs[slot]!.topSpeed : 1;
  const through = isThroughKind(b.lastKickKind);
  const dir = s.teams[p.team]!.dir;
  SC[0] = own > counted ? own : counted;
  SC[1] = own > counted ? own - counted : 0;
  SC[2] = SC[0]! > p.noTouchT ? SC[0]! : p.noTouchT;
  SC[3] = TICK_HZ / top;
  SC[4] = SC[3]! * LT.receiveSkipSafety;
  SC[5] = dir * p.x - LT.throughBackTol;
  SC[6] = through ? 1 : 0;
  SC[7] = dir;
  scanBudget = LT.receiveMaxEvals;
  scanAny = -1;
  let found: number;
  if (through) {
    // In stride: the passer led him to (passX, passZ); meet the ball there or further along, never behind him.
    let ip = 0;
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const dx = xs[k]! - b.passX;
      const dz = zs[k]! - b.passZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; ip = k; }
    }
    found = scanReach(s, slot, ip, n);
    if (found < 0 && ip > 0) found = scanReach(s, slot, 0, ip);
    if (found < 0) found = scanAny;
  } else {
    found = scanReach(s, slot, 0, n);
  }
  if (found < 0) found = n - 1; // nothing reachable in the horizon: go where the ball is going
  RES[0] = xs[found]!;
  RES[1] = zs[found]!;
}

/** The job-driven intended receiver of this team's pass in flight, or -1. */
function assistedReceiver(s: SimState, team: number): number {
  const b = s.ball;
  const r = b.passTarget;
  const first = teamFirstSlot(team);
  if (r < first || r >= first + N || (r | 0) !== r) return -1;
  if (s.match.phase !== MatchPhase.IN_PLAY || b.owner !== -1 || b.heldBy !== -1) return -1;
  if (b.lastKickTeam !== team || b.lastTouchTeam !== team) return -1;
  return isJobDriven(s, r) ? r : -1;
}

export function receiverAssist(s: SimState, team: number, ev: EventSink): void {
  if (team !== 0 && team !== 1) return;
  let r = assistedReceiver(s, team);
  if (r >= 0) {
    findReception(s, r);
    const b = s.ball;
    const x = RES[0]!;
    const z = RES[1]!;
    const tx = clampTo(Number.isFinite(x) ? x : b.x, TGT_MAX_X);
    const tz = clampTo(Number.isFinite(z) ? z : b.z, TGT_MAX_Z);
    const top = s.attrs[r]!.topSpeed;
    if (!assignJob(s, r, AiJob.RECEIVE, tx, tz, top > 0 ? top : T_PLAYER.topSpeedMin, -1)) r = -1;
  }
  for (let c = 0; c < NUM_CONTROLLERS; c++) {
    const ctl = s.ctrl[c]!;
    if (ctl.kind === ControllerKind.NONE || ctl.side !== team) continue;
    if (r >= 0) {
      if (ctl.slot !== r) ctl.receiver = r;
    } else if (ctl.receiver !== -1 && ctl.receiver !== ctl.slot) {
      ctl.receiver = -1;
    }
  }
}

/** Exposed for tests and tuning tools (read-only). */
export const TACTICS_TUNING = LOCAL_TUNING;
