/**
 * [PAD-08] Keyboard scheme for desktop development (section 10: "Keyboard scheme for desktop development,
 * documented in the README"). Produces the same InputFrame as a pad (positional-semantic buttons, D-004).
 *
 *   Key                      InputFrame                 Pad equivalent
 *   W / ArrowUp              move up (-z)               left stick up
 *   S / ArrowDown            move down (+z)             left stick down
 *   A / ArrowLeft            move left (-x)             left stick left
 *   D / ArrowRight           move right (+x)            left stick right
 *   J                        Btn.PASS                   Cross / A
 *   K                        Btn.SHOOT                  Circle / B
 *   U                        Btn.LOB                    Square / X
 *   I                        Btn.THROUGH                Triangle / Y
 *   Q                        Btn.MOD_L                  L1 / LB
 *   E                        Btn.MOD_R                  R1 / RB
 *   Shift (either)           Btn.SPRINT                 R2 / RT
 *   C                        Btn.SHIELD                 L2 / LT
 *   Space                    Btn.SKIP                   (skip cut-scene)
 *   Esc / P                  pause (onPause)            Options / Menu
 *
 * Diagonals are normalised (magnitude 1). Every key is tracked on its own: a direction stays held while any of its
 * keys is down (D + ArrowRight, release one: still moving right), as both Shift keys do for SPRINT. Key presses
 * shorter than a tick are latched and reported by the next sample(). Window blur and visibilitychange release
 * everything (no stuck keys). Keys typed into text fields are ignored. Uses KeyboardEvent.code
 * (layout-independent physical positions).
 *
 * WAVE 0 BASELINE (FND-05). PAD-08 owns and refines it.
 */

import { Btn, clearInputFrame, type InputFrame, type InputSampleContext, type InputSource } from '../contracts/input';
import { writeMoveAxes } from './axes';

export const DIR_UP = 1, DIR_DOWN = 2, DIR_LEFT = 4, DIR_RIGHT = 8;

/** KeyboardEvent.code -> movement direction bit. */
export const KEY_DIRS: Readonly<Record<string, number>> = {
  KeyW: DIR_UP, ArrowUp: DIR_UP,
  KeyS: DIR_DOWN, ArrowDown: DIR_DOWN,
  KeyA: DIR_LEFT, ArrowLeft: DIR_LEFT,
  KeyD: DIR_RIGHT, ArrowRight: DIR_RIGHT,
};

/** Direction key codes in a fixed order: bit i of a direction-key mask = DIR_CODES[i] is down. Built once. */
export const DIR_CODES: readonly string[] = Object.keys(KEY_DIRS);

/** Mask bit for a direction key code (0 when the code is not a direction key). Pure. */
export function dirKeyBit(code: string): number {
  for (let i = 0; i < DIR_CODES.length; i++) if (DIR_CODES[i] === code) return 1 << i;
  return 0;
}

/** Held direction bits (DIR_*) for a direction-key mask: a direction is held while any of its keys is down. Pure. */
export function dirsFromKeyMask(mask: number): number {
  let dirs = 0;
  for (let i = 0; i < DIR_CODES.length; i++) if (mask & (1 << i)) dirs |= KEY_DIRS[DIR_CODES[i]!]!;
  return dirs;
}

/** KeyboardEvent.code -> Btn bit. */
export const KEY_BUTTONS: Readonly<Record<string, number>> = {
  KeyJ: Btn.PASS,
  KeyK: Btn.SHOOT,
  KeyU: Btn.LOB,
  KeyI: Btn.THROUGH,
  KeyQ: Btn.MOD_L,
  KeyE: Btn.MOD_R,
  ShiftLeft: Btn.SPRINT,
  ShiftRight: Btn.SPRINT,
  KeyC: Btn.SHIELD,
  Space: Btn.SKIP,
};

export const KEY_PAUSE: readonly string[] = ['Escape', 'KeyP'];

/** Bit per mapped button key (so both Shift keys can be held independently). Built once. */
const BUTTON_CODES: readonly string[] = Object.keys(KEY_BUTTONS);
function buttonKeyIndex(code: string): number {
  for (let i = 0; i < BUTTON_CODES.length; i++) if (BUTTON_CODES[i] === code) return i;
  return -1;
}
function heldFromKeys(keys: number): number {
  let bits = 0;
  for (let i = 0; i < BUTTON_CODES.length; i++) if (keys & (1 << i)) bits |= KEY_BUTTONS[BUTTON_CODES[i]!]!;
  return bits;
}

