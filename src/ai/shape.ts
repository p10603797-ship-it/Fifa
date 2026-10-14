/**
 * [TAI-01] Formations and role home positions. Formations 4-4-2, 4-3-3, 4-2-3-1, 3-5-2, 5-3-2, 4-1-2-1-2
 * (data/formations.ts). Each role's home position shifts with the ball, the team phase (build-up, attack,
 * defend, transition) and the tactical focus; staggered updates (T_AI.shapeInterval, team.shapeT). Writes
 * team.homeX/homeZ (per formIdx) and every player's homeX/homeZ. Mirror for attack direction (team.dir).
 * Handles teams playing short (fewer than 11) by stretching remaining roles.
 *
 * Model (all maths in the team frame: u = dir * x is progress toward the opposition goal, v = dir * z is the
 * team's right flank, so one code path serves both attack directions and the result is mirrored exactly):
 *  1. Occupants: every active non-keeper player holds his formation slot (by p.formIdx). Short-handed sides
 *     (sent off, keeper replaced by an outfielder) rebalance their lines toward a target shape (4-4-2 minus one
 *     -> 4-4-1, ...): a lacking line pulls the laterally nearest player from the line ahead (cascading), and
 *     sub-lines with gaps re-spread their members across a slightly narrower span. The keeper (isKeeper) always
 *     gets the keeper home, whatever his formIdx; nobody else does.
 *  2. Quick tactic extraStriker (DAT-04 data/tactics EXTRA_STRIKER_SHAPES, the same data TAI-14's slotRole /
 *     slotLineFor give TAI-04/05/06): with a full side every listed slot moves to its override position, so the
 *     slot that slotLineFor reports in the FWD line joins the forward line as a forward and his neighbours close
 *     the gap (all of them half way out of possession). A short-handed side pushes that same formIdx when he still
 *     plays in midfield, else its best midfielder (CAM > CM > CDM, then most central, then most advanced), into a
 *     free lane of the forward line.
 *  3. Vertical: the back line starts at the formation's neutral back line (its deepest outfield slot) and moves
 *     by a per-phase offset + slope * ballU (higher in build-up/attack, deeper when defending), shifted by the
 *     block push of data/tactics resolveTactics (focus FOCUS_MODIFIERS.pushNx in possession; + team press
 *     QUICK_TACTICS.teamPress.pushNx out of possession), and is taken from TAI-04's team.lineX in defending open
 *     play (within LOCAL_TUNING.lineXTrust of our own estimate). Other slots keep their formation depth relative
 *     to the back line, scaled per phase and focus (focusDepth), plus role pushes (full-backs and forwards up in
 *     attack, wide players back in defence); the back line is flattened when defending and nobody stands deeper
 *     than it. Widths scale per phase and by the resolveTactics focus width (widthAttack in possession,
 *     widthDefend out of possession).
 *  4. Lateral: the block slides toward the ball, the far side narrows, and the ball side is squeezed so the
 *     widest player stays inside the touchline (width shrinks on the ball side).
 *  5. Compactness: sorted outfield depths never leave a gap above T_AI.lineSpacingMax (chain clamp).
 *  6. Quick tactic getInBox: when crossing (in possession, ball in the crossing zone) the widest non-defenders
 *     (one per flank, never the carrier) go to the far post and the penalty spot (data/tactics BOX_SPOTS, the
 *     spots TAI-03's box runners fill).
 *  7. Clamps: onside (not beyond the opponents' second-last defender unless level with/behind the ball or in our
 *     own half, when offside is on), inside the pitch, outfielders outside their own goal area; during KICK_OFF
 *     own half and, for the defending side, outside the centre circle.
 *  8. getInBox spacing: a box player whose (clamped) spot lands on a team-mate's home slides sideways to the
 *     nearest free spot inside the box (LOCAL_TUNING.boxSeparation).
 *
 * Staggering: team.shapeT counts down; the shape is recomputed when it reaches 1 (or 0 = forced, see
 * invalidateShape) on ticks aligned to the interval, team 1 offset by half an interval. Every tick each active
 * player's homeX/homeZ is re-synced from team.homeX/homeZ[p.formIdx] (cheap; robust to substitutions).
 */
import {
  CENTRE_CIRCLE_RADIUS, CROSS_ZONE_DEPTH, CROSS_ZONE_MIN_Z, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_HALF_WIDTH,
  HALF_LENGTH, HALF_WIDTH, PENALTY_AREA_HALF_WIDTH, PLAYERS_PER_TEAM,
} from '../contracts/constants';
import { MatchPhase, RestartKind, Role, TeamPhase } from '../contracts/enums';
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';
import { T_AI } from '../contracts/tuning';
import { FORMATIONS, ShapeLine, slotLine } from '../data/formations';
import {
  BOX_SPOTS, createTacticParams, EXTRA_STRIKER_SHAPES, resolveTactics, slotLineFor, TacticFlag, tacticFlags,
} from '../data/tactics';
import { otherTeam, possessingTeam, teamEnd, teamStart } from '../sim/core/query';

