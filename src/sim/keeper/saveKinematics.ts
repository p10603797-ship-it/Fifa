/**
 * [GKP-02] Save kinematics and the GK_DIVE / GK_CATCH action handlers (helper of saves.ts, owned by GKP-02).
 *
 * Kept apart from saves.ts on purpose: this file imports only contracts and core maths, never the action
 * registry / dispatcher (directly or through keeper/handling.ts). saves.ts imports actions/dispatch, which imports
 * actions/registry, which imports saves.ts back; when saves.ts is the module that enters that cycle the registry
 * would read its handlers before they exist (TDZ in a bundle, `undefined` -> idle under vitest) and keepers would
 * never dive. saves.ts re-exports these handlers FIRST so they are always initialised before the registry runs.
 *
 * Dive kinematics: load (diveWindupTicks; arms go from 50% to 100% extension), then the hip accelerates along the
 * dive line to keeperDiveSpeed(gkDiving) over diveAccelTicks and flies on at that speed for the planned travel; the
 * hands are up to armReach beyond the hip. The touch distance from the dive start is hip travel + hand offset +
 * handRadius + BALL_RADIUS and never exceeds keeperMaxReach(gkDiving).
 * Then the arms stay out for diveStretchTicks, he lies on the ground (diveGround*) and gets up (getUp*): one GK_DIVE
 * action with a fixed actDur, so a dive always ends. The hip is placed directly each tick (velocity 0, LOCKED) so
 * locomotion friction cannot change the reach the decision planned with.
 */
import { BALL_RADIUS, BOARD_X, BOARD_Z, DT, HALF_LENGTH } from '../../contracts/constants';
import { MoveMode, type PlayerAttrs, type SimState } from '../../contracts/state';
import type { ActionHandler } from '../../contracts/systems';
import { T_GK } from '../../contracts/tuning';
import { attr, clamp01, lerp } from '../core/dmath';

