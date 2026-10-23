/**
 * [PAD-08] Menu input: pads + keyboard -> MenuAction for the FocusNavigator, with an initial delay and repeat for
 * held directions (section 10 "Menus: Confirm; back; move; switch tab": Cross / A, Circle / B, D-pad or left stick,
 * L1 and R1 / LB and RB; "Any: Pause: Options / Menu").
 *
 *   Pad (standard mapping)       Keyboard                      MenuAction
 *   D-pad / left stick           Arrows / WASD                 UP DOWN LEFT RIGHT (repeat while held)
 *   0 Cross / A                  Enter / Space / J             CONFIRM
 *   1 Circle / B                 Escape / Backspace / K        BACK
 *   4 L1 / LB                    Q / PageUp                    TAB_PREV
 *   5 R1 / RB                    E / PageDown                  TAB_NEXT
 *   9 Options / Menu             P                             START -> opts.onPause()
 *
 * poll(nowMs) runs once per animation frame from the app loop (it also polls the shared pad manager, which is how
 * pads become known to the DeviceRegistry while in menus). Every connected pad that has been pressed once counts
 * (several pads at once are merged); a non-standard pad with a saved remap (settings.controls.pad.remaps, PAD-07) is
 * read through it (PASS = Confirm, SHOOT = Back, MOD_L / MOD_R = tabs, PAUSE = Options, DPAD_* = directions).
 * Home and Share are never read.
 *
 * Timing: a direction fires on its press, again after MENU_REPEAT_DELAY_MS while held, then every
 * MENU_REPEAT_INTERVAL_MS (the same count at 60 and 120 Hz; the schedule never drifts with the frame rate). Repeats
 * reach the navigator through its handleRepeat (focus.ts) when it has one, so a held direction never runs past the
 * control it acts on (QF-3 QA-30). The left
 * stick counts as a direction past MENU_STICK_THRESHOLD on its dominant axis and lets go below MENU_STICK_RELEASE
 * (hysteresis: a stick resting near the threshold cannot chatter; a diagonal never fires two directions).
 *
 * Keyboard presses are queued in press order between polls, so every physical press is one action even when several
 * land inside one frame (Enter then ArrowDown in one frame: CONFIRM, then DOWN). Typing in a text field is ignored
 * except Escape; key auto-repeat is ignored (the repeat machine owns held keys); keys with Ctrl / Alt / Cmd (browser
 * shortcuts) are ignored. Mapped keys are preventDefault-ed (no page scroll, no native slider step on top of the
 * navigator's adjust). Blur, a hidden page and the release of Cmd forget every held key (no runaway repeat).
 */

import { MenuAction, type FocusNavigator } from '../contracts/app';
import type { Settings } from '../contracts/settings';
import { T_MENU_INPUT } from '../contracts/tuning';
import { dirKeyBit, dirsFromKeyMask, isEditableTarget, isMetaCode } from './keyboard';
import { getPadManager, PAD_BUTTON_COUNT, PadButton, type PadManager, type PadSlot } from './pad/manager';
import { PAD_ACTION_COUNT, PadAction, resolvePadRemap } from './pad/mapper';

const LOCAL_TUNING = T_MENU_INPUT; // [TUN-2] menu feel: contracts/tuning.ts T_MENU_INPUT

/** The LOCAL_TUNING block (read-only; tests). */
export const MENU_TUNING = LOCAL_TUNING;

/** Directional repeat: first repeat after this delay, then every interval (ms). */
export const MENU_REPEAT_DELAY_MS = LOCAL_TUNING.repeatDelayMs;
export const MENU_REPEAT_INTERVAL_MS = LOCAL_TUNING.repeatIntervalMs;
/** Left-stick deflection that counts as a direction in menus (and the level it lets go at). */
export const MENU_STICK_THRESHOLD = LOCAL_TUNING.stickEngage;
export const MENU_STICK_RELEASE = LOCAL_TUNING.stickRelease;