// Per-phase tables are indexed by TeamPhase: BUILD_UP, ATTACK, DEFEND, TRANSITION_ATTACK, TRANSITION_DEFEND,
// SET_PIECE. SET_PIECE is resolved to BUILD_UP/ATTACK (restart team) or DEFEND (other team) before lookup, so its
// column is only a fallback. Team-frame u: metres from the centre spot toward the opposition goal.
const LOCAL_TUNING = {
  /** Back-line height: u = dataBack + lineOffset + lineSlope * ballU, clamped to [lineMin, lineMax]. dataBack is
   *  the formation's deepest outfield slot (its neutral back line). m, m/m, m (team frame), m (team frame). */
  lineOffset: [8, 16, 7, 14, 3, 7],
  lineSlope: [0.55, 0.6, 0.55, 0.55, 0.55, 0.55],
  lineMin: [-40, -36, -46.5, -36, -46.5, -44],
  lineMax: [2, 16, 9, 14, 3, 9],
  /** Absolute back-line limits after focus and TAI-04 lineX, m (floor = own goal-area edge + 0.5 m). */
  lineFloor: -46.5,
  lineCeil: 18,
  /** Vertical stretch of formation depths relative to the deepest outfield slot (1 = data depths). */
  depthScale: [1.25, 1.45, 1.0, 1.4, 0.95, 1],
  /** Back-line depth stagger kept in defending phases (0 = perfectly flat, 1 = data stagger). */
  defFlatten: 0.3,
  /** Lateral stretch of the formation width (1 = data width). */
  widthScale: [1.1, 1.05, 0.85, 1, 0.88, 0.95],
  /** Fraction of the ball's lateral offset the block slides by; cap, m. */
  slide: [0.25, 0.3, 0.45, 0.25, 0.4, 0.3],
  slideMax: 14,
  /** Width factor on the ball side / far side with the ball fully wide (1 = unchanged); full at narrowRange m. */
  nearNarrow: [1, 1, 0.9, 1, 0.9, 1],
  farNarrow: [0.95, 1, 0.7, 1, 0.75, 0.9],
  narrowRange: 20,
  /** Role depth offsets per phase, m (+ = toward the opposition goal). */
  fullBackPush: [4, 8, 0, 5, 0, 0],
  wingBackPush: [4, 6, -6, 6, -6, 0],
  wideMidPush: [0, 2, -2, 3, -2, 0],
  wingerPush: [2, 7, -2, 8, -2, 0],
  forwardPush: [2, 6, 3, 8, 0, 0],
  /** Tactical focus (DEFAULT, DEFENDING, ATTACKING): multiplier on the formation depths. The focus block push
   *  and width multipliers are DAT-04's (data/tactics resolveTactics), shared with every other module. */
  focusDepth: [1, 0.9, 1.08],
  /** Accepted deviation of TAI-04's team.lineX from this module's own back-line estimate, m. */
  lineXTrust: 15,
  /** Max gap between consecutive outfield depths as a fraction of T_AI.lineSpacingMax ... */
  lineGapFraction: 0.97,
  /** ... x this per phase [INT-A: a team in possession stretches (about 40 m from the back line to the forwards);
   *  one capped at 14 m gaps in possession had nobody between or beyond the opponents' lines]. */
  lineGapScale: [1.35, 1.5, 1, 1.5, 1, 1],
  /** Formation slots of one line whose nx differ by at most this form one sub-line (normalised units). */
  subLineTolerance: 0.12,
  /** Span kept by a sub-line with k of n members: spreadMin + (1 - spreadMin) * (k - 1) / (n - 1). */
  spreadMin: 0.5,
  /** Sub-lines whose members are all at least this wide (|nz|) are flank pairs and keep their spots. */
  flankNz: 0.4,
  /** Extra striker: lateral offset beside a lone forward (nz units, short-handed sides only); share of the move
   *  to the EXTRA_STRIKER_SHAPES positions (and of the push up) out of possession. */
  extraStrikerNz: 0.22,
  extraStrikerDefend: 0.5,
  /** Get in the box: min |nz| to count as wide (targets: data/tactics BOX_SPOTS far post and penalty spot). */
  getInBoxMinNz: 0.25,
  /** Get in the box: min distance of a box player's home from any team-mate's home, m; numeric slack, m; he stays
   *  this far inside the penalty area's side lines, m. */
  boxSeparation: 4,
  boxSeparationSlack: 1e-6,
  boxSideMargin: 1,
  /** Margins, m: inside the touchlines, inside the goal lines, outside the own goal area, onside. */
  sideMargin: 1.5,
  endMargin: 1,
  goalAreaMargin: 0.5,
  offsideMargin: 0.7,
  /** Kick-off: stay this far inside the own half / outside the centre circle, m. */
  kickOffMargin: 0.5,
  /** Keeper home: depth off the goal line with the ball at the own / opposition goal line, m; lateral follow. */
  keeperDepthNear: 2,
  keeperDepthFar: 12,
  keeperFollow: 0.15,
  /** Keeper home stays this far inside the posts laterally, m. */
  keeperPostMargin: 0.5,
} as const; // TUNING-CR

const T = LOCAL_TUNING;
const N = PLAYERS_PER_TEAM;

const LINE_GK = -1;
const LINE_DEF = 0;
const LINE_MID = 1;
const LINE_FWD = 2;

const KIND_OTHER = 0;
const KIND_FB = 1;
const KIND_WB = 2;
const KIND_WIDE = 3;
const KIND_WINGER = 4;
const KIND_FWD = 5;

// ------------------------------------------------------------------ formation tables (built once at load)

const NF = FORMATIONS.length;
const fNx = new Float64Array(NF * N);
const fNz = new Float64Array(NF * N);
const fLine = new Int32Array(NF * N);
const fKind = new Int32Array(NF * N);
/** extraStriker preference: CAM 3, CM 2, CDM 1, others 0. */
const fCentral = new Int32Array(NF * N);
/** Sub-line id (formation-local, 0..10) per slot; -1 for the keeper. */
const fGroup = new Int32Array(NF * N);
const gSize = new Int32Array(NF * N);
const gVmax = new Float64Array(NF * N);
const gVmin = new Float64Array(NF * N);
const gFlank = new Int32Array(NF * N);
const fNxBack = new Float64Array(NF);
const fNxFront = new Float64Array(NF);
const fLineCount = new Int32Array(NF * 3);
const fOutfield = new Int32Array(NF);

function roleKind(role: Role): number {
  if (role === Role.RB || role === Role.LB) return KIND_FB;
  if (role === Role.RWB || role === Role.LWB) return KIND_WB;
  if (role === Role.RM || role === Role.LM) return KIND_WIDE;
  if (role === Role.RW || role === Role.LW) return KIND_WINGER;
  if (role === Role.ST || role === Role.CF) return KIND_FWD;
  return KIND_OTHER;
}

