/**
 * [TCH-09] Touch overlay rendering (section 9 "Layout" + "Touch quality bar", section 12 visual identity, section 3
 * safe areas). The DOM for the floating stick, the four right-hand cluster slots and the pause button, drawn from the
 * same TouchIntentState the controls write (and, once bound, from TCH-04's cluster controller and TCH-02's stick
 * config).
 *
 *  - Stick: base ring + thumb at the floating origin while a thumb is down (`.dk-stick.is-active`); a fixed stick
 *    (StickConfig.floating false) also shows its ring at the fixed origin while idle (`.is-fixed`). The thumb is
 *    clamped to the rim; ring and thumb scale with StickConfig.radius (the editor's size).
 *  - Cluster: one `.dk-tbtn` per ClusterSlot (BIG gets `.dk-tbtn--big`) with `data-slot` and `data-btn` = the
 *    TouchButtonId the slot stands for now. Labels come from the cluster controller (ids / labels / pressed / version:
 *    a held thumb keeps its touch-down meaning, CLEAR replaces SLIDE, the keeper row) with plain-word captions for
 *    the big button (SPRINT & SKILL / SPRINT & TACKLE). Without a bound controller the same view is derived from the
 *    intent state (mode, clearOn, held), so the overlay always tracks possession. Slots hide (`.is-hidden`) in
 *    cut-scenes (ClusterMode.HIDDEN) and for PASS / THROUGH / SHOOT under Gestures Only.
 *  - Pressed state: `.is-pressed` toggled synchronously inside sync(), which index.ts calls from the pointer manager's
 *    onChange (the pointerdown path), so the pressed look is in the DOM before the next frame is painted.
 *  - Power ring on the slot of TouchIntentState.powerButton from TouchIntentState.power: two clipped half rings
 *    rotated with transforms (no stroke or size animation).
 *  - Swipe direction hints: arrows with plain-word labels (ATTACK_SWIPE_HINTS / DEFENCE_SWIPE_HINTS) around a press
 *    the cluster reports in hintMask (250 ms hold during the first matches; the cluster owns the timer and the
 *    hintMatchesLeft setting). Unbound fallback: the hold timer from downAt, gated by touchSettings().hintMatchesLeft.
 *  - Set-piece flight preview (TCH-06): up to PREVIEW_DOTS dots along previewX / previewY.
 *  - Pause button top right (`.dk-tbtn--pause`, pressed from the PAUSE held bit).
 *  - Opacity from settings (setOpacity, a CSS variable on the visual layer); size comes with the layout. Hidden with an
 *    opacity fade while TouchIntentState.hiddenByPad (a controller drives this side); the next screen touch clears it
 *    (index.ts onDown) and the controls return. createPadDriveWatcher sets hiddenByPad when a pad of the same human
 *    has fresh input (wired by the device registry, see the CR in the TCH-09 report).
 *  - Only the full-screen layer `.dk-touch` takes pointer events; every child is a visual with pointer-events: none,
 *    positioned with translate3d. Animations touch transform / opacity only. sync() writes the DOM only when a value
 *    changed (domWrites counts every write for tests) and allocates nothing.
 *  - HUD regions (scoreboard top left, the top-centre HUD lane, radar bottom centre) are published by hudRegions();
 *    the default layout never overlaps them and the controls editor (TCH-08) keeps custom layouts clear of them.
 *
 * Wiring (TCH-07, index.ts): createTouchOverlay(root, state) as today; after createClusterController() call
 * overlay.bind({ cluster, stickConfig: stickCfg, touchSettings: () => settings.get().controls.touch }) (CR).
 */

import './overlay.css';
import type { TouchSettings } from '../../contracts/settings';
import {
  ClusterMode, ClusterSlot, SwipeDir, TouchButtonId, type TouchIntentState,
} from '../../contracts/touch';
import { T_TOUCHUI } from '../../contracts/tuning';
import { ATTACK_SWIPE_HINTS, SLOT_ATTACK_BUTTON, type ClusterLayout, type SafeInsets } from './attack';
import { buttonLabel, DEFENCE_SWIPE_HINTS, SLOT_DEFENCE_BUTTON, slotButton } from './cluster';
import type { StickConfig } from './stick';

