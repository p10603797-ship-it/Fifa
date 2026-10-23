/**
 * [PAD-07] Controller remap for pads without the standard mapping (section 10: "A pad without standard mapping gets a
 * remap screen: press the button for each action"; section 12: works by touch alone and by controller alone, Back
 * always works).
 *
 * Flow (route 'remap', optional params.pad = device key 'pad:<n>' to open one pad directly):
 *  - pick   the active pads (pressed once this session). With none yet: "press any button"; the first non-standard
 *           pad that shows up opens by itself, as does the only non-standard pad when the screen opens.
 *  - pad    one pad: its bindings (saved remap or the default positions) with Start remap, Reset to default and
 *           Other controller. A standard-mapping pad needs no remap (the mapper ignores remaps for it): it says so.
 *  - walk   one step per action in PadAction order (PASS, SHOOT, LOB, THROUGH, MOD_L, MOD_R, SHIELD, SPRINT, PAUSE,
 *           D-pad up / down / left / right): "press the button for <action>", with what it does and where it usually
 *           is (glyph of the pad's family, or the face-button diamond). The next new press of a raw button 0..31 on
 *           that pad binds it (buttons already held when the step began never count, so the press that started the
 *           walk is not captured). Skips: the on-screen Skip, or pressing a button already used in this walk (pad
 *           alone: an action the pad lacks, e.g. a D-pad reported as axes). Undo steps back. Cancel / Back / Escape /
 *           holding the last pressed button for REMAP_TUNING.holdCancelMs leave the walk without saving anything.
 *           A disconnect pauses the walk until the pad comes back.
 *  - done   after the last step the remap is saved: settings.controls.pad.remaps[gamepad.id] = raw index per
 *           PadAction (-1 unbound; the PAD-02 mapper and the PAD-08 menu input read it for that non-standard pad).
 *           A walk that bound nothing saves nothing.
 * Menu actions while walking: every action (Confirm, Back, directions, tabs) that the pad being remapped produces is
 * consumed (FocusNavigator.onAction), because its presses are being captured; another pad, the keyboard and touch
 * keep driving the on-screen Skip / Undo / Cancel. After a walk ends, the pad's actions stay consumed until it lets go
 * of every button (a held button never confirms something on the next view).
 *
 * The capture (createRemapCapture) and the view logic (createRemapController) are DOM-free and unit-tested in Node;
 * createRemapScreen is the DOM layer. UI code: allocation is fine; onFrame only polls and patches changed text.
 */
import type { AppContext, FrameInfo, Screen, ScreenParams, SettingsStore } from '../../contracts/app';
import { MenuAction, UiSound } from '../../contracts/app';
import { PadFamily } from '../../contracts/enums';
import { MENU_STICK_RELEASE } from '../../input/menuInput';
import { facePositionSvg, familyForPad, glyph, padLabel, rawButtonLabel } from '../../input/pad/glyphs';
import { getPadManager, PAD_BUTTON_COUNT, type PadManager, type PadSlot } from '../../input/pad/manager';
import { PAD_ACTION_COUNT, PAD_REMAP_MAX_INDEX, PAD_STANDARD_INDEX, PadAction } from '../../input/pad/mapper';
import { createBackButton, createButton, createList, h, injectStyle } from '../components';
import { attachDotField, sharedDotField } from '../dotfield';

const LOCAL_TUNING = {
  /** Holding the button just pressed this long cancels the walk (controller-only Back), ms. */
  holdCancelMs: 1500,
  /** The hold-to-cancel bar starts to fill after this, ms (a normal press never shows it). */
  holdHintMs: 350,
} as const; // LOCAL_TUNING (non-gameplay: menu feel, remap screen hold-to-cancel)

/** The LOCAL_TUNING block (read-only; tests and the lead's tuning review). */
export const REMAP_TUNING = LOCAL_TUNING;

// ============================================================ steps

export interface RemapStep {
  /** PadAction (slot of the remap array). */
  readonly action: number;
  /** Plain-word name. */
  readonly label: string;
  /** What it does (section 10). */
  readonly detail: string;
  /** Standard Gamepad index where it usually is (for the glyph hint). */
  readonly standardIndex: number;
}