function roleCentral(role: Role): number {
  return role === Role.CAM ? 3 : role === Role.CM ? 2 : role === Role.CDM ? 1 : 0;
}

function buildFormationTables(): void {
  const tmp = new Int32Array(N);
  for (let fi = 0; fi < NF; fi++) {
    const slots = FORMATIONS[fi]!.slots;
    const base = fi * N;
    let defSum = 0, defN = 0, midSum = 0, midN = 0;
    for (let k = 0; k < N; k++) {
      const sl = slots[k];
      const role = sl ? sl.role : Role.CM;
      fNx[base + k] = sl ? sl.nx : 0;
      fNz[base + k] = sl ? sl.nz : 0;
      fKind[base + k] = roleKind(role);
      fCentral[base + k] = roleCentral(role);
      if (role === Role.RB || role === Role.CB || role === Role.LB) { defSum += fNx[base + k]!; defN++; }
      if (role === Role.CDM || role === Role.CM || role === Role.CAM || role === Role.RM || role === Role.LM) { midSum += fNx[base + k]!; midN++; }
    }
    const defMean = defN > 0 ? defSum / defN : -0.65;
    const midMean = midN > 0 ? midSum / midN : -0.3;
    let back = 1e9, front = -1e9, outfield = 0;
    for (let k = 0; k < N; k++) {
      const sl = slots[k];
      const role = sl ? sl.role : Role.CM;
      const nx = fNx[base + k]!;
      let line: number;
      if (k === 0 || role === Role.GK) line = LINE_GK;
      else if (role === Role.RB || role === Role.CB || role === Role.LB) line = LINE_DEF;
      else if (role === Role.RWB || role === Role.LWB) line = nx - defMean <= midMean - nx ? LINE_DEF : LINE_MID;
      else if (role === Role.CDM || role === Role.CM || role === Role.CAM || role === Role.RM || role === Role.LM) line = LINE_MID;
      else line = LINE_FWD;
      fLine[base + k] = line;
      // A wing-back in the back line (back five) behaves like a full-back: up in attack, flat in defence.
      if (line === LINE_DEF && fKind[base + k] === KIND_WB) fKind[base + k] = KIND_FB;
      if (line === LINE_GK) continue;
      fLineCount[fi * 3 + line]++;
      outfield++;
      if (nx < back) back = nx;
      if (nx > front) front = nx;
    }
    fOutfield[fi] = outfield;
    fNxBack[fi] = outfield > 0 ? back : -0.65;
    fNxFront[fi] = outfield > 0 ? front : 0;
    // Sub-lines: per line, slots sorted by nx, split where consecutive nx differ by more than the tolerance.
    let gid = 0;
    for (let k = 0; k < N; k++) fGroup[base + k] = -1;
    for (let line = LINE_DEF; line <= LINE_FWD; line++) {
      let n = 0;
      for (let k = 0; k < N; k++) {
        if (fLine[base + k] !== line) continue;
        let j = n++;
        while (j > 0 && fNx[base + tmp[j - 1]!]! > fNx[base + k]!) { tmp[j] = tmp[j - 1]!; j--; }
        tmp[j] = k;
      }
      for (let j = 0; j < n; j++) {
        const k = tmp[j]!;
        if (j > 0 && fNx[base + k]! - fNx[base + tmp[j - 1]!]! > T.subLineTolerance) gid++;
        fGroup[base + k] = gid;
      }
      if (n > 0) gid++;
    }
    for (let g = 0; g < N; g++) { gSize[base + g] = 0; gVmax[base + g] = -1e9; gVmin[base + g] = 1e9; gFlank[base + g] = 1; }
    for (let k = 0; k < N; k++) {
      const g = fGroup[base + k]!;
      if (g < 0) continue;
      const nz = fNz[base + k]!;
      gSize[base + g]++;
      if (nz > gVmax[base + g]!) gVmax[base + g] = nz;
      if (nz < gVmin[base + g]!) gVmin[base + g] = nz;
      if ((nz < 0 ? -nz : nz) < T.flankNz) gFlank[base + g] = 0;
    }
    for (let g = 0; g < N; g++) if (gSize[base + g]! < 2) gFlank[base + g] = 0;
  }
}
buildFormationTables();

/** DAT-04 EXTRA_STRIKER_SHAPES per formation, flattened: override count, slot, nx, nz (slot order of the data). */
const esCount = new Int32Array(NF);
const esIdx = new Int32Array(NF * N);
const esNx = new Float64Array(NF * N);
const esNz = new Float64Array(NF * N);
/** The extra striker's formIdx per formation: the slot slotLineFor puts in the FWD line under EXTRA_STRIKER while
 *  the formation has it elsewhere (-1: no such slot in the data). */
const esStriker = new Int32Array(NF);

function buildExtraStrikerTables(): void {
  for (let fi = 0; fi < NF; fi++) {
    const base = fi * N;
    const list = EXTRA_STRIKER_SHAPES[fi];
    let n = 0;
    if (list !== undefined) {
      for (let j = 0; j < list.length && n < N; j++) {
        const o = list[j]!;
        if (!(o.idx >= 1 && o.idx < N) || (o.idx | 0) !== o.idx || fLine[base + o.idx] === LINE_GK) continue;
        esIdx[base + n] = o.idx;
        esNx[base + n] = fin(o.nx);
        esNz[base + n] = fin(o.nz);
        n++;
      }
    }
    esCount[fi] = n;
    esStriker[fi] = -1;
    for (let k = 1; k < N; k++) {
      if (fLine[base + k] === LINE_GK || slotLine(fi, k) === ShapeLine.FWD) continue;
      if (slotLineFor(fi, k, TacticFlag.EXTRA_STRIKER) === ShapeLine.FWD) { esStriker[fi] = k; break; }
    }
  }
}
buildExtraStrikerTables();