export const LOCAL_TUNING = {
  // ---- body geometry (for a 185 cm keeper; scaled by height)
  /** Hip-to-hand-point distance of a stretched diver, m. */
  armReach: 0.95,
  /** Hand / forearm radius of the dive capsule, m (contact when the ball centre is within this + BALL_RADIUS). */
  handRadius: 0.2,
  /** Feet behind the hip along the dive line, m (body part of the dive capsule: blocks only). */
  legLength: 0.9,
  /** Fraction of the dive capsule (feet 0 .. hands 1) from which a contact counts as hands. */
  handsFrom: 0.55,
  /** Hip height of a dive: standing hip, m; blend toward the target height; clamp, m. */
  hipStand: 0.95,
  hipBlend: 0.6,
  hipMin: 0.35,
  hipMax: 1.5,
  /** Standing catch radius around the body axis, m (arms). */
  standArm: 0.6,
  /** Body-only radius for an unready keeper (reflex block), m. */
  bodyRadius: 0.32,
  /** Reach heights as multiples of keeper height (max ball-centre height): standing (small jump), dive near, dive
   *  at full stretch. */
  standTopMul: 1.22,
  diveTopNearMul: 1.32,
  diveTopFarMul: 1.16,
  // ---- dive timing
  /** Load / push-off ticks before the hip moves (arms extend 50% -> 100% meanwhile). */
  diveWindupTicks: 6,
  /** Ticks for the hip to accelerate from rest to the dive speed (uniform acceleration). */
  diveAccelTicks: 12,
  /** Ticks the arms stay stretched (contact active) after full extension. */
  diveStretchTicks: 8,
  /** Ticks on the ground after a low / mid / high dive. */
  diveGroundLow: 10,
  diveGroundMid: 14,
  diveGroundHigh: 20,
  /** Get-up ticks at gkDiving 99 / 1. */
  getUpBest: 14,
  getUpWorst: 26,
  /** Hands aim this far past the ball's lateral position, m. */
  diveOvershoot: 0.25,
  /** Shortest hip-to-hand offset of a dive (a leap for a ball right above him), m. */
  minHandOffset: 0.3,
  /** Height classes (actA) by target ball-centre height, m. */
  lowMax: 0.6,
  midMax: 1.5,
  // ---- standing / set position
  /** Step allowance of a standing save: fraction of the keeper's acceleration assumed (arrival steering is not a
   *  straight sprint), cap m, setup ticks. */
  stepAccelFrac: 0.6,
  stepMax: 0.8,
  stepSetupTicks: 3,
  /** GK_CATCH movement speed toward the save spot, m/s. */
  setMoveSpeed: 5,
  /** GK_CATCH lasts this many ticks past the planned arrival. */
  catchPostTicks: 10,
  /** Ready stance (GK_CATCH, feet planted) taken while a goal-bound ball has not been reacted to yet, ticks
   *  (renewed every tick until he reacts). */
  setHoldTicks: 4,
  /** Commit a dive when (ticks until the ball arrives) - (ticks the hands need) <= this. */
  commitSlackTicks: 2,
  // ---- perception
  /** Screening: radius around the sight line m, extra reaction ticks per screening player, max players counted. */
  screenRadius: 0.7,
  screenTicks: 4,
  screenMax: 2,
  /** Threat filter: min speed toward the goal m/s, max distance from the goal line m, lateral pre-filter margin m. */
  threatMinSpeed: 5,
  threatMaxDist: 45,
  threatLateralMargin: 8,
  /** Margin around the goal mouth that still counts as "going in" for the prediction, m. */
  mouthMargin: 0.1,
  /** Predicted samples this far behind the keeper's plane still count, m; a ball further behind has passed him. */
  planeBackReach: 0.5,
  /** Prediction horizon: extra ticks over the straight-line time, and the time multiplier for deceleration. */
  predictExtraTicks: 12,
  predictTimeMul: 1.4,
  /** Despairing dive: only when the closest approach is within maxReach * this and within this many ticks. */
  hopelessReachMul: 1.6,
  hopelessMaxTicks: 40,
  /** Extra height allowed for a despairing dive over diveTopNear, m. */
  hopelessHeightSlack: 0.3,
  /** The keeper's body stays at least this far in front of his goal line, m. */
  minDepth: 0.15,
  // ---- contact
  /** Unready (reflex) blocks: min speed toward the goal m/s, look-ahead s, mouth margin m. */
  reflexMinSpeed: 6,
  reflexHorizon: 2,
  reflexMouthMargin: 1,
  /** No new keeper contact within this many ticks of his own last touch. */
  recontactTicks: 12,
  /** Catch speed multiplier of T_GK.catchSpeed at gkHandling 1 / 99. */
  catchMulWorst: 0.9,
  catchMulBest: 1.5,
  /** Catch limit cut at full stretch (fraction) and above head height (fraction, height m). */
  stretchCatchPenalty: 0.35,
  highCatchPenalty: 0.15,
  headHeight: 1.9,
  /** Tip over: contact at or above GOAL_HEIGHT - tipBand (m), within tipMaxDepth m of the line, ball faster than
   *  tipMinSpeed (m/s). */
  tipBand: 0.4,
  tipMaxDepth: 5,
  tipMinSpeed: 8,
  /** Tip over: speed toward the goal after the tip (min m/s, fraction of incoming), ball-centre height to clear at
   *  the line (m), max lift (m/s). */
  tipGoalwardMin: 3,
  tipGoalwardFrac: 0.35,
  tipClearHeight: 2.8,
  tipMaxLift: 12,
  /** Parry: speed fraction poor/good, angle off the outward axis poor/good (rad), noise (rad), lift poor/good (m/s). */
  parryRestPoor: 0.3,
  parryRestGood: 0.42,
  parryAnglePoor: 0.15,
  parryAngleGood: 1.2,
  parryNoise: 0.15,
  parryLiftPoor: 0.8,
  parryLiftGood: 4,
  parryHighLift: 1,
  parryStretchPenalty: 0.35,
  parryMinSpeed: 3,
  /** Contact z within this of the goal centre: parry side from the dive / ball direction, m. */
  parryCentreBand: 0.3,
  /** Body block: normal restitution, tangential speed kept, goal-ward speed kept when bouncing toward goal. */
  blockRestitution: 0.3,
  blockTangential: 0.5,
  blockGoalwardKeep: 0.3,
} as const; // TUNING-CR