/** One step per PadAction, in PadAction order (REMAP_STEPS[i].action === i). */
export const REMAP_STEPS: readonly RemapStep[] = [
  { action: PadAction.PASS, label: 'Pass', detail: 'Ground pass, header, contain, keeper throw. Menus: Confirm.', standardIndex: PAD_STANDARD_INDEX[PadAction.PASS]! },
  { action: PadAction.SHOOT, label: 'Shoot', detail: 'Shoot, tackle, clearance. Menus: Back.', standardIndex: PAD_STANDARD_INDEX[PadAction.SHOOT]! },
  { action: PadAction.LOB, label: 'Lob', detail: 'Lob pass, cross, slide tackle.', standardIndex: PAD_STANDARD_INDEX[PadAction.LOB]! },
  { action: PadAction.THROUGH, label: 'Through ball', detail: 'Through ball, rush the keeper out, drop the ball.', standardIndex: PAD_STANDARD_INDEX[PadAction.THROUGH]! },
  { action: PadAction.MOD_L, label: 'Left shoulder', detail: 'Change player, chip, trigger a run. Menus: previous tab.', standardIndex: PAD_STANDARD_INDEX[PadAction.MOD_L]! },
  { action: PadAction.MOD_R, label: 'Right shoulder', detail: 'Finesse, driven, call for support, second defender. Menus: next tab.', standardIndex: PAD_STANDARD_INDEX[PadAction.MOD_R]! },
  { action: PadAction.SHIELD, label: 'Shield', detail: 'Shield the ball, jockey.', standardIndex: PAD_STANDARD_INDEX[PadAction.SHIELD]! },
  { action: PadAction.SPRINT, label: 'Sprint', detail: 'Sprint. Free kick: choose the taker.', standardIndex: PAD_STANDARD_INDEX[PadAction.SPRINT]! },
  { action: PadAction.PAUSE, label: 'Pause', detail: 'Pause the match.', standardIndex: PAD_STANDARD_INDEX[PadAction.PAUSE]! },
  { action: PadAction.DPAD_UP, label: 'D-pad up', detail: 'Quick tactics. Menus: move up.', standardIndex: PAD_STANDARD_INDEX[PadAction.DPAD_UP]! },
  { action: PadAction.DPAD_DOWN, label: 'D-pad down', detail: 'Substitutions, corner tactics. Menus: move down.', standardIndex: PAD_STANDARD_INDEX[PadAction.DPAD_DOWN]! },
  { action: PadAction.DPAD_LEFT, label: 'D-pad left', detail: 'Tactics. Menus: move left.', standardIndex: PAD_STANDARD_INDEX[PadAction.DPAD_LEFT]! },
  { action: PadAction.DPAD_RIGHT, label: 'D-pad right', detail: 'Tactical focus. Menus: move right.', standardIndex: PAD_STANDARD_INDEX[PadAction.DPAD_RIGHT]! },
];

const POSITION_WORDS: Readonly<Record<number, string>> = {
  0: 'the bottom face button', 1: 'the right face button', 2: 'the left face button', 3: 'the top face button',
  4: 'the upper left shoulder button', 5: 'the upper right shoulder button', 6: 'the lower left trigger',
  7: 'the lower right trigger', 9: 'the start or menu button', 12: 'up on the D-pad', 13: 'down on the D-pad',
  14: 'left on the D-pad', 15: 'right on the D-pad',
};

/** Where an action usually is on a pad of `family`: { text, svg } (svg = generated glyph markup). */
export function stepHint(step: RemapStep, family: PadFamily): { text: string; svg: string } {
  const i = step.standardIndex;
  if (family === PadFamily.PLAYSTATION || family === PadFamily.XBOX || family === PadFamily.SWITCH) {
    const g = glyph(family, i);
    const article = g.shape === 'dpad' || g.shape === 'shoulder' || g.shape === 'trigger' ? '' : 'the ';
    return { text: `Usually ${article}${g.name}`, svg: g.svg };
  }
  const svg = i >= 0 && i <= 3 ? facePositionSvg(i) : glyph(PadFamily.GENERIC, i).svg;
  return { text: `Usually ${POSITION_WORDS[i] ?? 'a spare button'}`, svg };
}

// ============================================================ capture (pure, DOM-free)

/** Raw buttons a remap can name: bit i = raw button i down (0..PAD_REMAP_MAX_INDEX - 1). 0 when disconnected. */
export function readRawButtons(s: Readonly<PadSlot> | null | undefined): number {
  if (!s || !s.connected) return 0;
  let m = s.pressed & ((1 << PAD_BUTTON_COUNT) - 1);
  const btns = s.pad ? s.pad.buttons : null;
  if (btns) {
    const n = Math.min(btns.length, PAD_REMAP_MAX_INDEX);
    for (let b = PAD_BUTTON_COUNT; b < n; b++) {
      const v = btns[b] as GamepadButton | number | null | undefined;
      const down = typeof v === 'number' ? v > 0.5 : !!v && v.pressed === true;
      if (down) m |= 1 << b;
    }
  }
  return m;
}

/** Index of the lowest set bit (0..31), -1 for 0. */
function lowestBit(m: number): number {
  return m === 0 ? -1 : 31 - Math.clz32(m & -m);
}

export type CaptureState = 'listening' | 'disconnected' | 'done' | 'cancelled';

/** What one poll of the capture did. */
export enum CaptureResult {
  NONE = 0,
  /** A new raw button was bound to the step (capture.lastRaw); the step advanced. */
  CAPTURED = 1,
  /** A button already used in this walk was pressed: the step was skipped (left unbound). */
  SKIPPED_DUPLICATE = 2,
  /** The pressed button was held for REMAP_TUNING.holdCancelMs: the walk is cancelled. */
  CANCELLED = 3,
  DISCONNECTED = 4,
  RECONNECTED = 5,
}