/** getInBox targets (team frame; nzSide is multiplied by the ball side): BOX_SPOTS far post and penalty spot. */
const BOX_FAR = BOX_SPOTS[1]!;
const BOX_SPOT = BOX_SPOTS[2]!;

/** Focus + quick tactics resolved by data/tactics (module scratch, rewritten on every computeShape). */
const TP = createTacticParams();

/** Same lookup rule as data/formations getFormation (falls back to the first formation). */
function formationIndex(id: number): number {
  return id >= 0 && id < NF && (id | 0) === id ? id : 0;
}

// ------------------------------------------------------------------ scratch (reused; never state)

/** 1 if formIdx f is held by an active outfielder. */
const occ = new Int32Array(N);
/** Formation slot assigned to occupant f (-1 none). */
const asg = new Int32Array(N);
/** Occupant formIdx in formation slot k (-1 vacant). */
const slotBy = new Int32Array(N);
/** Effective normalised position per formIdx. */
const enx = new Float64Array(N);
const enz = new Float64Array(N);
/** Team-frame home per formIdx, and lateral offset from the block centre. */
const hu = new Float64Array(N);
const hv = new Float64Array(N);
const hw = new Float64Array(N);
/** 1 if entry f gets the keeper home. */
const isGk = new Int32Array(N);
const ord = new Int32Array(N);
const fwdZ = new Float64Array(N);
const cnt = new Int32Array(3);
const tgt = new Int32Array(3);
const gOcc = new Int32Array(N);
/** Result of computeShape in pitch coordinates per formIdx. */
const outX = new Float64Array(N);
const outZ = new Float64Array(N);

/** Line removal order for short-handed target shapes: (line, floor) pairs applied while players are missing. */
const REMOVE_LINE = [LINE_FWD, LINE_MID, LINE_DEF, LINE_MID, LINE_FWD, LINE_DEF, LINE_MID, LINE_DEF, LINE_MID, LINE_DEF] as const;
const REMOVE_FLOOR = [1, 3, 4, 2, 0, 3, 1, 2, 0, 0] as const;

// No allocation per call: V8 boxes a non-integer number into a new heap object whenever it crosses a call that is
// not inlined (argument or return value). Per-tick code therefore uses the Math.abs/min/max/sqrt intrinsics,
// passes doubles through module scratch (num / ballIn) and calls helpers only with small-integer arguments and
// results (formIdx, slot, phase, flags). Load-time code may use fin().
/** v if finite, else 0 (load time only; computeShape inlines the same test). */
function fin(v: number): number { return v - v === 0 ? v : 0; }
/** Double scratch: [0] offside line of the opposition (team frame of the shape's team, see offsideLine). */
const num = new Float64Array(1);
/** Ball position handed to computeShape (pitch coordinates): x, z. */
const ballIn = new Float64Array(2);
/** Candidate box position for boxSpotClear (team frame): u, v. */
const boxQ = new Float64Array(2);

/** Active keeper slot of a team: team.keeperSlot when valid, else the first active isKeeper player, else -1. */
function keeperSlotOf(s: SimState, team: number): number {
  const ks = s.teams[team]!.keeperSlot;
  const start = teamStart(team), end = teamEnd(team);
  if (ks >= start && ks < end) {
    const p = s.players[ks]!;
    if (p.active === 1 && p.isKeeper === 1) return ks;
  }
  for (let i = start; i < end; i++) {
    const p = s.players[i]!;
    if (p.active === 1 && p.isKeeper === 1) return i;
  }
  return -1;
}

/** Most important vacant outfield slot in `line` (LINE_GK = any line, defence first): central first, then index. */
function bestVacancy(base: number, line: number): number {
  let best = -1;
  for (let k = 0; k < N; k++) {
    const l = fLine[base + k]!;
    if (l === LINE_GK || slotBy[k] !== -1) continue;
    if (line !== LINE_GK && l !== line) continue;
    if (best < 0) { best = k; continue; }
    const lb = fLine[base + best]!;
    if (l < lb || (l === lb && Math.abs(fNz[base + k]!) < Math.abs(fNz[base + best]!))) best = k;
  }
  return best;
}

/** Occupant on a slot of `line` laterally nearest to slot k (then nearest in depth, then lowest formIdx). */
function bestDonor(base: number, line: number, k: number): number {
  let best = -1, bestDz = 0, bestDx = 0;
  const vz = fNz[base + k]!, vx = fNx[base + k]!;
  for (let f = 0; f < N; f++) {
    if (occ[f] !== 1) continue;
    const a = asg[f]!;
    if (a < 0 || fLine[base + a] !== line) continue;
    const dz = Math.abs(fNz[base + a]! - vz), dx = Math.abs(fNx[base + a]! - vx);
    if (best < 0 || dz < bestDz || (dz === bestDz && dx < bestDx)) { best = f; bestDz = dz; bestDx = dx; }
  }
  return best;
}

/** Move the best donor of line `from` into the most important vacancy of line `to`. */
function moveOne(base: number, from: number, to: number): boolean {
  const k = bestVacancy(base, to);
  if (k < 0) return false;
  const f = bestDonor(base, from, k);
  if (f < 0) return false;
  slotBy[asg[f]!] = -1;
  asg[f] = k;
  slotBy[k] = f;
  cnt[from]--;
  cnt[to]++;
  return true;
}

