/**
 * InputFrame: the one input format for every device (ARCHITECTURE rule 2).
 * Touch, controller, keyboard, network peer and CPU all produce one InputFrame per tick
 * for the controller they drive. sim never knows which device produced it.
 *
 * Every field is an integer so frames serialise, replay and travel over the network exactly.
 *
 * Directions are in PITCH space, not screen space: +x along the pitch toward the right of
 * the broadcast camera, +z toward the camera (screen down). The input layer converts screen
 * directions using the active camera (for the broadcast camera: stick right -> +x, stick down -> +z).
 *
 * Buttons are POSITIONAL-SEMANTIC (EA FC Classic layout): each bit is one physical role whose
 * meaning the sim resolves from context (attacking, defending, keeper in hands, set piece).
 * Holds, double-taps, combos, power bars and buffering are resolved inside sim from button edges.
 */

import { Command, GestureKind, SkillMove } from './enums';

/** Button bits. Aliases name the meaning in each context; they share a bit with their pad position. */
export const Btn = {
  /** Cross / A. Attack: ground pass, header. Defence: contain (hold). Keeper: throw. */
  PASS: 1 << 0,
  /** Circle / B. Attack: shoot, volley, header. Defence: tackle, push/pull, shoulder, clearance. */
  SHOOT: 1 << 1,
  /** Square / X. Attack: lob pass, cross, header. Defence: slide tackle, quick get-up. */
  LOB: 1 << 2,
  /** Triangle / Y. Attack: through ball. Defence: keeper rush (hold). Keeper: drop ball. */
  THROUGH: 1 << 3,
  /** L1 / LB. Attack: chip modifier, trigger run (tap), strafe dribble. Defence: change player. */
  MOD_L: 1 << 4,
  /** R1 / RB. Attack: finesse/driven modifier, call for support (tap), controlled sprint. Defence: second defender (hold). */
  MOD_R: 1 << 5,
  /** L2 / LT. Shield (attack) / jockey (defence). */
  SHIELD: 1 << 6,
  /** R2 / RT. Sprint. Free kick: choose taker. */
  SPRINT: 1 << 7,
  /** Edge: right stick flicked past the flick threshold this tick; direction in ax/az. */
  RS_FLICK: 1 << 8,
  /** Edge: skip the current cut-scene (celebration, replay, establishing shot). */
  SKIP: 1 << 9,
  /** Held: right stick held past the hold threshold (directional switch aim / free-kick curl). */
  RS_HOLD: 1 << 10,
} as const;

/** Context aliases (same bits). */
export const BtnAlias = {
  CONTAIN: Btn.PASS,
  TACKLE: Btn.SHOOT,
  SLIDE: Btn.LOB,
  KEEPER_RUSH: Btn.THROUGH,
  CHIP: Btn.MOD_L,
  SWITCH: Btn.MOD_L,
  TRIGGER_RUN: Btn.MOD_L,
  FINESSE: Btn.MOD_R,
  SECOND_DEF: Btn.MOD_R,
  CALL_SUPPORT: Btn.MOD_R,
  JOCKEY: Btn.SHIELD,
} as const;

/** Number of button bits with hold/edge tracking in the sim (bits 0..7 = the eight pad buttons). */
export const TRACKED_BUTTONS = 8;

/** Quantisation scale for analogue axes: value / AXIS_SCALE is in [-1, 1]. */
export const AXIS_SCALE = 127;
/** Quantisation scale for 0..1 values (power). */
export const UNIT_SCALE = 127;
/** Gesture positions are in decimetres. */
export const GESTURE_POS_SCALE = 10;

export interface InputFrame {
  /** Movement, pitch space, -127..127 each. Magnitude <= 127 (radial). */
  mx: number;
  mz: number;
  /** Aim / right stick, pitch space, -127..127. */
  ax: number;
  az: number;
  /** Btn bitfield. */
  buttons: number;
  /**
   * Explicit power for an action press in this frame, 0..127. 0 = derive power from hold time.
   * Used by touch swipes, gestures and set-piece swipes.
   */
  power: number;
  /** Curl for finesse / set pieces, -127..127 (positive = curls toward +z when kicking toward +x). */
  curve: number;
  /** Skill move requested this tick (edge), SkillMove. Direction is taken from mx/mz (or facing if zero). */
  skill: SkillMove;
  /** Command edge this tick (tactics, substitution, skip). */
  cmd: Command;
  cmdArg: number;
  /** Pitch gesture edge this tick. */
  gesture: GestureKind;
  /** Gesture target point in decimetres (pitch space). */
  gx: number;
  gz: number;
  /** Gesture target player slot (0..21) or -1. */
  gSlot: number;
  /** Swipe direction, pitch space, -127..127. */
  gdx: number;
  gdz: number;
  /** Swipe speed / strength 0..127. */
  gPower: number;
  /** Swipe curvature -127..127. */
  gCurve: number;
  /** Gesture flags (GestureFlag bits). */
  gFlags: number;
}

