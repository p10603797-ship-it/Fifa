/**
 * [TAI-08] CPU ball-carrier decision engine. On the ball the CPU scores its options every few ticks
 * (T_AI.carrierEvalInterval, brain.evalT): each pass candidate (TAI-09), through ball, cross, dribble into
 * space, skill move, shield, clear, and shoot (TAI-10 xG). Team style weights (TAI-12) and difficulty
 * (reaction, noise, look-ahead, execution error) shape choices. Executes the chosen plan ONLY by writing the
 * CPU InputFrame (stick, buttons held for the power it wants, aim, gestures for explicit targets) — the same
 * frame a human would produce. Never reads human inputs; no stat boosts.
 *
 * HOW IT WORKS (cpuCarrier, called by ai/cpu/index.ts cpuThink while the team owns the ball IN_PLAY; `out` is cleared)
 *  Reads only SimState (players, ball, its own team and brain, its own controller's fastPower) and writes only `out`
 *  and its brain (s.teams[team].cpu). The carrier is ball.owner: SIM-16 moves the CPU controller onto him in the same
 *  tick (resolveControllers runs after cpuThink), so the frame drives him.
 *  1. Situation (brain.seenOwner = ball.owner; brain.p0 = the tick of the previous call, so any gap — a restart, a
 *     loose ball, another module using the brain — is a new situation too): a new situation drops the plan and starts
 *     the reaction delay, levelParams(level).reactionTicks, during which the carrier just keeps running the way he is
 *     going (stick along his velocity, no buttons). A loose ball (our pass in flight: the receiver meets it on his own
 *     with the stick released) or a keeper holding the ball (GKP-04 distributes) gets a neutral frame.
 *  2. Decision (first tick after the reaction delay, then every T_AI.carrierEvalInterval ticks while dribbling,
 *     shielding or holding; a kick or skill plan is committed until it has been executed or has failed). Every option
 *     gets a utility in goal-probability units against a possession-value model: PV(progress) = pvBase + pvSpan *
 *     ((progress + 1) / 2)^3 for having the ball at a spot, and lossCost(progress) (the opponents' PV(-progress), x style safety)
 *     for losing it there:
 *       - pass / through ball / cross (TAI-09 scorePassOptions: completion c, progress, danger):
 *         c * max(PV(target), danger * dangerValueMul) - (1 - c) * lossCost(min(here, target)); a through ball's
 *         completion is discounted when the level's look-ahead is short; gains over keeping the ball are scaled by
 *         style progress (forward), directness (through / long balls), width (crosses); counter-attack bonus per metre
 *         gained (x completion); a settling penalty for a pass right after gaining the ball unless pressed;
 *       - shoot (TAI-10 estimateXg, only when xG >= the level's shotThresholdXg, raised / lowered for long shots by
 *         style longShot): shotXgMul * xG + (1 - xG) * shotMissValue (+ boxShotBonus in the box);
 *       - dribble (TAI-10 bestDribble direction and score; toward goal, away from the nearest opponent ahead when it
 *         gives none): keep chance (pressure x dribbling) * PV(a step ahead) - risk, gain x style dribble;
 *       - skill move (TAI-10 chooseSkill): success estimate from stars and dribbling, beats the man by skillGain m;
 *       - shield (opponent within shieldDist): keep chance from strength, falling as the shield lasts (shieldAgeRef);
 *         after shieldMaxTicks of shielding it rests for shieldRestEvals decisions (never shields forever);
 *       - clear (own third, opponent within clearPressDist): a flat clearValue (+ own box bonus).
 *     Pressure uses the nearest opponent now and after the level's look-ahead (both moving on). Each utility gets
 *     decision noise rngGauss(s.rng) x decisionNoise x noiseScale; the current dribble / shield plan keeps a
 *     switchMargin bonus (no dithering) and a re-chosen dribble blends its direction with the previous one (dirKeep).
 *     A plan whose action failed to start is skipped for failEvals evaluations.
 *  3. Execution (frame only):
 *       - PASS (ground) / THROUGH / CROSS / lofted passes: turn toward the target first (stick at aimStick, at most
 *         aimMaxTicks, skipped when facing within aimCos or pressed tightly), then a pitch-gesture TAP (ground pass to
 *         gSlot's feet; through ball: the tap point leads the runner by >= throughMinLead m + tap noise) or DOUBLE_TAP
 *         (lob / lobbed through ball / cross to the post spot) — exactly what a touch player can tap. DRIVEN passes are
 *         PASS + MOD_R held for the power that suits the distance, the stick on the receiver.
 *       - SHOOT: aim point inside the far / open post (keeper position) with aim noise x executionError; normal, finesse
 *         (MOD_R: angled, mid range, good curve) or chip (MOD_L: keeper off his line); SHOOT pressed (modifiers on the
 *         press tick only) and HELD power x powerFillTicks ticks (+ power noise), the stick toward the aim point.
 *       - CLEAR: LOB held clearPower x powerFillTicks, the stick upfield toward the ball's touchline.
 *       - DRIBBLE: stick along the plan direction (turned along a line within edgeMargin of it); turning more than
 *         acos(leashCos) away from the ball: no sprint, and run to the ball first while it is beyond his touch reach (so
 *         SIM-06's next touch takes it the new way instead of leaving it behind); SPRINT only with space ahead (no
 *         opponent within sprintSpaceDist in the cone, none within tightDist) and stamina; never SPRINT or MOD_L with a
 *         released stick (those are stop-ball inputs).
 *       - SKILL: frame.skill edge with the stick on the exit side away from the nearest opponent, then dribble on.
 *       - SHIELD: SHIELD held, stick released.
 *     A kick / skill that has not started within startTimeoutTicks of its press or gesture (or a busy player not
 *     free within readyWaitTicks) is dropped and decided again next tick.
 *  Brain fields: plan, planT (ticks in the current step / age of a continuous plan), planSlot (receiver), planX/Z
 *  (target point; unit direction for DRIBBLE / SKILL), holdTicks (button hold for power), evalT, reactT, seenOwner,
 *  p0 (tick of the previous call), p1 (step | mode << 4 | started << 6 | failMask << 7 | failEvals << 17),
 *  p2 (utility of the committed plan), p3 (buttons to press, or the SkillMove for SKILL).
 * Determinism / cost: plain arithmetic + Math.sqrt / Math.round, s.rng only for noise, slot-order loops, module
 * scratch only (no allocation; on the hot paths doubles travel through typed scratch — SV stick, NZ noise, CU option —
 * instead of call arguments / return values, which V8 would box). Per tick O(11); per evaluation one TAI-09 scan plus
 * a few TAI-10 calls (about 0.04 ms per full evaluation on desktop Node, tests/perf/tai-08-budget.test.ts).
 */
import {
  CPU_CONTROLLER_BASE, DT, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM,
} from '../../contracts/constants';
import { ActionKind, GestureKind, KickKind, SkillMove, TeamPhase } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { Btn, GESTURE_POS_SCALE, type InputFrame } from '../../contracts/input';
import { CpuPlan, type CpuBrainState, type PlayerState, type SimState } from '../../contracts/state';
import type { LevelParams, StyleWeights } from '../../contracts/systems';
import { T_AI, T_DRIBBLE, T_PASS, T_PLAYER, T_SKILL } from '../../contracts/tuning';
import { rngGauss } from '../../sim/core/rng';
import { inPenaltyArea } from '../../sim/pitch/geometry';
import { levelParams, styleWeights } from './levels';
import { createPassOptions, scorePassOptions, type PassOption } from './passing';
import { bestDribble, chooseSkill, estimateXg } from './shooting';

