/**
 * [PAD-08] Menu input: pads + keyboard -> MenuAction for the FocusNavigator, with an initial delay and key repeat
 * for directions (section 10 "Menus: Confirm; back; move; switch tab": Cross / A, Circle / B, D-pad or left stick,
 * L1 and R1 / LB and RB; Options / Menu pauses).
 *
 *   Pad (standard mapping)       Keyboard                      MenuAction
 *   D-pad / left stick           Arrows / WASD                 UP DOWN LEFT RIGHT (repeat)
 *   0 Cross / A                  Enter / Space                 CONFIRM
 *   1 Circle / B                 Escape / Backspace            BACK
 *   4 L1 / LB                    Q / PageUp                    TAB_PREV
 *   5 R1 / RB                    E / PageDown                  TAB_NEXT
 *   9 Options / Menu             P                             START -> opts.onPause()
 *
 * poll(nowMs) runs once per animation frame from the app loop (it also polls the shared pad manager, which is how
 * pads become known to the DeviceRegistry while in menus). Keyboard events are latched between polls; typing in a
 * text field is ignored except Escape. Home and Share are never read.
 *
 * WAVE 0 BASELINE (FND-05). PAD-08 owns and refines it.
 */

import { MenuAction, type FocusNavigator } from '../contracts/app';
import { dirKeyBit, dirsFromKeyMask, isEditableTarget } from './keyboard';
import { getPadManager, PadButton, type PadManager } from './pad/manager';

/** Directional repeat: first repeat after this delay, then every interval (ms). */
export const MENU_REPEAT_DELAY_MS = 380;
export const MENU_REPEAT_INTERVAL_MS = 110;
/** Left-stick deflection that counts as a direction in menus. */
export const MENU_STICK_THRESHOLD = 0.5;

const KEY_ACTIONS: Readonly<Record<string, MenuAction>> = {
  ArrowUp: MenuAction.UP, KeyW: MenuAction.UP,
  ArrowDown: MenuAction.DOWN, KeyS: MenuAction.DOWN,
  ArrowLeft: MenuAction.LEFT, KeyA: MenuAction.LEFT,
  ArrowRight: MenuAction.RIGHT, KeyD: MenuAction.RIGHT,
  Enter: MenuAction.CONFIRM, NumpadEnter: MenuAction.CONFIRM, Space: MenuAction.CONFIRM,
  Escape: MenuAction.BACK, Backspace: MenuAction.BACK,
  KeyQ: MenuAction.TAB_PREV, PageUp: MenuAction.TAB_PREV,
  KeyE: MenuAction.TAB_NEXT, PageDown: MenuAction.TAB_NEXT,
  KeyP: MenuAction.START,
};

const PAD_ACTIONS: readonly (readonly [number, MenuAction])[] = [
  [PadButton.SOUTH, MenuAction.CONFIRM],
  [PadButton.EAST, MenuAction.BACK],
  [PadButton.L1, MenuAction.TAB_PREV],
  [PadButton.R1, MenuAction.TAB_NEXT],
  [PadButton.START, MenuAction.START],
];

const DIRS: readonly MenuAction[] = [MenuAction.UP, MenuAction.DOWN, MenuAction.LEFT, MenuAction.RIGHT];

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
 * the machine saw the first release still fires).
 */
export function stepRepeat(st: RepeatState, heldBits: number, nowMs: number, fire: (a: MenuAction) => void, edgeBits = 0): void {
  for (let i = 0; i < 4; i++) {
    const held = (heldBits & (1 << i)) !== 0;
    const edge = (edgeBits & (1 << i)) !== 0;
    if (!held && !edge) { st.next[i] = -1; continue; }
    if (st.next[i] === -1 || edge) {
      fire(DIRS[i]!);
      st.next[i] = nowMs + MENU_REPEAT_DELAY_MS;
    } else if (nowMs >= st.next[i]!) {
      fire(DIRS[i]!);
      st.next[i] = Math.max(st.next[i]! + MENU_REPEAT_INTERVAL_MS, nowMs - MENU_REPEAT_INTERVAL_MS);
    }
  }
}

export interface MenuInputOptions {
  focus: FocusNavigator;
  onPause(): void;
  /** Defaults to the shared pad manager. */
  pads?: PadManager;
  /** Key event target (default window). */
  target?: EventTarget;
}

export interface MenuInput {
  poll(nowMs: number): void;
  dispose(): void;
}

interface KeyLike { code?: string; repeat?: boolean; target?: EventTarget | null; preventDefault?: () => void }

