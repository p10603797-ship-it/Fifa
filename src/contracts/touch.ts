/**
 * Touch-layer internal contract (TCH squad). Lead-owned, frozen after Wave 0.
 *
 * Flow: pointer manager (TCH-01) routes each pointer to one control by zone -> controls (stick TCH-02,
 * buttons TCH-03/04, pitch gestures TCH-05, set-piece swipes TCH-06) write into a shared TouchIntentState
 * -> the mapper (TCH-07) converts intents into one InputFrame per tick using the sim context and the
 * section 9 tables -> overlay (TCH-09) draws controls from the same state.
 * All coordinates here are CSS pixels in screen space (y down).
 */

import type { GestureKind } from './enums';

/** Touch buttons. Attack and defence buttons share cluster slots (see CLUSTER_SLOT). */
export enum TouchButtonId {
  PASS = 0,
  THROUGH = 1,
  SHOOT = 2,
  /** Large attack button: hold sprint, tap skill. */
  SPRINT_SKILL = 3,
  /** Large defence button: tap tackle, hold sprint/press. */
  SPRINT_TACKLE = 4,
  /** Becomes CLEAR when a first-time clearance is on. */
  SLIDE = 5,
  SWITCH = 6,
  SECOND_DEF = 7,
  PAUSE = 8,
}

export const TOUCH_BUTTON_COUNT = 9;

/** Cluster slot geometry: BIG bottom right; LOW left of BIG; MID diagonal up-left; HIGH above BIG. */
export enum ClusterSlot {
  BIG = 0,
  LOW = 1,
  MID = 2,
  HIGH = 3,
}

/** Which slot each button occupies (attack: PASS low, THROUGH mid, SHOOT high; defence: SWITCH low, 2ND DEF mid, SLIDE high). */
export const CLUSTER_SLOT: Readonly<Record<TouchButtonId, ClusterSlot | -1>> = {
  [TouchButtonId.PASS]: ClusterSlot.LOW,
  [TouchButtonId.THROUGH]: ClusterSlot.MID,
  [TouchButtonId.SHOOT]: ClusterSlot.HIGH,
  [TouchButtonId.SPRINT_SKILL]: ClusterSlot.BIG,
  [TouchButtonId.SPRINT_TACKLE]: ClusterSlot.BIG,
  [TouchButtonId.SLIDE]: ClusterSlot.HIGH,
  [TouchButtonId.SWITCH]: ClusterSlot.LOW,
  [TouchButtonId.SECOND_DEF]: ClusterSlot.MID,
  [TouchButtonId.PAUSE]: -1,
};

/** Which button set the right cluster shows. Chosen by the mapper from sim context each frame. */
export enum ClusterMode {
  ATTACK = 0,
  DEFENCE = 1,
  /** Own keeper holds the ball. */
  KEEPER = 2,
  /** A set piece where swipes from the ball are used (cluster may still show PASS). */
  SET_PIECE = 3,
  /** Cut-scenes: cluster hidden, any tap = skip. */
  HIDDEN = 4,
}

export enum TouchEdge {
  /** Finger down on the button (pressed state shows within one frame). */
  DOWN = 0,
  /** Finger lifted after a hold or a tap. */
  UP = 1,
  /** Short press released without a swipe. */
  TAP = 2,
  /** Second tap within the double-tap window. */
  DOUBLE_TAP = 3,
  /** Swipe recognised (>= 24 pt travel) from a button; dir set. The finger may still be down. */
  SWIPE = 4,
  /** Hold passed the tap threshold. */
  HOLD = 5,
  /** Pointer cancelled (system gesture, blur) — treat as release without action. */
  CANCEL = 6,
}

export enum SwipeDir {
  NONE = 0,
  UP = 1,
  DOWN = 2,
  LEFT = 3,
  RIGHT = 4,
}

export interface TouchButtonEvent {
  button: TouchButtonId;
  edge: TouchEdge;
  dir: SwipeDir;
  /** performance.now() ms */
  tMs: number;
  /** Cluster mode the button belonged to when the finger went down (a thumb keeps its meaning until it lifts). */
  mode: ClusterMode;
}

export interface TouchGestureEvent {
  kind: GestureKind;
  /** Start and end, CSS px. */
  sx: number; sy: number;
  ex: number; ey: number;
  /** End velocity px/ms. */
  vx: number; vy: number;
  /** -1..1 signed curvature of the path (positive = bends clockwise on screen). */
  curve: number;
  tMs: number;
  /** Started on/near the ball's screen position. */
  fromBall: boolean;
}