/** Screen-space stick (x right, y down) for held direction bits; diagonals normalised. Writes out.x/out.y. */
export function dirsToStick(dirs: number, out: { x: number; y: number }): void {
  let x = 0, y = 0;
  if (dirs & DIR_RIGHT) x += 1;
  if (dirs & DIR_LEFT) x -= 1;
  if (dirs & DIR_DOWN) y += 1;
  if (dirs & DIR_UP) y -= 1;
  if (x !== 0 && y !== 0) { x *= Math.SQRT1_2; y *= Math.SQRT1_2; }
  out.x = x;
  out.y = y;
}

/** True when the event comes from a text field (typing must not drive the player). */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export interface KeyboardSourceOptions {
  /** Called on Esc / P. */
  onPause(): void;
  /** Key event target (default window). */
  target?: EventTarget;
  /** visibilitychange target (default document when it exists). */
  doc?: EventTarget & { visibilityState?: string };
}

export interface KeyboardInputSource extends InputSource {
  /** Held direction bits (DIR_*). */
  readonly dirs: number;
  /** Held Btn bits. */
  readonly held: number;
}

interface KeyLike { code?: string; repeat?: boolean; target?: EventTarget | null; preventDefault?: () => void }

export function createKeyboardSource(opts: KeyboardSourceOptions): KeyboardInputSource {
  const target: EventTarget | null = opts.target ?? (typeof window !== 'undefined' ? window : null);
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
  /** Bit per DIR_CODES entry currently down, and the direction bits it resolves to. */
  let dirKeys = 0;
  let dirs = 0;
  /** Bit per BUTTON_CODES entry currently down. */
  let keys = 0;
  let held = 0;
  let latched = 0;
  const stick = { x: 0, y: 0 };

  const onDown = (ev: Event): void => {
    const e = ev as unknown as KeyLike;
    const code = e.code ?? '';
    if (isEditableTarget(e.target ?? null)) return;
    const d = KEY_DIRS[code];
    const b = KEY_BUTTONS[code];
    if (d !== undefined) {
      dirKeys |= dirKeyBit(code);
      dirs = dirsFromKeyMask(dirKeys);
    }
    if (b !== undefined && !e.repeat) {
      keys |= 1 << buttonKeyIndex(code);
      held = heldFromKeys(keys);
      latched |= b;
    }
    if (d !== undefined || b !== undefined) e.preventDefault?.();
    if (!e.repeat && KEY_PAUSE.includes(code)) opts.onPause();
  };
  const onUp = (ev: Event): void => {
    const code = (ev as unknown as KeyLike).code ?? '';
    const d = KEY_DIRS[code];
    const b = KEY_BUTTONS[code];
    if (d !== undefined) {
      dirKeys &= ~dirKeyBit(code);
      dirs = dirsFromKeyMask(dirKeys);
    }
    if (b !== undefined) {
      keys &= ~(1 << buttonKeyIndex(code));
      held = heldFromKeys(keys);
    }
  };
  const release = (): void => { dirKeys = 0; dirs = 0; keys = 0; held = 0; latched = 0; };
  const onVisibility = (): void => {
    if (doc && doc.visibilityState === 'hidden') release();
  };

  target?.addEventListener('keydown', onDown);
  target?.addEventListener('keyup', onUp);
  target?.addEventListener('blur', release);
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    id: 'keyboard',
    kind: 'keyboard',
    get dirs() { return dirs; },
    get held() { return held; },
    sample(out: InputFrame, ctx: InputSampleContext) {
      clearInputFrame(out);
      dirsToStick(dirs, stick);
      writeMoveAxes(out, stick.x, stick.y, ctx.projector);
      out.buttons = held | latched;
      latched = 0;
    },
    releaseAll: release,
    dispose() {
      release();
      target?.removeEventListener('keydown', onDown);
      target?.removeEventListener('keyup', onUp);
      target?.removeEventListener('blur', release);
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