/** Short-handed rebalancing: place unassigned occupants, then move players between lines toward the target. */
function rebalance(fi: number): void {
  const base = fi * N;
  for (let f = 0; f < N; f++) {
    if (occ[f] !== 1 || asg[f]! >= 0) continue;
    const k = bestVacancy(base, LINE_GK);
    if (k < 0) { occ[f] = 0; continue; } // no outfield spot left: he keeps his (keeper) entry
    asg[f] = k;
    slotBy[k] = f;
  }
  cnt[0] = 0; cnt[1] = 0; cnt[2] = 0;
  let total = 0;
  for (let f = 0; f < N; f++) {
    if (occ[f] !== 1 || asg[f]! < 0) continue;
    cnt[fLine[base + asg[f]!]!]++;
    total++;
  }
  for (let l = 0; l < 3; l++) tgt[l] = fLineCount[fi * 3 + l]!;
  let missing = tgt[0]! + tgt[1]! + tgt[2]! - total;
  for (let r = 0; r < REMOVE_LINE.length && missing > 0; r++) {
    const l = REMOVE_LINE[r]!, floor = REMOVE_FLOOR[r]!;
    while (missing > 0 && tgt[l]! > floor) { tgt[l]--; missing--; }
  }
  for (let l = LINE_DEF; l <= LINE_FWD; l++) {
    let guard = 0;
    while (cnt[l]! < tgt[l]! && guard++ < N) {
      // Nearest line with a surplus (ties: the line ahead), cascading through midfield when two lines away.
      let d = -1;
      for (let dist = 1; dist <= 2 && d < 0; dist++) {
        if (l + dist <= LINE_FWD && cnt[l + dist]! > tgt[l + dist]!) d = l + dist;
        else if (l - dist >= LINE_DEF && cnt[l - dist]! > tgt[l - dist]!) d = l - dist;
      }
      if (d < 0) break;
      if ((d - l === 2 || l - d === 2) && cnt[LINE_MID]! > 0) {
        if (!moveOne(base, LINE_MID, l)) break;
        if (!moveOne(base, d, LINE_MID)) break;
      } else if (!moveOne(base, d, l)) break;
    }
  }
}

/** Re-spread the members of sub-lines that have gaps across a slightly narrower span (keeps their order). */
function respread(fi: number): void {
  const base = fi * N;
  for (let g = 0; g < N; g++) gOcc[g] = 0;
  for (let f = 0; f < N; f++) if (occ[f] === 1 && asg[f]! >= 0) gOcc[fGroup[base + asg[f]!]!]++;
  for (let g = 0; g < N; g++) {
    const k = gOcc[g]!, n = gSize[base + g]!;
    if (k === 0 || k >= n || gFlank[base + g] === 1) continue;
    let m = 0;
    for (let f = 0; f < N; f++) {
      if (occ[f] !== 1 || asg[f]! < 0 || fGroup[base + asg[f]!] !== g) continue;
      let j = m++;
      while (j > 0 && fNz[base + asg[ord[j - 1]!]!]! < fNz[base + asg[f]!]!) { ord[j] = ord[j - 1]!; j--; }
      ord[j] = f;
    }
    const vmax = gVmax[base + g]!, vmin = gVmin[base + g]!;
    const c = (vmax + vmin) * 0.5;
    const half = (vmax - vmin) * 0.5 * (T.spreadMin + (1 - T.spreadMin) * (k - 1) / (n - 1));
    for (let j = 0; j < m; j++) enz[ord[j]!] = k === 1 ? c : c + half - (2 * half * j) / (k - 1);
  }
}

/**
 * Extra striker (see the header, step 2). Full side: DAT-04's EXTRA_STRIKER_SHAPES (every listed slot moves `share`
 * of the way to its override; the striker is esStriker). Short-handed (or no data shape): esStriker when he still
 * plays in midfield, else the best midfielder (CAM > CM > CDM > other, then most central, then most advanced, then
 * the lowest formIdx) moves `share` of the way into a free lane of the forward line. Returns his formIdx (-1 none).
 */
function applyExtraStriker(fi: number, defending: boolean, full: boolean): number {
  const base = fi * N;
  const share = defending ? T.extraStrikerDefend : 1;
  const es = esStriker[fi]!;
  if (full && es >= 0) {
    for (let j = 0; j < esCount[fi]!; j++) {
      const f = slotBy[esIdx[base + j]!]!;
      if (f < 0) continue;
      enx[f] = enx[f]! + (esNx[base + j]! - enx[f]!) * share;
      enz[f] = enz[f]! + (esNz[base + j]! - enz[f]!) * share;
    }
    return es;
  }
  let pick = es >= 0 && occ[es] === 1 && asg[es]! >= 0 && fLine[base + asg[es]!] === LINE_MID ? es : -1;
  const fixed = pick >= 0;
  let nf = 0;
  let front = -1e9;
  for (let f = 0; f < N; f++) {
    if (occ[f] !== 1 || asg[f]! < 0) continue;
    const a = asg[f]!;
    const line = fLine[base + a]!;
    if (line === LINE_FWD) {
      if (enx[f]! > front) front = enx[f]!;
      let j = nf++;
      while (j > 0 && fwdZ[j - 1]! < enz[f]!) { fwdZ[j] = fwdZ[j - 1]!; j--; }
      fwdZ[j] = enz[f]!;
      continue;
    }
    if (line !== LINE_MID || fixed) continue;
    if (pick < 0) { pick = f; continue; }
    const cp = fCentral[base + asg[pick]!]!, cf = fCentral[base + a]!;
    if (cf !== cp) { if (cf > cp) pick = f; continue; }
    const zf = Math.abs(enz[f]!), zp = Math.abs(enz[pick]!);
    if (zf < zp || (zf === zp && enx[f]! > enx[pick]!)) pick = f;
  }
  if (pick < 0) return -1;
  let tz = 0;
  if (nf === 0) front = fNxFront[fi]!;
  else if (nf === 1) tz = fwdZ[0]! + (enz[pick]! < 0 ? -T.extraStrikerNz : T.extraStrikerNz);
  else {
    let gap = -1;
    for (let j = 1; j < nf; j++) {
      const d = fwdZ[j - 1]! - fwdZ[j]!;
      if (d > gap) { gap = d; tz = (fwdZ[j - 1]! + fwdZ[j]!) * 0.5; }
    }
  }
  enx[pick] = enx[pick]! + (front - enx[pick]!) * share;
  enz[pick] = enz[pick]! + (tz - enz[pick]!) * share;
  return pick;
}