/** KeyboardEvent.code -> MenuAction. */
export const MENU_KEY_ACTIONS: Readonly<Record<string, MenuAction>> = {
  ArrowUp: MenuAction.UP, KeyW: MenuAction.UP,
  ArrowDown: MenuAction.DOWN, KeyS: MenuAction.DOWN,
  ArrowLeft: MenuAction.LEFT, KeyA: MenuAction.LEFT,
  ArrowRight: MenuAction.RIGHT, KeyD: MenuAction.RIGHT,
  Enter: MenuAction.CONFIRM, NumpadEnter: MenuAction.CONFIRM, Space: MenuAction.CONFIRM, KeyJ: MenuAction.CONFIRM,
  Escape: MenuAction.BACK, Backspace: MenuAction.BACK, KeyK: MenuAction.BACK,
  KeyQ: MenuAction.TAB_PREV, PageUp: MenuAction.TAB_PREV,
  KeyE: MenuAction.TAB_NEXT, PageDown: MenuAction.TAB_NEXT,
  KeyP: MenuAction.START,
};

/** Standard Gamepad button -> MenuAction (D-pad buttons are the directions). */
export const MENU_PAD_ACTIONS: readonly (readonly [number, MenuAction])[] = [
  [PadButton.SOUTH, MenuAction.CONFIRM],
  [PadButton.EAST, MenuAction.BACK],
  [PadButton.L1, MenuAction.TAB_PREV],
  [PadButton.R1, MenuAction.TAB_NEXT],
  [PadButton.START, MenuAction.START],
  [PadButton.DPAD_UP, MenuAction.UP],
  [PadButton.DPAD_DOWN, MenuAction.DOWN],
  [PadButton.DPAD_LEFT, MenuAction.LEFT],
  [PadButton.DPAD_RIGHT, MenuAction.RIGHT],
];

/** PadAction (remap slot) -> MenuAction, for pads read through a custom remap. */
const REMAP_ACTIONS: readonly (readonly [number, MenuAction])[] = [
  [PadAction.PASS, MenuAction.CONFIRM],
  [PadAction.SHOOT, MenuAction.BACK],
  [PadAction.MOD_L, MenuAction.TAB_PREV],
  [PadAction.MOD_R, MenuAction.TAB_NEXT],
  [PadAction.PAUSE, MenuAction.START],
  [PadAction.DPAD_UP, MenuAction.UP],
  [PadAction.DPAD_DOWN, MenuAction.DOWN],
  [PadAction.DPAD_LEFT, MenuAction.LEFT],
  [PadAction.DPAD_RIGHT, MenuAction.RIGHT],
];

const DIRS: readonly MenuAction[] = [MenuAction.UP, MenuAction.DOWN, MenuAction.LEFT, MenuAction.RIGHT];
/** Direction bits (bit i = DIRS[i] = MenuAction i). */
const DIR_MASK = 15;

/** Directional repeat state machine (pure, unit-testable). */
export interface RepeatState {
  /** Per direction (index in DIRS order): next fire time, -1 when not held. */
  next: number[];
}

export function createRepeatState(): RepeatState {
  return { next: [-1, -1, -1, -1] };
}

/**
 * Advance the repeat machine for held direction bits (bit i = DIRS[i]) at time nowMs; calls fire(action) for each
 * press edge and each repeat. `edgeBits` marks fresh presses since the last step (a second tap that lands before
 * the machine saw the first release still fires, and restarts the delay).
 */
export function stepRepeat(st: RepeatState, heldBits: number, nowMs: number, fire: (a: MenuAction, repeat?: boolean) => void, edgeBits = 0): void {
  for (let i = 0; i < 4; i++) {
    const held = (heldBits & (1 << i)) !== 0;
    const edge = (edgeBits & (1 << i)) !== 0;
    if (!held && !edge) { st.next[i] = -1; continue; }
    if (st.next[i] === -1 || edge) {
      fire(DIRS[i]!, false);
      st.next[i] = held ? nowMs + MENU_REPEAT_DELAY_MS : -1;
    } else if (nowMs >= st.next[i]! - LOCAL_TUNING.repeatSlackMs) {
      fire(DIRS[i]!, true);
      st.next[i] = Math.max(st.next[i]! + MENU_REPEAT_INTERVAL_MS, nowMs - MENU_REPEAT_INTERVAL_MS);
    }
  }
}

/**
 * Left-stick menu direction with hysteresis (pure): `cur` is the held direction (MenuAction 0..3) or -1. Keeps `cur`
 * while its component stays at or above MENU_STICK_RELEASE; otherwise the dominant axis past MENU_STICK_THRESHOLD,
 * else -1. Stick space: x right, y down (Gamepad API).
 */