const LOCAL_TUNING = {
  /** Stick thumb diameter at the default stick radius, pt (scales with the radius). */
  knob: 56,
  /** Set-piece preview dots drawn at most. */
  previewDots: 24,
  /** Power ring quantisation steps (DOM writes only when the step changes). */
  powerSteps: 64,
  /** HUD regions (CSS px at the larger-HUD scale, so both HUD sizes fit): scoreboard box from its top-left anchor. */
  scoreboardW: 360,
  scoreboardH: 64,
  scoreboardTop: 16,
  /** Top-centre HUD lane (toasts, hints): half width and height below the safe top edge. */
  laneHalfW: 220,
  laneH: 120,
  /** Radar box (canvas + padding + border at the larger-HUD scale) and its gap to the bottom safe edge. */
  radarW: 230,
  radarH: 152,
  radarBottom: 16,
  /** Swipe-hint size estimate (11 px semi-bold caps): px per character, fixed extra width (padding, border, arrow,
   *  gap), height (arrow + gap + label), and the offset from the button edge (overlay.css translate). */
  hintCharPx: 7,
  hintExtraW: 30,
  hintH: 34,
  hintOffset: 8,
  /** Keep hints this far inside the viewport / safe area, px. */
  hintMargin: 4,
} as const; // TUNING-CR (HUD-anchored layout, not gameplay): T_TOUCHUI.overlay = { ... }

/** The LOCAL_TUNING block (read-only; tests, the controls editor and the lead's TUNING-CR review). */
export const OVERLAY_TUNING = LOCAL_TUNING;
export const PREVIEW_DOTS = LOCAL_TUNING.previewDots;

// ============================================================ HUD regions (pure)

/** Axis-aligned rectangle, CSS px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * HUD regions touch controls must never cover, for a w x h viewport with safe-area insets: [scoreboard (top left),
 * top-centre HUD lane, radar (bottom centre)]. The scoreboard stays top left in the mirrored layout too. Pure.
 */
export function hudRegions(w: number, h: number, safe: Readonly<SafeInsets>, out?: Rect[]): Rect[] {
  const r = out ?? [{ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 }];
  const T = LOCAL_TUNING;
  const st = fin(safe.top), sl = fin(safe.left), sb = fin(safe.bottom);
  const sb0 = r[0]!, lane = r[1]!, radar = r[2]!;
  sb0.x = sl + T_TOUCHUI.systemEdgeMargin; sb0.y = st + T.scoreboardTop; sb0.w = T.scoreboardW; sb0.h = T.scoreboardH;
  lane.x = w / 2 - T.laneHalfW; lane.y = st; lane.w = T.laneHalfW * 2; lane.h = T.laneH;
  radar.x = w / 2 - T.radarW / 2; radar.y = h - sb - T.radarBottom - T.radarH; radar.w = T.radarW; radar.h = T.radarH;
  return r;
}

/**
 * Shift (px, into out.x / out.y) that keeps the swipe hint of direction `dir` (SwipeDir UP..RIGHT) with text `label`
 * around a button at (cx, cy) radius r inside a w x h viewport and its safe area (QF-3: the BIG button's right and
 * down hints went off screen). The hint keeps its side of the button; it only slides inward (over the button edge when
 * there is no room beyond it). Width / height are estimated from the label (OVERLAY_TUNING hint*). w or h 0 = unknown:
 * no shift. Pure.
 */
export function hintShift(
  dir: SwipeDir, label: string, cx: number, cy: number, r: number, w: number, h: number, safe: Readonly<SafeInsets>,
  out: { x: number; y: number },
): { x: number; y: number } {
  out.x = 0;
  out.y = 0;
  if (!(w > 0 && h > 0) || label === '' || !Number.isFinite(cx) || !Number.isFinite(cy)) return out;
  const T = LOCAL_TUNING;
  const hw = label.length * T.hintCharPx + T.hintExtraW;
  const hh = T.hintH;
  const lo = fin(safe.left) + T.hintMargin, hi = w - fin(safe.right) - T.hintMargin;
  const top = fin(safe.top) + T.hintMargin, bot = h - fin(safe.bottom) - T.hintMargin;
  let x0: number, x1: number, y0: number, y1: number;
  switch (dir) {
    case SwipeDir.UP: x0 = cx - hw / 2; x1 = cx + hw / 2; y1 = cy - r - T.hintOffset; y0 = y1 - hh; break;
    case SwipeDir.DOWN: x0 = cx - hw / 2; x1 = cx + hw / 2; y0 = cy + r + T.hintOffset; y1 = y0 + hh; break;
    case SwipeDir.LEFT: x1 = cx - r - T.hintOffset; x0 = x1 - hw; y0 = cy - hh / 2; y1 = cy + hh / 2; break;
    case SwipeDir.RIGHT: x0 = cx + r + T.hintOffset; x1 = x0 + hw; y0 = cy - hh / 2; y1 = cy + hh / 2; break;
    default: return out;
  }
  if (x1 > hi) out.x = hi - x1;
  else if (x0 < lo) out.x = lo - x0;
  if (y1 > bot) out.y = bot - y1;
  else if (y0 < top) out.y = top - y0;
  out.x = Math.round(out.x);
  out.y = Math.round(out.y);
  return out;
}

