/**
 * [GFX-12] Animation mapping and blending from sim state (ARCHITECTURE rule 3: animation is derived from sim state
 * and never feeds back; nothing here writes sim state). Section 8: run cycles advance with distance travelled so feet
 * do not slide; poses blend; the kicking foot meets the ball on the contact tick. Consumed by the player model
 * (GFX-07) through a PoseDriver.
 *
 * TWO ENTRY POINTS
 *  - createAnimDriver() / createAnimator(): the full per-frame driver for 22 players (PoseDriver shape: (frame, sink)).
 *    Per slot: clip choice (chooseClip), interpolated action phase, distance-driven stride cycle (reset-safe on
 *    teleports above LOCAL_TUNING.teleportDist), turn lean from the smoothed yaw rate, breathing, upper-body
 *    layering over locomotion, short cross-fades on clip changes (per-joint pose lerp, smoothstep weight), then
 *    sink.setPose. Allocation-free per frame.
 *  - The Wave 0 stub API kept for the model's default driver: mapAnim / advanceCycle / samplePose / poseFnFor with
 *    AnimSample / AnimBank. Same mapping; when called per slot in that order with a bank from createAnimBank it also
 *    keeps hysteresis / foot memory and cross-fades clip changes (timed in sim ticks); no alpha term in the action
 *    phase and no turn lean (no frame time / yaw rate in that API). Prefer createAnimDriver.
 *
 * ACTION PHASE (actionPhase): u = p.actT + alpha (interpolated action time; the frame that shows the ball still at the
 * foot is the one where u = actContact, because the sim launches and moves the ball on the contact tick). The clip
 * phase is piecewise linear: [0, actContact] -> [0, cf] and [actContact, actDur] -> [cf, 1], cf = the clip's
 * contact fraction (ACTION_CONTACT / CONTACT_CONTACT), so t = cf exactly at the contact tick for any wind-up length.
 * A charged kick (p.actCharging) winds up to the clip's backswing top (ACTION_HOLD) and holds there until release.
 *
 * MAPPING (ActionKind -> AnimId): NONE / SET_PIECE / GK_RUSH -> locomotion (IDLE / JOG / SPRINT / TURN_LEAN /
 * STRAFE / JOCKEY / SHIELD / KEEPER_READY from speed, sprinting / jockeying / shielding flags, movement vs facing,
 * keeper in play) or KEEPER_HOLD when the keeper has the ball in his hands; KICK / SHOT by actKick (pass, shot,
 * power shot, finesse, chip -> pass, volley / header shots); HEADER, VOLLEY, FIRST_TOUCH, SKILL / FAKE -> SKILL;
 * tackles; SLIDE_TACKLE -> SLIDE; STUMBLE; FALLEN -> FALL; GET_UP; GK_DIVE -> DIVE_{LOW,MID,HIGH}_{L,R} by actA / actB;
 * GK_HOLD; GK_THROW (roll / release -> underarm); GK_KICK; GK_PUNCH -> PARRY; GK_CATCH -> CATCH (set or done) or the
 * keeper stance; THROW_IN (hold pose until the throw); CELEBRATE -> CELEBRATE_1..3 by actA; DEJECTED -> DEJECTION;
 * WALL_JUMP (brace / jump; charge runs); SHIELD. See ACTION_ANIM for the default per kind.
 *
 * CLIP PARAMETERS passed to the pose functions: see locomotion.ts (t = breathing phase or movement direction for the
 * locomotion clips, side = yaw rate for TURN_LEAN / arm side for SHIELD) and actions.ts (foot 0 right / 1 left).
 */

import { NUM_SLOTS } from '../../contracts/constants';
import { ActionKind, KickKind, MatchPhase } from '../../contracts/enums';
import { T_DRIBBLE, T_TOUCH } from '../../contracts/tuning';
import { AnimId, createPose, POSE_SIZE, type Pose, type PoseFn } from '../../contracts/render';
import type { ReadonlySimState } from '../../contracts/state';
import type { RenderFrame } from '../types';
import { ACTION_CONTACT, ACTION_HOLD, ACTION_IMPLS, ACTION_POSES } from './actions';
import { celebrationAnim, CONTACT_CONTACT, CONTACT_IMPLS, CONTACT_POSES, diveAnim } from './contact';
import {
  applyBreathS, applyTurnLeanS, BRA, isLocomotion, LOCOMOTION_IMPLS, LOCOMOTION_POSES, LOCOMOTION_TUNING, LOWER_BODY,
  neutralPose, PP, SLEN, strideLengthForS, TLA, type PoseImpl,
} from './locomotion';
import { TAU } from './poseMath';
import { kickReach, nearerLeg, RCH, REACH_SWITCH, reachClip, touchNeed, touchReach } from './reach';

const LOCAL_TUNING = { // TUNING-CR (render-only animation constants)
  /** Idle below / locomotion above these speeds (m/s, hysteresis). */
  idleEnter: 0.25,
  idleLeave: 0.5,
  /** Moving this far off the facing (rad) switches to STRAFE (enter / leave), only up to strafeMaxSpeed (m/s). */
  strafeEnter: 0.75,
  strafeLeave: 0.55,
  strafeMaxSpeed: 3.2,
  /** Interpolated travel above this in one frame is a teleport: no stride advance, no cross-fade (m). */
  teleportDist: 3,
  /** Cross-fade times (s): locomotion <-> locomotion, into / out of actions, dives, in-clip jumps. */
  blendLoco: 0.2,
  blendAction: 0.12,
  blendDive: 0.07,
  blendJump: 0.06,
  /** A cross-fade into a clip with a pending contact ends by this fraction of the time left to the contact. */
  blendBeforeContact: 0.75,
  /** Yaw-rate smoothing time constant (s) and the lean (rad) that reports TURN_LEAN (enter / leave). */
  yawRateTau: 0.12,
  leanEnter: 0.12,
  leanLeave: 0.07,
  /** Upper-body clips keep the clip's legs below / take the locomotion legs above (m/s, smoothstep). */
  layerFrom: 0.4,
  layerTo: 1.3,
  /** Breathing period (s). */
  breathPeriod: 3.6,
  /** A keeper in play takes the ready stance while the ball is within this distance (m) and he is slower (m/s). */
  keeperReadyDist: 40,
  keeperReadyMaxSpeed: 4.5,
  /** Weak foot used when the ball sits this far (m) to that side at the start of a kick. */
  weakFootSide: 0.2,
  /** A clip phase jumping forward by more than this in one frame (or backward) re-blends briefly. */
  phaseJump: 0.2,
  // ---- ball contact [QF-4] (reach.ts)
  /** Foot kicks: the reach toward the predicted ball fades in from reachLeadTicks before the contact tick (from the
   *  start of a shorter wind-up) to reachFullTicks before it, and out over reachTailTicks after it. */
  reachLeadTicks: 8,
  reachFullTicks: 2.5,
  reachTailTicks: 8,
  /** Dribble: the owner's run cycle is phase-aligned so a foot comes through just before the next touch the sim has
   *  scheduled (touchCd, or when he closes on the ball), within this stride-rate factor range; touchLead = phase (rad)
   *  before touchdown the touch is aimed at. */
  alignMin: 0.78,
  alignMax: 1.3,
  touchLead: 0.25,
  /** Touch reach (dribble touches, first touches): fades in over the last touchIn s before a predicted touch, peaks on
   *  the touch frame and fades over touchOut s after it. Below alignMinSpeed (m/s) there is no phase alignment. */
  touchIn: 0.08,
  touchOut: 0.12,
  /** A touch reaches in at once when the foot has to move at most touchStepMax (m) this frame, else over more frames
   *  (weight step = touchStepMax / distance), so the foot never pops; touchSnapStep is the weight step of the
   *  scheduled fade-ins. */
  touchSnapStep: 0.5,
  touchStepMax: 0.34,
  /** The predicted ball a kick reaches for moves at most this far per 60 Hz frame (m). */
  kickTargetStep: 0.12,
  /** Fastest an action clip's phase advances after its contact (phase per second): ~0.34 s for a whole follow-through. */
  followRate: 1.6,
  alignMinSpeed: 1.2,
  /** Height scale clamp of the player model (players/model.ts minScale / maxScale). */
  minScale: 0.85,
  maxScale: 1.2,
} as const;

/** Exposed for tests / tools. */
export const MAPPER_TUNING = LOCAL_TUNING;