export function stickMenuDir(cur: number, x: number, y: number): number {
  const fx = Number.isFinite(x) ? x : 0, fy = Number.isFinite(y) ? y : 0;
  if (cur >= 0) {
    const comp = cur === MenuAction.UP ? -fy : cur === MenuAction.DOWN ? fy : cur === MenuAction.LEFT ? -fx : cur === MenuAction.RIGHT ? fx : 0;
    if (comp >= LOCAL_TUNING.stickRelease) return cur;
  }
  const ax = Math.abs(fx), ay = Math.abs(fy);
  if (Math.max(ax, ay) < LOCAL_TUNING.stickEngage) return -1;
  if (ax > ay) return fx > 0 ? MenuAction.RIGHT : MenuAction.LEFT;
  return fy > 0 ? MenuAction.DOWN : MenuAction.UP;
}

export interface MenuInputOptions {
  focus: FocusNavigator;
  onPause(): void;
  /** Defaults to the shared pad manager. */
  pads?: PadManager;
  /** Key event target (default window). */
  target?: EventTarget;
  /** visibilitychange target (default document when it exists). */
  doc?: EventTarget & { visibilityState?: string };
  /** Settings for custom remaps of non-standard pads (settings.controls.pad.remaps). None: standard positions. */
  settings?: { get(): Readonly<Settings> } | null;
}

export interface MenuInput {
  poll(nowMs: number): void;
  dispose(): void;
}

interface KeyLike {
  code?: string;
  repeat?: boolean;
  target?: EventTarget | null;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  preventDefault?: () => void;
}

/** Digital state of raw button `raw` of a slot (manager bit below PAD_BUTTON_COUNT, else the Gamepad snapshot). */
function rawDown(s: Readonly<PadSlot>, raw: number): boolean {
  if (raw < 0) return false;
  if (raw < PAD_BUTTON_COUNT) return (s.pressed & (1 << raw)) !== 0;
  const btns = s.pad ? s.pad.buttons : null;
  if (!btns || raw >= btns.length) return false;
  const b = btns[raw] as GamepadButton | number | null | undefined;
  if (typeof b === 'number') return b > 0.5;
  return !!b && b.pressed === true;
}