/** Distance from (cx, cy) to the nearest point of a rectangle (0 inside). Pure. */
export function rectDistance(rc: Readonly<Rect>, cx: number, cy: number): number {
  const dx = cx < rc.x ? rc.x - cx : cx > rc.x + rc.w ? cx - rc.x - rc.w : 0;
  const dy = cy < rc.y ? rc.y - cy : cy > rc.y + rc.h ? cy - rc.y - rc.h : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

/** True when a circle (centre, radius) keeps at least `gap` from a rectangle. Pure. */
export function circleClearOfRect(cx: number, cy: number, r: number, rc: Readonly<Rect>, gap = 0): boolean {
  return rectDistance(rc, cx, cy) >= r + gap;
}

/** Every cluster slot and the pause button lie inside the safe area, 24 pt clear of the edges, and off the HUD. Pure. */
export function layoutClearOfHud(l: Readonly<ClusterLayout>, w: number, h: number, safe: Readonly<SafeInsets>): boolean {
  const regions = hudRegions(w, h, safe);
  const m = T_TOUCHUI.systemEdgeMargin;
  const circles = [l.slots[0], l.slots[1], l.slots[2], l.slots[3], l.pause];
  for (const g of circles) {
    if (g.cx - g.r < fin(safe.left) - 0.5 || g.cx + g.r > w - fin(safe.right) + 0.5) return false;
    if (g.cy - g.r < fin(safe.top) + m - 0.5 || g.cy + g.r > h - fin(safe.bottom) - m + 0.5) return false;
    for (const rc of regions) if (!circleClearOfRect(g.cx, g.cy, g.r, rc)) return false;
  }
  return true;
}

function fin(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

// ============================================================ labels (pure)

/** Plain-word caption under a slot label: the big button's second meaning (SPRINT & SKILL / SPRINT & TACKLE). */
export function slotCaption(id: TouchButtonId | -1, mode: ClusterMode): string {
  if (id === TouchButtonId.SPRINT_SKILL) return mode === ClusterMode.KEEPER ? '' : '& SKILL';
  if (id === TouchButtonId.SPRINT_TACKLE) return '& SPRINT';
  return '';
}

/** Swipe-hint labels of a press of `id` that went down in `mode` (null = no swipes in that mode). Pure. */
export function hintLabels(id: TouchButtonId | -1, mode: ClusterMode): readonly string[] | null {
  if (id < 0) return null;
  if (mode === ClusterMode.ATTACK) return ATTACK_SWIPE_HINTS[id] ?? null;
  if (mode === ClusterMode.DEFENCE) return DEFENCE_SWIPE_HINTS[id] ?? null;
  return null;
}

/** Mask of (1 << SwipeDir) with a hint label for `id` in `mode`. Pure. */
export function hintDirMask(id: TouchButtonId | -1, mode: ClusterMode): number {
  const row = hintLabels(id, mode);
  if (!row) return 0;
  let m = 0;
  for (let d = SwipeDir.UP; d <= SwipeDir.RIGHT; d++) if (row[d]) m |= 1 << d;
  return m;
}

/**
 * Power ring rotations (deg) for power 0..1: the right half's arc turns 0..180 for the first half of the bar, then the
 * left half's arc turns 0..180. Both are added to the arcs' resting angles in CSS. Pure.
 */
export function powerRingAngles(power: number, out: { a: number; b: number }): { a: number; b: number } {
  const p = Number.isFinite(power) ? (power < 0 ? 0 : power > 1 ? 1 : power) : 0;
  out.a = (p < 0.5 ? p : 0.5) * 360;
  out.b = (p > 0.5 ? p - 0.5 : 0) * 360;
  return out;
}

// ============================================================ the overlay

/** The cluster controller as the overlay reads it (TCH-04 ClusterController fits). */
export interface OverlayClusterView {
  readonly ids: readonly (TouchButtonId | -1)[];
  readonly modes: readonly ClusterMode[];
  readonly labels: readonly string[];
  /** Mask over ClusterSlot of slots with a finger down. */
  readonly pressed: number;
  /** Changes whenever ids / modes / labels / pressed change. */
  readonly version: number;
  /** Buttons showing direction hints now, mask over TouchButtonId. */
  readonly hintMask?: number;
  /** The attack set (live(id) is false for PASS / THROUGH / SHOOT under Gestures Only). */
  readonly attack?: { live(id: TouchButtonId): boolean };
}

export interface TouchOverlayParts {
  cluster?: OverlayClusterView | null;
  /** Stick radius and the fixed-stick origin (TCH-02 StickConfig, kept current by index.ts relayout). */
  stickConfig?: Readonly<StickConfig> | null;
  /** Live touch settings (Gestures Only and the hint fallback while no cluster is bound). */
  touchSettings?: (() => Readonly<TouchSettings> | null | undefined) | null;
  /** Clock for the unbound hint fallback (ms, same base as TouchIntentState.downAt). Default performance.now. */
  now?: (() => number) | null;
}

export interface TouchOverlay {
  /** The full-screen layer that receives pointer events. */
  readonly el: HTMLElement;
  /** Reflect the intent state (pressed buttons, stick). Cheap when nothing changed. */
  sync(): void;
  /**
   * Position the buttons for a new layout. With the viewport (w x h CSS px, safe-area insets) the swipe hints are
   * kept on screen (hintShift); without it they keep their default places.
   */
  layout(l: ClusterLayout, w?: number, h?: number, safe?: Readonly<SafeInsets>): void;
  setOpacity(o: number): void;
  setVisible(v: boolean): void;
  dispose(): void;
  /** Attach the cluster controller / stick config / settings (TCH-07 wiring); re-renders on the next sync. */
  bind(parts: TouchOverlayParts): void;
  /** DOM writes so far (tests: sync() with nothing changed adds none). */
  readonly domWrites: number;
  /** The element of a cluster slot (tests, editor previews). */
  slotEl(slot: ClusterSlot): HTMLElement;
}

interface SlotView {
  el: HTMLElement;
  label: HTMLElement;
  caption: HTMLElement;
  ring: HTMLElement;
  arcA: HTMLElement;
  arcB: HTMLElement;
  hints: HTMLElement[];
  hintText: HTMLElement[];
  // last written
  id: number;
  text: string;
  cap: string;
  pressed: boolean;
  hidden: boolean;
  ringOn: boolean;
  ringStep: number;
  hintId: number;
  hintMode: number;
  hintDirs: number;
  /** Geometry as of the last layout (for the hint shift). */
  cx: number;
  cy: number;
  r: number;
}

const DIR_CLASS = ['', 'up', 'down', 'left', 'right'];
const NO_INSETS: Readonly<SafeInsets> = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
const NO_POS = -1e9;

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export function createTouchOverlay(root: HTMLElement, state: TouchIntentState, stickRadius: number = T_TOUCHUI.stickRadius, parts: TouchOverlayParts = {}): TouchOverlay {
  const doc = root.ownerDocument;
  let writes = 0;
  let cluster: OverlayClusterView | null = parts.cluster ?? null;
  let stickCfg: Readonly<StickConfig> | null = parts.stickConfig ?? null;
  let touchSettings: (() => Readonly<TouchSettings> | null | undefined) | null = parts.touchSettings ?? null;
  let now: () => number = parts.now ?? defaultNow;

  const mk = (tag: string, cls: string): HTMLElement => {
    const e = doc.createElement(tag);
    e.className = cls;
    return e;
  };

  const el = mk('div', 'dk-touch');
  el.setAttribute('data-touch-layer', '');
  const vis = mk('div', 'dk-touch-vis');
  el.append(vis);

  // ---- stick
  const stick = mk('div', 'dk-stick');
  const base = mk('div', 'dk-stick-base');
  const knob = mk('div', 'dk-stick-knob');
  stick.append(base, knob);
  vis.append(stick);

  // ---- preview dots (TCH-06)
  const preview = mk('div', 'dk-preview');
  const dots: HTMLElement[] = [];
  const dotX = new Float64Array(PREVIEW_DOTS).fill(NO_POS);
  const dotY = new Float64Array(PREVIEW_DOTS).fill(NO_POS);
  for (let i = 0; i < PREVIEW_DOTS; i++) {
    const d = mk('div', 'dk-dot');
    dots.push(d);
    preview.append(d);
  }
  vis.append(preview);
  let dotsShown = 0;

  // ---- cluster slots
  const slots: SlotView[] = [];
  for (let s = ClusterSlot.BIG; s <= ClusterSlot.HIGH; s++) {
    const b = mk('div', s === ClusterSlot.BIG ? 'dk-tbtn dk-tbtn--big' : 'dk-tbtn');
    b.setAttribute('data-slot', String(s));
    const label = mk('span', 'dk-tbtn-label');
    const caption = mk('span', 'dk-tbtn-cap');
    const ring = mk('div', 'dk-pring');
    const halfR = mk('div', 'dk-pring-half dk-pring-half--r');
    const halfL = mk('div', 'dk-pring-half dk-pring-half--l');
    const arcA = mk('div', 'dk-pring-arc');
    const arcB = mk('div', 'dk-pring-arc');
    halfR.append(arcA);
    halfL.append(arcB);
    ring.append(halfR, halfL);
    const hints: HTMLElement[] = [];
    const hintText: HTMLElement[] = [];
    for (let d = SwipeDir.UP; d <= SwipeDir.RIGHT; d++) {
      const hEl = mk('div', `dk-hint dk-hint--${DIR_CLASS[d]}`);
      hEl.setAttribute('data-dir', String(d));
      const arrow = mk('span', 'dk-hint-arrow');
      const t = mk('span', 'dk-hint-text');
      hEl.append(arrow, t);
      hints[d] = hEl;
      hintText[d] = t;
      b.append(hEl);
    }
    b.append(ring, label, caption);
    vis.append(b);
    slots.push({
      el: b, label, caption, ring, arcA, arcB, hints, hintText,
      id: -2, text: '\u0000', cap: '\u0000', pressed: false, hidden: false, ringOn: false, ringStep: -1, hintId: -2, hintMode: -1, hintDirs: 0,
      cx: NaN, cy: NaN, r: 0,
    });
  }

  // ---- pause
  const pause = mk('div', 'dk-tbtn dk-tbtn--pause');
  pause.setAttribute('data-btn', String(TouchButtonId.PAUSE));
  pause.setAttribute('aria-label', 'Pause');
  pause.append(mk('span', 'dk-pause-icon'));
  vis.append(pause);
  root.append(el);

  // ---- last written stick / layer values
  let padHidden = false;
  let stickActive = false;
  let stickFixed = false;
  let radius = -1;
  let baseX = NaN, baseY = NaN, knobX = NaN, knobY = NaN;
  let pausePressed = false;
  const ang = { a: 0, b: 0 };
  /** Viewport of the last layout (0 = unknown) and the hint shift scratch. */
  let viewW = 0, viewH = 0;
  let viewSafe: Readonly<SafeInsets> = NO_INSETS;
  const SHIFT = { x: 0, y: 0 };

  function setClass(e: HTMLElement, cls: string, on: boolean): void {
    e.classList.toggle(cls, on);
    writes++;
  }

  function place(e: HTMLElement, cx: number, cy: number, r: number): void {
    e.style.width = `${r * 2}px`;
    e.style.height = `${r * 2}px`;
    e.style.transform = `translate3d(${cx - r}px, ${cy - r}px, 0)`;
    writes += 3;
  }

  function gesturesOnly(): boolean {
    try {
      return touchSettings?.()?.gesturesOnly === true;
    } catch {
      return false;
    }
  }

  // Scratch for the unbound fallback view.
  const fbId: number[] = [-1, -1, -1, -1];
  const fbMode: number[] = [0, 0, 0, 0];
  const fbLabel: string[] = ['', '', '', ''];
  let fbPressed = 0;

  /** Slot view from the intent state alone (no cluster controller bound). */
  function fallbackView(): void {
    const mode = state.mode;
    const held = state.held;
    const clear = state.clearOn;
    fbPressed = 0;
    for (let s = 0; s < 4; s++) {
      const a = SLOT_ATTACK_BUTTON[s]!;
      const d = SLOT_DEFENCE_BUTTON[s]!;
      const aDown = (held & (1 << a)) !== 0;
      const dDown = (held & (1 << d)) !== 0;
      const defLive = mode === ClusterMode.DEFENCE;
      if ((aDown && (!dDown || !defLive))) {
        const m = mode === ClusterMode.KEEPER ? ClusterMode.KEEPER : mode === ClusterMode.SET_PIECE ? ClusterMode.SET_PIECE : ClusterMode.ATTACK;
        fbId[s] = a; fbMode[s] = m; fbLabel[s] = buttonLabel(a, m, false);
        fbPressed |= 1 << s;
      } else if (dDown) {
        fbId[s] = d; fbMode[s] = ClusterMode.DEFENCE; fbLabel[s] = buttonLabel(d, ClusterMode.DEFENCE, clear && defLive);
        fbPressed |= 1 << s;
      } else {
        const id = slotButton(mode, s as ClusterSlot);
        fbId[s] = id; fbMode[s] = mode; fbLabel[s] = id === -1 ? '' : buttonLabel(id, mode, clear);
      }
    }
  }

  function hintMaskFallback(): number {
    let ts: Readonly<TouchSettings> | null | undefined;
    try {
      ts = touchSettings?.();
    } catch {
      ts = null;
    }
    if (!ts || !(ts.hintMatchesLeft > 0) || state.held === 0) return 0;
    const t = now();
    let m = 0;
    for (let i = 0; i < TouchButtonId.PAUSE; i++) {
      const at = state.downAt[i] ?? 0;
      if ((state.held & (1 << i)) !== 0 && at > 0 && t - at >= T_TOUCHUI.hintHoldMs) m |= 1 << i;
    }
    return m;
  }

  function syncCluster(): void {
    const c = cluster;
    if (!c) fallbackView();
    const ids = c ? c.ids : fbId;
    const modes = c ? c.modes : fbMode;
    const labels = c ? c.labels : fbLabel;
    const pressedMask = c ? c.pressed : fbPressed;
    const hintMask = c ? (c.hintMask ?? 0) : hintMaskFallback();
    const gOnly = c && c.attack ? -1 : gesturesOnly() ? 1 : 0;
    const atk = c && c.attack ? c.attack : null;
    const pb = state.powerButton;
    for (let s = 0; s < 4; s++) {
      const v = slots[s]!;
      const id = ids[s]! as number;
      const mode = modes[s]! as ClusterMode;
      const pressed = (pressedMask & (1 << s)) !== 0;
      let hidden = id < 0;
      if (!hidden && !pressed && id !== TouchButtonId.SPRINT_SKILL && (id === TouchButtonId.PASS || id === TouchButtonId.THROUGH || id === TouchButtonId.SHOOT)) {
        hidden = atk ? !atk.live(id as TouchButtonId) : gOnly === 1;
      }
      if (id !== v.id) {
        v.id = id;
        if (id >= 0) v.el.setAttribute('data-btn', String(id));
        else v.el.removeAttribute('data-btn');
        writes++;
      }
      const text = labels[s] ?? '';
      if (text !== v.text) {
        v.text = text;
        v.label.textContent = text;
        writes++;
      }
      const cap = slotCaption(id as TouchButtonId | -1, mode);
      if (cap !== v.cap) {
        v.cap = cap;
        v.caption.textContent = cap;
        writes++;
      }
      if (pressed !== v.pressed) {
        v.pressed = pressed;
        setClass(v.el, 'is-pressed', pressed);
      }
      if (hidden !== v.hidden) {
        v.hidden = hidden;
        setClass(v.el, 'is-hidden', hidden);
      }
      // Power ring on the slot whose button is charging.
      const ringOn = pb !== -1 && id === pb && !hidden && state.power > 0;
      if (ringOn !== v.ringOn) {
        v.ringOn = ringOn;
        setClass(v.ring, 'is-on', ringOn);
      }
      if (ringOn) {
        const step = Math.round(Math.max(0, Math.min(1, state.power)) * LOCAL_TUNING.powerSteps);
        if (step !== v.ringStep) {
          v.ringStep = step;
          powerRingAngles(step / LOCAL_TUNING.powerSteps, ang);
          v.arcA.style.transform = `rotate(${ang.a}deg)`;
          v.arcB.style.transform = `rotate(${ang.b}deg)`;
          writes += 2;
        }
      }
      // Direction hints around a held press the cluster flags.
      const showHint = pressed && id >= 0 && (hintMask & (1 << id)) !== 0;
      const dirs = showHint ? hintDirMask(id as TouchButtonId, mode) : 0;
      if (dirs !== 0 && (id !== v.hintId || mode !== v.hintMode)) {
        v.hintId = id;
        v.hintMode = mode;
        const row = hintLabels(id as TouchButtonId, mode)!;
        for (let d = SwipeDir.UP; d <= SwipeDir.RIGHT; d++) {
          const t = row[d] ?? '';
          if (v.hintText[d]!.textContent !== t) {
            v.hintText[d]!.textContent = t;
            writes++;
          }
          // Keep the hint on screen (it only slides inward); written with the text, so once per press meaning.
          hintShift(d, t, v.cx, v.cy, v.r, viewW, viewH, viewSafe, SHIFT);
          const he = v.hints[d]!;
          he.style.setProperty('--dk-hx', `${SHIFT.x}px`);
          he.style.setProperty('--dk-hy', `${SHIFT.y}px`);
          writes += 2;
        }
      }
      if (dirs !== v.hintDirs) {
        for (let d = SwipeDir.UP; d <= SwipeDir.RIGHT; d++) {
          const on = (dirs & (1 << d)) !== 0;
          if (on !== ((v.hintDirs & (1 << d)) !== 0)) setClass(v.hints[d]!, 'is-on', on);
        }
        v.hintDirs = dirs;
      }
    }
  }

  function syncStick(): void {
    const cfg = stickCfg;
    const r = cfg && Number.isFinite(cfg.radius) && cfg.radius > 0 ? cfg.radius : stickRadius;
    if (r !== radius) {
      radius = r;
      base.style.width = `${r * 2}px`;
      base.style.height = `${r * 2}px`;
      const k = LOCAL_TUNING.knob * (r / T_TOUCHUI.stickRadius);
      knob.style.width = `${k}px`;
      knob.style.height = `${k}px`;
      writes += 4;
      baseX = NaN; knobX = NaN;
    }
    const fixed = !!cfg && !cfg.floating && cfg.width > 0 && cfg.height > 0;
    const active = state.stickActive;
    if (active !== stickActive) {
      stickActive = active;
      setClass(stick, 'is-active', active);
    }
    if (fixed !== stickFixed) {
      stickFixed = fixed;
      setClass(stick, 'is-fixed', fixed);
    }
    if (!active && !fixed) return;
    const ox = active ? state.stickOriginX : cfg!.fixedX;
    const oy = active ? state.stickOriginY : cfg!.fixedY;
    if (ox !== baseX || oy !== baseY) {
      baseX = ox; baseY = oy;
      base.style.transform = `translate3d(${ox - r}px, ${oy - r}px, 0)`;
      writes++;
    }
    let tx = active ? state.stickThumbX : ox;
    let ty = active ? state.stickThumbY : oy;
    const dx = tx - ox, dy = ty - oy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > r) { tx = ox + (dx / d) * r; ty = oy + (dy / d) * r; }
    if (tx !== knobX || ty !== knobY) {
      knobX = tx; knobY = ty;
      const k = LOCAL_TUNING.knob * (r / T_TOUCHUI.stickRadius);
      knob.style.transform = `translate3d(${tx - k / 2}px, ${ty - k / 2}px, 0)`;
      writes++;
    }
  }

  function syncPreview(): void {
    const n = state.previewCount | 0;
    const count = n > 0 ? Math.min(n, state.previewX.length, state.previewY.length) : 0;
    const show = count <= 0 ? 0 : count <= PREVIEW_DOTS ? count : PREVIEW_DOTS;
    for (let i = 0; i < show; i++) {
      // Spread the dots over the whole path when it has more points than dots.
      const k = show === count ? i : Math.round((i * (count - 1)) / (show - 1));
      const x = state.previewX[k]!, y = state.previewY[k]!;
      if (x !== dotX[i] || y !== dotY[i]) {
        dotX[i] = x; dotY[i] = y;
        dots[i]!.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        writes++;
      }
    }
    if (show !== dotsShown) {
      const lo = show < dotsShown ? show : dotsShown;
      const hi = show < dotsShown ? dotsShown : show;
      for (let i = lo; i < hi; i++) setClass(dots[i]!, 'is-on', i < show);
      dotsShown = show;
    }
  }

  const api: TouchOverlay = {
    el,
    get domWrites() { return writes; },
    sync() {
      const hide = state.hiddenByPad === true;
      if (hide !== padHidden) {
        padHidden = hide;
        setClass(el, 'is-pad-hidden', hide);
      }
      const pp = (state.held & (1 << TouchButtonId.PAUSE)) !== 0;
      if (pp !== pausePressed) {
        pausePressed = pp;
        setClass(pause, 'is-pressed', pp);
      }
      syncCluster();
      syncStick();
      syncPreview();
    },
    layout(l: ClusterLayout, w?: number, h?: number, safe?: Readonly<SafeInsets>) {
      viewW = typeof w === 'number' && Number.isFinite(w) ? w : 0;
      viewH = typeof h === 'number' && Number.isFinite(h) ? h : 0;
      viewSafe = safe ?? NO_INSETS;
      for (let s = 0; s < 4; s++) {
        const g = l.slots[s]!;
        const v = slots[s]!;
        place(v.el, g.cx, g.cy, g.r);
        v.cx = g.cx; v.cy = g.cy; v.r = g.r;
        v.hintId = -2; // re-place the hints on the next show
      }
      place(pause, l.pause.cx, l.pause.cy, l.pause.r);
      baseX = NaN; knobX = NaN; // a fixed stick may have moved with the relayout
    },
    setOpacity(o: number) {
      const v = Number.isFinite(o) ? Math.max(0.2, Math.min(1, o)) : 0.85;
      vis.style.setProperty('--dk-touch-opacity', String(v));
      writes++;
    },
    setVisible(v: boolean) {
      el.style.display = v ? '' : 'none';
      writes++;
    },
    bind(p: TouchOverlayParts) {
      if (p.cluster !== undefined) cluster = p.cluster;
      if (p.stickConfig !== undefined) stickCfg = p.stickConfig;
      if (p.touchSettings !== undefined) touchSettings = p.touchSettings;
      if (p.now) now = p.now;
      radius = -1;
    },
    slotEl(s: ClusterSlot) {
      return slots[s]!.el;
    },
    dispose() {
      el.remove();
    },
  };
  return api;
}

// ============================================================ pad drive watcher

/** The pad manager as the watcher reads it (PAD-01 PadManager fits). */
export interface PadDriveSource {
  find(key: string): { readonly connected: boolean; readonly lastInputMs: number } | null;
}

export interface PadDriveWatcher {
  /** Once per animation frame after the pads were polled: hide the touch controls on fresh input of a bound pad. */
  update(): void;
  /** Forget what was seen (a new match). */
  reset(): void;
}

/**
 * Section 9 "Touch controls hide when a controller is driving that side and return on the next screen touch": sets
 * TouchIntentState.hiddenByPad when one of `keys()` (the pads bound to the same human as the touch overlay) shows input
 * newer than anything seen before (a button press or stick deflection). The next touch-down clears it (index.ts).
 * Input that existed before the first update() never hides anything.
 */
export function createPadDriveWatcher(state: TouchIntentState, pads: PadDriveSource, keys: () => readonly string[]): PadDriveWatcher {
  const seen: Record<string, number> = Object.create(null) as Record<string, number>;
  return {
    update() {
      let list: readonly string[];
      try {
        list = keys();
      } catch {
        return;
      }
      for (let i = 0; i < list.length; i++) {
        const k = list[i]!;
        const s = pads.find(k);
        if (!s || !s.connected) continue;
        const t = s.lastInputMs;
        const prev = seen[k];
        if (prev === undefined) {
          seen[k] = t;
          continue;
        }
        if (t > prev) {
          seen[k] = t;
          state.hiddenByPad = true;
        }
      }
    },
    reset() {
      for (const k of Object.keys(seen)) delete seen[k];
    },
  };
}