/** SIM-06's reach lookahead (sim/players/possession.ts LOCAL_TUNING.reachLookahead, s): a running owner touches a ball
 *  up to T_DRIBBLE.controlRadius + speed x this from his feet. Mirrored here (render must not import sim modules). */
const DRIBBLE_REACH_LOOKAHEAD = 0.08;

// ============================================================ stub API types (kept from Wave 0)

/** Clip choice for one player this frame. Reused; never allocate per frame. */
export interface AnimSample {
  anim: AnimId;
  /** Normalised phase 0..1 for action clips (direction / breathing phase for locomotion clips). */
  t: number;
  /** -1 / +1 mirror for sided clips (yaw rate for TURN_LEAN). */
  side: number;
  /** 0 right foot, 1 left foot. */
  foot: number;
}

export function createAnimSample(): AnimSample {
  return { anim: AnimId.IDLE, t: 0, side: 1, foot: 0 };
}

/** Per-player animation memory (stride cycles, current clip, blend). Owned by the model, advanced by GFX-12. */
export interface AnimBank {
  /** Stride phase per slot (radians), advanced by distance travelled. */
  cycle: Float32Array;
  /** Current clip per slot. */
  anim: Uint8Array;
  /** Blend weight toward the current clip, 0..1. */
  blend: Float32Array;
  /**
   * Internal: cross-fade / hysteresis state used when the bank drives the stub path (advanceCycle -> mapAnim ->
   * samplePose per slot, the model's default driver). Created by createAnimBank; treat as opaque.
   */
  readonly stub?: unknown;
}

export function createAnimBank(): AnimBank {
  return {
    cycle: new Float32Array(NUM_SLOTS), anim: new Uint8Array(NUM_SLOTS), blend: new Float32Array(NUM_SLOTS).fill(1),
    stub: createStubState(),
  };
}

/** Stub-path blending state (one per bank). */
interface StubState {
  mem: SlotMemory;
  last: Pose[];
  from: Pose[];
  layer: Pose;
  startTick: Float64Array;
  dur: Float32Array;
  seen: Uint8Array;
}

function createStubState(): StubState {
  const last: Pose[] = [], from: Pose[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) { last.push(createPose()); from.push(createPose()); }
  return {
    mem: createSlotMemory(), last, from, layer: createPose(), startTick: new Float64Array(NUM_SLOTS),
    dur: new Float32Array(NUM_SLOTS), seen: new Uint8Array(NUM_SLOTS),
  };
}

/**
 * Stub-path pairing: the bank / slot of the last advanceCycle, then what mapAnim saw for that slot (consumed by the
 * next samplePose). The model's default driver calls advanceCycle, mapAnim and samplePose per slot in that order;
 * any other order simply skips the blending (plain clip poses).
 */
const STUB_CUR = {
  bank: null as AnimBank | null, slot: -1, mapped: -1, tick: 0, prevAct: 0, prevActT: 0, act: 0, actT: 0, contact: -1,
  done: 0, kick: 0,
};

/** Stride length per full cycle (m) at a jog (stub fallback; the cycle uses locomotion.strideLengthFor). */
export const STRIDE_LENGTH = 2.6;

/** Speed / locomotion clip per slot seen by the last mapAnim (stub path: advanceCycle runs before mapAnim). */
const STUB_SPEED = new Float32Array(NUM_SLOTS);
const STUB_ANIM = new Uint8Array(NUM_SLOTS);

/**
 * Advance a slot's stride cycle by the distance moved this frame (m): 2 PI * distance / stride, with the stride of
 * the slot's locomotion clip at its speed (as last seen by mapAnim). Teleport filtering is the caller's job.
 */
export function advanceCycle(bank: AnimBank, slot: number, distance: number): void {
  // Tiny wrapper (inlined into the caller, so the double never crosses a call boundary); the work is in the S form.
  STUB_ARGS[0] = distance;
  advanceCycleS(bank, slot);
}

/** Stub API arguments: [0] advanceCycle distance, [1] mapAnim speed. */
const STUB_ARGS = new Float64Array(2);

function advanceCycleS(bank: AnimBank, slot: number): void {
  const distance = STUB_ARGS[0]!;
  if (!(slot >= 0 && slot < NUM_SLOTS)) return;
  STUB_CUR.bank = bank;
  STUB_CUR.slot = slot;
  STUB_CUR.mapped = -1;
  const d = distance > 0 && distance < 1e3 ? distance : 0;
  SLEN[0] = STUB_SPEED[slot]!;
  strideLengthForS(STUB_ANIM[slot] as AnimId);
  let c = bank.cycle[slot]! + (d / SLEN[1]!) * TAU;
  if (!(c === c)) c = 0;
  if (c >= TAU || c < 0) c -= TAU * Math.floor(c / TAU);
  bank.cycle[slot] = c >= TAU ? 0 : c;
}

// ============================================================ clip choice

/** Default clip per ActionKind (refined by chooseClip for kicks, dives, celebrations, keeper catches, wall). */
export const ACTION_ANIM: readonly AnimId[] = (() => {
  const a: AnimId[] = [];
  for (let i = 0; i <= ActionKind.SHIELD; i++) a[i] = AnimId.IDLE;
  a[ActionKind.KICK] = AnimId.PASS;
  a[ActionKind.SHOT] = AnimId.SHOT;
  a[ActionKind.HEADER] = AnimId.HEADER;
  a[ActionKind.VOLLEY] = AnimId.VOLLEY;
  a[ActionKind.FIRST_TOUCH] = AnimId.FIRST_TOUCH;
  a[ActionKind.SKILL] = AnimId.SKILL;
  a[ActionKind.FAKE] = AnimId.SKILL;
  a[ActionKind.STAND_TACKLE] = AnimId.STAND_TACKLE;
  a[ActionKind.HARD_TACKLE] = AnimId.STAND_TACKLE;
  a[ActionKind.SLIDE_TACKLE] = AnimId.SLIDE;
  a[ActionKind.SHOULDER] = AnimId.STAND_TACKLE;
  a[ActionKind.PUSH_PULL] = AnimId.STAND_TACKLE;
  a[ActionKind.STUMBLE] = AnimId.STUMBLE;
  a[ActionKind.FALLEN] = AnimId.FALL;
  a[ActionKind.GET_UP] = AnimId.GET_UP;
  a[ActionKind.GK_DIVE] = AnimId.DIVE_MID_R;
  a[ActionKind.GK_HOLD] = AnimId.KEEPER_HOLD;
  a[ActionKind.GK_THROW] = AnimId.GK_THROW;
  a[ActionKind.GK_KICK] = AnimId.GK_KICK;
  a[ActionKind.GK_RUSH] = AnimId.SPRINT;
  a[ActionKind.GK_PUNCH] = AnimId.PARRY;
  a[ActionKind.GK_CATCH] = AnimId.CATCH;
  a[ActionKind.THROW_IN] = AnimId.THROW_IN;
  a[ActionKind.SET_PIECE] = AnimId.IDLE;
  a[ActionKind.CELEBRATE] = AnimId.CELEBRATE_1;
  a[ActionKind.DEJECTED] = AnimId.DEJECTION;
  a[ActionKind.WALL_JUMP] = AnimId.WALL_JUMP;
  a[ActionKind.SHIELD] = AnimId.SHIELD;
  return a;
})();

/** Foot-kick clip for a KICK action's kick kind. */
export function kickAnim(kind: KickKind): AnimId {
  switch (kind) {
    case KickKind.DRIVEN_PASS: case KickKind.LOB_PASS: case KickKind.HIGH_LOB: case KickKind.DRIVEN_LOB:
    case KickKind.CROSS: case KickKind.LOW_CROSS: case KickKind.THROUGH_LOBBED: case KickKind.CLEARANCE:
      return AnimId.SHOT;
    case KickKind.VOLLEY_PASS: case KickKind.VOLLEY_SHOT: return AnimId.VOLLEY;
    case KickKind.HEADER_PASS: case KickKind.HEADER_SHOT: return AnimId.HEADER;
    default: return AnimId.PASS;
  }
}

/** Shot clip for a SHOT action's kick kind. */
export function shotAnim(kind: KickKind): AnimId {
  switch (kind) {
    case KickKind.SHOT_POWER: return AnimId.POWER_SHOT;
    case KickKind.SHOT_FINESSE: return AnimId.FINESSE;
    case KickKind.SHOT_CHIP: return AnimId.PASS;
    case KickKind.VOLLEY_SHOT: case KickKind.VOLLEY_PASS: return AnimId.VOLLEY;
    case KickKind.HEADER_SHOT: case KickKind.HEADER_PASS: return AnimId.HEADER;
    default: return AnimId.SHOT;
  }
}