export function createMenuInput(opts: MenuInputOptions): MenuInput {
  const pads = opts.pads ?? getPadManager();
  const target: EventTarget | null = opts.target ?? (typeof window !== 'undefined' ? window : null);
  const repeat = createRepeatState();
  /**
   * Direction keys currently down (one bit per key, keyboard.ts DIR_CODES) and the held direction bits they resolve
   * to (DIRS order, same encoding as keyboard.ts DIR_*): a direction stays held while any of its keys is down.
   */
  let keyDirKeys = 0;
  let keyDirs = 0;
  /** Direction keys pressed since the last poll (a tap shorter than a frame still moves focus once). */
  let keyDirTaps = 0;
  /** Latched non-directional key presses (bit = MenuAction). */
  let keyEdges = 0;

  const dirBit = (a: MenuAction): number => (a === MenuAction.UP ? 1 : a === MenuAction.DOWN ? 2 : a === MenuAction.LEFT ? 4 : a === MenuAction.RIGHT ? 8 : 0);

  const onDown = (ev: Event): void => {
    const e = ev as unknown as KeyLike;
    const a = KEY_ACTIONS[e.code ?? ''];
    if (a === undefined) return;
    if (isEditableTarget(e.target ?? null) && e.code !== 'Escape') return;
    const d = dirBit(a);
    if (d !== 0) {
      keyDirKeys |= dirKeyBit(e.code ?? '');
      keyDirs = dirsFromKeyMask(keyDirKeys);
      if (!e.repeat) keyDirTaps |= d;
    } else if (!e.repeat) keyEdges |= 1 << a;
  };
  const onUp = (ev: Event): void => {
    const code = (ev as unknown as KeyLike).code ?? '';
    const a = KEY_ACTIONS[code];
    if (a === undefined) return;
    if (dirBit(a) !== 0) {
      keyDirKeys &= ~dirKeyBit(code);
      keyDirs = dirsFromKeyMask(keyDirKeys);
    }
  };
  const onBlur = (): void => { keyDirKeys = 0; keyDirs = 0; keyDirTaps = 0; keyEdges = 0; };
  target?.addEventListener('keydown', onDown);
  target?.addEventListener('keyup', onUp);
  target?.addEventListener('blur', onBlur);

  const fire = (a: MenuAction): void => {
    if (a === MenuAction.START) opts.onPause();
    else opts.focus.handle(a);
  };

  return {
    poll(nowMs: number) {
      pads.poll(nowMs);
      const dirEdges = keyDirTaps;
      let dirs = keyDirs;
      keyDirTaps = 0;
      let nonDir = 0;
      let padDirEdges = 0;
      const slots = pads.slots;
      for (let k = 0; k < slots.length; k++) {
        const s = slots[k]!;
        if (!s.connected || !s.active) continue;
        const p = s.pressed;
        if (p & (1 << PadButton.DPAD_UP) || s.ly < -MENU_STICK_THRESHOLD) dirs |= 1;
        if (p & (1 << PadButton.DPAD_DOWN) || s.ly > MENU_STICK_THRESHOLD) dirs |= 2;
        if (p & (1 << PadButton.DPAD_LEFT) || s.lx < -MENU_STICK_THRESHOLD) dirs |= 4;
        if (p & (1 << PadButton.DPAD_RIGHT) || s.lx > MENU_STICK_THRESHOLD) dirs |= 8;
        const dEdge = p & ~s.prevPressed;
        if (dEdge & (1 << PadButton.DPAD_UP)) padDirEdges |= 1;
        if (dEdge & (1 << PadButton.DPAD_DOWN)) padDirEdges |= 2;
        if (dEdge & (1 << PadButton.DPAD_LEFT)) padDirEdges |= 4;
        if (dEdge & (1 << PadButton.DPAD_RIGHT)) padDirEdges |= 8;
        for (let j = 0; j < PAD_ACTIONS.length; j++) {
          const b = PAD_ACTIONS[j]![0];
          if ((p & (1 << b)) !== 0 && (s.prevPressed & (1 << b)) === 0) nonDir |= 1 << PAD_ACTIONS[j]![1];
        }
      }
      stepRepeat(repeat, dirs, nowMs, fire, dirEdges | padDirEdges);
      const edges = keyEdges | nonDir;
      keyEdges = 0;
      if (edges !== 0) {
        for (let a = MenuAction.CONFIRM; a <= MenuAction.START; a++) if (edges & (1 << a)) fire(a);
      }
    },
    dispose() {
      target?.removeEventListener('keydown', onDown);
      target?.removeEventListener('keyup', onUp);
      target?.removeEventListener('blur', onBlur);
    },
  };
}
