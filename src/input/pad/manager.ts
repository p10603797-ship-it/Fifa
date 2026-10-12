/**
 * [PAD-01] Gamepad manager (section 10 "Controller quality bar", section 3 "Controllers").
 *  - Polls navigator.getGamepads() once per animation frame (poll(nowMs) is idempotent per timestamp), detects
 *    button edges (pressed vs prevPressed), never via timers.
 *  - A pad appears only after one of its buttons is pressed (`active`), as on iPadOS.
 *  - Identity: a slot is matched by gamepad.id + index. When a pad disconnects and reconnects at a NEW index with
 *    the same gamepad.id it re-attaches to its old slot, so its device id (`key`) and binding are kept.
 *  - Sticks use a radial dead zone (T_PAD.deadInner 0.15, deadOuter 0.95, rescaled). Triggers are analogue
 *    (value 0..1); their digital "pressed" bit uses T_PAD.triggerThreshold (0.3).
 *  - Home (16) and Share/touchpad (17) belong to iPadOS: they are ignored for activation and never reported.
 * One shared manager per page (getPadManager()); tests create isolated ones with a mock getGamepads.
 *
 * WAVE 0 BASELINE (FND-05). PAD-01 owns and refines it.
 */

import { T_PAD } from '../../contracts/tuning';
import { radialDeadZone } from '../axes';

/** Standard Gamepad mapping indices (section 10). */
export const PadButton = {
  /** Cross / A */ SOUTH: 0,
  /** Circle / B */ EAST: 1,
  /** Square / X */ WEST: 2,
  /** Triangle / Y */ NORTH: 3,
  L1: 4, R1: 5, L2: 6, R2: 7,
  /** Create / View */ SELECT: 8,
  /** Options / Menu */ START: 9,
  L3: 10, R3: 11,
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15,
} as const;

/** Buttons tracked (0..15). 16 (Home) and above are ignored. */
export const PAD_BUTTON_COUNT = 16;

/** One physical pad (persists across disconnect/reconnect). Fields update in place every poll. */
export interface PadSlot {
  /** Stable device id for the DeviceRegistry: 'pad:<n>' (n = 1, 2, ... in order of first appearance). */
  readonly key: string;
  /** gamepad.id string (vendor/product description). */
  readonly gamepadId: string;
  /** Current navigator.getGamepads() index, -1 while disconnected. */
  index: number;
  connected: boolean;
  /** True once any button was pressed (the pad is then listed as a device). */
  active: boolean;
  /** gamepad.mapping === 'standard'. */
  standard: boolean;
  /** Analogue value 0..1 per button (index = standard mapping). */
  readonly value: Float32Array;
  /** Bitmask of buttons down at the last poll (bit i = button i). Triggers use T_PAD.triggerThreshold. */
  pressed: number;
  /** Bitmask at the previous poll. Edge: pressed & ~prevPressed. */
  prevPressed: number;
  /** Dead-zoned sticks, -1..1, y down (Gamepad API convention: up is negative). */
  lx: number; ly: number;
  rx: number; ry: number;
  /** performance.now()-style timestamp (ms) of the last button press or stick deflection. */
  lastInputMs: number;
  /** The Gamepad object from the last poll (vibrationActuator for rumble). Null while disconnected. */
  pad: Gamepad | null;
}

export interface PadManager {
  /** Poll once per animation frame. Repeated calls with the same nowMs do nothing. */
  poll(nowMs: number): void;
  /** Timestamp of the last poll (ms), -1 before the first. */
  readonly lastPollMs: number;
  /** Every slot seen so far (connected or not, active or not). Do not mutate. */
  readonly slots: readonly PadSlot[];
  /** Slot by device key, or null. */
  find(key: string): PadSlot | null;
  /** Called when a pad becomes active, disconnects or reconnects. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
  /** Key of the pad with the most recent input, or null. */
  readonly lastActiveKey: string | null;
  readonly lastActiveMs: number;
}

export type GetGamepads = () => ArrayLike<Gamepad | null>;

const ACTIVATE_MASK = (1 << PAD_BUTTON_COUNT) - 1;

function defaultGetGamepads(): ArrayLike<Gamepad | null> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') return navigator.getGamepads() ?? [];
  } catch {
    // Not a secure context or blocked by permissions policy.
  }
  return [];
}

const stickOut = { x: 0, y: 0 };

