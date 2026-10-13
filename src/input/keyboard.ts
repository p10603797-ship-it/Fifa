/**
 * [PAD-08] Keyboard scheme for desktop development (section 10: "Keyboard scheme for desktop development, documented
 * in the README"; the full table with notes is docs/KEYBOARD.md). Produces the same InputFrame as a pad
 * (positional-semantic buttons, D-004): the right stick and D-pad keys feed the very recognisers a pad uses
 * (PAD-05 createRightStick, PAD-04 createPadSequences), so flicks, holds, stick skills, drag-back and D-pad tactics
 * behave exactly as on a controller.
 *
 *   Key                          InputFrame                         Pad equivalent
 *   W / ArrowUp                  move up (-z)                       left stick up
 *   S / ArrowDown                move down (+z)                     left stick down
 *   A / ArrowLeft                move left (-x)                     left stick left
 *   D / ArrowRight               move right (+x)                    left stick right
 *   J                            Btn.PASS                           Cross / A
 *   K                            Btn.SHOOT                          Circle / B
 *   U                            Btn.LOB                            Square / X
 *   I                            Btn.THROUGH                        Triangle / Y
 *   Q                            Btn.MOD_L                          L1 / LB
 *   E                            Btn.MOD_R                          R1 / RB
 *   Shift (either)               Btn.SPRINT                         R2 / RT
 *   C                            Btn.SHIELD                         L2 / LT
 *   Space                        Btn.SKIP                           (skip cut-scene)
 *   Esc / P                      pause (onPause)                    Options / Menu
 *   1 / 2 / 3 / 4                D-pad up / down / left / right     D-pad (tactics: cmd via PAD-04)
 *   Ctrl or Alt + Arrow          D-pad in that direction            D-pad
 *   Numpad 8 / 2 (or 5) / 4 / 6  right stick up / down / left / right  right stick (ax/az, RS_FLICK, RS_HOLD,
 *   Numpad 7 / 9 / 1 / 3         right stick diagonals                  stick skills via PAD-05)
 *   Alt (Option) + I / K / J / L right stick up / down / left / right (laptops without a numpad)
 *   R                            skill BALL_ROLL                    hold right stick to a side
 *   F                            skill BODY_FEINT                   flick right stick to a side
 *   T                            skill STEP_OVER                    roll right stick forward -> side
 *   G                            skill ROULETTE                     roll right stick back -> side -> forward
 *   H                            skill HEEL_FLICK                   flick right stick forward then back
 *   B                            skill DRAG_BACK                    L1 + R1 + left stick back
 *
 * Skill keys: side moves (ball roll, feint, step-over, roulette) go to the side you steer toward relative to the
 * controlled player's facing (no steer: right); like the pad they are only produced while a skill can apply (in play,
 * our ball or loose, controlled player active, not a keeper holding it) and never on the sample of an RS_FLICK.
 *
 * Rules:
 *  - Every key is tracked on its own: a direction stays held while any of its keys is down (D + ArrowRight, release
 *    one: still moving right), as both Shift keys do for SPRINT. Diagonals are normalised (magnitude 1).
 *  - A key's layer is decided when it goes down: an arrow pressed with Ctrl or Alt held is a D-pad press until it is
 *    released (no movement); I J K L pressed with Alt held are right-stick keys until released (no face button).
 *  - Button presses go through a press latch (PAD-04 createPressLatch): a tap shorter than a tick is reported once,
 *    and a release + re-press between two samples is reported as two presses (double taps are never merged).
 *    Right-stick and D-pad taps shorter than a frame are latched for the next poll.
 *  - Auto-repeat keydowns never press a button, the D-pad, the right stick or a skill again; they only re-arm a
 *    movement direction (FND-05 behaviour after a release).
 *  - Window blur, visibilitychange (hidden) and the release of Cmd / Meta release everything (no stuck keys: macOS
 *    never delivers the keyup of a key released while Cmd is down). Keys pressed with Cmd / Meta (browser
 *    shortcuts) or Ctrl (except Ctrl + Arrow) are ignored. Keys typed into text fields are ignored.
 *  - releaseAll() (pause, resume, match end) clears movement, the right stick and the D-pad, and keeps buttons that
 *    are still held suppressed until they are released (the pad mapper does the same).
 *  - Uses KeyboardEvent.code (layout-independent physical positions).
 *
 * Device code (not sim): sample() and pollFrame() do not allocate; Math and performance.now are fine here.
 */