export const GestureFlag = {
  /** Gesture started on or near the ball (set-piece swipes). */
  FROM_BALL: 1 << 0,
  /** Target point is on the opposition goal mouth. */
  ON_GOAL: 1 << 1,
  /** Target point is on the player's own keeper. */
  ON_OWN_KEEPER: 1 << 2,
} as const;

/** Field order for serialisation, hashing and the network codec. Never reorder. */
export const INPUT_FIELDS = [
  'mx', 'mz', 'ax', 'az', 'buttons', 'power', 'curve', 'skill', 'cmd', 'cmdArg',
  'gesture', 'gx', 'gz', 'gSlot', 'gdx', 'gdz', 'gPower', 'gCurve', 'gFlags',
] as const satisfies readonly (keyof InputFrame)[];

export function createInputFrame(): InputFrame {
  return {
    mx: 0, mz: 0, ax: 0, az: 0, buttons: 0, power: 0, curve: 0, skill: SkillMove.NONE, cmd: Command.NONE, cmdArg: 0,
    gesture: GestureKind.NONE, gx: 0, gz: 0, gSlot: -1, gdx: 0, gdz: 0, gPower: 0, gCurve: 0, gFlags: 0,
  };
}

/** Reset a frame to neutral in place (no allocation). */
export function clearInputFrame(f: InputFrame): void {
  f.mx = 0; f.mz = 0; f.ax = 0; f.az = 0; f.buttons = 0; f.power = 0; f.curve = 0;
  f.skill = SkillMove.NONE; f.cmd = Command.NONE; f.cmdArg = 0;
  f.gesture = GestureKind.NONE; f.gx = 0; f.gz = 0; f.gSlot = -1; f.gdx = 0; f.gdz = 0; f.gPower = 0; f.gCurve = 0; f.gFlags = 0;
}

export function copyInputFrame(dst: InputFrame, src: InputFrame): void {
  for (let i = 0; i < INPUT_FIELDS.length; i++) {
    const k = INPUT_FIELDS[i]!;
    (dst as unknown as Record<string, number>)[k] = (src as unknown as Record<string, number>)[k]!;
  }
}

/** Quantise a float in [-1,1] to an axis integer. Safe for device layers (not used inside sim). */
export const quantAxis = (v: number): number => Math.max(-AXIS_SCALE, Math.min(AXIS_SCALE, Math.round(v * AXIS_SCALE)));
/** Quantise a float in [0,1]. */
export const quantUnit = (v: number): number => Math.max(0, Math.min(UNIT_SCALE, Math.round(v * UNIT_SCALE)));
/** Quantise metres to gesture decimetres. */
export const quantPos = (m: number): number => Math.round(m * GESTURE_POS_SCALE);

/**
 * Anything that fills an InputFrame each tick. Implemented by touch (TCH-07), pads (PAD-02..06),
 * keyboard (PAD-08), network peers (NET-01) and replays (FND-06).
 */
export interface InputSource {
  readonly id: string;
  readonly kind: 'touch' | 'pad' | 'keyboard' | 'net' | 'replay' | 'none';
  /** Fill `out` for the coming tick. Must not allocate. `ctx` is read-only context. */
  sample(out: InputFrame, ctx: InputSampleContext): void;
  /** Release every held input (pointercancel, blur, visibility change, pause, possession swap). */
  releaseAll(): void;
  /** Optional per-animation-frame poll (gamepads). */
  pollFrame?(nowMs: number): void;
  dispose(): void;
}

/** Read-only context handed to input sources when sampling. */
export interface InputSampleContext {
  /** Sim tick about to be simulated. */
  readonly tick: number;
  /** Which human controller index (0 = P1, 1 = P2) this source drives. */
  readonly human: number;
  /** Side this human plays for (0 home, 1 away). */
  readonly side: number;
  /** Read-only view of the current sim state (for attack/defence context and gestures). */
  readonly state: import('./state').SimState;
  /** Screen <-> pitch projection from the active camera (for gestures). May be null headless. */
  readonly projector: CameraProjector | null;
}

/** Provided by render (GFX-14) for input mapping and UI anchoring. */
export interface CameraProjector {
  /** Screen CSS pixels -> pitch point on the ground plane (y = 0). Returns false if the ray misses. */
  screenToPitch(sx: number, sy: number, out: { x: number; z: number }): boolean;
  /** Pitch point (x, y, z) -> screen CSS pixels. Returns false if behind the camera. */
  pitchToScreen(x: number, y: number, z: number, out: { x: number; y: number }): boolean;
  /**
   * Rotation (radians) from screen axes to pitch axes for stick mapping: stick (sx, sy) maps to
   * pitch (cos*sx - sin*sy, sin*sx + cos*sy). 0 for the broadcast camera.
   */
  stickRotation(): number;
}
