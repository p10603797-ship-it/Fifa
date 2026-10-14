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
 *    AnimSample / AnimBank. Same mapping, no blending, action phase without the alpha term.
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
import { AnimId, createPose, POSE_SIZE, type Pose, type PoseFn } from '../../contracts/render';
import type { ReadonlySimState } from '../../contracts/state';
import type { RenderFrame } from '../types';
import { ACTION_CONTACT, ACTION_HOLD, ACTION_POSES } from './actions';
import { celebrationAnim, CONTACT_CONTACT, CONTACT_POSES, diveAnim } from './contact';
import {
  applyBreath, applyTurnLean, isLocomotion, LOCOMOTION_POSES, LOWER_BODY, neutralPose, strideLengthFor, turnLeanAngle,
} from './locomotion';
import { smooth01, smoothRange, TAU, wrap01 } from './poseMath';

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
} as const;

/** Exposed for tests / tools. */
export const MAPPER_TUNING = LOCAL_TUNING;

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
}

export function createAnimBank(): AnimBank {
  return { cycle: new Float32Array(NUM_SLOTS), anim: new Uint8Array(NUM_SLOTS), blend: new Float32Array(NUM_SLOTS).fill(1) };
}

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
  if (!(slot >= 0 && slot < NUM_SLOTS)) return;
  const d = distance > 0 && distance < 1e3 ? distance : 0;
  const stride = strideLengthFor(STUB_ANIM[slot] as AnimId, STUB_SPEED[slot]!);
  bank.cycle[slot] = wrapCycle(bank.cycle[slot]! + (d / stride) * TAU);
}

function wrapCycle(c: number): number {
  if (!(c === c)) return 0;
  if (c >= TAU || c < 0) c -= TAU * Math.floor(c / TAU);
  return c >= TAU ? 0 : c;
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
  if (!(dur > 0)) return 0;
  if (!(u > 0)) u = 0;
  if (contact < 0 || cf < 0) return u >= dur ? 1 : u / dur;
  if (kick === 1 && done === 0) {
    if (charging === 1 && hold >= 0) return contact > 0 ? hold * (u < contact ? u / contact : 1) : hold;
    if (u >= contact) return cf;
  }
  if (u <= contact) return contact > 0 ? cf * (u / contact) : cf;
  const rest = dur - contact;
  if (!(rest > 0)) return 1;
  const k = (u - contact) / rest;
  return cf + (1 - cf) * (k < 1 ? k : 1);
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

/**
 * Per-slot inputs beyond the sim state for chooseClip (module scratch, filled by the caller): interpolated velocity
 * and facing, alpha, yaw rate, breathing phase.
 */
const IN = {
  vx: 0, vz: 0, fx: 1, fz: 0, alpha: 0, yawRate: 0, breath: 0,
};

/** Extra outputs of chooseClip: locomotion clip under the action (for layering / stride), layer weight, flags. */
const OUTX = {
  /** Locomotion clip whose stride drives the cycle (and that is layered under upper-body clips). */
  loco: AnimId.JOG as AnimId,
  /** Movement direction relative to the facing (fraction of a turn). */
  dir: 0,
  /** 1 when the clip is a full-body action (no turn lean / locomotion legs). */
  action: 0,
  /** 1 for foot kicks, headers and volleys (contact timing rules). */
  kick: 0,
  /** Lower-body locomotion weight under an upper-body clip (0..1). */
  layer: 0,
  /** Breathing weight (0..1). */
  breathW: 0,
  /** Turn lean (rad) to add (0 for TURN_LEAN, whose pose function applies it itself). */
  lean: 0,
};

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

/** Locomotion clip from speed, flags and movement direction (writes OUTX.loco / dir). */
function chooseLocomotion(s: ReadonlySimState, slot: number, speed: number, mem: SlotMemory | null): AnimId {
  const p = s.players[slot]!;
  const fx = IN.fx, fz = IN.fz;
  const fwd = IN.vx * fx + IN.vz * fz;
  const lat = IN.vx * -fz + IN.vz * fx;
  let dir = 0;
  if (speed > 1e-3) dir = wrap01(Math.atan2(lat, fwd) / TAU);
  OUTX.dir = dir;
  const off = Math.abs(Math.atan2(lat, fwd));
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
 * Choose the clip and its parameters for `slot` (writes `out` and OUTX). IN must hold the slot's interpolated
 * velocity / facing, alpha, yaw rate and breathing phase. mem = null for the stateless stub API.
 */
function chooseClip(s: ReadonlySimState, slot: number, speed: number, out: AnimSample, mem: SlotMemory | null): void {
  const p = s.players[slot]!;
  const act = p.act;
  out.t = 0;
  out.side = 1;
  out.foot = 0;
  OUTX.action = 1;
  OUTX.kick = 0;
  OUTX.layer = 0;
  OUTX.breathW = 0;
  OUTX.lean = 0;
  // Restart detection / per-action memory (foot choice at the start of the action).
  if (mem) {
    if (mem.act[slot] !== act || p.actT < mem.actT[slot]!) mem.foot[slot] = 255;
    mem.act[slot] = act;
    mem.actT[slot] = p.actT;
  }
  const loco = chooseLocomotion(s, slot, speed, mem);
  OUTX.loco = loco;
  const u = p.actT + IN.alpha;
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
    locomotionParams(s, slot, speed, out);
    return;
  }
  // Action clips.
  const cf = CF_TABLE[anim]!;
  if (anim === AnimId.KEEPER_HOLD && act !== ActionKind.GK_HOLD) {
    out.t = wrap01(IN.breath / 3); // held outside the hold action: slow loop
  } else if (anim === AnimId.THROW_IN && p.actContact < 0) {
    out.t = 0; // holding the ball overhead until the throw
  } else if (anim === AnimId.WALL_JUMP && p.actA !== 1) {
    out.t = 0; // brace
  } else {
    out.t = actionPhase(u, p.actContact, p.actDur, cf, kick, p.actDone, p.actCharging, HOLD_TABLE[anim]!);
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
    OUTX.layer = smoothRange(LOCAL_TUNING.layerFrom, LOCAL_TUNING.layerTo, speed);
    OUTX.lean = OUTX.layer * turnLeanAngle(speed, IN.yawRate);
  }
}

/** Parameters of a locomotion clip (t, side, foot) plus the lean and breathing layers. */
function locomotionParams(s: ReadonlySimState, slot: number, speed: number, out: AnimSample): void {
  const anim = out.anim;
  OUTX.loco = anim;
  const lean = turnLeanAngle(speed, IN.yawRate);
  switch (anim) {
    case AnimId.IDLE:
      out.t = IN.breath;
      break;
    case AnimId.STRAFE: case AnimId.JOCKEY: case AnimId.KEEPER_READY:
      out.t = OUTX.dir;
      OUTX.breathW = 1 - smoothRange(0.3, 1.5, speed);
      break;
    case AnimId.SHIELD:
      out.t = OUTX.dir;
      out.side = shieldSide(s, slot);
      OUTX.breathW = 1 - smoothRange(0.3, 1.5, speed);
      break;
    default:
      break;
  }
  if (anim === AnimId.JOG || anim === AnimId.SPRINT || anim === AnimId.STRAFE) OUTX.lean = lean;
  else if (anim === AnimId.JOCKEY || anim === AnimId.SHIELD || anim === AnimId.KEEPER_READY) OUTX.lean = lean * 0.5;
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
      side = dx * -IN.fz + dz * IN.fx >= 0 ? 1 : -1;
    }
  }
  return side;
}