export const LOCAL_TUNING = { // TUNING-CR (TAI-08): move into T_AI as carrier* (utilities are goal-probability units)
  // ---- possession value model
  /** Value of having the ball at the own goal line, goal probability ... */
  pvBase: 0.004,
  /** ... plus this times ((progress + 1) / 2)^3 toward the opposition goal line, goal probability [INT-A: was
   *  0.01 + 0.07 t^2 — too flat, so a forward pass never paid for its risk and attacks went sideways forever]. */
  pvSpan: 0.08,
  /** Width discount: none within pvLatFree m of the centre line, down to x pvLatMin at pvLatFull m, weighted by the
   *  progress share t (so it bites in the final third), m / m / 0..1. */
  pvLatFree: 9,
  pvLatFull: 30,
  pvLatMin: 0.35,
  /** Losing the ball at progress p costs the opponents' possession value there, posValue(-p) (x style safety)
   *  [INT-A: replaces the linear lossOwn 0.07 .. lossOpp 0.01, which overcharged a loss in midfield]. */
  /** A receiving spot is worth at least its TAI-09 danger (xG-ish 0..1) times this. */
  dangerValueMul: 0.8,
  /** Style multiplier on a positive gain over keeping the ball: weight 0 -> min, 1 -> max. */
  styleMulMin: 0.7,
  styleMulMax: 1.3,
  /** Loss-cost multiplier from style safety: 0 -> min, 1 -> max. */
  safetyLossMin: 0.75,
  safetyLossMax: 1.35,
  /** A through ball's completion is discounted by up to this fraction as look-ahead falls to 0 ... */
  throughLookPenalty: 0.3,
  /** ... relative to this look-ahead (Legend), ticks. */
  lookAheadRef: 46,
  /** Passes at least this long are long balls (style directness), m. */
  longBallDist: 30,
  /** A pass within settleTicks of gaining the ball (ball.ownerT) loses up to settlePenalty unless pressed (pressure
   *  >= settlePressure), ticks / goal probability / 0..1. */
  settleTicks: 45,
  settlePenalty: 0.01,
  settlePressure: 0.5,
  /** Counter-attack (team phase TRANSITION_ATTACK): bonus per metre of progress at style counter 0.5, x the pass's
   *  completion, goal probability [INT-A: was 0.0008 regardless of completion — a 40 m lofted through ball with a 3%
   *  chance got +0.03 and won every counter, so lofted through balls were tried 7 times a match and never arrived]. */
  counterPerM: 0.0003,
  // ---- shooting
  /** Value of a shot that does not score (corner, rebound), goal probability. */
  shotMissValue: 0.006,
  /** A shot's xG is weighted by this against the possession value of keeping the ball (that value is only an
   *  average; against a set block it is rarely realised) [INT-A]. */
  shotXgMul: 3.5,
  /** Extra urge to shoot inside the penalty area, goal probability. */
  boxShotBonus: 0.012,
  /** Beyond this distance from the goal centre a shot is a long shot, m ... */
  longShotDist: 20,
  /** ... whose xG threshold is T_LEVEL.shotThresholdXg x this at style longShot 0 / 1. */
  longShotThreshMax: 1.0,
  longShotThreshMin: 0.7,
  /** Shot power 0..1 at <= shotNearDist m / >= shotFarDist m from the goal centre (linear between). */
  shotPowerNear: 0.65,
  shotPowerFar: 0.84,
  shotNearDist: 8,
  shotFarDist: 28,
  /** Shot power clamp after noise (0..1). */
  shotPowerMin: 0.35,
  shotPowerMax: 0.92,
  /** Aim point inside the post, m. */
  shotInset: 0.5,
  /** Keeper this far (|z|) off the goal centre: aim at the other side, m. */
  keeperSideDead: 0.3,
  /** Finesse shot (MOD_R): distance window m, |z| of the shooter at least m, curve attribute at least. */
  finesseMinDist: 10,
  finesseMaxDist: 24,
  finesseMinAbsZ: 4,
  finesseMinCurve: 65,
  /** Chip shot (MOD_L): keeper at least this far off his line, shooter distance window, m. */
  chipKeeperOff: 6,
  chipMinDist: 12,
  chipMaxDist: 30,
  // ---- dribbling
  /** Carry valued per dribble decision at full space, m (x (0.3 + 0.7 score)). */
  dribbleStep: 6,
  /** Chance of losing the ball dribbling at full pressure (x 1.2 - 0.4 x dribbling / 99). */
  dribbleLossMax: 0.35,
  /** Score assumed when bestDribble gives no direction. */
  fallbackDribbleScore: 0.4,
  /** Fallback dribble: an opponent within this distance ahead turns the run aside by fallbackTurn (cos/sin of 45 deg), m. */
  fallbackAvoidDist: 6,
  /** Keeper with the ball at his feet: dribble utility penalty, goal probability. */
  keeperDribblePenalty: 0.02,
  /** Sprint only with no opponent within this distance in the cone ahead (cos >= sprintConeCos), m ... */
  sprintSpaceDist: 7,
  sprintConeCos: 0.5,
  /** ... (x this on a counter-attack) ... */
  counterSpaceMul: 0.7,
  /** ... none within tightDist (pressed tightly, also: fire kicks without turning first), m ... */
  tightDist: 2.5,
  /** ... and stamina above this (0..1). */
  sprintMinStamina: 0.3,
  /** Stick magnitude dribbling at a jog / pressed tightly (0..1). */
  jogStick: 1,
  tightStick: 0.75,
  /** Within this distance of a line the dribble turns along it instead of running out, m. */
  edgeMargin: 3,
  /** Weight of the previous dribble direction when dribbling is chosen again (0 = snap to the new one). */
  dirKeep: 0.35,
  /** Turning with the ball: when the wanted direction is more than acos(leashCos) away from the ball, no sprint, and
   *  while the ball is beyond his touch reach (T_DRIBBLE.controlRadius + speed x reachLookahead, as SIM-06) + leashMargin
   *  he runs to the ball first (SIM-06 then touches it the new way), so a turn never leaves the ball behind. s / m. */
  leashCos: 0.94,
  reachLookahead: 0.08,
  leashMargin: 0.2,
  // ---- skill moves
  /** Success estimate: base + per star + x dribbling / 99, capped. */
  skillBase: 0.3,
  skillPerStar: 0.08,
  skillDribbling: 0.25,
  skillMaxSuccess: 0.85,
  /** Ground gained when the move beats the defender, m. */
  skillGain: 7,
  /** Exit direction: forward share added to the sideways exit (unit sideways + this x facing, normalised). */
  skillForward: 0.45,
  // ---- shield
  /** Shield only with an opponent within this distance, m. */
  shieldDist: 2.4,
  /** Chance of losing the ball shielding at strength 1 / 99. */
  shieldLossWeak: 0.3,
  shieldLossStrong: 0.1,
  /** Shielding gets riskier the longer it lasts: loss chance x (1 + shield age / shieldAgeRef), ticks ... */
  shieldAgeRef: 60,
  /** ... and after shieldMaxTicks of continuous shielding it is off the menu for shieldRestEvals decisions (<= 7), so
   *  a carrier never stalls behind a shield (glitch "CPU: shields forever"). ticks / evaluations. */
  shieldMaxTicks: 150,
  shieldRestEvals: 6,
  /** Shielding only holds the ball: the kept possession value is discounted by this (it is realised only by a later
   *  pass or turn) [INT-A: undiscounted, shield / skill / dribble cycles in the final third beat every shot]. */
  shieldHoldMul: 0.85,
  // ---- clearance
  /** Clear only in the own third (progress below this) with an opponent within clearPressDist m. */
  clearProgress: -1 / 3,
  clearPressDist: 4.5,
  /** Utility of a clearance (+ clearBoxBonus in the own penalty area), goal probability [INT-A: was 0.012 / 0.008,
   *  tuned to the old flat value model; against the cubic one a clearance beat every pass below ~95% completion, so
   *  CPUs hoofed 15+ long balls a match: a clearance gives the ball away upfield, worth about 0]. */
  clearValue: -0.0015,
  clearBoxBonus: 0.006,
  /** Clearance LOB power 0..1 and target: this far upfield / toward the ball's touchline, m. */
  clearPower: 0.5,
  clearDist: 40,
  clearSide: 18,
  // ---- pressure
  /** Pressure 1 at <= pressNear m, 0 at >= pressFar m (nearest opponent now, or after the look-ahead + slack). */
  pressNear: 1,
  pressFar: 6,
  predictSlack: 1,
  // ---- decisions
  /** Decision noise sd = T_LEVEL.decisionNoise x this, goal probability. */
  noiseScale: 0.02,
  /** Bonus the current dribble / shield plan keeps when deciding again (no dithering), goal probability. */
  switchMargin: 0.006,
  /** Evaluations after a failed start during which that plan is not chosen again. */
  failEvals: 2,
  // ---- execution
  /** Turn toward a kick target for at most this many ticks first; done early when facing within aimCos. */
  aimMaxTicks: 6,
  aimCos: 0.7,
  /** Stick magnitude while turning to aim (0..1). */
  aimStick: 0.6,
  /** The action must start within this many ticks of its press / gesture, ticks ... */
  startTimeoutTicks: 9,
  /** ... and a busy carrier (first touch, ...) must be free within this many ticks of the plan, ticks. */
  readyWaitTicks: 30,
  /** Execution noise x T_LEVEL.executionError (sd): shot aim across the mouth m, power 0..1, through-ball tap m,
   *  dribble / skill direction rad. */
  aimNoise: 0.45,
  powerNoise: 0.05,
  tapNoise: 0.6,
  dirNoise: 0.05,
  /** Ticks to the next decision after a skill move ends. */
  postSkillEval: 2,
  /** Driven pass power: base + per metre (0..1, capped at drivenPowerMax). */
  drivenPowerBase: 0.3,
  drivenPowerPerM: 0.012,
  drivenPowerMax: 0.9,
  /** Through-ball taps lead the runner by at least this (the gesture's through-ball rule is 1.5 m), m. */
  throughMinLead: 2,
  /** Gesture targets are kept this far inside the touchlines / goal lines, m. */
  tapPitchMargin: 1,
} as const;