/** Contact fraction of a clip (-1 when it has none). */
export function contactFractionFor(anim: AnimId): number {
  const a = ACTION_CONTACT[anim];
  if (a !== undefined) return a;
  const c = CONTACT_CONTACT[anim];
  return c !== undefined ? c : -1;
}

const HOLD_TABLE = new Float32Array(AnimId.STRAFE + 1).fill(-1);
const CF_TABLE = new Float32Array(AnimId.STRAFE + 1).fill(-1);
for (let i = 0; i <= AnimId.STRAFE; i++) {
  const h = ACTION_HOLD[i as AnimId];
  if (h !== undefined) HOLD_TABLE[i] = h;
  CF_TABLE[i] = contactFractionFor(i as AnimId);
}

/**
 * Clip phase from the interpolated action time u = actT + alpha (ticks). Piecewise linear so t = cf at u = contact.
 * kick = 1 for foot kicks / headers / volleys (charging and pending-contact rules apply).
 */
export function actionPhase(u: number, contact: number, dur: number, cf: number, kick: number, done: number, charging: number, hold: number): number {
  APA[0] = u; APA[1] = contact; APA[2] = dur; APA[3] = cf; APA[4] = kick; APA[5] = done; APA[6] = charging; APA[7] = hold;
  actionPhaseS();
  return APA[8]!;
}

/** actionPhase with its arguments in APA[0..7] and the result in APA[8] (allocation-free internal form). */
const APA = new Float64Array(9);
function actionPhaseS(): void {
  let u = APA[0]!;
  const contact = APA[1]!, dur = APA[2]!, cf = APA[3]!, kick = APA[4]!, done = APA[5]!, charging = APA[6]!, hold = APA[7]!;
  let t: number;
  if (!(dur > 0)) t = 0;
  else {
    if (!(u > 0)) u = 0;
    if (contact < 0 || cf < 0) t = u >= dur ? 1 : u / dur;
    else if (kick === 1 && done === 0 && charging === 1 && hold >= 0) t = contact > 0 ? hold * (u < contact ? u / contact : 1) : hold;
    else if (kick === 1 && done === 0 && u >= contact) t = cf;
    else if (u <= contact) t = contact > 0 ? cf * (u / contact) : cf;
    else {
      const rest = dur - contact;
      if (!(rest > 0)) t = 1;
      else { const k = (u - contact) / rest; t = cf + (1 - cf) * (k < 1 ? k : 1); }
    }
  }
  APA[8] = t;
}

/** Clips that are upper-body actions layered over the locomotion legs while the player moves. */
function isUpperLayer(anim: AnimId): boolean {
  return anim === AnimId.KEEPER_HOLD || anim === AnimId.CATCH || anim === AnimId.CELEBRATE_2 || anim === AnimId.CELEBRATE_3
    || anim === AnimId.DEJECTION || anim === AnimId.STUMBLE;
}

/** Memory a stateful caller (the animator) keeps per slot for hysteresis and per-action choices. */
interface SlotMemory {
  idle: Uint8Array;
  strafe: Uint8Array;
  lean: Uint8Array;
  /** Kicking foot chosen at the start of the current action (255 = not chosen yet). */
  foot: Uint8Array;
  /** Action kind and actT seen last frame (restart detection). */
  act: Uint8Array;
  actT: Float32Array;
}

function createSlotMemory(): SlotMemory {
  return {
    idle: new Uint8Array(NUM_SLOTS), strafe: new Uint8Array(NUM_SLOTS), lean: new Uint8Array(NUM_SLOTS),
    foot: new Uint8Array(NUM_SLOTS).fill(255), act: new Uint8Array(NUM_SLOTS), actT: new Float32Array(NUM_SLOTS),
  };
}

/**
 * Per-slot inputs beyond the sim state for chooseClip (typed scratch filled by the caller: doubles never cross a call
 * boundary): interpolated velocity and facing, alpha, yaw rate, breathing phase, speed.
 */
const IN = new Float64Array(8);
const IN_VX = 0, IN_VZ = 1, IN_FX = 2, IN_FZ = 3, IN_ALPHA = 4, IN_YAW = 5, IN_BREATH = 6, IN_SPEED = 7;

/** Extra outputs of chooseClip (integers). */
const OUTX = {
  /** Locomotion clip whose stride drives the cycle (and that is layered under upper-body clips). */
  loco: AnimId.JOG as AnimId,
  /** 1 when the clip is a full-body action (no turn lean / locomotion legs). */
  action: 0,
  /** 1 for foot kicks, headers and volleys (contact timing rules). */
  kick: 0,
};
/** Extra outputs of chooseClip (doubles): movement direction, lower-body layer weight, breathing weight, turn lean. */
const OUTF = new Float64Array(4);
const OF_DIR = 0, OF_LAYER = 1, OF_BREATH = 2, OF_LEAN = 3;

/** Turn lean (rad) for the slot's speed and yaw rate in IN, written to OUTF[OF_LEAN] (half = 1: half of it). */
function leanFromIn(half: number): void {
  let a = Math.atan((IN[IN_SPEED]! * IN[IN_YAW]!) / LOCOMOTION_TUNING.gravity);
  const m = LOCOMOTION_TUNING.maxTurnLean;
  a = a < -m ? -m : a > m ? m : a;
  OUTF[OF_LEAN] = half === 1 ? a * 0.5 : a;
}

/** Breathing weight for a standing clip: 1 standing, fading out between 0.3 and 1.5 m/s (OUTF[OF_BREATH]). */
function breathFromIn(): void {
  let x = (IN[IN_SPEED]! - 0.3) / 1.2;
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  OUTF[OF_BREATH] = 1 - x * x * (3 - 2 * x);
}

/** [INT-C] Run style of a run-family clip: 0 jog, 1 sprint (TURN_LEAN: its foot parameter), -1 not a run clip. */
function runStyle(a: AnimId, foot: number): number {
  if (a === AnimId.JOG) return 0;
  if (a === AnimId.SPRINT) return 1;
  if (a === AnimId.TURN_LEAN) return foot === 1 ? 1 : 0;
  return -1;
}

/**
 * [INT-C] JOG / SPRINT with the mapper's lean layer and TURN_LEAN of the same style are the same pose (one run gait,
 * the same lean formula), so a switch between them needs no cross-fade. Jog <-> turn lean flips on small yaw-rate
 * changes many times a minute; each started a 0.2 s fade (from a frozen snapshot when interrupted) for nothing.
 */
function sameRunPose(a: AnimId, footA: number, b: AnimId, footB: number): boolean {
  const sa = runStyle(a, footA);
  return sa >= 0 && sa === runStyle(b, footB);
}

/**
 * [INT-C] The lean and breathing layers locomotionParams / update give locomotion clip `anim`, applied to `out` (the
 * outgoing clip of a locomotion cross-fade, evaluated live). IN holds the slot's inputs of this frame. Clobbers
 * OUTF[OF_LEAN] / OUTF[OF_BREATH] (read by update before the blend).
 */
function liveLocoLayers(anim: AnimId, out: Pose): void {
  if (anim === AnimId.STRAFE || anim === AnimId.JOCKEY || anim === AnimId.KEEPER_READY || anim === AnimId.SHIELD) {
    breathFromIn();
    if (OUTF[OF_BREATH]! > 0) { BRA[0] = IN[IN_BREATH]!; BRA[1] = OUTF[OF_BREATH]!; applyBreathS(out); }
  }
  if (anim === AnimId.JOG || anim === AnimId.SPRINT || anim === AnimId.STRAFE) leanFromIn(0);
  else if (anim === AnimId.JOCKEY || anim === AnimId.SHIELD || anim === AnimId.KEEPER_READY) leanFromIn(1);
  else OUTF[OF_LEAN] = 0;
  if (OUTF[OF_LEAN] !== 0) { TLA[0] = OUTF[OF_LEAN]!; applyTurnLeanS(out); }
}

function preferredFoot(s: ReadonlySimState, slot: number): number {
  return s.attrs[slot]!.foot === 1 ? 1 : 0;
}

