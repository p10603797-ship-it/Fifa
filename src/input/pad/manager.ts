/**
 * [PAD-01] Gamepad manager (section 10 "Controller quality bar", section 3 "Controllers").
 *  - Polls navigator.getGamepads() once per animation frame (poll(nowMs) is idempotent per timestamp) and detects
 *    button edges (pressed vs prevPressed), never via timers.
 *  - A pad appears only after one of its buttons is pressed (`active`), as on iPadOS. Buttons 0..15 count (face,
 *    shoulders, triggers past T_PAD.triggerThreshold, Create/Options, L3/R3, D-pad); sticks never activate a pad.
 *    A tap shorter than a frame is not lost: the `gamepadconnected` event that a first press raises carries the
 *    pressed snapshot, and the next poll activates that pad even when the button is already up again.
 *  - Identity: each physical pad gets a slot with a stable device key 'pad:<n>' (n = 1, 2, ... in order of first
 *    sighting this page session) and an `instance` number among pads with the same gamepad.id (two identical pads:
 *    1 and 2). Matching each poll: same gamepad.id at the same index first; then, by gamepad.id, a slot that moved
 *    or reconnected (preferring the index it had before, then a pad that was already pressed). A pad that reconnects
 *    at a NEW index therefore re-attaches to its old slot and keeps its key and binding.
 *  - Connection changes come from the polling diff (the source of truth) and from `gamepadconnected` /
 *    `gamepaddisconnected` (they re-check presence at once, without reading buttons, so no edge is consumed early).
 *    Listeners get 'connect' (first sighting), 'activate' (first press), 'disconnect' and 'reconnect' per slot via
 *    onPadEvent(); subscribe() fires when the list of active pads changes. Listeners run after the poll finished.
 *  - Sticks use a radial dead zone (T_PAD.deadInner 0.15, deadOuter 0.95, rescaled to 0..1). Triggers are analogue
 *    (value 0..1); their digital "pressed" bit engages past T_PAD.triggerThreshold (0.3) and releases at or below
 *    LOCAL_TUNING.triggerRelease (hysteresis: a trigger resting near 0.3 cannot chatter). A digital-only trigger
 *    (pressed with value 0) reads as value 1.
 *  - Home (16) and Share/touchpad (17) belong to iPadOS: they are ignored for activation and never reported.
 *  - A disconnect zeroes every button, trigger and stick of that slot at once (no stuck sprint or stick).
 * One shared manager per page (getPadManager()); tests create isolated ones with a mock getGamepads and an
 * EventTarget for the connection events.
 */

import { T_PAD, T_PAD_TRIGGER } from '../../contracts/tuning';
import { radialDeadZone } from '../axes';

const LOCAL_TUNING = T_PAD_TRIGGER; // [TUN-2] trigger hysteresis: contracts/tuning.ts T_PAD_TRIGGER

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
/** Buttons whose press activates a pad / counts as "any button" (0..15; never Home or Share). */
export const PAD_ACTIVATE_MASK = (1 << PAD_BUTTON_COUNT) - 1;
/** Trigger release level (see LOCAL_TUNING). */
export const PAD_TRIGGER_RELEASE = LOCAL_TUNING.triggerRelease;
/** At most this many slots are remembered; past it, a disconnected pad that was never pressed is recycled. */
export const MAX_PAD_SLOTS = 16;
/** getGamepads() entries looked at per poll. */
const MAX_LIST = 16;

/** One physical pad (persists across disconnect/reconnect). Fields update in place every poll. */
export interface PadSlot {
  /** Stable device id for the DeviceRegistry: 'pad:<n>' (n = 1, 2, ... in order of first appearance). */
  readonly key: string;
  /** gamepad.id string (vendor/product description). */
  readonly gamepadId: string;
  /** 1-based count of pads with this gamepad.id first seen this session (two identical pads: 1 and 2). */
  readonly instance: number;
  /** Current navigator.getGamepads() index, -1 while disconnected. */
  index: number;
  /** Index the pad had when it last disconnected (-1 if never). A reconnect prefers the slot with the same index. */
  lastIndex: number;
  connected: boolean;
  /** True once any button was pressed (the pad is then listed as a device). */
  active: boolean;
  /** Activation order this session: 1 = first pad pressed, 2 = second, ...; 0 while not active ("Controller N"). */
  ordinal: number;
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

/**
 * Per-slot connection events: 'connect' = first sighting of a physical pad (not listed yet), 'activate' = its first
 * button press (now listed), 'disconnect' / 'reconnect' = the slot went away / came back (same key).
 */
export type PadEventKind = 'connect' | 'activate' | 'disconnect' | 'reconnect';
export type PadEventListener = (kind: PadEventKind, slot: PadSlot) => void;

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
  /** Per-slot connection events (any slot, active or not). Returns an unsubscribe function. */
  onPadEvent(fn: PadEventListener): () => void;
  /** Key of the pad with the most recent input, or null. */
  readonly lastActiveKey: string | null;
  readonly lastActiveMs: number;
  /** Remove the gamepadconnected / gamepaddisconnected listeners and every subscriber. */
  dispose(): void;
}