const LT = LOCAL_TUNING;

// ---------------------------------------------------------------- constants and scratch

const STICK_MAX = 126;
const FACE_MASK = Btn.PASS | Btn.SHOOT | Btn.LOB | Btn.THROUGH;
const MAX_OPTIONS = 48;
const OPTS: PassOption[] = createPassOptions(MAX_OPTIONS);
/** bestDribble / fallback direction (scratch). */
const DRB = { x: 0, z: 0 };
/** Stick scratch for stickOut / canSprint: direction x, z and magnitude. */
const SV = new Float64Array(3);
/** Noise scratch: NZ[0] decision noise (noise()), NZ[1] a Gaussian draw (gauss()). */
const NZ = new Float64Array(2);
/** Candidate option for consider(): utility, target x / direction x, target z / direction z. */
const CU = new Float64Array(3);

/** Execution steps (brain.p1 bits 0..3). */
const STEP_NONE = 0;
const STEP_AIM = 1;
const STEP_FIRE = 2;
const STEP_HOLD = 3;
const STEP_WAIT = 4;
const STEP_RUN = 5;
/** Kick execution modes (brain.p1 bits 4..5). */
const MODE_NONE = 0;
const MODE_TAP = 1;
const MODE_DTAP = 2;
const MODE_BUTTON = 3;

/** Decision context (scratch, filled by fillContext at each decision). */
const C = {
  team: 0, dir: 1, prog: 0, vHere: 0, pressure: 0, nearD: 1e9, nearOpp: -1, safetyMul: 1, noiseSd: 0, lookFrac: 0,
  counter: 0,
};

/** Best option so far (scratch). */
const BEST = { plan: CpuPlan.NONE as CpuPlan, u: -1e18, slot: -1, x: 0, z: 0, mode: MODE_NONE, kind: KickKind.NONE as number };

// ---------------------------------------------------------------- small helpers

function clamp01(v: number): number { return !(v > 0) ? 0 : v > 1 ? 1 : v; }
function fin(v: number): number { return v === v && v !== Infinity && v !== -Infinity ? v : 0; }
function validSlot(slot: number): boolean { return slot >= 0 && slot < NUM_SLOTS && slot === Math.floor(slot); }

function stepOf(b: CpuBrainState): number { return b.p1 & 15; }
function modeOf(b: CpuBrainState): number { return (b.p1 >> 4) & 3; }
function startedOf(b: CpuBrainState): number { return (b.p1 >> 6) & 1; }
function failMaskOf(b: CpuBrainState): number { return (b.p1 >> 7) & 1023; }
function failEvalsOf(b: CpuBrainState): number { return (b.p1 >> 17) & 7; }
function setP1(b: CpuBrainState, step: number, mode: number, started: number, failMask: number, failEvals: number): void {
  b.p1 = (step & 15) | ((mode & 3) << 4) | ((started & 1) << 6) | ((failMask & 1023) << 7) | ((failEvals & 7) << 17);
}
function setStep(b: CpuBrainState, step: number): void {
  setP1(b, step, modeOf(b), startedOf(b), failMaskOf(b), failEvalsOf(b));
  b.planT = 0;
}
function markStarted(b: CpuBrainState): void { b.p1 |= 1 << 6; }

/** Possession value at progress (-1 own goal line .. +1 opposition goal line), goal probability. */
function posValue(prog: number, z: number): number {
  const t = clamp01((prog + 1) * 0.5);
  // [INT-A] Width: toward the touchlines the spot is worth less, the more so the further up the pitch (a carrier at
  // the corner flag is not 0.08 goals from scoring; with x alone he kept the ball there rather than cross or cut back).
  const az = z < 0 ? -z : z;
  const w = az <= LT.pvLatFree ? 1 : 1 - (1 - LT.pvLatMin) * clamp01((az - LT.pvLatFree) / (LT.pvLatFull - LT.pvLatFree));
  return LT.pvBase + LT.pvSpan * t * t * t * (1 - t * (1 - w));
}

/** Cost of losing the ball at (progress, z) (x style safety): the opponents' possession value there, goal probability. */
function lossCost(prog: number, z: number): number {
  return posValue(-prog, z) * C.safetyMul;
}

function styleMul(w: number): number { return LT.styleMulMin + (LT.styleMulMax - LT.styleMulMin) * clamp01(w); }

function isOneShot(plan: CpuPlan): boolean {
  return plan === CpuPlan.PASS || plan === CpuPlan.THROUGH || plan === CpuPlan.CROSS || plan === CpuPlan.CLEAR ||
    plan === CpuPlan.SHOOT || plan === CpuPlan.SKILL;
}