/** Foot for a kick that starts now: the preferred foot unless the ball sits clearly on the other side. */
function chooseFoot(s: ReadonlySimState, slot: number): number {
  const p = s.players[slot]!;
  const pref = preferredFoot(s, slot);
  const b = s.ball;
  const dx = b.x - p.x, dz = b.z - p.z;
  // Lateral offset of the ball toward the player's right ((-fz, fx) is the right in world xz).
  const lat = dx * -p.fz + dz * p.fx;
  if (pref === 0 && lat < -LOCAL_TUNING.weakFootSide) return 1;
  if (pref === 1 && lat > LOCAL_TUNING.weakFootSide) return 0;
  return pref;
}

/** Locomotion clip from speed, flags and movement direction (writes OUTF[OF_DIR]). */
function chooseLocomotion(s: ReadonlySimState, slot: number, mem: SlotMemory | null): AnimId {
  const p = s.players[slot]!;
  const speed = IN[IN_SPEED]!;
  const fx = IN[IN_FX]!, fz = IN[IN_FZ]!;
  const fwd = IN[IN_VX]! * fx + IN[IN_VZ]! * fz;
  const lat = IN[IN_VX]! * -fz + IN[IN_VZ]! * fx;
  const ang = Math.atan2(lat, fwd);
  let dir = 0;
  if (speed > 1e-3) { dir = ang / TAU; dir -= Math.floor(dir); if (dir >= 1) dir = 0; }
  OUTF[OF_DIR] = dir;
  const off = ang < 0 ? -ang : ang;
  // Idle (hysteresis).
  const wasIdle = mem ? mem.idle[slot] === 1 : speed < LOCAL_TUNING.idleEnter;
  const idle = wasIdle ? speed < LOCAL_TUNING.idleLeave : speed < LOCAL_TUNING.idleEnter;
  if (mem) mem.idle[slot] = idle ? 1 : 0;
  // Keeper ready stance in play.
  const team = p.team === 1 ? 1 : 0;
  const keeper = p.isKeeper === 1 || s.teams[team]!.keeperSlot === slot;
  if (keeper && s.match.phase === MatchPhase.IN_PLAY && speed < LOCAL_TUNING.keeperReadyMaxSpeed) {
    const bx = s.ball.x - p.x, bz = s.ball.z - p.z;
    if (bx * bx + bz * bz < LOCAL_TUNING.keeperReadyDist * LOCAL_TUNING.keeperReadyDist) return AnimId.KEEPER_READY;
  }
  if (p.shielding === 1) return AnimId.SHIELD;
  if (p.jockeying === 1) return AnimId.JOCKEY;
  if (idle) return AnimId.IDLE;
  const wasStrafe = mem ? mem.strafe[slot] === 1 : false;
  const strafe = speed < LOCAL_TUNING.strafeMaxSpeed && (wasStrafe ? off > LOCAL_TUNING.strafeLeave : off > LOCAL_TUNING.strafeEnter);
  if (mem) mem.strafe[slot] = strafe ? 1 : 0;
  if (strafe) return AnimId.STRAFE;
  return p.sprinting === 1 ? AnimId.SPRINT : AnimId.JOG;
}

/**
 * Choose the clip and its parameters for `slot` (writes `out`, OUTX and OUTF). IN must hold the slot's interpolated
 * velocity / facing, alpha, yaw rate, breathing phase and speed. mem = null for the stateless stub API.
 */
function chooseClip(s: ReadonlySimState, slot: number, out: AnimSample, mem: SlotMemory | null): void {
  const p = s.players[slot]!;
  const act = p.act;
  const speed = IN[IN_SPEED]!;
  out.t = 0;
  out.side = 1;
  out.foot = 0;
  OUTX.action = 1;
  OUTX.kick = 0;
  OUTF[OF_LAYER] = 0;
  OUTF[OF_BREATH] = 0;
  OUTF[OF_LEAN] = 0;
  // Per-action memory (foot choice at the start of the action, restart detection).
  if (mem) {
    if (mem.act[slot] !== act || p.actT < mem.actT[slot]!) mem.foot[slot] = 255;
    mem.act[slot] = act;
    mem.actT[slot] = p.actT;
  }
  const loco = chooseLocomotion(s, slot, mem);
  OUTX.loco = loco;
  let anim: AnimId;
  let kick = 0;
  switch (act) {
    case ActionKind.KICK: anim = kickAnim(p.actKick); kick = 1; break;
    case ActionKind.SHOT: anim = shotAnim(p.actKick); kick = 1; break;
    case ActionKind.HEADER: anim = AnimId.HEADER; kick = 1; break;
    case ActionKind.VOLLEY: anim = AnimId.VOLLEY; kick = 1; break;
    case ActionKind.GK_DIVE: anim = diveAnim(p.actA, p.actB); break;
    case ActionKind.CELEBRATE: anim = celebrationAnim(p.actA); break;
    case ActionKind.GK_CATCH:
      anim = p.actA === 1 || p.actDone === 1 ? AnimId.CATCH : AnimId.KEEPER_READY;
      break;
    case ActionKind.WALL_JUMP:
      anim = p.actA === 2 ? loco : AnimId.WALL_JUMP;
      break;
    case ActionKind.NONE: case ActionKind.SET_PIECE: case ActionKind.GK_RUSH:
      anim = s.ball.heldBy === slot ? AnimId.KEEPER_HOLD : loco;
      break;
    case ActionKind.SHIELD:
      anim = AnimId.SHIELD;
      break;
    default:
      anim = act >= 0 && act < ACTION_ANIM.length ? ACTION_ANIM[act]! : AnimId.IDLE;
  }
  out.anim = anim;
  OUTX.kick = kick;
  if (isLocomotion(anim)) {
    OUTX.action = 0;
    locomotionParams(s, slot, out);
    return;
  }
  // Action clips.
  if (anim === AnimId.KEEPER_HOLD && act !== ActionKind.GK_HOLD) {
    let t = IN[IN_BREATH]! / 3; // held outside the hold action: slow loop
    t -= Math.floor(t);
    out.t = t;
  } else if (anim === AnimId.THROW_IN && p.actContact < 0) {
    out.t = 0; // holding the ball overhead until the throw
  } else if (anim === AnimId.WALL_JUMP && p.actA !== 1) {
    out.t = 0; // brace
  } else {
    APA[0] = p.actT + IN[IN_ALPHA]!; APA[1] = p.actContact; APA[2] = p.actDur; APA[3] = CF_TABLE[anim]!;
    APA[4] = kick; APA[5] = p.actDone; APA[6] = p.actCharging; APA[7] = HOLD_TABLE[anim]!;
    actionPhaseS();
    out.t = APA[8]!;
  }
  if (kick === 1 || anim === AnimId.FIRST_TOUCH || anim === AnimId.SKILL || anim === AnimId.GK_KICK) {
    let foot: number;
    if (mem) {
      if (mem.foot[slot] === 255) mem.foot[slot] = chooseFoot(s, slot);
      foot = mem.foot[slot]!;
    } else {
      foot = preferredFoot(s, slot);
    }
    out.foot = foot;
  } else if (anim === AnimId.GK_THROW) {
    out.foot = p.actKick === KickKind.GK_ROLL || p.actKick === KickKind.GK_RELEASE ? 1 : 0;
  }
  if (isUpperLayer(anim)) {
    OUTX.action = 0;
    let x = (speed - LOCAL_TUNING.layerFrom) / (LOCAL_TUNING.layerTo - LOCAL_TUNING.layerFrom);
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    const w = x * x * (3 - 2 * x);
    OUTF[OF_LAYER] = w;
    leanFromIn(0);
    OUTF[OF_LEAN] = OUTF[OF_LEAN]! * w;
  }
}

/** Parameters of a locomotion clip (t, side, foot) plus the lean and breathing layers. */
function locomotionParams(s: ReadonlySimState, slot: number, out: AnimSample): void {
  const anim = out.anim;
  OUTX.loco = anim;
  switch (anim) {
    case AnimId.IDLE:
      out.t = IN[IN_BREATH]!;
      break;
    case AnimId.STRAFE: case AnimId.JOCKEY: case AnimId.KEEPER_READY:
      out.t = OUTF[OF_DIR]!;
      breathFromIn();
      break;
    case AnimId.SHIELD:
      out.t = OUTF[OF_DIR]!;
      out.side = shieldSide(s, slot);
      breathFromIn();
      break;
    default:
      break;
  }
  if (anim === AnimId.JOG || anim === AnimId.SPRINT || anim === AnimId.STRAFE) leanFromIn(0);
  else if (anim === AnimId.JOCKEY || anim === AnimId.SHIELD || anim === AnimId.KEEPER_READY) leanFromIn(1);
}

