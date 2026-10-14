/**
 * [TAI-10] CPU shooting, dribbling and skill choices: expected-goal estimate from distance, angle, pressure and
 * keeper position; dribble-into-space scoring; skill move choice by skill stars and defender position.
 *
 * HOW IT WORKS (every function only reads SimState; `team` = the slot's team, `dir` = s.teams[team].dir, the attacked
 * goal is the one at x = dir x HALF_LENGTH; opponents are the other team's active players, keeper included)
 *
 *  estimateXg(s, slot, x, z) — chance 0..xgCap that a shot by `slot` from (x, z) scores. (x, z) may be hypothetical
 *  (the carrier's feet, a spot he could dribble to); the slot gives the team, attributes and facing.
 *   1. Clean chance (no blocker, no pressure, keeper set): goal-mouth angle theta (posts seen from the spot; atan by
 *      a fixed series, |error| < 2e-7 rad) through a Hill curve xgMax x theta^3 / (theta^3 + xgHalf), x 1 / (1 +
 *      farPerM x (d - farFrom)) beyond farFrom m (d = distance to the goal centre). Calibration (central, clean,
 *      average attributes): 6 m ~0.68, 8 m ~0.56, penalty spot ~0.38, edge of the box ~0.17, 20 m ~0.09, 25 m ~0.04,
 *      30 m ~0.02. 0 on / behind the goal line or beyond maxDist.
 *   2. Keeper: the clean chance moves toward the open-goal chance (openBase - openPerM x d, at least openMin, x
 *      min(1, theta / openAngleFull)) by `open` 0..1, the largest of
 *       - lateral misposition: in the shooter's frame (u toward the goal centre) the goal mouth is the slope interval
 *         [sL, sR] (lateral / forward of each post) and the keeper covers [sk - rK / tk, sk + rK / tk] (tk, sk his
 *         forward distance and slope); rK = keeperStandReach + dive speed (T_GK, gkDiving) x (ball time d /
 *         shotSpeedRef - reaction (T_GK, gkReflexes)), capped at keeperReachCap. open = latShare x the share of the
 *         mouth he leaves open beyond what an average keeper leaves on the bisector, beyond latDead [INT-A] (formerly
 *         the share of his own coverage lost, which rated a quicker keeper with a wider reach as more open);
 *       - off his line: distance from the goal centre beyond GKP-01's normal depth for d (T_GK.depthNear..depthFar over
 *         depthNearDist..depthFarDist) + offDead -> offShare x smoothstep over offSpan m, x smoothstep(chipMinDist,
 *         chipFullDist, shooter-to-keeper distance) (room to chip / round him);
 *       - down (diving, fallen, getting up, stumbling, stunned): downOpen;
 *       - no active keeper, or the keeper level with / behind the shooter: 1.
 *   3. Blockers: each outfield opponent between the spot and the goal covers [s - blockRadius / t, s + blockRadius / t]
 *      of the mouth's slope interval (t his distance along the shot); the chance x (1 - eff x covered share) per
 *      blocker, eff = blockEff falling linearly to blockEff x blockFarKeep from blockNear to blockFar m (a far blocker
 *      can be shot over or wrong-footed); at least blockFloor in all.
 *   4. Pressure: nearest opponent to (x, z) after pressLook s of his current velocity -> 0 at >= pressFar m, 1 at <=
 *      pressNear m; x (1 - pressMax x pressure x (1 - composureRelief x composure)).
 *   5. Attributes (mild): accuracy = finishing .. longShots blended over finishRange..longRange m (like SIM-07);
 *      x clamp(1 + attrSpan x (accuracy - attrRef) / 29, attrMin, attrMax). Weak foot (SIM-07's rule: a shot turning
 *      toward the preferred foot's side is struck with the weaker foot): x (1 - weakMax x smoothstep(weakTurnLo,
 *      weakTurnHi, turn sine) x (5 - weakFoot) / 4).
 *   Typical box shots (11..16.5 m, a defender pressing or half in the way) land in 0.08..0.35, long shots (24..30 m,
 *   keeper set) 0.02..0.05, one-on-ones (8..11 m with nobody between, or 12..14 m with the keeper rushing out)
 *   0.35..0.6 (tests pin these bands).
 *
 *  bestDribble(s, slot, out) — samples DRIBBLE_DIRS = 12 directions every 30 degrees from the direction to the attacked
 *  goal centre (goalward first: ties keep the more goalward one). Per direction:
 *   - space: at probe distances probe1..probe3 m the carrier arrives after a turn cost (turnCost s x (1 - cos(velocity,
 *     direction)) / 2 x speed fraction) + a run from his speed along the direction, accelerating (attrs.accel) to his
 *     dribbling speed (topSpeed x dribbleSpeedFrac, both x SIM-04 stamina factor); every opponent after oppReact s
 *     (moving on with his velocity meanwhile) + a run of (distance - oppReach) from his speed toward the point,
 *     accelerating to his top speed. Margin = opponent time - carrier time (+ probeSlack2 / probeSlack3 at the longer
 *     probes, where the carrier can still adjust); the smallest -> space = smoothstep(spaceLo, spaceHi);
 *   - progress (1 + cos to the goal direction) / 2; separation: nearest opponent to the far probe / sepRef;
 *   - staying on the pitch: x clamp01((run until edgeMargin inside a touchline / goal line - 1) / (probe3 - 1)).
 *  The direction maximises (wSpace x space + wProg x progress + wSep x separation) x pitch factor. The returned score
 *  is that direction's room to carry the ball, (spaceShare x space + (1 - spaceShare) x separation) x pitch factor,
 *  0..1 (TAI-08 scales the carry by it; it values the progress itself). An invalid slot gets 0 and (0, 0) (TAI-08 then
 *  falls back).
 *
 *  chooseSkill(s, slot) — only for an active outfield ball owner (at his feet, not in hands). The defender is the
 *  nearest opponent in front (cos to the facing >= frontCos) within knockMaxDist. Space probes (clearance from every
 *  opponent >= the threshold, point at least probeMargin inside the pitch):
 *   side (left / right of the facing, at the exit angles 45 / 60 / 90 degrees, max(defender distance + sidePast,
 *   sideProbeMin) m out, sideClear m), behind the defender (behindProbe m past him on the facing line, behindClear m,
 *   the defender himself excluded), behind the carrier (backProbe m, backClear m). Candidates (first fit wins, each
 *   gated by T_SKILL.minStars against attrs.skillMoves):
 *     ROULETTE    defender <= closeDist and closing >= lungeSpeed, side space at 45;
 *     HEEL_FLICK  defender heelMin..heelMax m, nearly straight ahead (|lateral| <= heelLat), space behind him;
 *     KNOCK_ON    defender knockMin..knockMaxDist m, space behind him (knockClear), the carrier already running at
 *                 >= knockMinSpeed along his facing and at least as quick as him (top speeds, - paceSlack), the
 *                 defender not running away (his speed along the facing < half the carrier's dribbling speed);
 *     BALL_ROLL   defender <= closeDist, side space at 90;
 *     STEP_OVER   defender closeDist..midDist, side space at 45;
 *     BODY_FEINT  defender closeDist x feintNear..midDist, side space at 60;
 *     DRAG_BACK   defender <= dragDist closing >= lungeSpeed / 2, no side space, space behind the carrier (an escape:
 *                 it keeps the ball rather than beating the man).
 *  FAKE_SHOT and the stop touches are never chosen (TAI-08 does not execute them as skills). The choice is also
 *  written into SKILL_CHOICE (move, side -1 left / +1 right of the facing with the more space, 0 straight on, and a
 *  suggested unit exit direction) for callers that want the side.
 *
 * Determinism / cost: +, -, x, / and Math.sqrt only (dmath dcos / dsin once at module load), no RNG, slot-order loops
 * with strict comparisons; state is only read. Allocation-free: module-level typed scratch, and no internal call passes
 * or returns a double (the exported functions are thin wrappers around kernels that hand results through R[], so
 * V8 boxes nothing). Measured (tests/perf/tai-10-budget.test.ts, Node): estimateXg ~0.4 us, bestDribble ~5 us
 * (12 x 3 x 11 arrival checks, far opponents skipped once per call), chooseSkill ~0.4 us — all far under 0.05 ms.
 */
import { GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, TICK_HZ } from '../../contracts/constants';
import { ActionKind, Foot, SkillMove } from '../../contracts/enums';
import type { SimState } from '../../contracts/state';
import { T_CPU, T_DRIBBLE, T_GK, T_PLAYER, T_SKILL } from '../../contracts/tuning';
import { dcos, dsin, PI } from '../../sim/core/dmath';

export const LOCAL_TUNING = { // TUNING-CR (TAI-10): move into T_AI as xg* / dribble* / skill* (m, s, m/s, 0..1)
  // ---- xG: clean chance
  /** Hill curve ceiling and the theta^3 (rad^3) at which it reaches half of it. */
  xgMax: 0.85,
  xgHalf: 0.3288,
  /** Distance decay beyond farFrom m: x 1 / (1 + farPerM x (d - farFrom)), 1/m. */
  farFrom: 16,
  farPerM: 0.045,
  /** No chance beyond this distance from the goal centre, m. */
  maxDist: 45,
  /** Upper bound of any estimate. */
  xgCap: 0.97,
  // ---- xG: keeper
  /** Typical shot speed for the keeper's time to react, m/s. */
  shotSpeedRef: 26,
  /** Keeper's reach without diving, and the cap on his effective reach (dive + move), m. */
  keeperStandReach: 1.0,
  keeperReachCap: 7,
  /** Lateral misposition: the lost share of his coverage below latDead is ignored; open = latShare x the rest. */
  latDead: 0.15,
  latShare: 0.9,
  /** GKP-01's normal depth ramp: T_GK.depthNear at depthNearDist .. T_GK.depthFar at depthFarDist (ball distance), m. */
  depthNearDist: 5,
  depthFarDist: 28,
  /** Off his line: beyond the normal depth + offDead m, open rises to offShare over offSpan m ... */
  offDead: 1.5,
  offSpan: 5,
  offShare: 0.4,
  /** ... x smoothstep(chipMinDist, chipFullDist, shooter-to-keeper distance), m. */
  chipMinDist: 3,
  chipFullDist: 8,
  /** Open share when the keeper is down (diving, fallen, getting up, stumbling, stunned). */
  downOpen: 0.75,
  /** Open-goal chance: openBase - openPerM x d (at least openMin), x min(1, theta / openAngleFull rad). */
  openBase: 0.97,
  openPerM: 0.012,
  openMin: 0.3,
  openAngleFull: 0.2,
  // ---- xG: blockers
  /** A blocker covers +-blockRadius m (body + leg) across the line; x (1 - blockEff x covered share); floor. */
  blockRadius: 0.75,
  blockEff: 0.85,
  blockFloor: 0.06,
  /** A blocker further than blockNear m from the shot blocks less (the ball can rise over him or he is wrong-footed):
   *  blockEff x 1 .. blockFarKeep from blockNear to blockFar m. */
  blockNear: 4,
  blockFar: 16,
  blockFarKeep: 0.4,
  /** [QF-2] A blocker close to the shooter reaches across the line with a leg (SIM-07 / SIM-14 reach): his radius
   *  grows from blockRadius at blockNear m to blockRadiusNear at the shooter, and his efficiency to blockEffNear (a
   *  shot straight through the man in front was rated 85% blocked; the sim blocked 80% of them, the CPU shot into
   *  them anyway), m / 0..1. */
  blockRadiusNear: T_CPU.xgBlockRadiusNear,
  blockEffNear: T_CPU.xgBlockEffNear,
  /** [QF-2] Blockers are also judged where they will be after this long (their velocity on): the press closes in
   *  during the CPU's aim and power-up (about 0.5 s from decision to contact), s. */
  blockLook: T_CPU.xgBlockLook,
  /** [QF-2] shotLaneClear: extra width (ball radius, aim error) added to a blocker's reach; 0 (0.15 priced too many
   *  half-open lanes as shut: the blocker reach already covers the ball), m. */
  laneBallSlack: T_CPU.xgLaneBallSlack,
  // ---- xG: pressure
  /** Pressure 1 at <= pressNear m, 0 at >= pressFar m, the opponent moved on pressLook s first. */
  pressNear: 1.0,
  pressFar: 4.5,
  pressLook: 0.2,
  /** x (1 - pressMax x pressure x (1 - composureRelief x composure 0..1)). */
  pressMax: 0.4,
  composureRelief: 0.4,
  // ---- xG: attributes
  /** Accuracy = finishing up to finishRange m, longShots from longRange m (blended between). */
  finishRange: 16,
  longRange: 22,
  /** x clamp(1 + attrSpan x (accuracy - attrRef) / 29, attrMin, attrMax). */
  attrRef: 70,
  attrSpan: 0.25,
  attrMin: 0.6,
  attrMax: 1.25,
  /** Weaker foot: x (1 - weakMax x smoothstep(weakTurnLo, weakTurnHi, turn sine) x (5 - weakFoot) / 4). */
  weakMax: 0.2,
  weakTurnLo: 0.3,
  weakTurnHi: 0.8,
  // ---- dribble
  /** Probe distances along each direction, m. */
  probe1: 2,
  probe2: 4.5,
  probe3: 7.5,
  /** Dribbling speed as a share of top speed (x stamina factor). */
  dribbleSpeedFrac: 0.8,
  /** Opponent reaction time and reach (tackle / poke), s / m. */
  oppReact: 0.2,
  oppReach: 1.0,
  /** Slack added to the arrival margin at probe2 / probe3 (the carrier can still adjust a longer run), s. */
  probeSlack2: 0.1,
  probeSlack3: 0.25,
  /** Time to turn fully round at top speed, s. */
  turnCost: 0.35,
  /** Space = smoothstep(spaceLo, spaceHi, smallest margin), s. */
  spaceLo: -0.5,
  spaceHi: 0.7,
  /** Separation reference: nearest opponent to the far probe / this, m. */
  sepRef: 6,
  /** Direction choice weights (space, progress, separation). */
  wSpace: 0.45,
  wProg: 0.4,
  wSep: 0.15,
  /** Returned score = (spaceShare x space + (1 - spaceShare) x separation) x pitch factor of the chosen direction. */
  spaceShare: 0.75,
  /** The run must stay this far inside the touchlines / goal lines, m. */
  edgeMargin: 1.5,
  // ---- skill moves
  /** Defender: in front (cos to the facing >= frontCos) within knockMaxDist m; nearer than minDefDist m ignored. */
  frontCos: 0.7,
  minDefDist: 0.6,
  knockMaxDist: 6,
  /** Distance bands, m. */
  closeDist: 2.2,
  midDist: 4.5,
  feintNear: 0.8,
  heelMin: 1.5,
  heelMax: 3.5,
  heelLat: 1.0,
  knockMin: 2.5,
  dragDist: 2.5,
  /** Closing speed (defender toward the carrier, relative) counted as a lunge, m/s. */
  lungeSpeed: 3,
  /** Knock-on: the carrier's top speed at least the defender's - paceSlack, and already running at knockMinSpeed
   *  along his facing, m/s. */
  paceSlack: 0.2,
  knockMinSpeed: 3,
  /** Side probes: max(defender distance + sidePast, sideProbeMin) m out at the exit angle; clearance sideClear m. */
  sidePast: 1.5,
  sideProbeMin: 3.5,
  sideClear: 2.2,
  /** Behind the defender: behindProbe m past him, clearance behindClear m (knock-on: knockClear m). */
  behindProbe: 4,
  behindClear: 3.5,
  knockClear: 4.5,
  /** [QF-2] Knock-on only when the ball's run (knockRun m along the facing: SIM-13 knocks it 7.5-15 m) stays knockEdge m
   *  inside the touchlines and goal lines, m. */
  knockRun: T_CPU.xgKnockRun,
  knockEdge: T_CPU.xgKnockEdge,
  /** Behind the carrier (drag-back): backProbe m, clearance backClear m. */
  backProbe: 4,
  backClear: 3,
  /** Probe points must be this far inside the pitch, m. */
  probeMargin: 1,
} as const;