function kickRunning(p: Readonly<PlayerState>): boolean {
  const a = p.act;
  return a === ActionKind.KICK || a === ActionKind.SHOT || a === ActionKind.HEADER || a === ActionKind.VOLLEY ||
    a === ActionKind.FAKE;
}

/** Free to start a kick or skill (a SHIELD hold is ended by the resolver when an action starts). */
function readyToAct(p: Readonly<PlayerState>): boolean {
  return p.active === 1 && p.stunT <= 0 && (p.act === ActionKind.NONE || p.act === ActionKind.SHIELD);
}

/**
 * Write the movement stick toward (SV[0], SV[1]) at magnitude SV[2] (0..1); released when the direction is degenerate.
 * The arguments travel through the SV scratch so no double crosses a call boundary on the per-tick path (V8 boxes those).
 */
function stickOut(out: InputFrame): void {
  const dx = SV[0]!, dz = SV[1]!, mag = SV[2]!;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (!(d > 1e-6) || !(mag > 0)) { out.mx = 0; out.mz = 0; return; }
  const k = (STICK_MAX * (mag < 1 ? mag : 1)) / d;
  out.mx = Math.round(dx * k);
  out.mz = Math.round(dz * k);
}

function quantPos(v: number): number {
  const q = Math.round(fin(v) * GESTURE_POS_SCALE);
  return q < -1023 ? -1023 : q > 1023 ? 1023 : q;
}

function clampTapX(x: number): number {
  const m = HALF_LENGTH - LT.tapPitchMargin;
  return x < -m ? -m : x > m ? m : x;
}

function clampTapZ(z: number): number {
  const m = HALF_WIDTH - LT.tapPitchMargin;
  return z < -m ? -m : z > m ? m : z;
}

function powerFill(s: SimState, team: number): number {
  const c = s.ctrl[CPU_CONTROLLER_BASE + team];
  return c && c.fastPower === 1 ? T_PASS.powerFillTicksFast : T_PASS.powerFillTicks;
}

function holdFor(power: number, fill: number): number {
  const h = Math.round(clamp01(power) * fill);
  return h < 1 ? 1 : h;
}

function resetPlan(b: CpuBrainState): void {
  b.plan = CpuPlan.NONE;
  b.planT = 0;
  b.planSlot = -1;
  b.planX = 0;
  b.planZ = 0;
  b.holdTicks = 0;
  b.p1 = 0;
  b.p2 = 0;
  b.p3 = 0;
}

/** Drop the current plan (decide again next tick); `fail` keeps it out of the next failEvals decisions. */
function abortPlan(b: CpuBrainState, fail: boolean): void {
  let mask = failMaskOf(b);
  let evals = failEvalsOf(b);
  if (fail && b.plan > CpuPlan.NONE && b.plan < 10) {
    mask |= 1 << b.plan;
    evals = LT.failEvals;
  }
  b.plan = CpuPlan.NONE;
  b.planT = 0;
  b.planSlot = -1;
  b.holdTicks = 0;
  b.p3 = 0;
  setP1(b, STEP_NONE, MODE_NONE, 0, mask, evals);
  b.evalT = 0;
}

// ---------------------------------------------------------------- reaction / hold

/** Keep running the way he is going (reaction delay, HOLD): stick along his velocity, no buttons. */
function emitCarry(s: SimState, p: Readonly<PlayerState>, out: InputFrame): void {
  const v = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  if (v < 0.5) return;
  const jog = s.attrs[p.slot]!.topSpeed * T_PLAYER.jogFraction;
  SV[0] = p.vx; SV[1] = p.vz; SV[2] = jog > 0 ? v / jog : 1; stickOut(out);
}

// ---------------------------------------------------------------- decision

function fillContext(s: SimState, team: number, p: Readonly<PlayerState>, lv: Readonly<LevelParams>, sw: Readonly<StyleWeights>): void {
  const t = s.teams[team]!;
  C.team = team;
  C.dir = t.dir;
  C.prog = (t.dir * p.x) / HALF_LENGTH;
  C.safetyMul = LT.safetyLossMin + (LT.safetyLossMax - LT.safetyLossMin) * clamp01(sw.safety);
  C.vHere = posValue(C.prog, p.z);
  C.noiseSd = clamp01(lv.decisionNoise) * LT.noiseScale;
  C.lookFrac = clamp01(lv.lookAheadTicks / LT.lookAheadRef);
  C.counter = t.phase === TeamPhase.TRANSITION_ATTACK ? 1 : 0;
  // Nearest opponent now, and the closest one after the look-ahead (both carrying on at their velocities).
  const la = (lv.lookAheadTicks > 0 ? lv.lookAheadTicks : 0) * DT;
  const px = p.x + p.vx * la, pz = p.z + p.vz * la;
  const first = team === 0 ? PLAYERS_PER_TEAM : 0;
  let nearD2 = 1e18, near = -1, pressD = 1e9;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < nearD2) { nearD2 = d2; near = i; }
    const fx = q.x + q.vx * la - px, fz = q.z + q.vz * la - pz;
    const dp = Math.sqrt(fx * fx + fz * fz) + LT.predictSlack;
    const dn = Math.sqrt(d2);
    const de = dp < dn ? dp : dn;
    if (de < pressD) pressD = de;
  }
  C.nearOpp = near;
  C.nearD = near >= 0 ? Math.sqrt(nearD2) : 1e9;
  C.pressure = pressD <= LT.pressNear ? 1 : pressD >= LT.pressFar ? 0 : 1 - (pressD - LT.pressNear) / (LT.pressFar - LT.pressNear);
}

/** Decision noise into NZ[0] (results travel through typed scratch: V8 boxes doubles returned across calls). */
function noise(s: SimState): void {
  NZ[0] = C.noiseSd > 0 ? rngGauss(s.rng) * C.noiseSd : 0;
}

/** One standard Gaussian draw (s.rng) into NZ[1]. */
function gauss(s: SimState): void {
  NZ[1] = rngGauss(s.rng);
}

/** Keep the option (utility CU[0], target / direction CU[1], CU[2]) if it beats the best so far. */
function consider(plan: CpuPlan, slot: number, mode: number, kind: number): void {
  const u = CU[0]!;
  if (!(u > BEST.u)) return;
  BEST.plan = plan; BEST.u = u; BEST.slot = slot; BEST.x = CU[1]!; BEST.z = CU[2]!; BEST.mode = mode; BEST.kind = kind;
}

function planOfPass(kind: number): CpuPlan {
  if (kind >= KickKind.THROUGH_GROUND && kind <= KickKind.THROUGH_DINKED) return CpuPlan.THROUGH;
  if (kind >= KickKind.CROSS && kind <= KickKind.LOW_CROSS) return CpuPlan.CROSS;
  return CpuPlan.PASS;
}

function modeOfPass(kind: number): number {
  if (kind === KickKind.DRIVEN_PASS) return MODE_BUTTON;
  if (kind === KickKind.DINKED_PASS || (kind >= KickKind.LOB_PASS && kind <= KickKind.LOW_CROSS) ||
      kind === KickKind.THROUGH_LOBBED || kind === KickKind.THROUGH_DINKED) return MODE_DTAP;
  return MODE_TAP;
}