/** Resolve the phase column: SET_PIECE -> restart team attacks (builds up when `ownThird` = 1: ball in its own
 *  third), the other side defends. */
function phaseIndex(s: SimState, team: number, ownThird: number): number {
  let ph: number = s.teams[team]!.phase;
  if (ph === TeamPhase.SET_PIECE) {
    ph = s.match.restart.team === team ? (ownThird === 1 ? TeamPhase.BUILD_UP : TeamPhase.ATTACK) : TeamPhase.DEFEND;
  }
  return ph >= TeamPhase.BUILD_UP && ph <= TeamPhase.TRANSITION_DEFEND && (ph | 0) === ph ? ph : TeamPhase.BUILD_UP;
}

/**
 * Compute every formIdx's home for `team` with the ball at (ballIn[0], ballIn[1]) into outX/outZ (pitch
 * coordinates). Reads state only.
 */
function computeShape(s: SimState, team: number): void {
  const t = s.teams[team]!;
  const dir = t.dir < 0 ? -1 : 1;
  const fi = formationIndex(t.formation);
  const base = fi * N;
  const bx = ballIn[0]!, bz = ballIn[1]!;
  const bu = dir * (bx - bx === 0 ? bx : 0), bv = dir * (bz - bz === 0 ? bz : 0);

  // 1. Occupants and keeper.
  for (let k = 0; k < N; k++) { occ[k] = 0; asg[k] = -1; slotBy[k] = -1; isGk[k] = 0; }
  const kSlot = keeperSlotOf(s, team);
  if (kSlot >= 0) {
    const kf = s.players[kSlot]!.formIdx;
    if (kf >= 0 && kf < N) isGk[kf] = 1;
  }
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || i === kSlot) continue;
    const f = p.formIdx;
    if (!(f >= 0 && f < N) || (f | 0) !== f || occ[f] === 1 || isGk[f] === 1) continue;
    occ[f] = 1;
  }
  let assigned = 0, unassigned = 0;
  for (let f = 0; f < N; f++) {
    if (occ[f] !== 1) continue;
    if (fLine[base + f] === LINE_GK) { unassigned++; continue; }
    asg[f] = f;
    slotBy[f] = f;
    assigned++;
  }
  const full = unassigned === 0 && assigned === fOutfield[fi];
  if (!full) rebalance(fi);
  for (let f = 0; f < N; f++) {
    const k = occ[f] === 1 ? asg[f]! : f;
    enx[f] = fNx[base + k]!;
    enz[f] = fNz[base + k]!;
  }
  if (!full) respread(fi);

  // 2. Phase, focus and the extra striker.
  const ph = phaseIndex(s, team, bu < -HALF_LENGTH / 3 ? 1 : 0);
  const defending = ph === TeamPhase.DEFEND || ph === TeamPhase.TRANSITION_DEFEND;
  const fo = t.focus >= 0 && t.focus <= 2 && (t.focus | 0) === t.focus ? t.focus : 0;
  const extra = t.extraStriker === 1 ? applyExtraStriker(fi, defending, full) : -1;
  // Focus + quick tactics as every module reads them (data/tactics): block push (team press only out of
  // possession) and width multiplier.
  resolveTactics(fo, tacticFlags(t), TP);
  const push = defending ? TP.pushDefendNx : TP.pushAttackNx;
  const fl = (push - push === 0 ? push : 0) * HALF_LENGTH;
  const tw = defending ? TP.widthDefend : TP.widthAttack;
  const fw = tw - tw === 0 ? tw : 0;

  // 3. Vertical: back-line height, then per-slot depth.
  const nxBack = fNxBack[fi]!;
  let lineU = Math.min(Math.max(nxBack * HALF_LENGTH + T.lineOffset[ph]! + fl + T.lineSlope[ph]! * bu, T.lineMin[ph]! + fl), T.lineMax[ph]! + fl);
  const tlx = t.lineX;
  const lineX = tlx - tlx === 0 ? tlx : 0;
  if (defending && s.match.phase === MatchPhase.IN_PLAY && lineX !== 0) {
    lineU = Math.min(Math.max(dir * lineX, lineU - T.lineXTrust), lineU + T.lineXTrust);
  }
  lineU = Math.min(Math.max(lineU, T.lineFloor), T.lineCeil);
  const depth = T.depthScale[ph]! * T.focusDepth[fo]! * HALF_LENGTH;
  const width = T.widthScale[ph]! * fw * HALF_WIDTH;
  for (let f = 0; f < N; f++) {
    const k = occ[f] === 1 ? asg[f]! : f;
    if (isGk[f] === 1 || k < 0 || fLine[base + k] === LINE_GK) { isGk[f] = 1; continue; }
    let rel = (enx[f]! - nxBack) * depth;
    if (defending && fLine[base + k] === LINE_DEF) rel *= T.defFlatten;
    const kind = f === extra ? KIND_FWD : fKind[base + k]!; // the extra striker plays as a forward
    if (kind === KIND_FB) rel += T.fullBackPush[ph]!;
    else if (kind === KIND_WB) rel += T.wingBackPush[ph]!;
    else if (kind === KIND_WIDE) rel += T.wideMidPush[ph]!;
    else if (kind === KIND_WINGER) rel += T.wingerPush[ph]!;
    else if (kind === KIND_FWD) rel += T.forwardPush[ph]!;
    hu[f] = lineU + (rel > 0 ? rel : 0); // nobody deeper than the back line
    hw[f] = enz[f]! * width;
  }

  // 4. Lateral: slide toward the ball, narrow the far side, squeeze the ball side inside the touchline.
  const shift = Math.min(Math.max(bv * T.slide[ph]!, -T.slideMax), T.slideMax);
  const side = bv > 0 ? 1 : bv < 0 ? -1 : 0;
  const a = Math.abs(bv) >= T.narrowRange ? 1 : Math.abs(bv) / T.narrowRange;
  const kFar = 1 - (1 - T.farNarrow[ph]!) * a;
  let kNear = 1 - (1 - T.nearNarrow[ph]!) * a;
  let maxNear = 0;
  for (let f = 0; f < N; f++) if (occ[f] === 1 && isGk[f] === 0 && hw[f]! * side > maxNear) maxNear = hw[f]! * side;
  const room = HALF_WIDTH - T.sideMargin - Math.abs(shift);
  if (maxNear * kNear > room) kNear = room > 0 ? room / maxNear : 0;
  for (let f = 0; f < N; f++) {
    if (isGk[f] === 1) continue;
    const w = hw[f]!;
    const sw = w * side;
    hv[f] = shift + w * (sw > 0 ? kNear : sw < 0 ? kFar : 1);
  }

  // 5. Compactness: walk the outfield depths from the deepest up and cap every gap at the line spacing; players
  //    above a capped gap move down together (equal depths stay equal, so the shape stays mirror-symmetric).
  let n = 0;
  for (let f = 0; f < N; f++) {
    if (occ[f] !== 1 || isGk[f] === 1) continue;
    let j = n++;
    while (j > 0 && hu[ord[j - 1]!]! > hu[f]!) { ord[j] = ord[j - 1]!; j--; }
    ord[j] = f;
  }
  const gap = T_AI.lineSpacingMax * T.lineGapFraction * T.lineGapScale[ph]!;
  let prevOrig = n > 0 ? hu[ord[0]!]! : 0;
  for (let j = 1; j < n; j++) {
    const f = ord[j]!;
    const orig = hu[f]!;
    const d = orig - prevOrig;
    prevOrig = orig;
    hu[f] = hu[ord[j - 1]!]! + (d > gap ? gap : d);
  }

  // 6. Get in the box when crossing: widest non-defender per flank (never the carrier) -> far post / spot.
  let boxFar = -1, boxNear = -1;
  if (t.getInBox === 1 && side !== 0 && possessingTeam(s) === team && bu >= HALF_LENGTH - CROSS_ZONE_DEPTH && Math.abs(bv) >= CROSS_ZONE_MIN_Z) {
    const owner = s.ball.owner;
    const carrierF = owner >= 0 ? s.players[owner]!.formIdx : -1;
    let bestR = -1, bestL = -1;
    for (let f = 0; f < N; f++) {
      if (occ[f] !== 1 || isGk[f] === 1 || f === carrierF || fLine[base + asg[f]!] === LINE_DEF) continue;
      const z = enz[f]!;
      if (z >= T.getInBoxMinNz && (bestR < 0 || z > enz[bestR]!)) bestR = f;
      if (z <= -T.getInBoxMinNz && (bestL < 0 || z < enz[bestL]!)) bestL = f;
    }
    boxFar = side > 0 ? bestL : bestR;
    boxNear = side > 0 ? bestR : bestL;
    if (boxFar >= 0) { hu[boxFar] = BOX_FAR.nx * HALF_LENGTH; hv[boxFar] = side * BOX_FAR.nzSide * HALF_WIDTH; }
    if (boxNear >= 0) { hu[boxNear] = BOX_SPOT.nx * HALF_LENGTH; hv[boxNear] = side * BOX_SPOT.nzSide * HALF_WIDTH; }
  }

  // 7. Clamps (ceilings and floors keep the compactness of step 5) and keeper home; final team-frame homes in hu/hv.
  let ceil = HALF_LENGTH - T.endMargin;
  if (s.config.offside === 1) {
    offsideLine(s, team);
    const oppU = num[0]!;
    let lim = oppU > bu ? oppU : bu;
    if (lim < 0) lim = 0;
    lim -= T.offsideMargin;
    if (lim < ceil) ceil = lim;
  }
  const kickOff = s.match.phase === MatchPhase.KICK_OFF;
  const kickTeam = s.match.restart.kind === RestartKind.KICK_OFF ? s.match.restart.team : s.match.kickoffTeam;
  const circle = CENTRE_CIRCLE_RADIUS + T.kickOffMargin;
  const vMax = HALF_WIDTH - T.sideMargin;
  const gaU = -HALF_LENGTH + GOAL_AREA_DEPTH + T.goalAreaMargin;
  const gaV = GOAL_AREA_HALF_WIDTH + T.goalAreaMargin;
  const prog = Math.min(Math.max((bu + HALF_LENGTH) / (2 * HALF_LENGTH), 0), 1);
  const ku = -HALF_LENGTH + T.keeperDepthNear + (T.keeperDepthFar - T.keeperDepthNear) * prog;
  const kPost = GOAL_HALF_WIDTH - T.keeperPostMargin;
  const kv = Math.min(Math.max(bv * T.keeperFollow, -kPost), kPost);
  for (let f = 0; f < N; f++) {
    let u: number, v: number;
    if (isGk[f] === 1) { u = ku; v = kv; } else {
      u = hu[f]!;
      v = Math.min(Math.max(hv[f]!, -vMax), vMax);
      if (u > ceil) u = ceil;
      u = Math.min(Math.max(u, -HALF_LENGTH + T.endMargin), HALF_LENGTH - T.endMargin);
      if (kickOff) {
        if (u > -T.kickOffMargin) u = -T.kickOffMargin;
        if (team !== kickTeam && Math.abs(v) < circle) {
          const cu = -Math.sqrt(circle * circle - v * v);
          if (u > cu) u = cu;
        }
      }
      if (u < gaU && Math.abs(v) < gaV) u = gaU;
    }
    hu[f] = u;
    hv[f] = v;
  }

  // 8. The get-in-box players keep clear of team-mates' homes (the onside clamp can put a box spot onto a
  //    forward's home): lateral nudge only, so onside, depth and compactness are unchanged.
  if (boxFar >= 0) separateBoxMover(boxFar, side);
  if (boxNear >= 0) separateBoxMover(boxNear, side);

  // Mirror to pitch coordinates.
  for (let f = 0; f < N; f++) {
    outX[f] = dir * hu[f]! + 0;
    outZ[f] = dir * hv[f]! + 0;
  }
}