const LT = LOCAL_TUNING;

// ---------------------------------------------------------------- scratch

/** Prepared opponents (index 0..NI[0]). */
const OX = new Float64Array(PLAYERS_PER_TEAM);
const OZ = new Float64Array(PLAYERS_PER_TEAM);
const OVX = new Float64Array(PLAYERS_PER_TEAM);
const OVZ = new Float64Array(PLAYERS_PER_TEAM);
const OTOP = new Float64Array(PLAYERS_PER_TEAM);
const OACC = new Float64Array(PLAYERS_PER_TEAM);
const OSLOT = new Int32Array(PLAYERS_PER_TEAM);
const OKEEP = new Int32Array(PLAYERS_PER_TEAM);
const ODOWN = new Int32Array(PLAYERS_PER_TEAM);
/** Opponent too far to matter for this bestDribble call. */
const OFAR = new Int32Array(PLAYERS_PER_TEAM);
const NI = new Int32Array(1);
/** Scalars handed to / from internal helpers: no double crosses a call boundary (V8 would box it). R[0] clearance,
 *  R[1] estimateXg result, R[2] bestDribble result, R[3] / R[4] atan argument / result, R[5] / R[6] the spot, R[7] the
 *  blocker factor of the last estimateXg (lastXgBlock). */
const R = new Float64Array(8);

/** Number of dribble directions sampled. */
export const DRIBBLE_DIRS = 12;
/** Direction offsets from the goal direction: 0, +30, -30, +60, -60, ... 180 degrees (built once with dmath). */
const DCOS = new Float64Array(DRIBBLE_DIRS);
const DSIN = new Float64Array(DRIBBLE_DIRS);
for (let k = 0; k < DRIBBLE_DIRS; k++) {
  const step = (k + 1) >> 1;
  const sgn = k % 2 === 1 ? 1 : -1;
  const a = k === 0 ? 0 : sgn * step * (PI / 6);
  DCOS[k] = k === DRIBBLE_DIRS - 1 ? -1 : dcos(a);
  DSIN[k] = k === DRIBBLE_DIRS - 1 ? 0 : dsin(a);
}

/** Exit angle cos / sin of the side probes: 45, 60, 90 degrees. */
const SIDE_COS = [0.7071067811865476, 0.5, 0] as const;
const SIDE_SIN = [0.7071067811865476, 0.8660254037844386, 1] as const;

/** The last chooseSkill result: move, side (-1 left / +1 right of the facing, 0 straight on) and exit direction. */
export const SKILL_CHOICE = { move: SkillMove.NONE as SkillMove, side: 0, dirX: 0, dirZ: 0 };

// ---------------------------------------------------------------- helpers