export function createMenuInput(opts: MenuInputOptions): MenuInput {
  const pads = opts.pads ?? getPadManager();
  const target: EventTarget | null = opts.target ?? (typeof window !== 'undefined' ? window : null);
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
  const settings = opts.settings ?? null;
  const repeat = createRepeatState();
  /**
   * Direction keys currently down (one bit per key, keyboard.ts DIR_CODES) and the held direction bits they resolve
   * to (DIRS order, same encoding as keyboard.ts DIR_*): a direction stays held while any of its keys is down.
   */
  let keyDirKeys = 0;
  let keyDirs = 0;
  /** Keyboard presses in order since the last poll (ring buffer of MenuAction). */
  const queue = new Int8Array(LOCAL_TUNING.keyQueueMax);
  let qHead = 0;
  let qLen = 0;
  /** Per pad slot index: menu bits (1 << MenuAction) at the last poll, and the held stick direction (-1 none). */
  const padPrev: number[] = [];
  const padStick: number[] = [];
  /** Raw button index per PadAction for the slot being read (custom remaps). */
  const remapIdx = new Int16Array(PAD_ACTION_COUNT);
  let disposed = false;

  const dirBit = (a: MenuAction): number => (a <= MenuAction.RIGHT ? 1 << a : 0);

  function clearKeys(): void {
    keyDirKeys = 0;
    keyDirs = 0;
    qLen = 0;
    qHead = 0;
  }

  const onDown = (ev: Event): void => {
    if (disposed) return;
    const e = ev as unknown as KeyLike;
    const code = e.code ?? '';
    const a = MENU_KEY_ACTIONS[code];
    if (a === undefined) return;
    if (e.ctrlKey === true || e.altKey === true || e.metaKey === true) return;
    if (isEditableTarget(e.target ?? null) && code !== 'Escape') return;
    // The menu owns these keys: no page scroll (arrows, Space, Page Up / Down) and no native step of a focused
    // slider on top of the navigator's own adjust.
    e.preventDefault?.();
    if (dirBit(a) !== 0) {
      keyDirKeys |= dirKeyBit(code);
      keyDirs = dirsFromKeyMask(keyDirKeys);
    }
    if (e.repeat === true || qLen >= queue.length) return;
    queue[(qHead + qLen) % queue.length] = a;
    qLen++;
  };
  const onUp = (ev: Event): void => {
    if (disposed) return;
    const code = (ev as unknown as KeyLike).code ?? '';
    if (isMetaCode(code)) {
      // macOS drops the keyups of keys released while Cmd was down: forget held keys (no runaway repeat).
      keyDirKeys = 0;
      keyDirs = 0;
      return;
    }
    const a = MENU_KEY_ACTIONS[code];
    if (a === undefined || dirBit(a) === 0) return;
    keyDirKeys &= ~dirKeyBit(code);
    keyDirs = dirsFromKeyMask(keyDirKeys);
  };
  const onBlur = (): void => { clearKeys(); };
  const onVisibility = (): void => {
    if (doc && doc.visibilityState === 'hidden') clearKeys();
  };
  target?.addEventListener('keydown', onDown);
  target?.addEventListener('keyup', onUp);
  target?.addEventListener('blur', onBlur);
  doc?.addEventListener('visibilitychange', onVisibility);

  /** Repeats go to the navigator's handleRepeat when it has one (focus.ts: a held direction never runs past the control
   *  it acts on, QF-3 QA-30); other navigators get them as plain actions. */
  const repeatTo = opts.focus as FocusNavigator & { handleRepeat?(a: MenuAction): void };
  const fire = (a: MenuAction, repeat?: boolean): void => {
    if (a === MenuAction.START) opts.onPause();
    else if (repeat === true && typeof repeatTo.handleRepeat === 'function') repeatTo.handleRepeat(a);
    else opts.focus.handle(a);
  };

  /** Menu bits (1 << MenuAction) of a connected, active pad (buttons and D-pad, not the stick). */
  function padBits(s: Readonly<PadSlot>): number {
    let bits = 0;
    if (s.standard || !settings) {
      for (let j = 0; j < MENU_PAD_ACTIONS.length; j++) {
        if ((s.pressed & (1 << MENU_PAD_ACTIONS[j]![0])) !== 0) bits |= 1 << MENU_PAD_ACTIONS[j]![1];
      }
      return bits;
    }
    const st = settings.get();
    const remaps = st && st.controls && st.controls.pad ? st.controls.pad.remaps : null;
    resolvePadRemap(remaps, s.gamepadId, s.standard, remapIdx);
    for (let j = 0; j < REMAP_ACTIONS.length; j++) {
      if (rawDown(s, remapIdx[REMAP_ACTIONS[j]![0]]!)) bits |= 1 << REMAP_ACTIONS[j]![1];
    }
    return bits;
  }

  return {
    poll(nowMs: number) {
      if (disposed) return;
      pads.poll(nowMs);
      // Keyboard presses, in press order. A direction press restarts that direction's repeat delay.
      while (qLen > 0) {
        const a = queue[qHead]! as MenuAction;
        qHead = (qHead + 1) % queue.length;
        qLen--;
        if (dirBit(a) !== 0) repeat.next[a] = (keyDirs & dirBit(a)) !== 0 ? nowMs + MENU_REPEAT_DELAY_MS : -1;
        fire(a);
      }
      // Pads: held directions (D-pad, stick) and press edges.
      let held = keyDirs;
      let edges = 0;
      const slots = pads.slots;
      for (let k = 0; k < slots.length; k++) {
        while (padPrev.length <= k) { padPrev.push(0); padStick.push(-1); }
        const s = slots[k]!;
        if (!s.connected || !s.active) {
          padPrev[k] = 0;
          padStick[k] = -1;
          continue;
        }
        let bits = padBits(s);
        const sd = stickMenuDir(padStick[k]!, s.lx, s.ly);
        padStick[k] = sd;
        if (sd >= 0) bits |= 1 << sd;
        edges |= bits & ~padPrev[k]!;
        padPrev[k] = bits;
        held |= bits & DIR_MASK;
      }
      stepRepeat(repeat, held, nowMs, fire, edges & DIR_MASK);
      if ((edges & ~DIR_MASK) !== 0) {
        for (let a = MenuAction.CONFIRM; a <= MenuAction.START; a++) if (edges & (1 << a)) fire(a);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearKeys();
      target?.removeEventListener('keydown', onDown);
      target?.removeEventListener('keyup', onUp);
      target?.removeEventListener('blur', onBlur);
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