function passOptionsInto(s: SimState, p: Readonly<PlayerState>, sw: Readonly<StyleWeights>, failMask: number): void {
  const slot = p.slot;
  const n0 = scorePassOptions(s, slot, OPTS);
  const n = n0 > MAX_OPTIONS ? MAX_OPTIONS : n0 > 0 ? Math.floor(n0) : 0;
  const first = p.team === 0 ? 0 : PLAYERS_PER_TEAM;
  const dir = C.dir;
  const own = s.ball.ownerT;
  const settle = C.pressure < LT.settlePressure && own < LT.settleTicks
    ? LT.settlePenalty * (1 - own / LT.settleTicks) : 0;
  for (let i = 0; i < n; i++) {
    const o = OPTS[i]!;
    const tgt = o.target;
    if (!validSlot(tgt) || tgt === slot || tgt < first || tgt >= first + PLAYERS_PER_TEAM) continue;
    const q = s.players[tgt]!;
    if (q.active !== 1) continue;
    const plan = planOfPass(o.kind);
    if ((failMask & (1 << plan)) !== 0) continue;
    const ox = o.x, oz = o.z;
    if (!(ox === ox && oz === oz) || ox > HALF_LENGTH + 5 || ox < -HALF_LENGTH - 5 || oz > HALF_WIDTH + 5 || oz < -HALF_WIDTH - 5) continue;
    let c = clamp01(o.completion);
    if (plan === CpuPlan.THROUGH) c *= 1 - LT.throughLookPenalty * (1 - C.lookFrac);
    const tprog = (dir * ox) / HALF_LENGTH;
    let vT = posValue(tprog, oz);
    const dv = clamp01(o.danger) * LT.dangerValueMul;
    if (dv > vT) vT = dv;
    const lossProg = tprog < C.prog ? tprog : C.prog;
    const raw = c * vT - (1 - c) * lossCost(lossProg, tprog < C.prog ? oz : p.z);
    let gain = raw - C.vHere;
    if (gain > 0) {
      const dx = ox - p.x, dz = oz - p.z;
      const long = dx * dx + dz * dz >= LT.longBallDist * LT.longBallDist;
      const w = plan === CpuPlan.THROUGH || long ? sw.directness : plan === CpuPlan.CROSS ? sw.width : sw.progress;
      gain *= styleMul(w);
    }
    let u = C.vHere + gain - settle;
    const prog = fin(o.progress);
    if (C.counter === 1 && prog > 0) u += c * LT.counterPerM * prog * clamp01(sw.counter) * 2;
    noise(s);
    u += NZ[0]!;
    CU[0] = u; CU[1] = ox; CU[2] = oz;
    consider(plan, tgt, modeOfPass(o.kind), o.kind);
  }
}

function shotOptionInto(s: SimState, p: Readonly<PlayerState>, lv: Readonly<LevelParams>, sw: Readonly<StyleWeights>): void {
  if (p.isKeeper === 1 || C.prog <= 0) return;
  const xg = clamp01(fin(estimateXg(s, p.slot, p.x, p.z)));
  if (!(xg > 0)) return;
  const gx = C.dir * HALF_LENGTH - p.x;
  const dist = Math.sqrt(gx * gx + p.z * p.z);
  const long = dist > LT.longShotDist;
  const ls = clamp01(sw.longShot);
  const thr = fin(lv.shotThresholdXg) * (long ? LT.longShotThreshMax + (LT.longShotThreshMin - LT.longShotThreshMax) * ls : 1);
  if (xg < thr) return;
  let u = xg * LT.shotXgMul + (1 - xg) * LT.shotMissValue;
  if (inPenaltyArea(p.x, p.z, C.dir)) u += LT.boxShotBonus;
  if (long && u > C.vHere) u = C.vHere + (u - C.vHere) * styleMul(ls);
  noise(s);
  u += NZ[0]!;
  CU[0] = u; CU[1] = 0; CU[2] = 0;
  consider(CpuPlan.SHOOT, -1, MODE_BUTTON, KickKind.SHOT_NORMAL);
}

/** Toward the attacked goal, turned 45 degrees away from an opponent close ahead (into DRB). */
function fallbackDribble(s: SimState, p: Readonly<PlayerState>): void {
  let gx = C.dir * HALF_LENGTH - p.x, gz = -p.z * 0.5;
  const gl = Math.sqrt(gx * gx + gz * gz);
  if (gl > 1e-6) { gx /= gl; gz /= gl; } else { gx = C.dir; gz = 0; }
  const o = C.nearOpp;
  if (o >= 0 && C.nearD <= LT.fallbackAvoidDist) {
    const q = s.players[o]!;
    const ox = q.x - p.x, oz = q.z - p.z;
    if (ox * gx + oz * gz > 0) {
      // Opponent on the left (cross > 0) -> turn right, and vice versa; 45 degrees.
      const side = gx * oz - gz * ox > 0 ? -1 : 1;
      const k = 0.7071067811865476;
      const rx = gx * k - side * gz * k;
      const rz = gz * k + side * gx * k;
      gx = rx; gz = rz;
    }
  }
  DRB.x = gx;
  DRB.z = gz;
}

function dribbleOptionInto(s: SimState, p: Readonly<PlayerState>, sw: Readonly<StyleWeights>, cur: CpuPlan): void {
  DRB.x = 0; DRB.z = 0;
  let sc = fin(bestDribble(s, p.slot, DRB));
  let dx = fin(DRB.x), dz = fin(DRB.z);
  let dl = Math.sqrt(dx * dx + dz * dz);
  if (!(dl > 1e-6)) {
    fallbackDribble(s, p);
    dx = DRB.x; dz = DRB.z; dl = 1;
    sc = LT.fallbackDribbleScore;
  }
  dx /= dl; dz /= dl;
  sc = clamp01(sc);
  const step = LT.dribbleStep * (0.3 + 0.7 * sc);
  const nprog = (C.dir * (p.x + dx * step)) / HALF_LENGTH;
  const keep = clamp01(1 - LT.dribbleLossMax * C.pressure * (1.2 - (0.4 * s.attrs[p.slot]!.dribbling) / 99));
  const raw = keep * posValue(nprog, p.z + dz * step) - (1 - keep) * lossCost(C.prog, p.z);
  let gain = raw - C.vHere;
  if (gain > 0) gain *= styleMul(sw.dribble);
  let u = C.vHere + gain;
  if (p.isKeeper === 1) u -= LT.keeperDribblePenalty;
  if (cur === CpuPlan.DRIBBLE) u += LT.switchMargin;
  noise(s);
  u += NZ[0]!;
  CU[0] = u; CU[1] = dx; CU[2] = dz;
  consider(CpuPlan.DRIBBLE, -1, MODE_NONE, KickKind.NONE);
}

function skillOptionInto(s: SimState, p: Readonly<PlayerState>, sw: Readonly<StyleWeights>): void {
  if (p.isKeeper === 1) return;
  const sk = chooseSkill(s, p.slot);
  if (!(sk >= SkillMove.BALL_ROLL && sk <= SkillMove.KNOCK_ON) || sk === SkillMove.FAKE_SHOT) return;
  const a = s.attrs[p.slot]!;
  const stars = a.skillMoves;
  if (stars < (T_SKILL.minStars[sk] ?? 99)) return;
  let succ = LT.skillBase + LT.skillPerStar * stars + (LT.skillDribbling * a.dribbling) / 99;
  if (succ > LT.skillMaxSuccess) succ = LT.skillMaxSuccess;
  const nprog = C.prog + LT.skillGain / HALF_LENGTH;
  const raw = succ * posValue(nprog, p.z) - (1 - succ) * lossCost(C.prog, p.z);
  let gain = raw - C.vHere;
  if (gain > 0) gain *= styleMul(sw.dribble);
  noise(s);
  const u = C.vHere + gain + NZ[0]!;
  CU[0] = u; CU[1] = 0; CU[2] = 0;
  consider(CpuPlan.SKILL, -1, MODE_NONE, sk);
}