/** Side (-1 left / +1 right of the facing) of the nearest opponent: the shielding arm goes out toward him. */
function shieldSide(s: ReadonlySimState, slot: number): number {
  const p = s.players[slot]!;
  let best = Infinity, side = 1;
  const from = p.team === 1 ? 0 : 11;
  for (let j = from; j < from + 11; j++) {
    const o = s.players[j]!;
    if (o.active !== 1) continue;
    const dx = o.x - p.x, dz = o.z - p.z;
    const d = dx * dx + dz * dz;
    if (d < best) {
      best = d;
      side = dx * -IN[IN_FZ]! + dz * IN[IN_FX]! >= 0 ? 1 : -1;
    }
  }
  return side;
}

/**
 * Stub API: choose the clip for `slot` from discrete sim facts and the interpolated speed (m/s). Pure apart from a
 * per-slot speed cache used by advanceCycle. No alpha (phase from p.actT), no hysteresis, preferred foot.
 */
export function mapAnim(state: ReadonlySimState, slot: number, speed: number, out: AnimSample): void {
  STUB_ARGS[1] = speed;
  mapAnimS(state, slot, out);
}

function mapAnimS(state: ReadonlySimState, slot: number, out: AnimSample): void {
  const speed = STUB_ARGS[1]!;
  const p = state.players[slot]!;
  IN[IN_VX] = p.vx; IN[IN_VZ] = p.vz;
  IN[IN_FX] = p.fx; IN[IN_FZ] = p.fz;
  IN[IN_ALPHA] = 0;
  IN[IN_YAW] = 0;
  let b = state.tick / (60 * LOCAL_TUNING.breathPeriod) + slot * 0.137;
  b -= Math.floor(b);
  IN[IN_BREATH] = b;
  const v = speed === speed && speed > 0 ? speed : 0;
  IN[IN_SPEED] = v;
  const bank = STUB_CUR.bank;
  const st = bank !== null && STUB_CUR.slot === slot ? (bank.stub as StubState | undefined) : undefined;
  const mem = st ? st.mem : null;
  if (mem) { STUB_CUR.prevAct = mem.act[slot]!; STUB_CUR.prevActT = mem.actT[slot]!; }
  chooseClip(state, slot, out, mem);
  STUB_CUR.mapped = st ? slot : -1;
  STUB_CUR.tick = state.tick;
  STUB_CUR.act = p.act; STUB_CUR.actT = p.actT; STUB_CUR.contact = p.actContact; STUB_CUR.done = p.actDone;
  STUB_CUR.kick = OUTX.kick;
  if (slot >= 0 && slot < NUM_SLOTS) {
    STUB_SPEED[slot] = v;
    STUB_ANIM[slot] = OUTX.loco;
  }
}

/** PoseFn lookup indexed by AnimId (built once at module load). */
const POSE_FNS: PoseFn[] = [];
/** Allocation-free entry points (parameters in PP) indexed by AnimId. */
const POSE_IMPLS: PoseImpl[] = [];
const neutralImpl: PoseImpl = (out) => { out.fill(0); };
for (let i = 0; i <= AnimId.STRAFE; i++) {
  const id = i as AnimId;
  POSE_FNS[i] = LOCOMOTION_POSES[id] ?? ACTION_POSES[id] ?? CONTACT_POSES[id] ?? neutralPose;
  POSE_IMPLS[i] = LOCOMOTION_IMPLS[id] ?? ACTION_IMPLS[id] ?? CONTACT_IMPLS[id] ?? neutralImpl;
}

export function poseFnFor(anim: AnimId): PoseFn {
  return POSE_FNS[anim] ?? neutralPose;
}

/** Write the pose for a sample into `out`. */
export function samplePose(sample: AnimSample, cycle: number, speed: number, out: Pose): void {
  STUB_POSE[0] = cycle; STUB_POSE[1] = speed;
  samplePoseS(sample, out);
}

/** samplePose arguments: cycle, speed. */
const STUB_POSE = new Float64Array(2);

function samplePoseS(sample: AnimSample, out: Pose): void {
  const cycle = STUB_POSE[0]!, speed = STUB_POSE[1]!;
  const bank = STUB_CUR.bank, slot = STUB_CUR.mapped;
  const st = bank !== null && slot >= 0 ? (bank.stub as StubState | undefined) : undefined;
  PP[0] = sample.t; PP[1] = cycle; PP[2] = speed; PP[3] = sample.side; PP[4] = sample.foot;
  const anim = sample.anim >= 0 && sample.anim <= AnimId.STRAFE ? sample.anim : AnimId.IDLE;
  POSE_IMPLS[anim]!(out);
  if (!st || !bank) return;
  STUB_CUR.mapped = -1;
  // Same layers as the animator (no turn lean: the stub path has no yaw rate).
  const lw = OUTF[OF_LAYER]!;
  if (lw > 0) {
    PP[0] = OUTX.loco === AnimId.IDLE ? IN[IN_BREATH]! : OUTF[OF_DIR]!; PP[1] = cycle; PP[2] = speed; PP[3] = 1; PP[4] = 0;
    POSE_IMPLS[OUTX.loco]!(st.layer);
    for (let k = 0; k < LOWER_BODY.length; k++) {
      const c = LOWER_BODY[k]!;
      out[c] = out[c]! + (st.layer[c]! - out[c]!) * lw;
    }
  }
  if (OUTF[OF_BREATH]! > 0) { BRA[0] = IN[IN_BREATH]!; BRA[1] = OUTF[OF_BREATH]!; applyBreathS(out); }
  // Cross-fade on clip changes / action restarts, timed in sim ticks (the stub API has no frame time).
  const prevAnim = bank.anim[slot]!;
  const tick = STUB_CUR.tick;
  const restarted = STUB_CUR.prevAct === STUB_CUR.act && STUB_CUR.act !== ActionKind.NONE && STUB_CUR.actT < STUB_CUR.prevActT;
  if (st.seen[slot] === 0) {
    st.dur[slot] = 0;
  } else if (anim !== prevAnim || restarted) {
    const a = st.last[slot]!, f = st.from[slot]!;
    for (let k = 0; k < POSE_SIZE; k++) f[k] = a[k]!;
    st.startTick[slot] = tick;
    BTA[0] = STUB_CUR.contact; BTA[1] = STUB_CUR.actT; BTA[2] = STUB_CUR.done; BTA[3] = STUB_CUR.kick;
    blendTimeS(prevAnim, anim);
    st.dur[slot] = BTA[4]!;
  }
  const dur = st.dur[slot]!;
  let w = 1;
  if (dur > 0) {
    let x = (tick - st.startTick[slot]!) / (60 * dur);
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    w = x * x * (3 - 2 * x);
  }
  if (w < 1) {
    const f = st.from[slot]!;
    for (let k = 0; k < POSE_SIZE; k++) out[k] = f[k]! + (out[k]! - f[k]!) * w;
  }
  const last = st.last[slot]!;
  for (let k = 0; k < POSE_SIZE; k++) last[k] = out[k]!;
  bank.anim[slot] = anim;
  bank.blend[slot] = w;
  st.seen[slot] = 1;
}

// ============================================================ the animator (full driver)

/** Anything with setPose (the player model, GFX-07 PoseSink). */
export interface PoseSinkLike {
  setPose(slot: number, pose: ArrayLike<number>): void;
  /**
   * [QF-4] Render-only offsets (m, [dx0, dz0, ...]) the sink drew each player with on the last frame (players/drawn.ts:
   * foot lock, set-piece stance); the ball-contact reach aims from the drawn body, not the sim position.
   */
  readonly drawnOffsets?: Float64Array;
}

/** Per-frame animation driver: same shape as GFX-07's PoseDriver. */
export type AnimDriver = (f: RenderFrame, sink: PoseSinkLike) => void;

export interface Animator {
  /** Stride cycles, current clip and blend weight per slot. */
  readonly bank: AnimBank;
  /** Clip choice per slot of the last update. */
  readonly samples: readonly AnimSample[];
  /** Pose per slot written to the sink last update (what is drawn). */
  readonly poses: readonly Pose[];
  /** Smoothed yaw rate per slot (rad/s, + = turning right). */
  readonly yawRate: Float32Array;
  /** Advance every active slot one animation frame and write its pose to the sink (null: compute only). */
  update(f: RenderFrame, sink: PoseSinkLike | null): void;
  /** Forget all per-slot memory (new match). */
  reset(): void;
  /** The update bound as a PoseDriver (created once). */
  readonly driver: AnimDriver;
}