export const TOUCH_QUEUE_SIZE = 32;

export interface TouchIntentState {
  // stick [TCH-02]
  stickActive: boolean;
  /** -1..1 screen space (x right, y down), already dead-zoned and radially clamped. */
  stickX: number;
  stickY: number;
  /** Stick centre (floating origin) and current thumb, CSS px, for the overlay. */
  stickOriginX: number; stickOriginY: number;
  stickThumbX: number; stickThumbY: number;
  /** Double-tap-and-hold on the stick: face-up strafe dribble. */
  stickStrafe: boolean;
  // buttons [TCH-03/04]
  /** Bitmask over TouchButtonId currently held down. */
  held: number;
  /** Down timestamp per button (ms), 0 when up. */
  downAt: number[];
  /** Event queue, drained by the mapper each tick. */
  buttonEvents: TouchButtonEvent[];
  buttonEventCount: number;
  // gestures [TCH-05/06]
  gestureEvents: TouchGestureEvent[];
  gestureEventCount: number;
  /** In-progress set-piece swipe path for the dotted preview (TCH-06), CSS px; count 0 = none. */
  previewCount: number;
  previewX: number[];
  previewY: number[];
  // context [TCH-07 writes, others read]
  mode: ClusterMode;
  /** 1 when the CLEAR variant replaces SLIDE. */
  clearOn: boolean;
  /** Power bar 0..1 shown on the pressed button (TCH-09 reads). */
  power: number;
  powerButton: TouchButtonId | -1;
  /** True while a controller drives this side (controls hidden until the next screen touch). */
  hiddenByPad: boolean;
}

export function createTouchIntentState(): TouchIntentState {
  return {
    stickActive: false, stickX: 0, stickY: 0, stickOriginX: 0, stickOriginY: 0, stickThumbX: 0, stickThumbY: 0, stickStrafe: false,
    held: 0, downAt: new Array<number>(9).fill(0),
    buttonEvents: Array.from({ length: TOUCH_QUEUE_SIZE }, () => ({ button: 0, edge: 0, dir: 0, tMs: 0, mode: 0 })),
    buttonEventCount: 0,
    gestureEvents: Array.from({ length: TOUCH_QUEUE_SIZE }, () => ({ kind: 0, sx: 0, sy: 0, ex: 0, ey: 0, vx: 0, vy: 0, curve: 0, tMs: 0, fromBall: false })),
    gestureEventCount: 0,
    previewCount: 0, previewX: new Array<number>(64).fill(0), previewY: new Array<number>(64).fill(0),
    mode: 0, clearOn: false, power: 0, powerButton: -1, hiddenByPad: false,
  };
}

/** Push a button event (drops the oldest on overflow). */
export function pushButtonEvent(s: TouchIntentState, button: TouchButtonId, edge: TouchEdge, dir: SwipeDir, tMs: number, mode: ClusterMode): void {
  if (s.buttonEventCount >= TOUCH_QUEUE_SIZE) {
    for (let i = 1; i < TOUCH_QUEUE_SIZE; i++) Object.assign(s.buttonEvents[i - 1]!, s.buttonEvents[i]!);
    s.buttonEventCount = TOUCH_QUEUE_SIZE - 1;
  }
  const e = s.buttonEvents[s.buttonEventCount++]!;
  e.button = button; e.edge = edge; e.dir = dir; e.tMs = tMs; e.mode = mode;
}

/** Push a pitch gesture (drops the oldest on overflow). */
export function pushGestureEvent(s: TouchIntentState, g: Omit<TouchGestureEvent, never>): void {
  if (s.gestureEventCount >= TOUCH_QUEUE_SIZE) {
    for (let i = 1; i < TOUCH_QUEUE_SIZE; i++) Object.assign(s.gestureEvents[i - 1]!, s.gestureEvents[i]!);
    s.gestureEventCount = TOUCH_QUEUE_SIZE - 1;
  }
  Object.assign(s.gestureEvents[s.gestureEventCount++]!, g);
}

/** A control that receives pointers from the pointer manager (TCH-01). */
export interface TouchControl {
  /** Return true to claim this pointer (hit test in CSS px). */
  hit(x: number, y: number): boolean;
  down(id: number, x: number, y: number, tMs: number): void;
  move(id: number, x: number, y: number, tMs: number): void;
  up(id: number, x: number, y: number, tMs: number): void;
  /** pointercancel / lost capture / blur: release without triggering an action. */
  cancel(id: number, tMs: number): void;
  /** Release everything held (visibility change, pause, possession swap of a lifted thumb). */
  releaseAll(tMs: number): void;
}