export interface RemapCapture {
  /** Device key of the pad being remapped. */
  readonly key: string;
  readonly state: CaptureState;
  /** Current step (index into REMAP_STEPS); PAD_ACTION_COUNT once done. */
  readonly step: number;
  /** Raw button per PadAction so far (-1 = unbound / not reached). */
  readonly binding: readonly number[];
  /** Raw button of the last capture (-1 none). */
  readonly lastRaw: number;
  /** Hold-to-cancel progress 0..1 (0 unless the last pressed button is held past REMAP_TUNING.holdHintMs). */
  readonly holdProgress: number;
  /** Read the pad (the manager must have been polled this frame). */
  poll(nowMs: number): CaptureResult;
  /** Leave the current step unbound and go on. */
  skip(): void;
  /** Step back one and clear it. */
  undo(): void;
  cancel(): void;
}

/** A walk over REMAP_STEPS for the pad `key` of `pads` (buttons held right now are not captured). */
export function createRemapCapture(pads: PadManager, key: string): RemapCapture {
  const binding: number[] = new Array<number>(PAD_ACTION_COUNT).fill(-1);
  const first = pads.find(key);
  let state: CaptureState = first && first.connected ? 'listening' : 'disconnected';
  let step = 0;
  let prev = readRawButtons(first);
  let lastRaw = -1;
  let holdBtn = -1;
  let holdStart = 0;
  let holdProgress = 0;
  const live = (): boolean => state === 'listening' || state === 'disconnected';
  const clearHold = (): void => {
    holdBtn = -1;
    holdProgress = 0;
  };
  const advance = (): void => {
    step++;
    if (step >= PAD_ACTION_COUNT) {
      step = PAD_ACTION_COUNT;
      state = 'done';
      clearHold();
    }
  };
  return {
    key,
    get state() { return state; },
    get step() { return step; },
    binding,
    get lastRaw() { return lastRaw; },
    get holdProgress() { return holdProgress; },
    poll(nowMs: number): CaptureResult {
      if (!live()) return CaptureResult.NONE;
      const s = pads.find(key);
      if (!s || !s.connected) {
        prev = 0;
        clearHold();
        if (state === 'disconnected') return CaptureResult.NONE;
        state = 'disconnected';
        return CaptureResult.DISCONNECTED;
      }
      const cur = readRawButtons(s);
      if (state === 'disconnected') {
        // Anything held while it reconnects is ignored until released and pressed again.
        state = 'listening';
        prev = cur;
        return CaptureResult.RECONNECTED;
      }
      const edges = cur & ~prev;
      prev = cur;
      if (holdBtn >= 0) {
        if ((cur & (1 << holdBtn)) === 0) {
          clearHold();
        } else {
          const t = nowMs - holdStart;
          if (t >= LOCAL_TUNING.holdCancelMs) {
            state = 'cancelled';
            clearHold();
            return CaptureResult.CANCELLED;
          }
          const f = (t - LOCAL_TUNING.holdHintMs) / (LOCAL_TUNING.holdCancelMs - LOCAL_TUNING.holdHintMs);
          holdProgress = f > 0 ? (f < 1 ? f : 1) : 0;
        }
      }
      if (edges === 0) return CaptureResult.NONE;
      const raw = lowestBit(edges);
      lastRaw = raw;
      holdBtn = raw;
      holdStart = nowMs;
      holdProgress = 0;
      let dup = false;
      for (let i = 0; i < step; i++) if (binding[i] === raw) dup = true;
      binding[step] = dup ? -1 : raw;
      advance();
      return dup ? CaptureResult.SKIPPED_DUPLICATE : CaptureResult.CAPTURED;
    },
    skip() {
      if (!live()) return;
      binding[step] = -1;
      clearHold();
      advance();
    },
    undo() {
      if (!live() || step === 0) return;
      step--;
      binding[step] = -1;
      clearHold();
    },
    cancel() {
      if (!live()) return;
      state = 'cancelled';
      clearHold();
    },
  };
}

// ============================================================ view controller (DOM-free)

export type RemapView = 'pick' | 'pad' | 'walk' | 'done';

export interface RemapControllerDeps {
  pads: PadManager;
  settings: Pick<SettingsStore, 'get' | 'update'>;
  /** Device key of the pad to open ('pad:<n>', route params.pad). */
  padKey?: string | null;
}