const L = LOCAL_TUNING;
/** Ball-centre distance from the hand point that still touches: hand radius + ball radius, m. */
export const CAP_TOL = L.handRadius + BALL_RADIUS;
const EPS = 1e-9;
/** "Never" in ticks. */
export const NEVER = 1e9;

// ---------------------------------------------------------------- attribute-derived kinematics (pure)

/** Keeper height in metres (falls back to 1.85 for bad data). */
export function heightM(a: Readonly<PlayerAttrs>): number {
  const h = a.height;
  return h > 100 && h < 250 ? h / 100 : 1.85;
}

/** Base reaction delay (ticks) from gkReflexes (T_GK.reactWorst .. reactBest). */
export function keeperReactTicks(a: Readonly<PlayerAttrs>): number {
  return Math.round(attr(a.gkReflexes, T_GK.reactWorst, T_GK.reactBest));
}

/** Dive (hip launch) speed m/s from gkDiving (T_GK.diveSpeedWorst .. diveSpeedBest). */
export function keeperDiveSpeed(a: Readonly<PlayerAttrs>): number {
  return attr(a.gkDiving, T_GK.diveSpeedWorst, T_GK.diveSpeedBest);
}

/** Max horizontal distance from the dive start at which the keeper can touch the ball centre, m (T_GK.reach*). */
export function keeperMaxReach(a: Readonly<PlayerAttrs>): number {
  return attr(a.gkDiving, T_GK.reachWorst, T_GK.reachBest);
}

/** Hip-to-hand-point distance of a stretched dive, m (scaled by height). */
export function armReach(a: Readonly<PlayerAttrs>): number {
  return (L.armReach * heightM(a)) / 1.85;
}

/** Max hip travel of a dive, m. */
export function maxTravel(a: Readonly<PlayerAttrs>): number {
  const m = keeperMaxReach(a) - armReach(a) - CAP_TOL;
  return m > 0 ? m : 0;
}

/** Arm extension 0.5..1 at dive tick t (actT). */
export function armExt(t: number): number {
  return t >= L.diveWindupTicks ? 1 : 0.5 + (0.5 * t) / L.diveWindupTicks;
}

/** Hip travel (m) after `fly` ticks of flight (accelerating over diveAccelTicks, then at the dive speed). */
function flightDistance(a: Readonly<PlayerAttrs>, fly: number): number {
  if (fly <= 0) return 0;
  const step = keeperDiveSpeed(a) * DT;
  const acc = L.diveAccelTicks;
  return fly <= acc ? (step * fly * fly) / (2 * acc) : step * (fly - 0.5 * acc);
}

/**
 * Attribute-derived constants of one keeper, so per-sample planning does not recompute them (single source of truth:
 * the attribute-taking functions below go through it too). Plain numbers; module scratch, never sim state.
 */
export interface KeeperKin {
  /** Max reach m, hip-to-hand offset m, max hip travel m, hip speed per tick m, height m, acceleration m/s^2. */
  reach: number; ar: number; mt: number; step: number; h: number; accel: number;
}
export function createKeeperKin(): KeeperKin {
  return { reach: 0, ar: 0, mt: 0, step: 0, h: 0, accel: 0 };
}
/** Fill k from the keeper's attributes; returns k. */
export function loadKeeperKin(a: Readonly<PlayerAttrs>, k: KeeperKin): KeeperKin {
  k.reach = keeperMaxReach(a);
  k.ar = armReach(a);
  const mt = k.reach - k.ar - CAP_TOL;
  k.mt = mt > 0 ? mt : 0;
  k.step = keeperDiveSpeed(a) * DT;
  k.h = heightM(a);
  k.accel = a.accel;
  return k;
}
const KIN = createKeeperKin();