import { MatchPhase, SkillMove } from '../contracts/enums';
import { Btn, clearInputFrame, type InputFrame, type InputSampleContext, type InputSource } from '../contracts/input';
import { quantStick, writeAimAxes, writeMoveAxes } from './axes';
import { createRightStick, type RightStickTracker } from './pad/rightStick';
import { createPadSequences, createPressLatch, type PadSequences } from './pad/sequences';

const LOCAL_TUNING = {
  /** sample() polls the right-stick / D-pad recognisers itself when pollFrame was not called for longer, ms. */
  fallbackPollMs: 12,
  /** D-pad presses queued between two polls (more within one frame are dropped). */
  dpadQueueMax: 8,
} as const; // TUNING-CR (device timing, not gameplay): T_PAD.keyboardFallbackPollMs

/** The LOCAL_TUNING block (read-only; tests and the lead's TUNING-CR review). */
export const KEYBOARD_TUNING = LOCAL_TUNING;

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

/** D-pad keys -> D-pad bit (PAD-04 DpadBit: 1 up, 2 down, 4 left, 8 right; same encoding as DIR_*). */
export const KEY_DPAD: Readonly<Record<string, number>> = {
  Digit1: DIR_UP, Digit2: DIR_DOWN, Digit3: DIR_LEFT, Digit4: DIR_RIGHT,
};

/** Arrow keys pressed while Ctrl or Alt is held -> D-pad bit. */
export const KEY_DPAD_ARROWS: Readonly<Record<string, number>> = {
  ArrowUp: DIR_UP, ArrowDown: DIR_DOWN, ArrowLeft: DIR_LEFT, ArrowRight: DIR_RIGHT,
};

/** Right-stick keys (numpad, any NumLock state) -> direction bits (DIR_*; screen space like the left stick). */
export const KEY_RSTICK: Readonly<Record<string, number>> = {
  Numpad8: DIR_UP, Numpad2: DIR_DOWN, Numpad5: DIR_DOWN, Numpad4: DIR_LEFT, Numpad6: DIR_RIGHT,
  Numpad7: DIR_UP | DIR_LEFT, Numpad9: DIR_UP | DIR_RIGHT, Numpad1: DIR_DOWN | DIR_LEFT, Numpad3: DIR_DOWN | DIR_RIGHT,
};

/** Right-stick keys while Alt / Option is held (laptops without a numpad). */
export const KEY_RSTICK_ALT: Readonly<Record<string, number>> = {
  KeyI: DIR_UP, KeyK: DIR_DOWN, KeyJ: DIR_LEFT, KeyL: DIR_RIGHT,
};

/** Skill keys -> SkillMove. */
export const KEY_SKILLS: Readonly<Record<string, SkillMove>> = {
  KeyR: SkillMove.BALL_ROLL,
  KeyF: SkillMove.BODY_FEINT,
  KeyT: SkillMove.STEP_OVER,
  KeyG: SkillMove.ROULETTE,
  KeyH: SkillMove.HEEL_FLICK,
  KeyB: SkillMove.DRAG_BACK,
};

/** Code lists (built once): bit i of a key mask = list[i] is down in that layer. */
const BUTTON_CODES: readonly string[] = Object.keys(KEY_BUTTONS);
const DPAD_CODES: readonly string[] = [...Object.keys(KEY_DPAD), ...Object.keys(KEY_DPAD_ARROWS)];
const DPAD_VALUES: readonly number[] = [...Object.values(KEY_DPAD), ...Object.values(KEY_DPAD_ARROWS)];
/** First DPAD_CODES index of the arrow (modifier) entries. */
const DPAD_ARROW_BASE = Object.keys(KEY_DPAD).length;
const RS_CODES: readonly string[] = [...Object.keys(KEY_RSTICK), ...Object.keys(KEY_RSTICK_ALT)];
const RS_VALUES: readonly number[] = [...Object.values(KEY_RSTICK), ...Object.values(KEY_RSTICK_ALT)];
/** First RS_CODES index of the Alt + I J K L entries. */
const RS_ALT_BASE = Object.keys(KEY_RSTICK).length;