/**
 * Stub API: choose the clip for `slot` from discrete sim facts and the interpolated speed (m/s). Pure apart from a
 * per-slot speed cache used by advanceCycle. No alpha (phase from p.actT), no hysteresis, preferred foot.
 */
export function mapAnim(state: ReadonlySimState, slot: number, speed: number, out: AnimSample): void {
  const p = state.players[slot]!;
  IN.vx = p.vx; IN.vz = p.vz;
  IN.fx = p.fx; IN.fz = p.fz;
  IN.alpha = 0;
  IN.yawRate = 0;
  IN.breath = breathPhase(state.tick, 0, slot);
  const v = speed === speed && speed > 0 ? speed : 0;
  chooseClip(state, slot, v, out, null);
  if (slot >= 0 && slot < NUM_SLOTS) {
    STUB_SPEED[slot] = v;
    STUB_ANIM[slot] = OUTX.loco;
  }
}

function breathPhase(tick: number, alpha: number, slot: number): number {
  return wrap01((tick + alpha) / (60 * LOCAL_TUNING.breathPeriod) + slot * 0.137);
}

/** PoseFn lookup indexed by AnimId (built once at module load). */
const POSE_FNS: PoseFn[] = [];
for (let i = 0; i <= AnimId.STRAFE; i++) {
  const id = i as AnimId;
  POSE_FNS[i] = LOCOMOTION_POSES[id] ?? ACTION_POSES[id] ?? CONTACT_POSES[id] ?? neutralPose;
}

export function poseFnFor(anim: AnimId): PoseFn {
  return POSE_FNS[anim] ?? neutralPose;
}

/** Write the pose for a sample into `out`. */
export function samplePose(sample: AnimSample, cycle: number, speed: number, out: Pose): void {
  poseFnFor(sample.anim)(out, sample.t, cycle, speed, sample.side, sample.foot);
}

// ============================================================ the animator (full driver)

/** Anything with setPose (the player model, GFX-07 PoseSink). */
export interface PoseSinkLike {
  setPose(slot: number, pose: ArrayLike<number>): void;
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
  const mem: SlotMemory = {
    idle: new Uint8Array(NUM_SLOTS), strafe: new Uint8Array(NUM_SLOTS), lean: new Uint8Array(NUM_SLOTS),
    foot: new Uint8Array(NUM_SLOTS).fill(255), act: new Uint8Array(NUM_SLOTS), actT: new Float32Array(NUM_SLOTS),
  };