function shieldOptionInto(s: SimState, p: Readonly<PlayerState>, cur: CpuPlan, age: number): void {
  if (C.nearD > LT.shieldDist) return;
  const str = clamp01(s.attrs[p.slot]!.strength / 99);
  const loss = clamp01((LT.shieldLossWeak + (LT.shieldLossStrong - LT.shieldLossWeak) * str) * (1 + age / LT.shieldAgeRef));
  let u = (1 - loss) * C.vHere * LT.shieldHoldMul - loss * lossCost(C.prog, p.z);
  if (cur === CpuPlan.SHIELD) u += LT.switchMargin;
  noise(s);
  u += NZ[0]!;
  CU[0] = u; CU[1] = 0; CU[2] = 0;
  consider(CpuPlan.SHIELD, -1, MODE_NONE, KickKind.NONE);
}

function clearOptionInto(s: SimState, p: Readonly<PlayerState>): void {
  if (C.prog >= LT.clearProgress || C.nearD > LT.clearPressDist) return;
  let u = LT.clearValue;
  if (inPenaltyArea(p.x, p.z, -C.dir)) u += LT.clearBoxBonus;
  noise(s);
  u += NZ[0]!;
  CU[0] = u; CU[1] = 0; CU[2] = 0;
  consider(CpuPlan.CLEAR, -1, MODE_BUTTON, KickKind.LOB_PASS);
}

/** Score every option and commit to the best (see the header). */
function decide(s: SimState, team: number, brain: CpuBrainState, p: Readonly<PlayerState>, lv: Readonly<LevelParams>,
  sw: Readonly<StyleWeights>): void {
  fillContext(s, team, p, lv, sw);
  BEST.plan = CpuPlan.NONE; BEST.u = -1e18; BEST.slot = -1; BEST.x = 0; BEST.z = 0; BEST.mode = MODE_NONE; BEST.kind = 0;
  const cur = brain.plan;
  const shieldAge = cur === CpuPlan.SHIELD ? brain.planT : 0;
  if (shieldAge >= LT.shieldMaxTicks) {
    // Shielded long enough: rest the shield (failure memory) so another option is played.
    setP1(brain, stepOf(brain), modeOf(brain), startedOf(brain), failMaskOf(brain) | (1 << CpuPlan.SHIELD), LT.shieldRestEvals + 1);
  }
  const evals = failEvalsOf(brain);
  const failMask = evals > 0 ? failMaskOf(brain) : 0;
  passOptionsInto(s, p, sw, failMask);
  if ((failMask & (1 << CpuPlan.SHOOT)) === 0) shotOptionInto(s, p, lv, sw);
  dribbleOptionInto(s, p, sw, cur);
  if ((failMask & (1 << CpuPlan.SKILL)) === 0) skillOptionInto(s, p, sw);
  if ((failMask & (1 << CpuPlan.SHIELD)) === 0) shieldOptionInto(s, p, cur, shieldAge);
  if ((failMask & (1 << CpuPlan.CLEAR)) === 0) clearOptionInto(s, p);
  // The failure memory lasts failEvals decisions.
  const left = evals > 0 ? evals - 1 : 0;
  setP1(brain, stepOf(brain), modeOf(brain), startedOf(brain), left > 0 ? failMaskOf(brain) : 0, left);
  commit(s, team, brain, p, lv);
}

// ---------------------------------------------------------------- commit

function rotateInto(x: number, z: number, ang: number): void {
  // Small-angle rotation (|ang| << 1): first-order with renormalisation; no trig needed for noise.
  const rx = x - z * ang, rz = z + x * ang;
  const l = Math.sqrt(rx * rx + rz * rz);
  DRB.x = l > 1e-9 ? rx / l : x;
  DRB.z = l > 1e-9 ? rz / l : z;
}

function commitKick(brain: CpuBrainState, plan: CpuPlan, mode: number, slot: number, x: number, z: number, btn: number, hold: number): void {
  brain.plan = plan;
  brain.planSlot = slot;
  brain.planX = x;
  brain.planZ = z;
  brain.holdTicks = hold;
  brain.p3 = btn;
  setP1(brain, STEP_AIM, mode, 0, failMaskOf(brain), failEvalsOf(brain));
  brain.planT = 0;
}

function commitShot(s: SimState, team: number, brain: CpuBrainState, p: Readonly<PlayerState>, lv: Readonly<LevelParams>): void {
  const dir = C.dir;
  const gx = dir * HALF_LENGTH;
  const opp = s.teams[team === 0 ? 1 : 0]!;
  const k = opp.keeperSlot;
  let kz = 0, kOff = 0;
  if (validSlot(k) && s.players[k]!.active === 1) {
    const kp = s.players[k]!;
    kz = kp.z;
    kOff = HALF_LENGTH - dir * kp.x;
  }
  let side: number;
  if (kz > LT.keeperSideDead) side = -1;
  else if (kz < -LT.keeperSideDead) side = 1;
  else side = p.z > 0 ? -1 : 1; // far post
  const ex = fin(lv.executionError);
  gauss(s);
  let az = side * (GOAL_HALF_WIDTH - LT.shotInset) + NZ[1]! * LT.aimNoise * ex;
  const lim = GOAL_HALF_WIDTH + 1;
  if (az > lim) az = lim; else if (az < -lim) az = -lim;
  const dx = gx - p.x;
  const dist = Math.sqrt(dx * dx + p.z * p.z);
  const f = clamp01((dist - LT.shotNearDist) / (LT.shotFarDist - LT.shotNearDist));
  gauss(s);
  let power = LT.shotPowerNear + (LT.shotPowerFar - LT.shotPowerNear) * f + NZ[1]! * LT.powerNoise * ex;
  if (power < LT.shotPowerMin) power = LT.shotPowerMin; else if (power > LT.shotPowerMax) power = LT.shotPowerMax;
  let btn: number = Btn.SHOOT;
  const a = s.attrs[p.slot]!;
  if (kOff >= LT.chipKeeperOff && dist >= LT.chipMinDist && dist <= LT.chipMaxDist) btn |= Btn.MOD_L;
  else if (dist >= LT.finesseMinDist && dist <= LT.finesseMaxDist && (p.z > LT.finesseMinAbsZ || p.z < -LT.finesseMinAbsZ) &&
    a.curve >= LT.finesseMinCurve) btn |= Btn.MOD_R;
  commitKick(brain, CpuPlan.SHOOT, MODE_BUTTON, -1, gx, az, btn, holdFor(power, powerFill(s, team)));
}

function commitClear(s: SimState, team: number, brain: CpuBrainState, p: Readonly<PlayerState>, lv: Readonly<LevelParams>): void {
  const side = p.z >= 0 ? 1 : -1;
  const tx = clampTapX(p.x + C.dir * LT.clearDist);
  const tz = clampTapZ(side * LT.clearSide);
  gauss(s);
  const power = LT.clearPower + NZ[1]! * LT.powerNoise * fin(lv.executionError);
  commitKick(brain, CpuPlan.CLEAR, MODE_BUTTON, -1, tx, tz, Btn.LOB, holdFor(power, powerFill(s, team)));
}