/** Flight ticks (>= 0) the hip needs to travel x metres. */
export function kinFlightTicks(k: Readonly<KeeperKin>, x: number): number {
  if (x <= 0) return 0;
  const acc = L.diveAccelTicks;
  const xa = 0.5 * k.step * acc;
  if (x <= xa) return Math.ceil(Math.sqrt((2 * acc * x) / k.step) - EPS);
  return acc + Math.ceil((x - xa) / k.step - EPS);
}
export function flightTicks(a: Readonly<PlayerAttrs>, x: number): number {
  return kinFlightTicks(loadKeeperKin(a, KIN), x);
}

/** Planned hip travel (m) of a dive whose target is d metres (horizontal) from the dive start. */
export function diveTravelFor(a: Readonly<PlayerAttrs>, d: number): number {
  const t = d + L.diveOvershoot - armReach(a) - CAP_TOL;
  const mt = maxTravel(a);
  return t <= 0 ? 0 : t < mt ? t : mt;
}

/** Hip-to-hand offset (m) at full extension of a dive whose target is d metres from the dive start. */
export function diveHandOffset(a: Readonly<PlayerAttrs>, d: number): number {
  const ar = armReach(a);
  const h = d + L.diveOvershoot - diveTravelFor(a, d) - CAP_TOL;
  return h <= L.minHandOffset ? L.minHandOffset : h < ar ? h : ar;
}

/** Target distance (m) of a dive from its action fields (actPower = target distance / max reach). */
export function diveTargetDist(a: Readonly<PlayerAttrs>, actPower: number): number {
  return clamp01(actPower) * keeperMaxReach(a);
}

/** Hip travel (m) at dive tick t (actT) for a planned travel. */
export function hipTravel(a: Readonly<PlayerAttrs>, t: number, planned: number): number {
  const d = flightDistance(a, t - L.diveWindupTicks);
  return d < planned ? d : planned;
}

/**
 * Ticks (>= 1, counted like actT, i.e. the tick the dive starts is 1) until a dive started now brings the keeper's
 * touch distance to d metres; NEVER when d is beyond his max reach.
 */
export function kinDiveTicks(k: Readonly<KeeperKin>, d: number): number {
  if (d > k.reach) return NEVER;
  const w = L.diveWindupTicks;
  if (d <= k.ar + CAP_TOL) {
    // Arms only: armExt(t) * ar + CAP_TOL >= d.
    const f = (d - CAP_TOL) / k.ar;
    if (f <= 0.5 + 0.5 / w) return 1;
    const t = Math.ceil(2 * w * (f - 0.5) - EPS);
    return t < 1 ? 1 : t > w ? w : t;
  }
  return w + kinFlightTicks(k, d - k.ar - CAP_TOL);
}
export function keeperDiveTicks(a: Readonly<PlayerAttrs>, d: number): number {
  return kinDiveTicks(loadKeeperKin(a, KIN), d);
}

/** Highest ball-centre height a standing keeper reaches (arms up, small jump), m. */
export function standTop(a: Readonly<PlayerAttrs>): number {
  return heightM(a) * L.standTopMul;
}

/** Lowest / highest point of the standing catch capsule axis, m (radius standArm; top of reach = standTop). */
export const STAND_AXIS_LOW = 0.25;
export function standAxisTop(a: Readonly<PlayerAttrs>): number {
  const top = standTop(a) - L.standArm - BALL_RADIUS;
  return top > STAND_AXIS_LOW ? top : STAND_AXIS_LOW;
}