export type GetGamepads = () => ArrayLike<Gamepad | null> | null | undefined;

export interface PadManagerOptions {
  /**
   * Where `gamepadconnected` / `gamepaddisconnected` are heard. Default: window when the browser's
   * navigator.getGamepads is used, none for a custom getGamepads. Null disables the listeners.
   */
  eventTarget?: EventTarget | null;
}

const EMPTY: ArrayLike<Gamepad | null> = [];

/** The browser's pad list. Throws when the API is blocked (the manager then skips that poll). */
function defaultGetGamepads(): ArrayLike<Gamepad | null> {
  if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') return navigator.getGamepads() ?? EMPTY;
  return EMPTY;
}

/** True when a Gamepad snapshot has one of buttons 0..15 down (Home / Share do not count). */
export function gamepadHasPress(gp: Gamepad | null | undefined): boolean {
  const btns = gp ? gp.buttons : null;
  if (!btns) return false;
  const n = Math.min(PAD_BUTTON_COUNT, btns.length);
  for (let b = 0; b < n; b++) {
    const btn = btns[b] as GamepadButton | number | null | undefined;
    if (typeof btn === 'number' ? btn > 0.5 : !!btn && btn.pressed === true) return true;
  }
  return false;
}

const stickOut = { x: 0, y: 0 };