/** Create the full animation driver state for 22 players. Allocates once; update() allocates nothing. */
export function createAnimator(): Animator {
  const bank = createAnimBank();
  const samples: AnimSample[] = [];
  const poses: Pose[] = [];
  const from: Pose[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) {
    samples.push(createAnimSample());
    poses.push(createPose());
    from.push(createPose());
  }
  const target = createPose();
  const layer = createPose();
  const yawRate = new Float32Array(NUM_SLOTS);
  const lastX = new Float64Array(NUM_SLOTS), lastZ = new Float64Array(NUM_SLOTS);
  const lastFx = new Float64Array(NUM_SLOTS), lastFz = new Float64Array(NUM_SLOTS);
  const seen = new Uint8Array(NUM_SLOTS);
  const blendT = new Float32Array(NUM_SLOTS);
  const blendDur = new Float32Array(NUM_SLOTS);
  const lastT = new Float32Array(NUM_SLOTS);
  const mem = createSlotMemory();
  // [INT-C] Locomotion -> locomotion cross-fades (jog / sprint / turn lean / strafe... flip often in live play) blend
  // from the outgoing clip evaluated LIVE at this frame's stride cycle and speed, not from a frozen snapshot: both
  // clips share the distance-driven gait, so their planted feet stay planted through the fade (a frozen "from" pose
  // made the stance foot slide with the body for the whole fade). Interrupted fades keep the frozen snapshot.
  const fromLive = new Uint8Array(NUM_SLOTS);
  const fromAnim = new Uint8Array(NUM_SLOTS);
  const fromT = new Float32Array(NUM_SLOTS), fromSide = new Float32Array(NUM_SLOTS);
  const fromFoot = new Uint8Array(NUM_SLOTS);
  const lastSide = new Float32Array(NUM_SLOTS);
  const lastFoot = new Uint8Array(NUM_SLOTS);
  const liveFrom = createPose();
  // [QF-4] Ball contact (reach.ts): per slot the world ball target of the current kick (frozen at the contact), the
  // touch reach (weight, leg, world contact point) and the dribble's last predicted touch.
  const kickWX = new Float64Array(NUM_SLOTS), kickWY = new Float64Array(NUM_SLOTS), kickWZ = new Float64Array(NUM_SLOTS);
  const kickInit = new Uint8Array(NUM_SLOTS);
  const touchW = new Float64Array(NUM_SLOTS);
  const touchSide = new Int8Array(NUM_SLOTS);
  const touchWX = new Float64Array(NUM_SLOTS), touchWY = new Float64Array(NUM_SLOTS), touchWZ = new Float64Array(NUM_SLOTS);
  const touchSeenTick = new Float64Array(NUM_SLOTS).fill(-1);
  /** Frames left in which the touch reach keeps rising toward 1 after a touch. */
  const touchRise = new Uint8Array(NUM_SLOTS);
  /** [QF-4] The kick was charging on the previous frame / the release strike is being shown (phase rate limited). */
  const wasCharging = new Uint8Array(NUM_SLOTS);
  const strike = new Uint8Array(NUM_SLOTS);

  function reset(): void {
    seen.fill(0);
    bank.cycle.fill(0);
    bank.anim.fill(0);
    bank.blend.fill(1);
    yawRate.fill(0);
    blendT.fill(0);
    blendDur.fill(0);
    fromLive.fill(0);
    mem.idle.fill(0); mem.strafe.fill(0); mem.lean.fill(0); mem.foot.fill(255); mem.act.fill(0); mem.actT.fill(0);
    touchW.fill(0); touchSeenTick.fill(-1); touchRise.fill(0); wasCharging.fill(0); strike.fill(0);
    kickInit.fill(0);
  }

  function update(f: RenderFrame, sink: PoseSinkLike | null): void {
    const s = f.curr, it = f.interp;
    const drawn = sink !== null && sink.drawnOffsets !== undefined ? sink.drawnOffsets : null;
    let dt = f.frame.paused ? 0 : f.frame.dtMs / 1000;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    const alpha = f.alpha > 0 ? (f.alpha < 1 ? f.alpha : 1) : 0;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = s.players[i]!;
      if (p.active !== 1) { seen[i] = 0; continue; }
      let x = it.x[i]!, z = it.z[i]!;
      if (!(x === x) || !(z === z)) { x = 0; z = 0; }
      let fx = it.fx[i]!, fz = it.fz[i]!;
      if (!(fx === fx) || !(fz === fz) || fx * fx + fz * fz < 1e-8) { fx = 1; fz = 0; }
      let vx = it.vx[i]!, vz = it.vz[i]!;
      if (!(vx === vx) || !(vz === vz)) { vx = 0; vz = 0; }
      let speed = Math.sqrt(vx * vx + vz * vz);
      if (speed > 20) speed = 20;
      // Distance travelled / teleport.
      let d = 0;
      let teleport = seen[i] !== 1;
      if (!teleport) {
        const dx = x - lastX[i]!, dz = z - lastZ[i]!;
        d = Math.sqrt(dx * dx + dz * dz);
        if (!(d <= LOCAL_TUNING.teleportDist)) { teleport = true; d = 0; }
      }
      // Yaw rate (+ = turning right: facing rotating toward its right vector (-fz, fx)).
      if (teleport) {
        yawRate[i] = 0;
      } else if (dt > 0) {
        const cross = lastFx[i]! * fz - lastFz[i]! * fx;
        const dot = lastFx[i]! * fx + lastFz[i]! * fz;
        const rate = Math.atan2(cross, dot) / dt;
        const k = 1 - Math.exp(-dt / LOCAL_TUNING.yawRateTau);
        yawRate[i] = yawRate[i]! + (rate - yawRate[i]!) * k;
      }
      lastX[i] = x; lastZ[i] = z; lastFx[i] = fx; lastFz[i] = fz;
      // Clip choice.
      IN[IN_VX] = vx; IN[IN_VZ] = vz; IN[IN_FX] = fx; IN[IN_FZ] = fz; IN[IN_ALPHA] = alpha; IN[IN_YAW] = yawRate[i]!;
      let br = (s.tick + alpha) / (60 * LOCAL_TUNING.breathPeriod) + i * 0.137;
      br -= Math.floor(br);
      IN[IN_BREATH] = br;
      IN[IN_SPEED] = speed;
      const sample = samples[i]!;
      const prevAnim = bank.anim[i]!;
      const prevAct = mem.act[i]!, prevActT = mem.actT[i]!;
      chooseClip(s, i, sample, mem);
      let anim = sample.anim;
      // TURN_LEAN: running clips with a marked lean (hysteresis); its pose function applies the lean itself.
      if (anim === AnimId.JOG || anim === AnimId.SPRINT) {
        const lean = OUTF[OF_LEAN]! < 0 ? -OUTF[OF_LEAN]! : OUTF[OF_LEAN]!;
        const was = mem.lean[i] === 1;
        const on = was ? lean > LOCAL_TUNING.leanLeave : lean > LOCAL_TUNING.leanEnter;
        mem.lean[i] = on ? 1 : 0;
        if (on) {
          sample.foot = anim === AnimId.SPRINT ? 1 : 0;
          sample.side = yawRate[i]!;
          sample.anim = anim = AnimId.TURN_LEAN;
          OUTF[OF_LEAN] = 0;
        }
      } else {
        mem.lean[i] = 0;
      }
      // [QF-4] A charged kick released: the sim kicks on the release tick, so the clip would jump from the backswing top
      // (held while charging) to the contact pose in one frame; show that strike over two frames instead.
      if (OUTX.kick === 1 && OUTX.action === 1) {
        if (wasCharging[i] === 1 && p.actCharging === 0 && anim === prevAnim) strike[i] = 1;
        if (strike[i] === 1) {
          const cf = CF_TABLE[anim]!, hold = HOLD_TABLE[anim]!;
          const step = cf > hold && hold >= 0 ? (cf - hold) * 0.5 : 1;
          if (sample.t > lastT[i]! + step) sample.t = lastT[i]! + step;
          if (sample.t >= cf || anim !== prevAnim) strike[i] = 0;
        }
        wasCharging[i] = p.actCharging === 1 ? 1 : 0;
      } else {
        wasCharging[i] = 0;
        strike[i] = 0;
      }
      // [QF-4] Follow-through speed limit: after the contact a clip plays at most followRate of its phase per second (a
      // whiffed or interrupted action shortens actDur and squeezed the swing into a few frames: a volley's leg moved
      // 0.85 m per frame). The cut back to locomotion cross-fades from wherever the clip got to.
      if (OUTX.action === 1 && anim === prevAnim && dt > 0) {
        const cf = CF_TABLE[anim]!;
        if (cf >= 0 && sample.t > cf && lastT[i]! >= cf && !(p.act === prevAct && p.actT < prevActT)) {
          const mx = lastT[i]! + LOCAL_TUNING.followRate * dt;
          if (sample.t > mx) sample.t = mx;
        }
      }
      // [QF-4] Dribble: phase-align the run so a foot comes through just before the touch the sim has scheduled.
      const owner = s.ball.owner === i && s.ball.heldBy < 0 && p.act === ActionKind.NONE ? 1 : 0;
      let touchTau = -1;
      if (owner === 1 && (anim === AnimId.JOG || anim === AnimId.SPRINT || anim === AnimId.TURN_LEAN)) {
        const bx = it.ballX - x, bz = it.ballZ - z;
        const dist = Math.sqrt(bx * bx + bz * bz);
        const reach = T_DRIBBLE.controlRadius + speed * DRIBBLE_REACH_LOOKAHEAD;
        let tau = p.touchCd > 0 ? p.touchCd - alpha : 0;
        if (dist > reach && dist > 1e-6) {
          const closing = ((vx - s.ball.vx) * bx + (vz - s.ball.vz) * bz) / dist;
          const tr = closing > 0.3 ? ((dist - reach) / closing) * 60 : 1e9;
          if (tr > tau) tau = tr;
        }
        if (tau < 60) touchTau = tau;
        if (d > 0 && REACH_SWITCH.align === 1 && speed > LOCAL_TUNING.alignMinSpeed && tau >= 1 && tau < 60) {
          SLEN[0] = speed;
          strideLengthForS(OUTX.loco);
          const nat = ((speed * tau) / 60 / SLEN[1]!) * TAU;
          // Phase at the touch if nothing changes, and the nearest foot-through phase (right at -lead, left at pi - lead).
          let e = -LOCAL_TUNING.touchLead - (bank.cycle[i]! + nat);
          e -= Math.PI * Math.round(e / Math.PI);
          let k = nat > 1e-6 ? 1 + e / nat : 1;
          k = k < LOCAL_TUNING.alignMin ? LOCAL_TUNING.alignMin : k > LOCAL_TUNING.alignMax ? LOCAL_TUNING.alignMax : k;
          d *= k;
        }
      }
      // Stride cycle: distance / stride of the locomotion clip in use.
      if (d > 0) {
        SLEN[0] = speed;
        strideLengthForS(OUTX.loco);
        let c = bank.cycle[i]! + (d / SLEN[1]!) * TAU;
        if (!(c === c)) c = 0;
        if (c >= TAU || c < 0) c -= TAU * Math.floor(c / TAU);
        bank.cycle[i] = c >= TAU ? 0 : c;
      }
      const cycle = bank.cycle[i]!;
      // Target pose: clip, locomotion legs under upper-body clips, lean and breathing layers.
      PP[0] = sample.t; PP[1] = cycle; PP[2] = speed; PP[3] = sample.side; PP[4] = sample.foot;
      POSE_IMPLS[anim]!(target);
      const lw = OUTF[OF_LAYER]!;
      if (lw > 0) {
        PP[0] = OUTX.loco === AnimId.IDLE ? br : OUTF[OF_DIR]!; PP[1] = cycle; PP[2] = speed; PP[3] = 1; PP[4] = 0;
        POSE_IMPLS[OUTX.loco]!(layer);
        for (let k = 0; k < LOWER_BODY.length; k++) {
          const c = LOWER_BODY[k]!;
          target[c] = target[c]! + (layer[c]! - target[c]!) * lw;
        }
      }
      if (OUTF[OF_LEAN] !== 0) { TLA[0] = OUTF[OF_LEAN]!; applyTurnLeanS(target); }
      if (OUTF[OF_BREATH]! > 0) { BRA[0] = br; BRA[1] = OUTF[OF_BREATH]!; applyBreathS(target); }
      // [QF-4] Foot kicks: the kicking boot reaches the ball the sim kicks (predicted to the contact tick, frozen there).
      const offX = drawn !== null ? drawn[i * 2]! : 0, offZ = drawn !== null ? drawn[i * 2 + 1]! : 0;
      let hs = s.attrs[i]!.height / 180;
      if (!(hs >= LOCAL_TUNING.minScale)) hs = LOCAL_TUNING.minScale; else if (hs > LOCAL_TUNING.maxScale) hs = LOCAL_TUNING.maxScale;
      if (!(OUTX.action === 1 && p.actContact >= 0 && reachClip(anim))) kickInit[i] = 0;
      if (OUTX.action === 1 && p.actContact >= 0 && reachClip(anim)) {
        // Weight by time to / since the contact tick (a phase window shrinks with short wind-ups and would pop).
        const ua = p.actT + alpha - p.actContact;
        // Full by reachFullTicks before the contact: the strike itself (the fastest part of the swing) adds no motion.
        const full = LOCAL_TUNING.reachFullTicks;
        let wu = ua <= 0 ? (ua + LOCAL_TUNING.reachLeadTicks) / (LOCAL_TUNING.reachLeadTicks - full) : 1 - ua / LOCAL_TUNING.reachTailTicks;
        if (p.actDone === 0 && ua > 0) wu = 1; // charging past the planned contact: the backswing aims at the ball
        wu = wu < 0 ? 0 : wu > 1 ? 1 : wu;
        const w = wu * wu * (3 - 2 * wu);
        if (p.actDone === 0) {
          let tau = p.actCharging === 1 ? 0 : (p.actContact - (p.actT + alpha)) / 60;
          if (!(tau > 0)) tau = 0;
          const b = s.ball;
          const px = it.ballX + b.vx * tau - vx * tau;
          const pz = it.ballZ + b.vz * tau - vz * tau;
          let py = it.ballY + b.vy * tau - 4.905 * tau * tau;
          if (py < 0.11) py = 0.11;
          // A new kick takes the prediction as it is; then it moves at most kickTargetStep per frame (a bounce or a
          // deflection changes the prediction at once: the boot must not jump with it).
          const fresh = p.act !== prevAct || p.actT < prevActT || kickInit[i] === 0;
          if (fresh) {
            kickWX[i] = px; kickWY[i] = py; kickWZ[i] = pz;
            kickInit[i] = 1;
          } else {
            const ex = px - kickWX[i]!, ey = py - kickWY[i]!, ez = pz - kickWZ[i]!;
            const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
            const mx = LOCAL_TUNING.kickTargetStep * (dt > 0 ? dt * 60 : 1);
            const k = el > mx ? mx / el : 1;
            kickWX[i] = kickWX[i]! + ex * k; kickWY[i] = kickWY[i]! + ey * k; kickWZ[i] = kickWZ[i]! + ez * k;
          }
        }
        if (w > 0 && REACH_SWITCH.kick === 1) {
          // World offset from the drawn player (prediction already relative to his motion) into model space.
          const rx = kickWX[i]! - x - offX, rz = kickWZ[i]! - z - offZ;
          RCH[0] = (rx * fx + rz * fz) / hs;
          RCH[1] = kickWY[i]! / hs;
          RCH[2] = (rx * -fz + rz * fx) / hs;
          RCH[3] = w;
          kickReach(target, anim, sample.foot);
        }
      }
      // Cross-fade on clip changes, action restarts and phase jumps.
      const restarted = prevAct === p.act && p.act !== ActionKind.NONE && p.actT < prevActT;
      const jump = OUTX.action === 1 && anim === prevAnim && (sample.t < lastT[i]! - 0.02 || sample.t > lastT[i]! + LOCAL_TUNING.phaseJump);
      const out = poses[i]!;
      if (teleport) {
        blendT[i] = 0;
        blendDur[i] = 0;
      } else if ((anim !== prevAnim && !sameRunPose(prevAnim, lastFoot[i]!, anim, sample.foot)) || restarted || jump) {
        for (let k = 0; k < POSE_SIZE; k++) from[i]![k] = out[k]!;
        // Settled fades only: an interrupted fade starts from the drawn mixture (frozen), so the pose stays continuous;
        // the model's foot lock catches the slip of those short fades.
        if (anim !== prevAnim && isLocomotion(prevAnim) && isLocomotion(anim) && blendT[i]! >= blendDur[i]!) {
          fromLive[i] = 1;
          fromAnim[i] = prevAnim;
          fromT[i] = lastT[i]!;
          fromSide[i] = lastSide[i]!;
          fromFoot[i] = lastFoot[i]!;
        } else {
          fromLive[i] = 0;
        }
        blendT[i] = 0;
        if (jump && anim === prevAnim && !restarted) blendDur[i] = LOCAL_TUNING.blendJump;
        else {
          BTA[0] = p.actContact; BTA[1] = p.actT + alpha; BTA[2] = p.actDone; BTA[3] = OUTX.kick;
          blendTimeS(prevAnim, anim);
          blendDur[i] = BTA[4]!;
        }
      }
      if (teleport) fromLive[i] = 0;
      bank.anim[i] = anim;
      lastT[i] = sample.t;
      lastSide[i] = sample.side;
      lastFoot[i] = sample.foot;
      const dur = blendDur[i]!;
      let w = 1;
      if (dur > 0 && blendT[i]! < dur) { const x = blendT[i]! / dur; w = x * x * (3 - 2 * x); }
      blendT[i] = blendT[i]! + dt;
      bank.blend[i] = w;
      if (w >= 1) {
        for (let k = 0; k < POSE_SIZE; k++) out[k] = target[k]!;
      } else {
        let a = from[i]!;
        if (fromLive[i] === 1) {
          const fa = fromAnim[i]! as AnimId;
          PP[0] = fromT[i]!; PP[1] = cycle; PP[2] = speed;
          PP[3] = fa === AnimId.TURN_LEAN ? yawRate[i]! : fromSide[i]!; PP[4] = fromFoot[i]!;
          POSE_IMPLS[fa]!(liveFrom);
          if (fa !== AnimId.TURN_LEAN) liveLocoLayers(fa, liveFrom);
          a = liveFrom;
        }
        for (let k = 0; k < POSE_SIZE; k++) out[k] = a[k]! + (target[k]! - a[k]!) * w;
      }
      // [QF-4] Touch reach (dribble touches, first touches): a touch this tick turns the reach on toward where the ball
      // was touched (the frame shows it there); a dribble touch the sim has scheduled, or a pass about to reach him,
      // fades it in beforehand; it fades out after. The weight wanted this frame is then rate-limited by how far the
      // foot would move (touchStepMax per frame), so a reach never pops the leg.
      if (teleport) { touchW[i] = 0; touchRise[i] = 0; }
      const b = s.ball;
      const touchedNow = b.lastTouch === i && b.lastTouchTick === s.tick && touchSeenTick[i] !== s.tick
        && (p.act === ActionKind.NONE || p.act === ActionKind.FIRST_TOUCH || p.act === ActionKind.SHIELD) && b.y < 0.7;
      let want = 0;
      if (touchedNow) {
        touchSeenTick[i] = s.tick;
        touchWX[i] = it.ballX; touchWY[i] = it.ballY; touchWZ[i] = it.ballZ;
        touchRise[i] = 4;
        want = 1;
      } else if (touchRise[i]! > 0) {
        touchRise[i] = touchRise[i]! - 1;
        want = 1;
      } else if (touchTau < 0 && b.owner < 0 && b.heldBy < 0 && b.passTarget === i && p.act === ActionKind.NONE && b.y < 0.6) {
        // A pass arriving: the sim's first touch comes when the ball enters his receive radius; reach ahead of it.
        const rx = it.ballX - x, rz = it.ballZ - z, ux = b.vx - vx, uz = b.vz - vz;
        const qa = ux * ux + uz * uz, qb = 2 * (rx * ux + rz * uz), qc = rx * rx + rz * rz - T_TOUCH.receiveRadius * T_TOUCH.receiveRadius;
        const disc = qb * qb - 4 * qa * qc;
        if (qc > 0 && qa > 1e-6 && qb < 0 && disc >= 0) {
          const tt = (-qb - Math.sqrt(disc)) / (2 * qa);
          if (tt <= LOCAL_TUNING.touchIn) {
            const tin = 1 - tt / LOCAL_TUNING.touchIn;
            want = tin * tin * (3 - 2 * tin);
            touchWX[i] = it.ballX + ux * tt;
            touchWY[i] = it.ballY;
            touchWZ[i] = it.ballZ + uz * tt;
          }
        }
      } else if (touchTau >= 0 && touchTau <= LOCAL_TUNING.touchIn * 60 && touchSeenTick[i] !== s.tick && b.y < T_DRIBBLE.controlHeight) {
        // Scheduled dribble touch (a low ball): the foot coming through reaches ahead.
        const tin = 1 - touchTau / (LOCAL_TUNING.touchIn * 60);
        want = tin * tin * (3 - 2 * tin);
        const tt = touchTau / 60;
        touchWX[i] = it.ballX + (b.vx - vx) * tt;
        touchWY[i] = it.ballY;
        touchWZ[i] = it.ballZ + (b.vz - vz) * tt;
        // The foot coming through to the touch: the phase alignment aims it just before its touchdown (right at 0,
        // left at pi), so it is the one swinging now.
        if (touchSide[i] === 0 && touchW[i] === 0) touchSide[i] = bank.cycle[i]! > Math.PI ? 1 : -1;
      }
      let tw = touchW[i]!;
      if (want < tw) {
        tw = dt > 0 ? Math.max(want, tw - dt / LOCAL_TUNING.touchOut) : tw;
        if (tw <= 0) { tw = 0; touchRise[i] = 0; }
      }
      if (want > tw || tw > 0) {
        const rx = touchWX[i]! - x - offX, rz = touchWZ[i]! - z - offZ;
        RCH[0] = (rx * fx + rz * fz) / hs;
        RCH[1] = touchWY[i]! / hs;
        RCH[2] = (rx * -fz + rz * fx) / hs;
        // The leg is chosen when the reach starts (the nearer toe) and kept: a switch mid-reach would pop.
        if (touchSide[i] === 0) touchSide[i] = nearerLeg(out);
        if (want > tw) {
          const need = touchNeed(out, touchSide[i]!);
          const step = need > LOCAL_TUNING.touchStepMax ? LOCAL_TUNING.touchStepMax / need : 1;
          tw = Math.min(want, tw + step);
        }
        touchW[i] = tw;
        if (tw > 0 && REACH_SWITCH.touch === 1) {
          RCH[3] = tw;
          touchReach(out, touchSide[i]!);
        }
      } else {
        touchW[i] = 0;
        touchSide[i] = 0;
      }
      seen[i] = 1;
      if (sink) sink.setPose(i, out);
    }
  }

  const driver: AnimDriver = (f, sink) => update(f, sink);
  return { bank, samples, poses, yawRate, update, reset, driver };
}