/** Highest ball-centre height a diving keeper reaches at horizontal distance d from the dive start, m. */
export function kinDiveTop(k: Readonly<KeeperKin>, d: number): number {
  const f = k.mt > EPS ? clamp01((d - k.ar - CAP_TOL) / k.mt) : 0;
  return lerp(k.h * L.diveTopNearMul, k.h * L.diveTopFarMul, f);
}
export function diveTop(a: Readonly<PlayerAttrs>, d: number): number {
  return kinDiveTop(loadKeeperKin(a, KIN), d);
}

/** Standing save reach (ball-centre distance from the body axis) for a ball arriving in t ticks, m. */
export function kinStandReach(k: Readonly<KeeperKin>, t: number): number {
  const tau = (t - L.stepSetupTicks) * DT;
  let step = tau > 0 ? 0.5 * L.stepAccelFrac * k.accel * tau * tau : 0;
  if (!(step < L.stepMax)) step = L.stepMax;
  return L.standArm + BALL_RADIUS + step;
}
export function standReach(a: Readonly<PlayerAttrs>, t: number): number {
  return kinStandReach(loadKeeperKin(a, KIN), t);
}

/** Get-up ticks after a dive (gkDiving). */
export function getUpTicks(a: Readonly<PlayerAttrs>): number {
  return Math.round(attr(a.gkDiving, L.getUpWorst, L.getUpBest));
}

/** Distance (m) of x from the goal line of a team attacking toward dir, positive into the field. */
export function depthOf(dir: number, x: number): number {
  return dir * x + HALF_LENGTH;
}

/** x at a depth u from the goal line of a team attacking toward dir. */
export function xOfDepth(dir: number, u: number): number {
  return dir * (u - HALF_LENGTH);
}

// ---------------------------------------------------------------- handlers

function settle(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  p.lookAt = 0;
  p.wantSprint = 0;
  p.ix = 0; p.iz = 0;
  if (p.moveMode === MoveMode.LOCKED || p.moveMode === MoveMode.ARRIVE) p.moveMode = MoveMode.STOP;
}

/** GK_DIVE: place the hip on the dive line (never behind the goal line or past the boards). */
export const diveHandler: ActionHandler = {
  update(s, slot, ev) {
    const p = s.players[slot]!;
    const a = s.attrs[slot]!;
    const dir = s.teams[p.team]!.dir;
    const travel = hipTravel(a, p.actT, diveTravelFor(a, diveTargetDist(a, p.actPower)));
    let x = p.actX + p.actDirX * travel;
    let z = p.actZ + p.actDirZ * travel;
    if (depthOf(dir, x) < L.minDepth) x = xOfDepth(dir, L.minDepth);
    if (x > BOARD_X) x = BOARD_X; else if (x < -BOARD_X) x = -BOARD_X;
    if (z > BOARD_Z) z = BOARD_Z; else if (z < -BOARD_Z) z = -BOARD_Z;
    if (x - x === 0 && z - z === 0) { p.x = x; p.z = z; }
    p.vx = 0; p.vz = 0; p.ix = 0; p.iz = 0;
    p.moveMode = MoveMode.LOCKED;
    p.lookAt = 0;
    p.wantSprint = 0;
  },
  end(s, slot, interrupted) {
    const p = s.players[slot]!;
    p.vx = 0; p.vz = 0;
    settle(s, slot);
  },
};

/** GK_CATCH: step to the save spot (arrival steering) facing the ball; stand still once he has played it. */
export const catchHandler: ActionHandler = {
  update(s, slot, ev) {
    const p = s.players[slot]!;
    const b = s.ball;
    p.lookAt = 1;
    p.lookX = b.x;
    p.lookZ = b.z;
    p.wantSprint = 0;
    if (p.actDone === 1) {
      p.moveMode = MoveMode.STOP;
      return;
    }
    p.moveMode = MoveMode.ARRIVE;
    p.tgtX = p.actX;
    p.tgtZ = p.actZ;
    p.tgtSpeed = L.setMoveSpeed;
  },
  end(s, slot, interrupted) { settle(s, slot); },
};