export function createPadManager(getGamepads: GetGamepads = defaultGetGamepads): PadManager {
  const slots: PadSlot[] = [];
  const seen: boolean[] = [];
  const subs: (() => void)[] = [];
  let lastPollMs = -1;
  let lastActiveKey: string | null = null;
  let lastActiveMs = -1;
  let nextOrdinal = 1;

  function notify(): void {
    for (let i = 0; i < subs.length; i++) subs[i]!();
  }

  function newSlot(gp: Gamepad, index: number): PadSlot {
    const s: PadSlot = {
      key: `pad:${nextOrdinal++}`, gamepadId: gp.id, index, connected: true, active: false, standard: gp.mapping === 'standard',
      value: new Float32Array(PAD_BUTTON_COUNT), pressed: 0, prevPressed: 0, lx: 0, ly: 0, rx: 0, ry: 0, lastInputMs: -1, pad: gp,
    };
    slots.push(s);
    seen.push(false);
    return s;
  }

  /** Set by match(): true when the matched slot was re-attached (a reconnect of an active pad). */
  let matchReconnected = false;

  /**
   * Index of the slot for a Gamepad at navigator index `index`: same id at the same index, else a disconnected slot
   * with the same gamepad.id (reconnect, preferring the old index). -1 when it is a new pad. No allocation.
   */
  function match(gp: Gamepad, index: number): number {
    matchReconnected = false;
    for (let k = 0; k < slots.length; k++) {
      const s = slots[k]!;
      if (s.connected && s.index === index && s.gamepadId === gp.id) return k;
    }
    let best = -1;
    for (let k = 0; k < slots.length; k++) {
      const s = slots[k]!;
      if (s.connected || s.gamepadId !== gp.id) continue;
      if (best < 0 || s.index === index) best = k;
    }
    if (best >= 0) {
      const s = slots[best]!;
      s.connected = true;
      s.index = index;
      matchReconnected = s.active;
    }
    return best;
  }

  function read(s: PadSlot, gp: Gamepad, nowMs: number): void {
    s.pad = gp;
    s.standard = gp.mapping === 'standard';
    s.prevPressed = s.pressed;
    let pressed = 0;
    const btns = gp.buttons;
    const n = Math.min(PAD_BUTTON_COUNT, btns ? btns.length : 0);
    for (let b = 0; b < PAD_BUTTON_COUNT; b++) {
      let value = 0;
      let down = false;
      if (b < n) {
        const btn = btns[b] as GamepadButton | number | undefined;
        if (typeof btn === 'number') { value = btn; down = btn > 0.5; }
        else if (btn) { value = Number.isFinite(btn.value) ? btn.value : 0; down = btn.pressed === true; }
      }
      if (b === PadButton.L2 || b === PadButton.R2) down = value > T_PAD.triggerThreshold || (down && value === 0);
      s.value[b] = value < 0 ? 0 : value > 1 ? 1 : value;
      if (down) pressed |= 1 << b;
    }
    s.pressed = pressed;
    const ax = gp.axes;
    const a0 = ax && ax.length > 0 ? ax[0]! : 0, a1 = ax && ax.length > 1 ? ax[1]! : 0;
    const a2 = ax && ax.length > 2 ? ax[2]! : 0, a3 = ax && ax.length > 3 ? ax[3]! : 0;
    radialDeadZone(a0, a1, T_PAD.deadInner, T_PAD.deadOuter, stickOut);
    s.lx = stickOut.x; s.ly = stickOut.y;
    radialDeadZone(a2, a3, T_PAD.deadInner, T_PAD.deadOuter, stickOut);
    s.rx = stickOut.x; s.ry = stickOut.y;
    const edge = pressed & ~s.prevPressed & ACTIVATE_MASK;
    const moved = s.lx !== 0 || s.ly !== 0 || s.rx !== 0 || s.ry !== 0;
    if (edge !== 0 || moved) {
      s.lastInputMs = nowMs;
      if (s.active || edge !== 0) { lastActiveKey = s.key; lastActiveMs = nowMs; }
    }
  }

  function release(s: PadSlot): void {
    s.connected = false;
    s.index = -1;
    s.pad = null;
    s.prevPressed = s.pressed;
    s.pressed = 0;
    s.value.fill(0);
    s.lx = 0; s.ly = 0; s.rx = 0; s.ry = 0;
  }

  const api: PadManager = {
    get lastPollMs() { return lastPollMs; },
    get lastActiveKey() { return lastActiveKey; },
    get lastActiveMs() { return lastActiveMs; },
    slots,
    poll(nowMs: number) {
      if (nowMs === lastPollMs) return;
      lastPollMs = nowMs;
      let changed = false;
      for (let k = 0; k < seen.length; k++) seen[k] = false;
      const list = getGamepads();
      const len = list ? list.length : 0;
      for (let i = 0; i < len; i++) {
        const gp = list[i];
        if (!gp || gp.connected === false) continue;
        const idx = Number.isInteger(gp.index) ? gp.index : i;
        let k = match(gp, idx);
        if (k < 0) {
          newSlot(gp, idx);
          k = slots.length - 1;
        } else if (matchReconnected) {
          changed = true;
        }
        seen[k] = true;
        const slot = slots[k]!;
        const wasActive = slot.active;
        read(slot, gp, nowMs);
        if (!wasActive && (slot.pressed & ~slot.prevPressed & ACTIVATE_MASK) !== 0) {
          slot.active = true;
          lastActiveKey = slot.key;
          lastActiveMs = nowMs;
          changed = true;
        }
      }
      for (let k = 0; k < slots.length; k++) {
        const s = slots[k]!;
        if (s.connected && !seen[k]) {
          release(s);
          if (s.active) changed = true;
        }
      }
      if (changed) notify();
    },
    find(key: string) {
      for (let k = 0; k < slots.length; k++) if (slots[k]!.key === key) return slots[k]!;
      return null;
    },
    subscribe(fn: () => void) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
  };
  return api;
}

let shared: PadManager | null = null;

/** The page-wide pad manager (menus, the device registry and pad sources all poll this one). */
export function getPadManager(): PadManager {
  if (!shared) shared = createPadManager();
  return shared;
}

/** True when button `b` went down at the last poll. */
export function padPressedEdge(s: PadSlot, b: number): boolean {
  return (s.pressed & (1 << b)) !== 0 && (s.prevPressed & (1 << b)) === 0;
}

/** True while button `b` is down. */
export function padDown(s: PadSlot, b: number): boolean {
  return (s.pressed & (1 << b)) !== 0;
}