/**
 * Cross-fade time (s) from clip a to clip b. For a foot kick / header / volley (kick = 1) with its contact still to
 * come the blend ends before the contact tick, so the foot meets the ball on it.
 */
export function blendTime(a: AnimId, b: AnimId, contact: number, u: number, done: number, kick: number): number {
  BTA[0] = contact; BTA[1] = u; BTA[2] = done; BTA[3] = kick;
  blendTimeS(a, b);
  return BTA[4]!;
}

/** blendTime with contact, u, done, kick in BTA[0..3] and the result in BTA[4] (allocation-free internal form). */
const BTA = new Float64Array(5);
function blendTimeS(a: AnimId, b: AnimId): void {
  const contact = BTA[0]!, u = BTA[1]!, done = BTA[2]!, kick = BTA[3]!;
  let t: number;
  if (isLocomotion(a) && isLocomotion(b)) t = LOCAL_TUNING.blendLoco;
  else if (b >= AnimId.DIVE_LOW_L && b <= AnimId.DIVE_HIGH_R) t = LOCAL_TUNING.blendDive;
  else t = LOCAL_TUNING.blendAction;
  if (kick === 1 && contact >= 0 && done === 0) {
    const left = ((contact - u) / 60) * LOCAL_TUNING.blendBeforeContact;
    if (left < t) t = left > 0.03 ? left : 0.03;
  }
  BTA[4] = t;
}

/** The full driver as a PoseDriver for the player model (GFX-07 setPoseDriver). */
export function createAnimDriver(): AnimDriver {
  return createAnimator().driver;
}