/**
 * The opposition's second-last defender (keeper included) in the team frame of `team` -> num[0]: the same rule as
 * sim/core/query secondLastDefenderX (kept here so no double crosses a call; see `num`).
 */
function offsideLine(s: SimState, team: number): void {
  const opp = otherTeam(team);
  const od = s.teams[opp]!.dir;
  let first = 1e9, second = 1e9;
  const end = teamEnd(opp);
  for (let i = teamStart(opp); i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const d = od * p.x;
    if (d < first) { second = first; first = d; } else if (d < second) second = d;
  }
  if (second >= 1e9) second = first;
  num[0] = (s.teams[team]!.dir < 0 ? -1 : 1) * od * second;
}

/** True if no active outfield home other than m's lies within T.boxSeparation of (boxQ[0], boxQ[1]) (team frame). */
function boxSpotClear(m: number): boolean {
  const u = boxQ[0]!, v = boxQ[1]!;
  const sep2 = T.boxSeparation * T.boxSeparation;
  for (let f = 0; f < N; f++) {
    if (f === m || occ[f] !== 1 || isGk[f] === 1) continue;
    const du = hu[f]! - u, dv = hv[f]! - v;
    if (du * du + dv * dv < sep2) return false;
  }
  return true;
}

/**
 * Move get-in-box player m (final team-frame home in hu/hv) to the nearest lateral position, inside the penalty
 * area, that keeps T.boxSeparation from every other outfield home: his own spot, or just beside a blocking
 * team-mate. Ties: the more central spot, then the far side. Unchanged when no such position exists.
 */