  function reset(): void {
    seen.fill(0);
    bank.cycle.fill(0);
    bank.anim.fill(0);
    bank.blend.fill(1);
    yawRate.fill(0);
    blendT.fill(0);
    blendDur.fill(0);
    mem.idle.fill(0); mem.strafe.fill(0); mem.lean.fill(0); mem.foot.fill(255); mem.act.fill(0); mem.actT.fill(0);
  }

  function update(f: RenderFrame, sink: PoseSinkLike | null): void {
    const s = f.curr, it = f.interp;
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
      IN.vx = vx; IN.vz = vz; IN.fx = fx; IN.fz = fz; IN.alpha = alpha; IN.yawRate = yawRate[i]!;
      IN.breath = breathPhase(s.tick, alpha, i);
      const sample = samples[i]!;
      const prevAnim = bank.anim[i]!;
      const prevAct = mem.act[i]!, prevActT = mem.actT[i]!;
      chooseClip(s, i, speed, sample, mem);
      let anim = sample.anim;
      // TURN_LEAN: running clips with a marked lean (hysteresis); its pose function applies the lean itself.
      if (anim === AnimId.JOG || anim === AnimId.SPRINT) {
        const lean = Math.abs(OUTX.lean);
        const was = mem.lean[i] === 1;
        const on = was ? lean > LOCAL_TUNING.leanLeave : lean > LOCAL_TUNING.leanEnter;
        mem.lean[i] = on ? 1 : 0;
        if (on) {
          sample.foot = anim === AnimId.SPRINT ? 1 : 0;
          sample.side = IN.yawRate;
          sample.anim = anim = AnimId.TURN_LEAN;
          OUTX.lean = 0;
        }
      } else {
        mem.lean[i] = 0;
      }
      // Stride cycle: distance / stride of the locomotion clip in use.
      if (d > 0) bank.cycle[i] = wrapCycle(bank.cycle[i]! + (d / strideLengthFor(OUTX.loco, speed)) * TAU);
      const cycle = bank.cycle[i]!;
      // Target pose: clip, locomotion legs under upper-body clips, lean and breathing layers.
      poseFnFor(anim)(target, sample.t, cycle, speed, sample.side, sample.foot);
      const lw = OUTX.layer;
      if (lw > 0) {
        poseFnFor(OUTX.loco)(layer, OUTX.loco === AnimId.IDLE ? IN.breath : OUTX.dir, cycle, speed, 1, 0);
        for (let k = 0; k < LOWER_BODY.length; k++) {
          const c = LOWER_BODY[k]!;
          target[c] = target[c]! + (layer[c]! - target[c]!) * lw;
        }
      }
      if (OUTX.lean !== 0) applyTurnLean(target, OUTX.lean);
      if (OUTX.breathW > 0) applyBreath(target, IN.breath, OUTX.breathW);
      // Cross-fade on clip changes, action restarts and phase jumps.
      const restarted = prevAct === p.act && p.act !== ActionKind.NONE && p.actT < prevActT;
      const jump = OUTX.action === 1 && anim === prevAnim && (sample.t < lastT[i]! - 0.02 || sample.t > lastT[i]! + LOCAL_TUNING.phaseJump);
      const out = poses[i]!;
      if (teleport) {
        blendT[i] = 0;
        blendDur[i] = 0;
      } else if (anim !== prevAnim || restarted || jump) {
        for (let k = 0; k < POSE_SIZE; k++) from[i]![k] = out[k]!;
        blendT[i] = 0;
        blendDur[i] = jump && anim === prevAnim && !restarted ? LOCAL_TUNING.blendJump : blendTime(prevAnim, anim, p.actContact, p.actT + alpha, p.actDone, OUTX.kick);
      }
      bank.anim[i] = anim;
      lastT[i] = sample.t;
      const dur = blendDur[i]!;
      let w = 1;
      if (dur > 0 && blendT[i]! < dur) w = smooth01(blendT[i]! / dur);
      blendT[i] = blendT[i]! + dt;
      bank.blend[i] = w;
      if (w >= 1) {
        for (let k = 0; k < POSE_SIZE; k++) out[k] = target[k]!;
      } else {
        const a = from[i]!;
        for (let k = 0; k < POSE_SIZE; k++) out[k] = a[k]! + (target[k]! - a[k]!) * w;
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
  let t: number;
  if (isLocomotion(a) && isLocomotion(b)) t = LOCAL_TUNING.blendLoco;
  else if (b >= AnimId.DIVE_LOW_L && b <= AnimId.DIVE_HIGH_R) t = LOCAL_TUNING.blendDive;
  else t = LOCAL_TUNING.blendAction;
  if (kick === 1 && contact >= 0 && done === 0) {
    const left = ((contact - u) / 60) * LOCAL_TUNING.blendBeforeContact;
    if (left < t) t = left > 0.03 ? left : 0.03;
  }
  return t;
}

/** The full driver as a PoseDriver for the player model (GFX-07 setPoseDriver). */
export function createAnimDriver(): AnimDriver {
  return createAnimator().driver;
}