function validSlot(slot: number): boolean {
  return slot === (slot | 0) && slot >= 0 && slot < NUM_SLOTS;
}

function finite(v: number): boolean {
  return v < 1e6 && v > -1e6;
}

/** Fill the opponent scratch for `team`'s opponents (active, finite positions). */
function prepOpponents(s: SimState, team: number): void {
  const start = team === 0 ? PLAYERS_PER_TEAM : 0;
  let n = 0;
  for (let i = start; i < start + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const x = q.x, z = q.z;
    if (!finite(x) || !finite(z)) continue;
    const a = s.attrs[i]!;
    const vx = q.vx, vz = q.vz;
    OX[n] = x; OZ[n] = z;
    OVX[n] = finite(vx) ? vx : 0;
    OVZ[n] = finite(vz) ? vz : 0;
    let top = a.topSpeed > 0 && finite(a.topSpeed) ? a.topSpeed : T_PLAYER.topSpeedMin;
    let acc = a.accel > 0 && finite(a.accel) ? a.accel : T_PLAYER.accelMin;
    const st = q.stamina;
    if (st < T_PLAYER.staminaLowThreshold) {
      // SIM-04 staminaFactor (inline).
      const f = st > 0 ? st / T_PLAYER.staminaLowThreshold : 0;
      const sf = T_PLAYER.staminaFloorMul + (1 - T_PLAYER.staminaFloorMul) * f;
      top *= sf; acc *= sf;
    }
    OTOP[n] = top > 0.5 ? top : 0.5;
    OACC[n] = acc > 0.5 ? acc : 0.5;
    OSLOT[n] = i;
    OKEEP[n] = q.isKeeper === 1 ? 1 : 0;
    const act = q.act;
    ODOWN[n] = act === ActionKind.GK_DIVE || act === ActionKind.FALLEN || act === ActionKind.GET_UP ||
      act === ActionKind.STUMBLE || q.stunT > 0 ? 1 : 0;
    OFAR[n] = 0;
    n++;
  }
  NI[0] = n;
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

function smooth01(t: number): number {
  const c = t > 0 ? (t < 1 ? t : 1) : 0;
  return c * c * (3 - 2 * c);
}

/** Smallest distance from (px, pz) to a prepared opponent other than index `excl` (-1 = none): into R[0]. */
function clearanceAt(px: number, pz: number, excl: number): void {
  let best = 1e18;
  const n = NI[0]!;
  for (let j = 0; j < n; j++) {
    if (j === excl) continue;
    const dx = OX[j]! - px, dz = OZ[j]! - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  R[0] = best < 1e17 ? Math.sqrt(best) : 1e9;
}

/** (px, pz) at least `m` inside the touchlines and goal lines. */
function insidePitch(px: number, pz: number, m: number): boolean {
  return px <= HALF_LENGTH - m && px >= -HALF_LENGTH + m && pz <= HALF_WIDTH - m && pz >= -HALF_WIDTH + m;
}

const TAN_PI_8 = 0.41421356237309503;
const QUARTER_PI = PI / 4;

/** atan(R[3]) for R[3] in [-1, 1] into R[4]: range reduction at tan(pi / 8) and a 7-term odd series (|error| < 2e-7,
 *  strictly increasing). */
function atanUnit(): void {
  const r = R[3]!;
  const ar = r < 0 ? -r : r;
  let t = ar, base = 0;
  if (ar > TAN_PI_8) { t = (ar - 1) / (ar + 1); base = QUARTER_PI; }
  const t2 = t * t;
  const v = base + t * (1 + t2 * (-1 / 3 + t2 * (1 / 5 + t2 * (-1 / 7 + t2 * (1 / 9 + t2 * (-1 / 11 + t2 / 13))))));
  R[4] = r < 0 ? -v : v;
}

// ---------------------------------------------------------------- xG

/** Expected-goal estimate 0..1 for a shot by slot from (x, z). Pure. */
export function estimateXg(s: SimState, slot: number, x: number, z: number): number {
  R[5] = x; R[6] = z;
  xgKernel(s, slot);
  return R[1]!;
}

/** [QF-2] The blocker factor (blockFloor..1, 1 = nobody in the way) the last estimateXg call applied. */
export function lastXgBlock(): number {
  return R[7]!;
}

/**
 * [QF-2] Chance (0..1) that a shot from (x, z) by `slot` toward the goal-line point z = aimZ gets past every outfield
 * opponent (now and after blockLook): each one whose line distance is within his reach (the estimateXg blocker radius
 * for his distance along the shot, + LT.laneBallSlack) takes eff x (1 - (offset / reach)^2) of it. Used to pick the
 * aim side and to price a shot into a man. 1 for an invalid slot or spot.
 */
export function shotLaneClear(s: SimState, slot: number, x: number, z: number, aimZ: number): number {
  if (!validSlot(slot) || !finite(x) || !finite(z) || !finite(aimZ)) return 1;
  const p = s.players[slot]!;
  const team = p.team;
  if (team !== 0 && team !== 1) return 1;
  const gx = (s.teams[team]!.dir === -1 ? -1 : 1) * HALF_LENGTH;
  const lx = gx - x, lz = aimZ - z;
  const L = Math.sqrt(lx * lx + lz * lz);
  if (!(L > 0.5)) return 1;
  const ux = lx / L, uz = lz / L;
  prepOpponents(s, team);
  const n = NI[0]!;
  let clear = 1;
  for (let j = 0; j < n; j++) {
    if (OKEEP[j] === 1) continue;
    let cov = 0;
    for (let k = 0; k < 2; k++) {
      const bx = OX[j]! - x + (k === 0 ? 0 : OVX[j]! * LT.blockLook), bz = OZ[j]! - z + (k === 0 ? 0 : OVZ[j]! * LT.blockLook);
      const t = bx * ux + bz * uz;
      if (t <= 0.05 || t >= L) continue;
      const near01 = t < LT.blockNear ? 1 - t / LT.blockNear : 0;
      const r = LT.blockRadius + (LT.blockRadiusNear - LT.blockRadius) * near01 + LT.laneBallSlack;
      const off = bx * -uz + bz * ux;
      const ao = off < 0 ? -off : off;
      if (ao >= r) continue;
      const far = t > LT.blockNear ? (t < LT.blockFar ? (t - LT.blockNear) / (LT.blockFar - LT.blockNear) : 1) : 0;
      const eff = LT.blockEff * (1 + (LT.blockFarKeep - 1) * far) + (LT.blockEffNear - LT.blockEff) * near01;
      const q = ao / r;
      const c = eff * (1 - q * q);
      if (c > cov) cov = c;
    }
    clear *= 1 - cov;
  }
  return clear;
}

/** estimateXg for the spot (R[5], R[6]) into R[1]. */
function xgKernel(s: SimState, slot: number): void {
  R[1] = 0;
  R[7] = 1;
  const x = R[5]!, z = R[6]!;
  if (!validSlot(slot) || !finite(x) || !finite(z)) return;
  const p = s.players[slot]!;
  const team = p.team;
  if (p.active !== 1 || (team !== 0 && team !== 1)) return;
  const dir = s.teams[team]!.dir === -1 ? -1 : 1;
  const ax = dir * HALF_LENGTH - x;
  // Forward distance to the goal line (dir x ax): nothing on or behind it.
  if (dir * ax <= 0.05) return;
  const d2 = ax * ax + z * z;
  const d = Math.sqrt(d2);
  if (d > LT.maxDist || d < 1e-6) return;
  const gh = GOAL_HALF_WIDTH;
  const adx = ax < 0 ? -ax : ax;
  // Goal-mouth angle: atan2(cr, dot) in (0, pi) with cr = |v1 x v2| > 0, dot = v1 . v2 (v1 / v2 toward the posts).
  const cr = adx * 2 * gh, dot = d2 - gh * gh;
  let theta: number;
  if (dot > 0 && cr <= dot) { R[3] = cr / dot; atanUnit(); theta = R[4]!; }
  else if (cr > (dot < 0 ? -dot : dot)) { R[3] = dot / cr; atanUnit(); theta = PI / 2 - R[4]!; }
  else { R[3] = cr / -dot; atanUnit(); theta = PI - R[4]!; }
  if (!(theta > 0)) return;
  // 1. Clean chance.
  const t3 = theta * theta * theta;
  let xg = (LT.xgMax * t3) / (t3 + LT.xgHalf);
  if (d > LT.farFrom) xg /= 1 + LT.farPerM * (d - LT.farFrom);

  prepOpponents(s, team);
  const n = NI[0]!;
  // Shooter frame: u toward the goal centre, w its right (-uz, ux).
  const ux = ax / d, uz = -z / d;
  const wx = -uz, wz = ux;
  // Posts as slopes (lateral / forward).
  const p1t = ax * ux + (gh - z) * uz, p1l = ax * wx + (gh - z) * wz;
  const p2t = ax * ux + (-gh - z) * uz, p2l = ax * wx + (-gh - z) * wz;
  const s1 = p1l / (p1t > 0.05 ? p1t : 0.05), s2 = p2l / (p2t > 0.05 ? p2t : 0.05);
  const sL = s1 < s2 ? s1 : s2, sR = s1 < s2 ? s2 : s1;
  const width = sR - sL > 1e-6 ? sR - sL : 1e-6;

  // 2. Keeper.
  let kj = -1, kBest = 1e18;
  const gx = dir * HALF_LENGTH;
  for (let j = 0; j < n; j++) {
    if (OKEEP[j] !== 1) continue;
    const ex = OX[j]! - gx, ez = OZ[j]!;
    const e2 = ex * ex + ez * ez;
    if (e2 < kBest) { kBest = e2; kj = j; }
  }
  let open = 1;
  if (kj >= 0) {
    const kx = OX[kj]! - x, kz = OZ[kj]! - z;
    const tk = kx * ux + kz * uz;
    if (tk > 0.3) {
      const ka = s.attrs[OSLOT[kj]!]!;
      const ref = clamp01((ka.gkReflexes - 1) / 98), div = clamp01((ka.gkDiving - 1) / 98);
      const react = (T_GK.reactWorst + (T_GK.reactBest - T_GK.reactWorst) * ref) / TICK_HZ;
      const dive = T_GK.diveSpeedWorst + (T_GK.diveSpeedBest - T_GK.diveSpeedWorst) * div;
      const tb = d / LT.shotSpeedRef - react;
      let rk = LT.keeperStandReach + (tb > 0 ? dive * tb : 0);
      if (rk > LT.keeperReachCap) rk = LT.keeperReachCap;
      const rs = rk / tk;
      const sk = (kx * wx + kz * wz) / tk;
      const lo = sk - rs > sL ? sk - rs : sL, hi = sk + rs < sR ? sk + rs : sR;
      const ovA = hi > lo ? hi - lo : 0;
      // [INT-A] Misposition against the clean chance's reference: the share of the mouth he leaves uncovered beyond
      // what an average keeper (attributes at the middle of T_GK's ranges) leaves standing on the bisector. (The old
      // share of his OWN coverage lost made a quicker keeper with a wider reach count as more open.)
      const reactRef = (T_GK.reactWorst + T_GK.reactBest) * 0.5 / TICK_HZ;
      const tbRef = d / LT.shotSpeedRef - reactRef;
      let rkRef = LT.keeperStandReach + (tbRef > 0 ? (T_GK.diveSpeedWorst + T_GK.diveSpeedBest) * 0.5 * tbRef : 0);
      if (rkRef > LT.keeperReachCap) rkRef = LT.keeperReachCap;
      const ovRef = 2 * rkRef / tk < width ? 2 * rkRef / tk : width;
      const uncov = width > 1e-9 ? 1 - ovA / width : 0;
      const uncovRef = width > 1e-9 ? 1 - ovRef / width : 0;
      const lost = uncov > uncovRef && uncovRef < 1 ? (uncov - uncovRef) / (1 - uncovRef) : 0;
      open = lost > LT.latDead ? (LT.latShare * (lost - LT.latDead)) / (1 - LT.latDead) : 0;
      // Off his line (depth beyond GKP-01's normal depth for this distance), with room to chip / round him.
      const kd = Math.sqrt(kBest);
      const far01 = clamp01((d - LT.depthNearDist) / (LT.depthFarDist - LT.depthNearDist));
      const ex = kd - (T_GK.depthNear + (T_GK.depthFar - T_GK.depthNear) * far01) - LT.offDead;
      if (ex > 0) {
        const dk = Math.sqrt(kx * kx + kz * kz);
        const off = LT.offShare * smooth01(ex / LT.offSpan) *
          smooth01((dk - LT.chipMinDist) / (LT.chipFullDist - LT.chipMinDist));
        if (off > open) open = off;
      }
      if (ODOWN[kj] === 1 && LT.downOpen > open) open = LT.downOpen;
    }
  }
  if (open > 0) {
    let og = LT.openBase - LT.openPerM * d;
    if (og < LT.openMin) og = LT.openMin;
    og *= theta < LT.openAngleFull ? theta / LT.openAngleFull : 1;
    if (og > xg) xg += (og - xg) * (open < 1 ? open : 1);
  }

  // 3. Blockers (outfield opponents between the spot and the goal) and 4. pressure (nearest opponent, keeper too).
  let block = 1, near2 = 1e18;
  for (let j = 0; j < n; j++) {
    const rx = OX[j]! - x, rz = OZ[j]! - z;
    const px = rx + OVX[j]! * LT.pressLook, pz = rz + OVZ[j]! * LT.pressLook;
    const e2 = px * px + pz * pz;
    if (e2 < near2) near2 = e2;
    if (OKEEP[j] === 1 || block <= LT.blockFloor) continue;
    // [QF-2] Now and after blockLook (moving on): the larger cover counts.
    let cov = 0;
    for (let k = 0; k < 2; k++) {
      const bx = k === 0 ? rx : rx + OVX[j]! * LT.blockLook, bz = k === 0 ? rz : rz + OVZ[j]! * LT.blockLook;
      const t = bx * ux + bz * uz;
      if (t <= 0.05 || t >= d) continue;
      const near01 = t < LT.blockNear ? 1 - t / LT.blockNear : 0;
      const sb = (bx * wx + bz * wz) / t, rb = (LT.blockRadius + (LT.blockRadiusNear - LT.blockRadius) * near01) / t;
      const lo = sb - rb > sL ? sb - rb : sL, hi = sb + rb < sR ? sb + rb : sR;
      if (hi <= lo) continue;
      const far = t > LT.blockNear ? (t < LT.blockFar ? (t - LT.blockNear) / (LT.blockFar - LT.blockNear) : 1) : 0;
      const eff = LT.blockEff * (1 + (LT.blockFarKeep - 1) * far) + (LT.blockEffNear - LT.blockEff) * near01;
      const c = (eff * (hi - lo)) / width;
      if (c > cov) cov = c;
    }
    block *= 1 - cov;
  }
  if (block < LT.blockFloor) block = LT.blockFloor;
  R[7] = block;
  xg *= block;
  const a = s.attrs[slot]!;
  if (near2 < 1e17) {
    const pr = clamp01((LT.pressFar - Math.sqrt(near2)) / (LT.pressFar - LT.pressNear));
    xg *= 1 - LT.pressMax * pr * (1 - LT.composureRelief * clamp01((a.composure - 1) / 98));
  }

  // 5. Attributes and the weaker foot.
  const w = clamp01((d - LT.finishRange) / (LT.longRange - LT.finishRange));
  const fin = finite(a.finishing) ? a.finishing : LT.attrRef;
  const lsh = finite(a.longShots) ? a.longShots : LT.attrRef;
  let am = 1 + (LT.attrSpan * (fin + (lsh - fin) * w - LT.attrRef)) / 29;
  am = am < LT.attrMin ? LT.attrMin : am > LT.attrMax ? LT.attrMax : am;
  xg *= am;
  const fx = p.fx, fz = p.fz;
  const fl = finite(fx) && finite(fz) ? Math.sqrt(fx * fx + fz * fz) : 0;
  if (fl > 1e-6) {
    // Sine of the turn from his facing to the goal, + = to his right (SIM-07 convention).
    const turn = (fx * uz - fz * ux) / fl;
    const weakTurn = a.foot === Foot.LEFT ? -turn : turn;
    if (weakTurn > LT.weakTurnLo) {
      let wf = finite(a.weakFoot) ? a.weakFoot : 3;
      wf = wf < 1 ? 1 : wf > 5 ? 5 : wf;
      xg *= 1 - (LT.weakMax * smooth01((weakTurn - LT.weakTurnLo) / (LT.weakTurnHi - LT.weakTurnLo)) * (5 - wf)) / 4;
    }
  }
  if (!(xg > 0)) return;
  R[1] = xg < LT.xgCap ? xg : LT.xgCap;
}

// ---------------------------------------------------------------- dribble

/** Best dribble direction for slot into space; returns a score 0..1 and writes the unit direction. */
export function bestDribble(s: SimState, slot: number, out: { x: number; z: number }): number {
  dribbleKernel(s, slot, out);
  return R[2]!;
}

/** bestDribble with the score into R[2]. */
function dribbleKernel(s: SimState, slot: number, out: { x: number; z: number }): void {
  out.x = 0; out.z = 0; R[2] = 0;
  if (!validSlot(slot)) return;
  const p = s.players[slot]!;
  const team = p.team;
  if (p.active !== 1 || (team !== 0 && team !== 1)) return;
  const x = p.x, z = p.z;
  if (!finite(x) || !finite(z)) return;
  const dir = s.teams[team]!.dir === -1 ? -1 : 1;
  prepOpponents(s, team);
  const n = NI[0]!;
  // Goal direction.
  let gux = dir * HALF_LENGTH - x, guz = -z;
  const gl = Math.sqrt(gux * gux + guz * guz);
  if (gl > 1) { gux /= gl; guz /= gl; } else { gux = dir; guz = 0; }
  // Carrier: dribbling speed and acceleration, current velocity.
  const a = s.attrs[slot]!;
  let top = a.topSpeed > 0 && finite(a.topSpeed) ? a.topSpeed : T_PLAYER.topSpeedMin;
  let acc = a.accel > 0 && finite(a.accel) ? a.accel : T_PLAYER.accelMin;
  const st = p.stamina;
  if (st < T_PLAYER.staminaLowThreshold) {
    const f = st > 0 ? st / T_PLAYER.staminaLowThreshold : 0;
    const sf = T_PLAYER.staminaFloorMul + (1 - T_PLAYER.staminaFloorMul) * f;
    top *= sf; acc *= sf;
  }
  const vc = top * LT.dribbleSpeedFrac > 1 ? top * LT.dribbleSpeedFrac : 1;
  if (acc < 0.5) acc = 0.5;
  const vx = finite(p.vx) ? p.vx : 0, vz = finite(p.vz) ? p.vz : 0;
  const sp = Math.sqrt(vx * vx + vz * vz);
  const spFrac = sp < vc ? sp / vc : 1;
  // Opponents who cannot threaten any probe within the space window are skipped for this call (lower bound on
  // their time vs the carrier's slowest arrival at the far probe from a standstill after a full turn).
  const accRun = (vc * vc) / (2 * acc);
  const tcMax = LT.turnCost + (LT.probe3 > accRun ? vc / acc + (LT.probe3 - accRun) / vc : Math.sqrt((2 * LT.probe3) / acc));
  for (let j = 0; j < n; j++) {
    const dx = OX[j]! - x, dz = OZ[j]! - z;
    const d0 = Math.sqrt(dx * dx + dz * dz);
    const ov = Math.sqrt(OVX[j]! * OVX[j]! + OVZ[j]! * OVZ[j]!);
    const reachable = d0 - LT.probe3 - LT.oppReach - ov * LT.oppReact;
    OFAR[j] = reachable > 0 && LT.oppReact + reachable / OTOP[j]! - tcMax - LT.probeSlack3 > LT.spaceHi ? 1 : 0;
  }
  const wSum = LT.wSpace + LT.wProg + LT.wSep;
  let best = -1, bestSc = 0, bx = 0, bz = 0;
  for (let k = 0; k < DRIBBLE_DIRS; k++) {
    const c = DCOS[k]!, sn = DSIN[k]!;
    const dx = gux * c - guz * sn, dz = guz * c + gux * sn;
    // Run until edgeMargin inside the lines.
    let tExit = 1e9;
    if (dx > 1e-6) { const t = (HALF_LENGTH - LT.edgeMargin - x) / dx; if (t < tExit) tExit = t; }
    else if (dx < -1e-6) { const t = (-HALF_LENGTH + LT.edgeMargin - x) / dx; if (t < tExit) tExit = t; }
    if (dz > 1e-6) { const t = (HALF_WIDTH - LT.edgeMargin - z) / dz; if (t < tExit) tExit = t; }
    else if (dz < -1e-6) { const t = (-HALF_WIDTH + LT.edgeMargin - z) / dz; if (t < tExit) tExit = t; }
    const lineF = clamp01((tExit - 1) / (LT.probe3 - 1));
    if (!(lineF > 0)) continue;
    // Carrier start: speed along the direction (0 when turning away) after a turn cost.
    const along = vx * dx + vz * dz;
    const cosT = sp > 0.3 ? along / sp : 1;
    const turnT = LT.turnCost * (1 - cosT) * 0.5 * spFrac;
    const v0c = along > 0 ? (along < vc ? along : vc) : 0;
    const accC = (vc * vc - v0c * v0c) / (2 * acc);
    // Space: smallest arrival margin over the probes (+ their slack); separation at the far probe.
    let margin = 1e9, sep2 = 1e18;
    for (let r = 0; r < 3; r++) {
      const dist = r === 0 ? LT.probe1 : r === 1 ? LT.probe2 : LT.probe3;
      const slack = r === 0 ? 0 : r === 1 ? LT.probeSlack2 : LT.probeSlack3;
      const px = x + dx * dist, pz = z + dz * dist;
      const tc = turnT + (dist > accC ? (vc - v0c) / acc + (dist - accC) / vc : (Math.sqrt(v0c * v0c + 2 * acc * dist) - v0c) / acc);
      for (let j = 0; j < n; j++) {
        if (OFAR[j] === 1) continue;
        const ovx = OVX[j]!, ovz = OVZ[j]!;
        const rx = px - OX[j]! - ovx * LT.oppReact, rz = pz - OZ[j]! - ovz * LT.oppReact;
        const e2 = rx * rx + rz * rz;
        if (r === 2 && e2 < sep2) sep2 = e2;
        const e = Math.sqrt(e2);
        const run = e - LT.oppReach;
        let to = LT.oppReact;
        if (run > 0) {
          // From his speed toward the point (0..top), accelerating at his acceleration up to his top speed.
          const V = OTOP[j]!, A = OACC[j]!;
          let v0 = (ovx * rx + ovz * rz) / e;
          v0 = v0 > 0 ? (v0 < V ? v0 : V) : 0;
          const sa = (V * V - v0 * v0) / (2 * A);
          to += run > sa ? (V - v0) / A + (run - sa) / V : (Math.sqrt(v0 * v0 + 2 * A * run) - v0) / A;
        }
        const m = to - tc + slack;
        if (m < margin) margin = m;
      }
    }
    const space = smooth01((margin - LT.spaceLo) / (LT.spaceHi - LT.spaceLo));
    const prog = (1 + c) * 0.5;
    const sep = sep2 < 1e17 ? clamp01(Math.sqrt(sep2) / LT.sepRef) : 1;
    const j = ((LT.wSpace * space + LT.wProg * prog + LT.wSep * sep) / wSum) * lineF;
    if (j > best) { best = j; bx = dx; bz = dz; bestSc = (LT.spaceShare * space + (1 - LT.spaceShare) * sep) * lineF; }
  }
  if (!(best > 0)) return;
  const l = Math.sqrt(bx * bx + bz * bz);
  out.x = bx / l; out.z = bz / l;
  R[2] = bestSc > 0 ? (bestSc < 1 ? bestSc : 1) : 0;
}

// ---------------------------------------------------------------- skill moves

/** Skill move to beat the nearest defender, or SkillMove.NONE. */
export function chooseSkill(s: SimState, slot: number): SkillMove {
  SKILL_CHOICE.move = SkillMove.NONE; SKILL_CHOICE.side = 0; SKILL_CHOICE.dirX = 0; SKILL_CHOICE.dirZ = 0;
  if (!validSlot(slot)) return SkillMove.NONE;
  const p = s.players[slot]!;
  const team = p.team;
  if (p.active !== 1 || p.isKeeper === 1 || (team !== 0 && team !== 1)) return SkillMove.NONE;
  const b = s.ball;
  if (b.owner !== slot || b.heldBy === slot || !(b.y <= T_DRIBBLE.controlHeight)) return SkillMove.NONE;
  const a = s.attrs[slot]!;
  const stars = finite(a.skillMoves) ? a.skillMoves : 0;
  if (stars < 1) return SkillMove.NONE;
  const x = p.x, z = p.z;
  if (!finite(x) || !finite(z)) return SkillMove.NONE;
  let fx = finite(p.fx) ? p.fx : 0, fz = finite(p.fz) ? p.fz : 0;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (!(fl > 1e-6)) return SkillMove.NONE;
  fx /= fl; fz /= fl;
  // Right of the facing (SIM-13 convention).
  const rx = -fz, rz = fx;
  prepOpponents(s, team);
  const n = NI[0]!;
  // The defender: nearest opponent in front.
  let dj = -1, dd = 1e18;
  for (let j = 0; j < n; j++) {
    const ox = OX[j]! - x, oz = OZ[j]! - z;
    const e = Math.sqrt(ox * ox + oz * oz);
    if (e < LT.minDefDist || e > LT.knockMaxDist) continue;
    if (ox * fx + oz * fz < LT.frontCos * e) continue;
    if (e < dd) { dd = e; dj = j; }
  }
  if (dj < 0) return SkillMove.NONE;
  const ox = OX[dj]! - x, oz = OZ[dj]! - z;
  const lat = ox * rx + oz * rz;
  const alat = lat < 0 ? -lat : lat;
  // Closing speed (relative, toward the carrier).
  const ex = ox / dd, ez = oz / dd;
  const pvx = finite(p.vx) ? p.vx : 0, pvz = finite(p.vz) ? p.vz : 0;
  const closing = (pvx - OVX[dj]!) * ex + (pvz - OVZ[dj]!) * ez;
  // Side space per exit angle (0: 45, 1: 60, 2: 90) and side (left, right): bit k*2 + (right ? 1 : 0).
  let sideBits = 0;
  let leftClear = 0, rightClear = 0;
  const reach = dd + LT.sidePast > LT.sideProbeMin ? dd + LT.sidePast : LT.sideProbeMin;
  for (let k = 0; k < 3; k++) {
    const c = SIDE_COS[k]!, sn = SIDE_SIN[k]!;
    for (let side = -1; side <= 1; side += 2) {
      const qx = fx * c + side * rx * sn, qz = fz * c + side * rz * sn;
      const px = x + qx * reach, pz = z + qz * reach;
      if (!insidePitch(px, pz, LT.probeMargin)) continue;
      clearanceAt(px, pz, -1);
      const cl = R[0]!;
      if (side < 0 && cl > leftClear) leftClear = cl;
      if (side > 0 && cl > rightClear) rightClear = cl;
      if (cl >= LT.sideClear) sideBits |= 1 << (k * 2 + (side > 0 ? 1 : 0));
    }
  }
  const side45 = (sideBits & 3) !== 0, side60 = (sideBits & 12) !== 0, side90 = (sideBits & 48) !== 0;
  // Behind the defender (him excluded) and behind the carrier.
  const bpx = x + fx * (dd + LT.behindProbe), bpz = z + fz * (dd + LT.behindProbe);
  let behind = 0;
  if (insidePitch(bpx, bpz, LT.probeMargin)) { clearanceAt(bpx, bpz, dj); behind = R[0]!; }
  const kpx = x - fx * LT.backProbe, kpz = z - fz * LT.backProbe;
  let back = 0;
  if (insidePitch(kpx, kpz, LT.probeMargin)) { clearanceAt(kpx, kpz, -1); back = R[0]!; }
  const myTop = a.topSpeed > 0 && finite(a.topSpeed) ? a.topSpeed : T_PLAYER.topSpeedMin;
  const defAway = OVX[dj]! * fx + OVZ[dj]! * fz;
  const anySide = side45 || side60 || side90;

  let move = SkillMove.NONE;
  const ms = T_SKILL.minStars;
  if (stars >= ms[SkillMove.ROULETTE]! && dd <= LT.closeDist && closing >= LT.lungeSpeed && side45) move = SkillMove.ROULETTE;
  else if (stars >= ms[SkillMove.HEEL_FLICK]! && dd >= LT.heelMin && dd <= LT.heelMax && alat <= LT.heelLat &&
    behind >= LT.behindClear) move = SkillMove.HEEL_FLICK;
  else if (stars >= ms[SkillMove.KNOCK_ON]! && dd >= LT.knockMin && dd <= LT.knockMaxDist && behind >= LT.knockClear &&
    pvx * fx + pvz * fz >= LT.knockMinSpeed && myTop >= OTOP[dj]! - LT.paceSlack &&
    defAway < myTop * LT.dribbleSpeedFrac * 0.5 &&
    insidePitch(x + fx * LT.knockRun, z + fz * LT.knockRun, LT.knockEdge)) move = SkillMove.KNOCK_ON;
  else if (stars >= ms[SkillMove.BALL_ROLL]! && dd <= LT.closeDist && side90) move = SkillMove.BALL_ROLL;
  else if (stars >= ms[SkillMove.STEP_OVER]! && dd > LT.closeDist && dd <= LT.midDist && side45) move = SkillMove.STEP_OVER;
  else if (stars >= ms[SkillMove.BODY_FEINT]! && dd > LT.closeDist * LT.feintNear && dd <= LT.midDist && side60) {
    move = SkillMove.BODY_FEINT;
  } else if (stars >= ms[SkillMove.DRAG_BACK]! && dd <= LT.dragDist && closing >= LT.lungeSpeed * 0.5 && !anySide &&
    back >= LT.backClear) move = SkillMove.DRAG_BACK;
  if (move === SkillMove.NONE) return SkillMove.NONE;

  // Side with more space (and away from the defender's lateral offset on a tie); exit direction suggestion.
  let side = rightClear > leftClear ? 1 : rightClear < leftClear ? -1 : lat > 0 ? -1 : 1;
  let qx = fx, qz = fz;
  if (move === SkillMove.KNOCK_ON || move === SkillMove.HEEL_FLICK) side = 0;
  else if (move === SkillMove.DRAG_BACK) { qx = -fx; qz = -fz; }
  else {
    const k = move === SkillMove.BALL_ROLL ? 2 : move === SkillMove.BODY_FEINT ? 1 : 0;
    qx = fx * SIDE_COS[k]! + side * rx * SIDE_SIN[k]!;
    qz = fz * SIDE_COS[k]! + side * rz * SIDE_SIN[k]!;
  }
  SKILL_CHOICE.move = move; SKILL_CHOICE.side = side; SKILL_CHOICE.dirX = qx; SKILL_CHOICE.dirZ = qz;
  return move;
}