function separateBoxMover(m: number, side: number): void {
  const um = hu[m]!, vm = hv[m]!;
  boxQ[0] = um; boxQ[1] = vm;
  if (boxSpotClear(m)) return;
  const sep = T.boxSeparation;
  const vLim = PENALTY_AREA_HALF_WIDTH - T.boxSideMargin;
  let best = vm, bestD = -1;
  for (let c = 0; c < N; c++) {
    if (c === m || occ[c] !== 1 || isGk[c] === 1) continue;
    const du = hu[c]! - um;
    if (du >= sep || du <= -sep) continue;
    const half = Math.sqrt(sep * sep - du * du) + T.boxSeparationSlack;
    for (let k = 0; k < 2; k++) {
      const v = k === 0 ? hv[c]! - half : hv[c]! + half;
      if (v > vLim || v < -vLim) continue;
      boxQ[1] = v;
      if (!boxSpotClear(m)) continue;
      const d = Math.abs(v - vm);
      if (bestD < 0 || d < bestD || (d === bestD && (Math.abs(v) < Math.abs(best) || (Math.abs(v) === Math.abs(best) && v * side < 0)))) {
        best = v;
        bestD = d;
      }
    }
  }
  if (bestD >= 0) hv[m] = best;
}

function nextDelay(tick: number, team: number): number {
  const interval = T_AI.shapeInterval >= 1 ? T_AI.shapeInterval | 0 : 1;
  const offset = team === 0 ? 0 : interval >> 1;
  const d = (((offset - tick) % interval) + interval) % interval;
  return d === 0 ? interval : d;
}

/** Copy team.homeX/homeZ[p.formIdx] into every active player of the team. */
function syncPlayers(s: SimState, team: number): void {
  const t = s.teams[team]!;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    const p = s.players[i]!;
    const f = p.formIdx;
    if (p.active !== 1 || !(f >= 0 && f < N) || (f | 0) !== f) continue;
    p.homeX = t.homeX[f]!;
    p.homeZ = t.homeZ[f]!;
  }
}

export function updateShape(s: SimState, team: number, ev: EventSink): void {
  const t = s.teams[team]!;
  // A direction swap (half-time) leaves the stored keeper home in the attacking half: recompute now.
  const ks = keeperSlotOf(s, team);
  if (ks >= 0) {
    const kf = s.players[ks]!.formIdx;
    if (kf >= 0 && kf < N && t.homeX[kf]! * t.dir > 0) t.shapeT = 0;
  }
  if (t.shapeT > 1) {
    t.shapeT--;
  } else {
    ballIn[0] = s.ball.x; ballIn[1] = s.ball.z;
    computeShape(s, team);
    for (let f = 0; f < N; f++) { t.homeX[f] = outX[f]!; t.homeZ[f] = outZ[f]!; }
    t.shapeT = nextDelay(s.tick, team);
  }
  syncPlayers(s, team);
}

/** Force the next updateShape call for `team` to recompute (formation, focus or quick-tactic change). */
export function invalidateShape(s: SimState, team: number): void {
  s.teams[team]!.shapeT = 0;
}

/**
 * Home position of formation index `formIdx` for `team` with the ball at (bx, bz), from the current state
 * (pure: writes nothing to state). Recomputes the whole team shape; prefer p.homeX/homeZ where possible.
 * Invalid formIdx -> (0, 0).
 */
export function homePositionAt(s: SimState, team: number, formIdx: number, bx: number, bz: number, out: { x: number; z: number }): void {
  if (!(formIdx >= 0 && formIdx < N) || (formIdx | 0) !== formIdx) { out.x = 0; out.z = 0; return; }
  ballIn[0] = bx; ballIn[1] = bz;
  computeShape(s, team);
  out.x = outX[formIdx]!;
  out.z = outZ[formIdx]!;
}

/** Base home position for a formation index given ball position (pure). */
export function homePosition(s: SimState, team: number, formIdx: number, out: { x: number; z: number }): void {
  homePositionAt(s, team, formIdx, s.ball.x, s.ball.z, out);
}