function indexIn(list: readonly string[], code: string, from: number, to: number): number {
  for (let i = from; i < to; i++) if (list[i] === code) return i;
  return -1;
}

function orValues(mask: number, values: readonly number[]): number {
  let bits = 0;
  for (let i = 0; i < values.length; i++) if (mask & (1 << i)) bits |= values[i]!;
  return bits;
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

/** <input> types that take no typing (sliders, toggles, buttons): keys on them are game / menu keys. */
const NON_TEXT_INPUTS: readonly string[] = ['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image'];

/**
 * True when the event comes from a text-entry element (typing must not drive the player or the menus): textarea,
 * select, contenteditable, and <input> of a typing type (text, number, search, ...; a missing type is text). A focused
 * slider, checkbox or button is not one.
 */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean; type?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.includes(typeof el.type === 'string' ? el.type.toLowerCase() : '');
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** True for the Cmd / Windows key codes (OSLeft / OSRight in older engines). */
export function isMetaCode(code: string): boolean {
  return code === 'MetaLeft' || code === 'MetaRight' || code === 'OSLeft' || code === 'OSRight';
}

/** Scratch for skillKeyDirection. */
export interface SkillDir { x: number; z: number }

/**
 * Skill gate and direction for a skill key (pure; same gate as the pad's right stick, PAD-05 setContext): false while
 * no skill can apply (not IN_PLAY, no active controlled player, the keeper holds the ball, or the opponents own it).
 * Otherwise writes the pitch-space unit direction the pad would report: the side steered toward (movement mx/mz
 * relative to the player's facing; no steer: right) for side moves, forward for HEEL_FLICK, back for DRAG_BACK.
 */
export function skillKeyDirection(
  ctx: Pick<InputSampleContext, 'state' | 'human' | 'side'>, skill: SkillMove, mx: number, mz: number, out: SkillDir,
): boolean {
  const st = ctx.state;
  if (!st || !st.match || st.match.phase !== MatchPhase.IN_PLAY) return false;
  const ctl = st.ctrl[ctx.human];
  const slot = ctl ? ctl.slot : -1;
  const p = slot >= 0 ? st.players[slot] : undefined;
  if (!p || p.active !== 1) return false;
  const b = st.ball;
  if (b.heldBy === slot) return false;
  const holder = b.heldBy >= 0 ? b.heldBy : b.owner;
  if (holder >= 0) {
    const h = st.players[holder];
    if (!h || h.team !== p.team) return false;
  }
  let fx = p.fx, fz = p.fz;
  let m = Math.sqrt(fx * fx + fz * fz);
  if (!(m > 1e-6) || !Number.isFinite(m)) {
    const team = st.teams[ctx.side];
    fx = team && team.dir < 0 ? -1 : 1;
    fz = 0;
    m = 1;
  }
  fx /= m;
  fz /= m;
  switch (skill) {
    case SkillMove.HEEL_FLICK:
      out.x = fx; out.z = fz;
      return true;
    case SkillMove.DRAG_BACK:
      out.x = -fx; out.z = -fz;
      return true;
    default: {
      // Right of facing = facing rotated toward +z when facing +x (PAD-05 convention).
      const right = -mx * fz + mz * fx;
      if (right < 0) { out.x = fz; out.z = -fx; } else { out.x = -fz; out.z = fx; }
      return true;
    }
  }
}

export interface KeyboardSourceOptions {
  /** Called on Esc / P. */
  onPause(): void;
  /** Key event target (default window). */
  target?: EventTarget;
  /** visibilitychange target (default document when it exists). */
  doc?: EventTarget & { visibilityState?: string };
  /** Clock for the fallback poll when pollFrame is not called (defaults to performance.now). */
  now?: () => number;
  /** Right-stick recogniser (PAD-05). Defaults to a new createRightStick(). */
  rightStick?: RightStickTracker;
  /** D-pad sequence recogniser (PAD-04). Defaults to a new createPadSequences(). */
  sequences?: PadSequences;
}

export interface KeyboardInputSource extends InputSource {
  /** Held movement direction bits (DIR_*). */
  readonly dirs: number;
  /** Held Btn bits (buttons suppressed by releaseAll() excluded). */
  readonly held: number;
  /** Held right-stick direction bits (DIR_*). */
  readonly rsDirs: number;
  /** Held D-pad bits (DIR_* = PAD-04 DpadBit). */
  readonly dpad: number;
  /** The right-stick recogniser the right-stick keys feed (debug input viewer). */
  readonly rightStick: RightStickTracker;
  /** The D-pad sequence recogniser the D-pad keys feed (HUD hint). */
  readonly sequences: PadSequences;
  pollFrame(nowMs: number): void;
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

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function createKeyboardSource(opts: KeyboardSourceOptions): KeyboardInputSource {
  const target: EventTarget | null = opts.target ?? (typeof window !== 'undefined' ? window : null);
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
  const now = opts.now ?? defaultNow;
  const rs = opts.rightStick ?? createRightStick();
  const seq = opts.sequences ?? createPadSequences();
  const latch = createPressLatch();

  /** Bit per DIR_CODES entry down in the movement layer, and the direction bits it resolves to. */
  let dirKeys = 0;
  let dirs = 0;
  /** Bit per BUTTON_CODES entry currently down; Btn bits held; Btn bits ignored until released (releaseAll). */
  let keys = 0;
  let heldBits = 0;
  let suppress = 0;
  /** Bit per DPAD_CODES / RS_CODES entry down. */
  let dpadKeys = 0;
  let rsKeys = 0;
  /** D-pad presses since the last poll, in press order (D-pad bits; taps shorter than a frame count too). */
  const dpadQueue = new Uint8Array(LOCAL_TUNING.dpadQueueMax);
  let dpadQLen = 0;
  /** Right-stick keys pressed since the last poll (RS_CODES bits; taps shorter than a frame count too). */
  let rsTaps = 0;
  /** What the recognisers saw at the last poll: D-pad bits, right-stick direction bits. */
  let lastDpad = 0;
  let lastRs = 0;
  /** Skill key pressed since the last sample (latest wins). */
  let pendingSkill: SkillMove = SkillMove.NONE;
  let lastPollMs = -1;
  let disposed = false;
  const stick = { x: 0, y: 0 };
  const rstick = { x: 0, y: 0 };
  const sdir: SkillDir = { x: 0, z: 0 };
  const q = { qx: 0, qy: 0 };

  function syncButtons(): void {
    heldBits = heldFromKeys(keys);
    suppress &= heldBits;
    latch.poll(heldBits);
  }

  /**
   * Reset both recognisers and tell them at once that nothing is held (the keys were just forgotten), so the very next
   * press counts: a reset recogniser otherwise ignores a stick until it is seen centred and takes the first D-pad
   * reading as the baseline, not as a press.
   */
  function resetRecognisers(): void {
    rs.reset();
    seq.reset();
    const t = lastPollMs >= 0 ? lastPollMs : now();
    rs.setLeft(0, 0, 0);
    rs.update(0, 0, t);
    seq.updateHeld(0, t);
    dpadQLen = 0;
    lastDpad = 0;
    lastRs = 0;
  }

  /** Forget every key (blur, hidden page, Cmd released, dispose): no keyup will come for keys down now. */
  function releaseKeys(): void {
    dirKeys = 0; dirs = 0;
    keys = 0; heldBits = 0; suppress = 0;
    latch.poll(0);
    latch.reset();
    dpadKeys = 0;
    rsKeys = 0; rsTaps = 0;
    pendingSkill = SkillMove.NONE;
    resetRecognisers();
  }

  const onDown = (ev: Event): void => {
    if (disposed) return;
    const e = ev as unknown as KeyLike;
    const code = e.code ?? '';
    if (isEditableTarget(e.target ?? null)) return;
    if (e.metaKey === true || isMetaCode(code)) return; // browser / OS shortcut
    if (code === 'AltLeft' || code === 'AltRight') {
      e.preventDefault?.(); // no Windows menu-bar activation while Alt is the right-stick / D-pad layer
      return;
    }
    const repeat = e.repeat === true;
    const ctrl = e.ctrlKey === true;
    const alt = e.altKey === true;
    let handled = false;

    // D-pad: 1-4, or an arrow pressed with Ctrl / Alt (it stays a D-pad key until released).
    let di = ctrl ? -1 : indexIn(DPAD_CODES, code, 0, DPAD_ARROW_BASE);
    if (di < 0 && (ctrl || alt)) di = indexIn(DPAD_CODES, code, DPAD_ARROW_BASE, DPAD_CODES.length);
    if (di >= 0) {
      if (!repeat) {
        dpadKeys |= 1 << di;
        if (dpadQLen < dpadQueue.length) dpadQueue[dpadQLen++] = DPAD_VALUES[di]!;
      }
      e.preventDefault?.();
      return;
    }
    if (ctrl) return; // Ctrl + key (other than an arrow): a browser shortcut, never a game input

    // Right stick: numpad, or I J K L pressed with Alt (it stays a right-stick key until released).
    let ri = indexIn(RS_CODES, code, 0, RS_ALT_BASE);
    if (ri < 0 && alt) ri = indexIn(RS_CODES, code, RS_ALT_BASE, RS_CODES.length);
    if (ri >= 0) {
      if (!repeat) {
        rsKeys |= 1 << ri;
        rsTaps |= 1 << ri;
      }
      e.preventDefault?.();
      return;
    }

    // Movement. An arrow held as a D-pad key never moves; auto-repeat re-arms a released direction.
    if (KEY_DIRS[code] !== undefined) {
      const arrow = indexIn(DPAD_CODES, code, DPAD_ARROW_BASE, DPAD_CODES.length);
      if (arrow < 0 || (dpadKeys & (1 << arrow)) === 0) {
        dirKeys |= dirKeyBit(code);
        dirs = dirsFromKeyMask(dirKeys);
      }
      handled = true;
    }

    const bi = indexIn(BUTTON_CODES, code, 0, BUTTON_CODES.length);
    if (bi >= 0) {
      if (!repeat) {
        keys |= 1 << bi;
        syncButtons();
      }
      handled = true;
    }

    const skill = KEY_SKILLS[code];
    if (skill !== undefined) {
      if (!repeat) pendingSkill = skill;
      handled = true;
    }

    if (handled) e.preventDefault?.();
    if (!repeat && KEY_PAUSE.includes(code)) opts.onPause();
  };

  const onUp = (ev: Event): void => {
    if (disposed) return;
    const e = ev as unknown as KeyLike;
    const code = e.code ?? '';
    if (isMetaCode(code)) {
      releaseKeys(); // macOS drops the keyups of keys released while Cmd was down
      return;
    }
    if (code === 'AltLeft' || code === 'AltRight') {
      e.preventDefault?.();
      return;
    }
    const dk = dirKeyBit(code);
    if (dk !== 0 && (dirKeys & dk) !== 0) {
      dirKeys &= ~dk;
      dirs = dirsFromKeyMask(dirKeys);
    }
    for (let i = 0; i < DPAD_CODES.length; i++) if (DPAD_CODES[i] === code) dpadKeys &= ~(1 << i);
    for (let i = 0; i < RS_CODES.length; i++) if (RS_CODES[i] === code) rsKeys &= ~(1 << i);
    const bi = indexIn(BUTTON_CODES, code, 0, BUTTON_CODES.length);
    if (bi >= 0 && (keys & (1 << bi)) !== 0) {
      keys &= ~(1 << bi);
      syncButtons();
    }
  };

  const onBlur = (): void => {
    if (!disposed) releaseKeys();
  };
  const onVisibility = (): void => {
    if (!disposed && doc && doc.visibilityState === 'hidden') releaseKeys();
  };

  /**
   * Feed the right-stick and D-pad recognisers (once per animation frame, or from sample() as a fallback). Presses
   * shorter than a frame are shown held for this poll; a re-press of something the recognisers still saw held is shown
   * released first (two quick taps are two strokes / two D-pad presses even at a low frame rate); D-pad presses are
   * fed one at a time in press order (two taps inside one frame are a sequence, not a diagonal).
   */
  function poll(nowMs: number): void {
    lastPollMs = nowMs;
    const rsNow = orValues(rsKeys | rsTaps, RS_VALUES);
    if ((orValues(rsTaps, RS_VALUES) & lastRs) !== 0) rs.update(0, 0, nowMs); // the stick went through the centre
    rsTaps = 0;
    dirsToStick(rsNow, rstick);
    dirsToStick(dirs, stick);
    rs.setLeft(stick.x, stick.y, heldBits & ~suppress);
    rs.update(rstick.x, rstick.y, nowMs);
    lastRs = rsNow;
    for (let i = 0; i < dpadQLen; i++) {
      const p = dpadQueue[i]!;
      if ((lastDpad & p) !== 0) {
        lastDpad &= ~p;
        seq.updateHeld(lastDpad, nowMs);
      }
      lastDpad |= p;
      seq.updateHeld(lastDpad, nowMs);
    }
    dpadQLen = 0;
    lastDpad = orValues(dpadKeys, DPAD_VALUES);
    seq.updateHeld(lastDpad, nowMs);
  }

  // A fresh D-pad recogniser takes its first reading as the baseline: give it "nothing held" now.
  seq.updateHeld(0, now());

  target?.addEventListener('keydown', onDown);
  target?.addEventListener('keyup', onUp);
  target?.addEventListener('blur', onBlur);
  doc?.addEventListener('visibilitychange', onVisibility);

  const api: KeyboardInputSource = {
    id: 'keyboard',
    kind: 'keyboard',
    rightStick: rs,
    sequences: seq,
    get dirs() { return dirs; },
    get held() { return heldBits & ~suppress; },
    get rsDirs() { return orValues(rsKeys, RS_VALUES); },
    get dpad() { return orValues(dpadKeys, DPAD_VALUES); },
    pollFrame(nowMs: number) {
      if (disposed) return;
      poll(nowMs);
    },
    sample(out: InputFrame, ctx: InputSampleContext) {
      clearInputFrame(out);
      if (disposed) return;
      const t = now();
      if (lastPollMs < 0 || t - lastPollMs > LOCAL_TUNING.fallbackPollMs || t < lastPollMs - LOCAL_TUNING.fallbackPollMs) poll(t);
      dirsToStick(dirs, stick);
      writeMoveAxes(out, stick.x, stick.y, ctx.projector);
      dirsToStick(orValues(rsKeys, RS_VALUES), rstick);
      writeAimAxes(out, rstick.x, rstick.y, ctx.projector);
      out.buttons = latch.sample();
      rs.setContext(ctx);
      rs.applyTo(out);
      seq.setContext(ctx);
      seq.applyTo(out);
      if (pendingSkill !== SkillMove.NONE && out.skill === SkillMove.NONE && (out.buttons & Btn.RS_FLICK) === 0) {
        const k = pendingSkill;
        pendingSkill = SkillMove.NONE;
        if (skillKeyDirection(ctx, k, out.mx, out.mz, sdir)) {
          out.skill = k;
          quantStick(sdir.x, sdir.z, q);
          out.ax = q.qx;
          out.az = q.qy;
        }
      }
    },
    releaseAll() {
      dirKeys = 0;
      dirs = 0;
      dpadKeys = 0;
      rsKeys = 0;
      rsTaps = 0;
      pendingSkill = SkillMove.NONE;
      suppress = heldBits;
      latch.reset();
      resetRecognisers();
    },
    dispose() {
      if (disposed) return;
      releaseKeys();
      disposed = true;
      seq.dispose();
      target?.removeEventListener('keydown', onDown);
      target?.removeEventListener('keyup', onUp);
      target?.removeEventListener('blur', onBlur);
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
  };
  return api;
}