function commitPass(s: SimState, team: number, brain: CpuBrainState, p: Readonly<PlayerState>, lv: Readonly<LevelParams>): void {
  const plan = BEST.plan;
  const slot = BEST.slot;
  const q = s.players[slot]!;
  const mode = BEST.mode;
  const ex = fin(lv.executionError);
  if (plan === CpuPlan.THROUGH) {
    gauss(s);
    let tx = BEST.x + NZ[1]! * LT.tapNoise * ex;
    gauss(s);
    const tz = BEST.z + NZ[1]! * LT.tapNoise * ex;
    if (C.dir * (tx - q.x) < LT.throughMinLead) tx = q.x + C.dir * LT.throughMinLead;
    commitKick(brain, plan, mode, slot, clampTapX(tx), clampTapZ(tz), 0, 0);
    return;
  }
  if (plan === CpuPlan.CROSS) {
    commitKick(brain, plan, mode, slot, clampTapX(BEST.x), clampTapZ(BEST.z), 0, 0);
    return;
  }
  if (mode === MODE_BUTTON) {
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    gauss(s);
    let power = LT.drivenPowerBase + LT.drivenPowerPerM * d + NZ[1]! * LT.powerNoise * ex;
    if (power > LT.drivenPowerMax) power = LT.drivenPowerMax;
    commitKick(brain, plan, mode, slot, q.x, q.z, Btn.PASS | Btn.MOD_R, holdFor(power, powerFill(s, team)));
    return;
  }
  // Ground / lofted pass to his feet: the tap is on him (the planned point follows him while aiming).
  commitKick(brain, plan, mode, slot, q.x, q.z, 0, 0);
}

function commitSkill(s: SimState, brain: CpuBrainState, p: Readonly<PlayerState>, lv: Readonly<LevelParams>): void {
  let fx = p.fx, fz = p.fz;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl > 1e-6) { fx /= fl; fz /= fl; } else { fx = C.dir; fz = 0; }
  // Exit on the side away from the nearest opponent (right of facing = (-fz, fx)).
  let side = 1;
  if (C.nearOpp >= 0) {
    const q = s.players[C.nearOpp]!;
    const lat = (q.x - p.x) * -fz + (q.z - p.z) * fx;
    side = lat > 0 ? -1 : 1;
  }
  const ex = -fz * side + fx * LT.skillForward;
  const ez = fx * side + fz * LT.skillForward;
  gauss(s);
  rotateInto(ex, ez, NZ[1]! * LT.dirNoise * fin(lv.executionError));
  brain.plan = CpuPlan.SKILL;
  brain.planSlot = -1;
  brain.planX = DRB.x;
  brain.planZ = DRB.z;
  brain.holdTicks = 0;
  brain.p3 = BEST.kind;
  setP1(brain, STEP_FIRE, MODE_NONE, 0, failMaskOf(brain), failEvalsOf(brain));
  brain.planT = 0;
}

function commitContinuous(brain: CpuBrainState, plan: CpuPlan): void {
  if (brain.plan !== plan) {
    brain.plan = plan;
    brain.planT = 0;
    brain.planSlot = -1;
    brain.holdTicks = 0;
    brain.p3 = 0;
    setP1(brain, STEP_RUN, MODE_NONE, 0, failMaskOf(brain), failEvalsOf(brain));
  }
}

function commit(s: SimState, team: number, brain: CpuBrainState, p: Readonly<PlayerState>, lv: Readonly<LevelParams>): void {
  const plan = BEST.plan;
  brain.p2 = BEST.u > -1e17 ? BEST.u : 0;
  switch (plan) {
    case CpuPlan.DRIBBLE: {
      let dx = BEST.x, dz = BEST.z;
      if (brain.plan === CpuPlan.DRIBBLE) {
        const bx = brain.planX * LT.dirKeep + dx * (1 - LT.dirKeep);
        const bz = brain.planZ * LT.dirKeep + dz * (1 - LT.dirKeep);
        const bl = Math.sqrt(bx * bx + bz * bz);
        if (bl > 0.3) { dx = bx / bl; dz = bz / bl; }
      }
      gauss(s);
      rotateInto(dx, dz, NZ[1]! * LT.dirNoise * fin(lv.executionError));
      commitContinuous(brain, CpuPlan.DRIBBLE);
      brain.planX = DRB.x;
      brain.planZ = DRB.z;
      return;
    }
    case CpuPlan.SHIELD:
      commitContinuous(brain, CpuPlan.SHIELD);
      return;
    case CpuPlan.SHOOT:
      commitShot(s, team, brain, p, lv);
      return;
    case CpuPlan.CLEAR:
      commitClear(s, team, brain, p, lv);
      return;
    case CpuPlan.PASS:
    case CpuPlan.THROUGH:
    case CpuPlan.CROSS:
      commitPass(s, team, brain, p, lv);
      return;
    case CpuPlan.SKILL:
      commitSkill(s, brain, p, lv);
      return;
    default:
      commitContinuous(brain, CpuPlan.HOLD);
      return;
  }
}

// ---------------------------------------------------------------- execution

/** Nearest active opponent distance (for per-tick sprint / aim decisions). Writes C.nearD / C.nearOpp. */
function nearestOpponent(s: SimState, p: Readonly<PlayerState>): void {
  const first = p.team === 0 ? PLAYERS_PER_TEAM : 0;
  let best = 1e18, bi = -1;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; bi = i; }
  }
  C.nearOpp = bi;
  C.nearD = bi >= 0 ? Math.sqrt(best) : 1e9;
}

/** Space to sprint along the unit direction (SV[0], SV[1]): nobody tight, nobody close in the cone ahead, stamina left. */
function canSprint(s: SimState, team: number, p: Readonly<PlayerState>): boolean {
  if (p.isKeeper === 1 || p.stamina <= LT.sprintMinStamina) return false;
  const dx = SV[0]!, dz = SV[1]!;
  const space = LT.sprintSpaceDist * (s.teams[team]!.phase === TeamPhase.TRANSITION_ATTACK ? LT.counterSpaceMul : 1);
  const first = team === 0 ? PLAYERS_PER_TEAM : 0;
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const ox = q.x - p.x, oz = q.z - p.z;
    const d = Math.sqrt(ox * ox + oz * oz);
    if (d <= LT.tightDist) return false;
    if (d <= space && ox * dx + oz * dz >= LT.sprintConeCos * d) return false;
  }
  return true;
}

function runDribble(s: SimState, team: number, brain: CpuBrainState, p: Readonly<PlayerState>, out: InputFrame): void {
  let dx = brain.planX, dz = brain.planZ;
  // Along a line instead of over it.
  const zl = HALF_WIDTH - LT.edgeMargin;
  if ((p.z > zl && dz > 0) || (p.z < -zl && dz < 0)) dz = 0;
  const xl = HALF_LENGTH - LT.edgeMargin;
  if ((p.x > xl && dx > 0) || (p.x < -xl && dx < 0)) {
    dx = 0;
    if (dz === 0) dz = p.z > 0 ? -1 : 1;
  }
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (dl > 1e-6) { dx /= dl; dz /= dl; } else { dx = s.teams[team]!.dir; dz = 0; }
  // Turning: keep the ball (see leashCos).
  let turning = false;
  const b = s.ball;
  const bx = b.x - p.x, bz = b.z - p.z;
  const bd = Math.sqrt(bx * bx + bz * bz);
  if (bd > 1e-6 && (bx * dx + bz * dz) / bd < LT.leashCos) {
    turning = true;
    const v = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    if (bd > T_DRIBBLE.controlRadius + v * LT.reachLookahead + LT.leashMargin) { dx = bx / bd; dz = bz / bd; }
  }
  nearestOpponent(s, p);
  SV[0] = dx; SV[1] = dz;
  const sprint = !turning && canSprint(s, team, p);
  SV[2] = sprint ? 1 : C.nearD <= LT.tightDist ? LT.tightStick : LT.jogStick;
  stickOut(out);
  if (sprint) out.buttons |= Btn.SPRINT;
  brain.planT++;
}