export interface RemapController {
  readonly view: RemapView;
  /** Selected pad (device key) or null. */
  readonly padKey: string | null;
  /** The walk in progress (view 'walk'), else the last walk, else null. */
  readonly capture: RemapCapture | null;
  /** Status line ('' = none). */
  readonly notice: string;
  /** Bumps whenever anything shown changes. */
  readonly version: number;
  /** Changes when the view must be rebuilt (not just patched): view, pad, pad list, saved remap. */
  layoutKey(): string;
  /** Active pads (pressed once this session) that are connected, plus the selected pad, in activation order. */
  pads(): PadSlot[];
  slot(): PadSlot | null;
  /** The remap saved for the selected pad's gamepad.id, or null (default positions). */
  saved(): number[] | null;
  /** Raw button per PadAction the selected pad is read through now (saved remap, else the standard positions). */
  current(): number[];
  family(): PadFamily;
  select(key: string): void;
  showPicker(): void;
  /** Start the walk on the selected non-standard pad. False when not possible. */
  start(): boolean;
  skip(): void;
  undo(): void;
  cancel(): void;
  /** Remove the saved remap of the selected pad. */
  resetSaved(): void;
  /** Once per animation frame, after the menu input poll. */
  frame(nowMs: number): void;
  /** FocusNavigator.onAction hook: true = consumed (the pad being remapped pressed it). */
  consumeAction(a: MenuAction): boolean;
  /** Screen.onBack: true = handled here. */
  back(): boolean;
  dispose(): void;
}

const hasOwn = Object.prototype.hasOwnProperty;
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