function finite01(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function axis(ax: readonly number[] | null | undefined, i: number): number {
  if (!ax || ax.length <= i) return 0;
  const v = ax[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function createPadManager(getGamepads: GetGamepads = defaultGetGamepads, opts: PadManagerOptions = {}): PadManager {
  const slots: PadSlot[] = [];
  /** Per slot: matched during the current scan. */
  const seen: boolean[] = [];
  /** Per slot: activate at the next poll even without an edge (a first press seen only in a gamepadconnected event). */
  const pendingActivate: boolean[] = [];
  /** Per getGamepads() entry: the slot it was matched to in this scan (-1 none). */
  const slotOf: number[] = [];
  const subs: (() => void)[] = [];
  const evSubs: PadEventListener[] = [];
  /** Event queue, flushed after each scan (preallocated; grows only with the number of events in one scan). */
  const qKind: PadEventKind[] = [];
  const qSlot: PadSlot[] = [];
  let qLen = 0;
  let listChanged = false;
  let lastPollMs = -1;
  let lastActiveKey: string | null = null;
  let lastActiveMs = -1;
  let nextKey = 1;
  let activations = 0;
  /** gamepadconnected snapshot with a press, applied by the next scan that sees that pad. */
  let hintId: string | null = null;
  let hintIndex = -1;
  let disposed = false;

  function emit(kind: PadEventKind, s: PadSlot): void {
    qKind[qLen] = kind;
    qSlot[qLen] = s;
    qLen++;
    if (kind !== 'connect' && s.active) listChanged = true;
  }

  /** Dispatch queued events, then list-change subscribers. Every listener runs; the first error is rethrown after. */
  function flush(): void {
    if (qLen === 0 && !listChanged) return;
    const n = qLen;
    const kinds = n > 0 && evSubs.length > 0 ? qKind.slice(0, n) : null;
    const evSlots = kinds ? qSlot.slice(0, n) : null;
    qLen = 0;
    const changed = listChanged;
    listChanged = false;
    let failed = false;
    let firstErr: unknown = null;
    if (kinds && evSlots) {
      const ls = evSubs.slice();
      for (let e = 0; e < n; e++) {
        for (let j = 0; j < ls.length; j++) {
          try {
            ls[j]!(kinds[e]!, evSlots[e]!);
          } catch (err) {
            if (!failed) { failed = true; firstErr = err; }
          }
        }
      }
    }
    if (changed) {
      const ls = subs.slice();
      for (let j = 0; j < ls.length; j++) {
        try {
          ls[j]!();
        } catch (err) {
          if (!failed) { failed = true; firstErr = err; }
        }
      }
    }
    if (failed) throw firstErr;
  }

  function makeSlot(gp: Gamepad, index: number): PadSlot {
    let instance = 1;
    for (let k = 0; k < slots.length; k++) if (slots[k]!.gamepadId === gp.id) instance++;
    return {
      key: `pad:${nextKey++}`, gamepadId: gp.id, instance, index, lastIndex: -1, connected: true, active: false, ordinal: 0,
      standard: gp.mapping === 'standard', value: new Float32Array(PAD_BUTTON_COUNT), pressed: 0, prevPressed: 0,
      lx: 0, ly: 0, rx: 0, ry: 0, lastInputMs: -1, pad: gp,
    };
  }

  /** New slot for a first-seen pad; recycles a never-pressed disconnected slot at the cap. -1 when full. */
  function addSlot(gp: Gamepad, index: number): number {
    if (slots.length < MAX_PAD_SLOTS) {
      slots.push(makeSlot(gp, index));
      seen.push(false);
      pendingActivate.push(false);
      return slots.length - 1;
    }
    for (let k = 0; k < slots.length; k++) {
      const s = slots[k]!;
      if (s.connected || s.active || seen[k]) continue;
      slots[k] = makeSlot(gp, index);
      pendingActivate[k] = false;
      return k;
    }
    return -1;
  }

  function entryIndex(gp: Gamepad, i: number): number {
    const idx = gp.index;
    return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 ? idx : i;
  }

  function read(s: PadSlot, gp: Gamepad, nowMs: number): void {
    s.prevPressed = s.pressed;
    let pressed = 0;
    const btns = gp.buttons;
    const n = btns ? Math.min(PAD_BUTTON_COUNT, btns.length) : 0;
    for (let b = 0; b < PAD_BUTTON_COUNT; b++) {
      let value = 0;
      let down = false;
      if (b < n) {
        const btn = btns[b] as GamepadButton | number | null | undefined;
        if (typeof btn === 'number') {
          value = finite01(btn);
          down = btn > 0.5;
        } else if (btn) {
          value = finite01(btn.value);
          down = btn.pressed === true;
        }
      }
      if (down && value === 0) value = 1; // digital-only button or trigger
      if (b === PadButton.L2 || b === PadButton.R2) {
        const wasDown = (s.prevPressed & (1 << b)) !== 0;
        down = value > (wasDown ? LOCAL_TUNING.triggerRelease : T_PAD.triggerThreshold);
      }
      s.value[b] = value;
      if (down) pressed |= 1 << b;
    }
    s.pressed = pressed;
    const ax = gp.axes;
    radialDeadZone(axis(ax, 0), axis(ax, 1), T_PAD.deadInner, T_PAD.deadOuter, stickOut);
    s.lx = stickOut.x; s.ly = stickOut.y;
    radialDeadZone(axis(ax, 2), axis(ax, 3), T_PAD.deadInner, T_PAD.deadOuter, stickOut);
    s.rx = stickOut.x; s.ry = stickOut.y;
    const edge = pressed & ~s.prevPressed & PAD_ACTIVATE_MASK;
    const moved = s.lx !== 0 || s.ly !== 0 || s.rx !== 0 || s.ry !== 0;
    if (edge !== 0 || moved) {
      s.lastInputMs = nowMs;
      if (s.active) { lastActiveKey = s.key; lastActiveMs = nowMs; }
    }
  }

  function activate(s: PadSlot, nowMs: number): void {
    s.active = true;
    s.ordinal = ++activations;
    s.lastInputMs = nowMs;
    lastActiveKey = s.key;
    lastActiveMs = nowMs;
    emit('activate', s);
  }

  function release(s: PadSlot): void {
    s.connected = false;
    s.lastIndex = s.index;
    s.index = -1;
    s.pad = null;
    s.prevPressed = s.pressed;
    s.pressed = 0;
    s.value.fill(0);
    s.lx = 0; s.ly = 0; s.rx = 0; s.ry = 0;
    emit('disconnect', s);
  }

  /**
   * Match the pad list to slots. readInputs: read buttons/sticks and activate (animation-frame poll); false only
   * re-checks presence (connection events), so button edges are left for the next poll.
   */
  function scan(nowMs: number, readInputs: boolean): void {
    let list: ArrayLike<Gamepad | null>;
    try {
      list = getGamepads() ?? EMPTY;
    } catch {
      return; // API blocked or failing this frame: keep the last known state (no spurious disconnects)
    }
    const len = Math.min(MAX_LIST, list.length >>> 0);
    while (slotOf.length < len) slotOf.push(-1);
    for (let k = 0; k < slots.length; k++) seen[k] = false;
    // Pass 1: the same pad at the same index.
    for (let i = 0; i < len; i++) {
      slotOf[i] = -1;
      const gp = list[i];
      if (!gp || gp.connected === false) continue;
      const idx = entryIndex(gp, i);
      for (let k = 0; k < slots.length; k++) {
        const s = slots[k]!;
        if (s.connected && !seen[k] && s.index === idx && s.gamepadId === gp.id) {
          seen[k] = true;
          slotOf[i] = k;
          break;
        }
      }
    }
    // Pass 2: moved, reconnected or new pads, matched by gamepad.id.
    for (let i = 0; i < len; i++) {
      if (slotOf[i]! >= 0) continue;
      const gp = list[i];
      if (!gp || gp.connected === false) continue;
      const idx = entryIndex(gp, i);
      let best = -1;
      let bestScore = -1;
      for (let k = 0; k < slots.length; k++) {
        const s = slots[k]!;
        if (seen[k] || s.gamepadId !== gp.id) continue;
        const score = (s.connected ? 8 : 0) + ((s.connected ? s.index : s.lastIndex) === idx ? 4 : 0) + (s.active ? 2 : 0);
        if (score > bestScore) { best = k; bestScore = score; }
      }
      if (best >= 0) {
        const s = slots[best]!;
        s.index = idx;
        if (!s.connected) {
          s.connected = true;
          s.prevPressed = 0;
          s.pressed = 0;
          emit('reconnect', s);
        }
      } else {
        best = addSlot(gp, idx);
        if (best < 0) continue;
        emit('connect', slots[best]!);
      }
      seen[best] = true;
      slotOf[i] = best;
    }
    // Read the matched pads.
    for (let i = 0; i < len; i++) {
      const k = slotOf[i]!;
      if (k < 0) continue;
      const gp = list[i]!;
      const s = slots[k]!;
      s.pad = gp;
      s.standard = gp.mapping === 'standard';
      if (hintId !== null && hintId === gp.id && hintIndex === s.index) {
        pendingActivate[k] = true;
        hintId = null;
      }
      if (!readInputs) continue;
      read(s, gp, nowMs);
      if (!s.active && ((s.pressed & ~s.prevPressed & PAD_ACTIVATE_MASK) !== 0 || pendingActivate[k])) activate(s, nowMs);
      pendingActivate[k] = false;
    }
    if (readInputs) hintId = null;
    // Pads that went away.
    for (let k = 0; k < slots.length; k++) {
      const s = slots[k]!;
      if (s.connected && !seen[k]) {
        release(s);
        pendingActivate[k] = false;
      }
    }
    flush();
  }

  const onConnected = (e: Event): void => {
    if (disposed) return;
    const gp = (e as Partial<GamepadEvent>).gamepad;
    if (gp && typeof gp.id === 'string' && gamepadHasPress(gp)) {
      hintId = gp.id;
      hintIndex = typeof gp.index === 'number' ? gp.index : -1;
    }
    scan(lastPollMs, false);
  };
  const onDisconnected = (): void => {
    if (disposed) return;
    scan(lastPollMs, false);
  };
  const target: EventTarget | null = opts.eventTarget !== undefined
    ? opts.eventTarget
    : getGamepads === defaultGetGamepads && typeof window !== 'undefined' ? window : null;
  if (target) {
    target.addEventListener('gamepadconnected', onConnected);
    target.addEventListener('gamepaddisconnected', onDisconnected);
  }

  const api: PadManager = {
    get lastPollMs() { return lastPollMs; },
    get lastActiveKey() { return lastActiveKey; },
    get lastActiveMs() { return lastActiveMs; },
    slots,
    poll(nowMs: number) {
      if (nowMs === lastPollMs || disposed) return;
      lastPollMs = nowMs;
      scan(nowMs, true);
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
    onPadEvent(fn: PadEventListener) {
      evSubs.push(fn);
      return () => {
        const i = evSubs.indexOf(fn);
        if (i >= 0) evSubs.splice(i, 1);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (target) {
        target.removeEventListener('gamepadconnected', onConnected);
        target.removeEventListener('gamepaddisconnected', onDisconnected);
      }
      subs.length = 0;
      evSubs.length = 0;
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

/** True when button `b` went up at the last poll (also at a disconnect while it was held). */
export function padReleasedEdge(s: PadSlot, b: number): boolean {
  return (s.pressed & (1 << b)) === 0 && (s.prevPressed & (1 << b)) !== 0;
}

/** True when any of buttons 0..15 went down at the last poll ("any pad button", e.g. resume after a reconnect). */
export function padAnyPressedEdge(s: PadSlot): boolean {
  return (s.pressed & ~s.prevPressed & PAD_ACTIVATE_MASK) !== 0;
}

/** True while button `b` is down. */
export function padDown(s: PadSlot, b: number): boolean {
  return (s.pressed & (1 << b)) !== 0;
}