function runSkill(s: SimState, team: number, brain: CpuBrainState, p: Readonly<PlayerState>, out: InputFrame): void {
  const step = stepOf(brain);
  if (step === STEP_FIRE) {
    SV[0] = brain.planX; SV[1] = brain.planZ; SV[2] = 1; stickOut(out);
    if (!readyToAct(p)) {
      brain.planT++;
      if (brain.planT > LT.readyWaitTicks) abortPlan(brain, false);
      return;
    }
    out.skill = brain.p3 as SkillMove;
    setStep(brain, STEP_WAIT);
    return;
  }
  if (p.act === ActionKind.SKILL) {
    markStarted(brain);
    SV[0] = brain.planX; SV[1] = brain.planZ; SV[2] = 1; stickOut(out);
    return;
  }
  if (startedOf(brain) === 1) {
    // Move done: run on along the exit, decide again shortly.
    brain.plan = CpuPlan.DRIBBLE;
    setP1(brain, STEP_RUN, MODE_NONE, 0, failMaskOf(brain), failEvalsOf(brain));
    brain.planT = 0;
    brain.evalT = LT.postSkillEval;
    runDribble(s, team, brain, p, out);
    return;
  }
  brain.planT++;
  if (brain.planT > LT.startTimeoutTicks) abortPlan(brain, true);
}

function runKick(s: SimState, brain: CpuBrainState, p: Readonly<PlayerState>, out: InputFrame): void {
  // A pass to feet follows the receiver while aiming.
  if (brain.plan === CpuPlan.PASS && validSlot(brain.planSlot)) {
    const q = s.players[brain.planSlot]!;
    if (q.active === 1 && q.team === p.team) { brain.planX = q.x; brain.planZ = q.z; }
  }
  const dx = brain.planX - p.x, dz = brain.planZ - p.z;
  let step = stepOf(brain);
  if (step === STEP_AIM) {
    nearestOpponent(s, p);
    const d = Math.sqrt(dx * dx + dz * dz);
    const facing = d > 1e-6 ? (p.fx * dx + p.fz * dz) / d : 1;
    if (facing >= LT.aimCos || brain.planT >= LT.aimMaxTicks || C.nearD <= LT.tightDist) {
      setStep(brain, STEP_FIRE);
      step = STEP_FIRE;
    } else {
      SV[0] = dx; SV[1] = dz; SV[2] = LT.aimStick; stickOut(out);
      brain.planT++;
      return;
    }
  }
  const mode = modeOf(brain);
  if (step === STEP_FIRE) {
    if (!readyToAct(p)) {
      SV[0] = dx; SV[1] = dz; SV[2] = LT.aimStick; stickOut(out);
      brain.planT++;
      if (brain.planT > LT.readyWaitTicks) abortPlan(brain, false);
      return;
    }
    if (mode === MODE_BUTTON) {
      out.buttons |= brain.p3;
      SV[0] = dx; SV[1] = dz; SV[2] = 1; stickOut(out);
      setStep(brain, STEP_HOLD);
      brain.planT = 1;
      return;
    }
    out.gesture = mode === MODE_DTAP ? GestureKind.DOUBLE_TAP : GestureKind.TAP;
    out.gSlot = validSlot(brain.planSlot) ? brain.planSlot : -1;
    out.gx = quantPos(brain.planX);
    out.gz = quantPos(brain.planZ);
    setStep(brain, STEP_WAIT);
    return;
  }
  if (step === STEP_HOLD) {
    if (kickRunning(p)) markStarted(brain);
    if (brain.planT >= brain.holdTicks) {
      // Release this tick (no buttons): the power bar stops at the held time.
      setStep(brain, STEP_WAIT);
      SV[0] = dx; SV[1] = dz; SV[2] = 1; stickOut(out);
      return;
    }
    out.buttons |= brain.p3 & FACE_MASK;
    SV[0] = dx; SV[1] = dz; SV[2] = 1; stickOut(out);
    brain.planT++;
    if (startedOf(brain) === 0 && brain.planT > LT.startTimeoutTicks) abortPlan(brain, true);
    return;
  }
  // STEP_WAIT: the kick is (or should be) running; stick released.
  if (kickRunning(p)) { markStarted(brain); return; }
  if (startedOf(brain) === 1) { abortPlan(brain, false); return; } // ran and the ball is still ours (whiff / fake)
  brain.planT++;
  if (brain.planT > LT.startTimeoutTicks) abortPlan(brain, true);
}

function execute(s: SimState, team: number, brain: CpuBrainState, p: Readonly<PlayerState>, out: InputFrame): void {
  switch (brain.plan) {
    case CpuPlan.DRIBBLE:
      runDribble(s, team, brain, p, out);
      return;
    case CpuPlan.SHIELD:
      out.buttons |= Btn.SHIELD;
      brain.planT++;
      return;
    case CpuPlan.SKILL:
      runSkill(s, team, brain, p, out);
      return;
    case CpuPlan.PASS:
    case CpuPlan.THROUGH:
    case CpuPlan.CROSS:
    case CpuPlan.CLEAR:
    case CpuPlan.SHOOT:
      runKick(s, brain, p, out);
      return;
    default:
      emitCarry(s, p, out);
      brain.planT++;
      return;
  }
}

// ---------------------------------------------------------------- entry

export function cpuCarrier(s: SimState, team: number, out: InputFrame, ev: EventSink): void {
  if (team !== 0 && team !== 1) return;
  const t = s.teams[team]!;
  const brain = t.cpu;
  const b = s.ball;
  const owner = b.owner;
  const fresh = brain.p0 !== s.tick - 1 || brain.seenOwner !== owner;
  brain.p0 = s.tick;
  if (fresh) {
    resetPlan(brain);
    brain.seenOwner = owner;
    brain.evalT = 0;
    brain.reactT = 0;
  }
  // Loose (our pass in flight: the receiver meets it with the stick released) or in a keeper's hands (GKP-04).
  if (!validSlot(owner) || b.heldBy >= 0) return;
  const p = s.players[owner]!;
  if (p.team !== team || p.active !== 1) return;
  const lv = levelParams(brain.level);
  if (fresh) {
    const r = Math.floor(fin(lv.reactionTicks));
    brain.reactT = r > 0 ? r : 0;
  }
  if (brain.reactT > 0) {
    brain.reactT--;
    emitCarry(s, p, out);
    return;
  }
  if (!isOneShot(brain.plan)) {
    if (brain.evalT > 0) brain.evalT--;
    if (brain.evalT <= 0 || brain.plan === CpuPlan.NONE) {
      decide(s, team, brain, p, lv, styleWeights(t.style));
      brain.evalT = T_AI.carrierEvalInterval;
    }
  }
  execute(s, team, brain, p, out);
}