function remapsOf(settings: Pick<SettingsStore, 'get'>): Readonly<Record<string, readonly number[]>> | null {
  try {
    const r = settings.get()?.controls?.pad?.remaps;
    return r && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

export function createRemapController(deps: RemapControllerDeps): RemapController {
  const { pads, settings } = deps;
  let view: RemapView = 'pick';
  let padKey: string | null = null;
  let capture: RemapCapture | null = null;
  let notice = '';
  let version = 0;
  /** In 'pick' with no non-standard pad yet: open the first one that appears. */
  let autoPick = false;
  /** The pad was chosen from a list of several: Back returns to the list. */
  let fromList = false;
  /** Keep consuming the remapped pad's menu actions until it lets go of everything. */
  let settleKey: string | null = null;
  let listSig = '';
  let lastNow = 0;

  const bump = (): void => { version++; };

  function activePads(): PadSlot[] {
    const out: PadSlot[] = [];
    const slots = pads.slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      if (s.active && (s.connected || s.key === padKey)) out.push(s);
    }
    out.sort((a, b) => a.ordinal - b.ordinal);
    return out;
  }

  function nonStandard(list: readonly PadSlot[]): PadSlot[] {
    const out: PadSlot[] = [];
    for (const s of list) if (s.connected && !s.standard) out.push(s);
    return out;
  }

  function signature(): string {
    let sig = '';
    for (const s of activePads()) sig += `${s.key}:${s.connected ? 1 : 0}:${s.standard ? 1 : 0};`;
    return sig;
  }

  function slot(): PadSlot | null {
    return padKey ? pads.find(padKey) : null;
  }

  function saved(): number[] | null {
    const s = slot();
    if (!s) return null;
    const r = remapsOf(settings);
    if (!r || !hasOwn.call(r, s.gamepadId)) return null;
    const v = (r as Record<string, unknown>)[s.gamepadId];
    if (!Array.isArray(v)) return null;
    const out: number[] = [];
    for (let a = 0; a < PAD_ACTION_COUNT; a++) {
      const b = v[a] as unknown;
      out.push(typeof b === 'number' && Number.isInteger(b) && b >= 0 && b < PAD_REMAP_MAX_INDEX ? b : -1);
    }
    return out;
  }

  /**
   * The pad holds a button 0..31, or (withStick) its left stick is past the menu release level. Only directions look
   * at the stick: a non-standard pad whose axis rests off centre never blocks the keyboard's Confirm / Back.
   */
  function busy(key: string, withStick: boolean): boolean {
    const s = pads.find(key);
    if (!s || !s.connected) return false;
    if (readRawButtons(s) !== 0) return true;
    return withStick && (Math.abs(s.lx) >= MENU_STICK_RELEASE || Math.abs(s.ly) >= MENU_STICK_RELEASE);
  }

  /** Open a pad's view. viaList: the user chose it from a list of several (Back then returns to the list). */
  function open(key: string, viaList: boolean): void {
    if (!pads.find(key)) return;
    fromList = viaList;
    padKey = key;
    view = 'pad';
    autoPick = false;
    notice = '';
    bump();
  }

  function select(key: string): void {
    open(key, view === 'pick' && activePads().length > 1);
  }

  function showPicker(): void {
    if (view === 'walk') return;
    view = 'pick';
    notice = '';
    autoPick = false;
    bump();
  }

  function save(binding: readonly number[]): boolean {
    const s = slot();
    if (!s) return false;
    const id = s.gamepadId;
    if (typeof id !== 'string' || UNSAFE_KEYS.includes(id)) return false;
    const copy = binding.slice(0, PAD_ACTION_COUNT);
    try {
      settings.update((st) => {
        const pad = st.controls.pad;
        if (!pad.remaps || typeof pad.remaps !== 'object') pad.remaps = {};
        pad.remaps[id] = copy;
      });
    } catch {
      return false;
    }
    const after = saved();
    if (!after) return false;
    for (let a = 0; a < PAD_ACTION_COUNT; a++) if (after[a] !== copy[a]) return false;
    return true;
  }

  function endWalk(msg: string, next: RemapView): void {
    view = next;
    notice = msg;
    if (padKey) settleKey = padKey;
    bump();
  }

  function finish(): void {
    if (!capture) return;
    let bound = 0;
    for (let a = 0; a < PAD_ACTION_COUNT; a++) if (capture.binding[a]! >= 0) bound++;
    if (bound === 0) {
      endWalk('No buttons were set, so nothing changed.', 'pad');
      return;
    }
    if (save(capture.binding)) endWalk('Saved. This controller now uses these buttons.', 'done');
    else endWalk('Could not save the remap. Nothing changed.', 'pad');
  }

  function stepName(i: number): string {
    return REMAP_STEPS[i]?.label ?? '';
  }

  // Initial view.
  {
    const list = activePads();
    const want = typeof deps.padKey === 'string' ? pads.find(deps.padKey) : null;
    if (want && want.active) {
      padKey = want.key;
      view = 'pad';
    } else {
      const ns = nonStandard(list);
      if (ns.length === 1) {
        padKey = ns[0]!.key;
        view = 'pad';
      } else {
        view = 'pick';
        autoPick = ns.length === 0;
      }
    }
    listSig = signature();
  }

  const api: RemapController = {
    get view() { return view; },
    get padKey() { return padKey; },
    get capture() { return capture; },
    get notice() { return notice; },
    get version() { return version; },
    layoutKey() {
      if (view === 'walk') return `walk|${padKey}`;
      const sv = view === 'pick' ? '' : (saved() ?? []).join(',');
      return `${view}|${padKey}|${listSig}|${sv}`;
    },
    pads: activePads,
    slot,
    saved,
    current() {
      const sv = saved();
      const s = slot();
      if (sv && s && !s.standard) return sv;
      return PAD_STANDARD_INDEX.slice(0, PAD_ACTION_COUNT);
    },
    family() {
      const s = slot();
      if (!s) return PadFamily.GENERIC;
      let st: ReturnType<typeof settings.get> | null;
      try {
        st = settings.get();
      } catch {
        st = null;
      }
      return familyForPad(s.gamepadId, st);
    },
    select,
    showPicker,
    start() {
      const s = slot();
      if (view === 'walk' || !s || !s.connected || s.standard) return false;
      capture = createRemapCapture(pads, s.key);
      view = 'walk';
      notice = '';
      bump();
      return true;
    },
    skip() {
      if (view !== 'walk' || !capture) return;
      const was = capture.step;
      capture.skip();
      notice = `${stepName(was)} skipped.`;
      bump();
      if (capture.state === 'done') finish();
    },
    undo() {
      if (view !== 'walk' || !capture || capture.step === 0) return;
      capture.undo();
      notice = `Press the button for ${stepName(capture.step)} again.`;
      bump();
    },
    cancel() {
      if (view !== 'walk' || !capture) return;
      capture.cancel();
      endWalk('Remap cancelled. Nothing changed.', 'pad');
    },
    resetSaved() {
      const s = slot();
      if (!s || view === 'walk') return;
      const id = s.gamepadId;
      try {
        settings.update((st) => {
          const r = st.controls.pad.remaps;
          if (r && typeof r === 'object' && hasOwn.call(r, id)) delete r[id];
        });
      } catch {
        notice = 'Could not reset the remap.';
        bump();
        return;
      }
      view = 'pad';
      notice = 'Back to the default buttons.';
      bump();
    },
    frame(nowMs: number) {
      lastNow = Number.isFinite(nowMs) ? nowMs : lastNow;
      pads.poll(lastNow);
      const sig = signature();
      if (sig !== listSig) {
        listSig = sig;
        bump();
        if (view === 'pick' && autoPick) {
          const ns = nonStandard(activePads());
          if (ns.length === 1) open(ns[0]!.key, false);
        }
      }
      if (settleKey !== null && !busy(settleKey, false)) settleKey = null;
      if (view !== 'walk' || !capture) return;
      const before = capture.holdProgress;
      const was = capture.step;
      const r = capture.poll(lastNow);
      switch (r) {
        case CaptureResult.CAPTURED:
          notice = `${stepName(was)}: ${rawButtonLabel(capture.lastRaw)}.`;
          break;
        case CaptureResult.SKIPPED_DUPLICATE:
          notice = `${rawButtonLabel(capture.lastRaw)} is already used, so ${stepName(was)} was skipped.`;
          break;
        case CaptureResult.CANCELLED:
          endWalk('Remap cancelled. Nothing changed.', 'pad');
          return;
        case CaptureResult.DISCONNECTED:
          notice = 'Controller disconnected. Reconnect it to carry on.';
          break;
        case CaptureResult.RECONNECTED:
          notice = 'Controller back. Carry on.';
          break;
        default:
          if (capture.holdProgress !== before) bump();
          return;
      }
      bump();
      if (capture.state === 'done') finish();
    },
    consumeAction(a: MenuAction) {
      const dir = a === MenuAction.UP || a === MenuAction.DOWN || a === MenuAction.LEFT || a === MenuAction.RIGHT;
      if (view === 'walk' && capture && padKey) return busy(padKey, dir);
      if (settleKey !== null) {
        if (busy(settleKey, false)) return true;
        settleKey = null;
      }
      return false;
    },
    back() {
      if (view === 'walk') {
        api.cancel();
        return true;
      }
      if ((view === 'pad' || view === 'done') && fromList && activePads().length > 1) {
        showPicker();
        return true;
      }
      return false;
    },
    dispose() {
      if (view === 'walk' && capture) capture.cancel();
      capture = null;
      settleKey = null;
    },
  };
  return api;
}

// ============================================================ DOM

const CSS = `
.rmp { display: flex; flex-direction: column; align-items: center; gap: var(--space-4); width: min(920px, 100%);
  max-height: 100%; min-height: 0; }
.rmp__head { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); text-align: center; }
.rmp__eyebrow { margin: 0; }
.rmp__body { display: flex; flex-direction: column; align-items: center; gap: var(--space-4); width: 100%; min-height: 0; }
.rmp__notice { margin: 0; min-height: 1.4em; font-size: var(--fs-sm); color: var(--text-2); text-align: center; }
.rmp__notice:empty { visibility: hidden; }
.rmp__warn { color: var(--warning); }
.rmp__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--space-1) var(--space-5);
  width: 100%; margin: 0; padding: var(--space-4) var(--space-5); box-sizing: border-box; background: var(--surface-1);
  border: var(--line) solid var(--hairline); border-radius: var(--radius-lg); }
.rmp__cell { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3); padding: var(--space-1) 0;
  border-bottom: var(--line) solid var(--hairline); font-size: var(--fs-sm); }
.rmp__cell dt { color: var(--text-2); }
.rmp__cell dd { margin: 0; font-family: var(--font-num); color: var(--text-1); white-space: nowrap; }
.rmp__cell dd[data-unset] { color: var(--text-3); }
.rmp__pads { width: min(560px, 100%); }
.rmp__prompt { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); text-align: center; }
.rmp__ask { margin: 0; font-size: var(--fs-md); color: var(--text-2); }
.rmp__action { margin: 0; font-size: var(--fs-hero); font-weight: var(--fw-bold); line-height: var(--lh-tight); color: var(--text-1); }
.rmp__detail { margin: 0; font-size: var(--fs-sm); color: var(--text-3); max-width: 36em; }
.rmp__where { display: inline-flex; align-items: center; gap: var(--space-3); font-size: var(--fs-sm); color: var(--text-2); }
.rmp__where .dk-glyph { width: 40px; height: 40px; color: var(--ember); flex: none; }
.rmp__dots { display: flex; gap: var(--space-2); justify-content: center; }
.rmp__dot { width: 12px; height: 12px; border-radius: 50%; box-sizing: border-box; border: 2px solid var(--line-control); }
.rmp__dot[data-state="bound"] { background: var(--text-1); border-color: var(--text-1); }
.rmp__dot[data-state="skipped"] { border-style: dashed; }
.rmp__dot[data-state="current"] { border-color: var(--ember); background: var(--ember-soft); transform: scale(1.35); }
.rmp__hold { display: flex; flex-direction: column; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); color: var(--text-3); }
.rmp__bar { width: 160px; height: 4px; border-radius: var(--radius-pill); background: var(--surface-3); overflow: hidden; }
.rmp__fill { width: 100%; height: 100%; background: var(--ember); transform-origin: left center; transform: scaleX(0); }
`;

/** DOM nodes of the walk view patched in place. */
interface WalkNodes {
  step: HTMLElement;
  action: HTMLElement;
  detail: HTMLElement;
  where: HTMLElement;
  dots: HTMLElement[];
  fill: HTMLElement;
  undo: HTMLButtonElement;
  renderedStep: number;
  renderedHold: number;
}

function padTitle(s: PadSlot): string {
  return s.ordinal > 0 ? `Controller ${s.ordinal}` : 'Controller';
}

function svgNode(svg: string): HTMLElement {
  const span = h('span', { class: 'rmp__glyph', attrs: { 'aria-hidden': 'true' } });
  span.innerHTML = svg; // generated in glyphs.ts from constants only (no user text)
  return span;
}

function bindingGrid(binding: readonly number[], testId: string): HTMLElement {
  const dl = h('dl', { class: 'rmp__grid', testId });
  for (let a = 0; a < PAD_ACTION_COUNT; a++) {
    const v = binding[a] ?? -1;
    const dd = h('dd', { text: rawButtonLabel(v), testId: `${testId}-${a}` });
    if (v < 0) dd.dataset.unset = '';
    dl.append(h('div', { class: 'rmp__cell' }, h('dt', { text: REMAP_STEPS[a]!.label }), dd));
  }
  return dl;
}

/** Remap screen (route 'remap'; params.pad = device key to open). */
export function createRemapScreen(): Screen {
  let ctl: RemapController | null = null;
  let cleanup: (() => void) | null = null;
  let sync: (() => void) | null = null;

  return {
    id: 'remap',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectStyle('remap', CSS);
      const detachDots = attachDotField(root);
      let pads: PadManager;
      try {
        pads = (ctx.devices as unknown as { pads?: PadManager }).pads ?? getPadManager();
      } catch {
        pads = getPadManager();
      }
      const c = createRemapController({ pads, settings: ctx.settings, padKey: typeof params.pad === 'string' ? params.pad : null });
      ctl = c;

      const title = h('h1', { class: 'ui-title', text: 'Controller remap', testId: 'remap-title' });
      const eyebrow = h('p', { class: 'rmp__eyebrow eyebrow', testId: 'remap-eyebrow' });
      const head = h('div', { class: 'rmp__head' }, eyebrow, title);
      const body = h('div', { class: 'rmp__body' });
      const notice = h('p', { class: 'rmp__notice', testId: 'remap-notice', attrs: { role: 'status', 'aria-live': 'polite' } });
      const wrap = h('div', { class: 'rmp', testId: 'remap' }, head, body, notice);
      root.append(wrap, createBackButton(ctx));

      let renderedKey = '';
      let renderedVersion = -1;
      let walk: WalkNodes | null = null;

      function renderPick(): void {
        eyebrow.textContent = 'Controllers';
        const list = c.pads();
        if (list.length === 0) {
          body.append(h('p', { class: 'ui-subtitle', text: 'Press any button on the controller you want to set up.', testId: 'remap-waiting' }));
          return;
        }
        body.append(h('p', { class: 'ui-subtitle', text: 'Choose the controller to set up.' }));
        const items = list.map((s) => ({
          label: padTitle(s),
          detail: `${padLabel(s.gamepadId)} · ${s.standard ? 'standard layout' : 'needs a remap'}${s.connected ? '' : ' · disconnected'}`,
          testId: `remap-pad-${s.key.replace(':', '-')}`,
          onSelect: () => c.select(s.key),
        }));
        const lst = createList(items, { ctx, testId: 'remap-pads', ariaLabel: 'Controllers' });
        lst.classList.add('rmp__pads');
        const firstNs = lst.querySelector<HTMLElement>('button');
        if (firstNs) firstNs.dataset.focusDefault = '';
        body.append(lst);
      }

      function renderPad(done: boolean): void {
        const s = c.slot();
        if (!s) {
          c.showPicker();
          return;
        }
        eyebrow.textContent = `${padTitle(s)} · ${padLabel(s.gamepadId)}`;
        const sv = c.saved();
        if (done) {
          title.textContent = 'Controller ready';
        } else if (s.standard) {
          body.append(h('p', {
            class: 'ui-subtitle', testId: 'remap-standard',
            text: 'This controller uses the standard layout, so every button already works. Only controllers without it need a remap.',
          }));
        } else {
          body.append(h('p', {
            class: 'ui-subtitle', testId: 'remap-intro',
            text: sv
              ? 'This controller uses your remap. Remap again to change it.'
              : 'This controller has no standard layout. Set it up once: press the button for each action.',
          }));
        }
        if (!s.connected) body.append(h('p', { class: 'ui-note rmp__warn', text: 'Disconnected. Reconnect it to remap.' }));
        const binding = s.standard ? PAD_STANDARD_INDEX.slice(0, PAD_ACTION_COUNT) : c.current();
        body.append(bindingGrid(binding, 'remap-binding'));
        if (!s.standard && sv && (sv[PadAction.PASS]! < 0 || sv[PadAction.SHOOT]! < 0)) {
          body.append(h('p', { class: 'ui-note rmp__warn', testId: 'remap-warn', text: 'Pass and Shoot are Confirm and Back in menus: set both to use menus with this controller.' }));
        }
        const row = h('div', { class: 'ui-row' });
        if (done) {
          row.append(createButton('Done', () => ctx.router.back(), { testId: 'remap-done', variant: 'primary', autofocus: true, ctx }));
        }
        if (!s.standard) {
          row.append(createButton(sv ? 'Remap again' : 'Start remap', () => { c.start(); }, {
            testId: done ? 'remap-again' : 'remap-start', variant: done ? 'secondary' : 'primary', autofocus: !done, ctx,
            disabled: !s.connected,
          }));
          if (sv) row.append(createButton('Reset to default', () => c.resetSaved(), { testId: 'remap-reset', variant: 'ghost', ctx }));
        }
        if (c.pads().length > 1) row.append(createButton('Other controller', () => c.showPicker(), { testId: 'remap-other', variant: 'ghost', ctx }));
        body.append(row);
      }

      function renderWalk(): void {
        const s = c.slot();
        eyebrow.textContent = s ? `${padTitle(s)} · ${padLabel(s.gamepadId)}` : 'Controller';
        const step = h('p', { class: 'eyebrow', testId: 'remap-step' });
        const action = h('p', { class: 'rmp__action', testId: 'remap-action' });
        const detail = h('p', { class: 'rmp__detail' });
        const where = h('div', { class: 'rmp__where', testId: 'remap-where' });
        const prompt = h('div', { class: 'rmp__prompt' }, step, h('p', { class: 'rmp__ask', text: 'Press the button for' }), action, detail, where);
        const dotsRow = h('div', { class: 'rmp__dots', testId: 'remap-dots', attrs: { 'aria-hidden': 'true' } });
        const dots: HTMLElement[] = [];
        for (let a = 0; a < PAD_ACTION_COUNT; a++) {
          const d = h('span', { class: 'rmp__dot' });
          dots.push(d);
          dotsRow.append(d);
        }
        const fill = h('span', { class: 'rmp__fill' });
        const hold = h('div', { class: 'rmp__hold' },
          h('span', { text: 'No such button? Press one you already used to skip it. Hold a button to cancel.' }),
          h('span', { class: 'rmp__bar' }, fill));
        const undo = createButton('Undo', () => c.undo(), { testId: 'remap-undo', variant: 'ghost', ctx, sound: UiSound.BACK });
        const row = h('div', { class: 'ui-row' },
          createButton('Skip', () => c.skip(), { testId: 'remap-skip', autofocus: true, ctx, sound: UiSound.MOVE }),
          undo,
          createButton('Cancel', () => c.cancel(), { testId: 'remap-cancel', variant: 'ghost', ctx, sound: UiSound.BACK }));
        body.append(prompt, dotsRow, hold, row);
        walk = { step, action, detail, where, dots, fill, undo, renderedStep: -1, renderedHold: -1 };
      }

      function patchWalk(): void {
        const cap = c.capture;
        if (!walk || !cap) return;
        if (walk.renderedStep !== cap.step) {
          walk.renderedStep = cap.step;
          const i = Math.min(cap.step, PAD_ACTION_COUNT - 1);
          const st = REMAP_STEPS[i]!;
          walk.step.textContent = `Step ${i + 1} of ${PAD_ACTION_COUNT}`;
          walk.action.textContent = st.label;
          walk.detail.textContent = st.detail;
          const hint = stepHint(st, c.family());
          walk.where.replaceChildren(svgNode(hint.svg), h('span', { text: hint.text }));
          for (let a = 0; a < PAD_ACTION_COUNT; a++) {
            walk.dots[a]!.dataset.state = a === cap.step ? 'current' : a < cap.step ? (cap.binding[a]! >= 0 ? 'bound' : 'skipped') : 'todo';
          }
          walk.undo.disabled = cap.step === 0;
        }
        const hp = Math.round(cap.holdProgress * 50) / 50;
        if (hp !== walk.renderedHold) {
          walk.renderedHold = hp;
          walk.fill.style.transform = `scaleX(${hp})`;
        }
      }

      function render(): void {
        body.replaceChildren();
        title.textContent = 'Controller remap';
        walk = null;
        if (c.view === 'pick') renderPick();
        else if (c.view === 'pad') renderPad(false);
        else if (c.view === 'done') renderPad(true);
        else renderWalk();
      }

      sync = () => {
        if (c.version === renderedVersion) return;
        renderedVersion = c.version;
        const key = c.layoutKey();
        if (key !== renderedKey) {
          renderedKey = key;
          render();
          // render() may change the view (a pad that vanished): settle in the same frame.
          if (c.layoutKey() !== renderedKey) {
            renderedKey = c.layoutKey();
            render();
          }
          renderedVersion = c.version;
        }
        if (notice.textContent !== c.notice) notice.textContent = c.notice;
        patchWalk();
      };
      sync();

      const offAction = ctx.focus.onAction((a) => c.consumeAction(a));
      cleanup = () => {
        offAction();
        c.dispose();
        detachDots();
      };
    },
    unmount() {
      cleanup?.();
      cleanup = null;
      sync = null;
      ctl = null;
    },
    onBack() {
      return ctl ? ctl.back() : false;
    },
    onFrame(frame: FrameInfo) {
      sharedDotField().frame(frame.nowMs);
      if (!ctl) return;
      ctl.frame(frame.nowMs);
      sync?.();
    },
  };
}
