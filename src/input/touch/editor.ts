/**
 * [TCH-08] Controls editor and touch settings (Screen 'controls-editor'; section 9 quality bar: "Controls editor in
 * settings: drag to reposition, size, spacing, opacity, mirror for left-handers, fixed or floating stick, gestures on
 * or off, fast power bar, auto-switch level, and reset"; section 12 UI rules: touch alone and controller alone, focus
 * ring, Back always works, 60 pt targets).
 *
 * Full-screen editor: the stick and the four cluster buttons at the positions the match uses (same layout functions as
 * the touch layer: TCH-03 computeClusterLayout, TCH-02 computeStickConfig) over a dimmed pitch, the pause button and
 * the HUD regions (TCH-09 hudRegions) drawn as no-go areas, and a panel with three tabs:
 *   Layout   size of the selected control (0.7..1.4), spacing, opacity, mirror, floating / fixed stick, Reset.
 *   Gestures pitch gestures on / off, Gestures Only, one toggle per section 9 gesture rule (TCH-05 GESTURE_RULES).
 *   Play     fast power bar, auto-switch level (Off / Air and loose / Auto), skill slots (tap / swipe up / swipe right,
 *            each one of the eight section 6 moves).
 * Every change is saved at once to settings.controls.touch (and controls.autoSwitch) through ctx.settings.update.
 *
 * Layout rules (pure helpers below, unit-tested): every control stays inside the safe area and T_TOUCHUI.
 * systemEdgeMargin (24 pt) clear of every edge; the stick stays in its half (the right half when mirrored); controls
 * keep >= T_TOUCHUI.buttonGap (12 pt) from each other, from the pause button and from the HUD regions (scoreboard,
 * top-centre lane, radar). A drop on a bad spot snaps to the nearest valid spot (or back where the drag started).
 * Placements are stored the way the touch layer reads them (ControlPlacement: dx from the anchored side's safe edge
 * (right for buttons, left for the stick; swapped when mirrored), dy from the safe bottom edge, scale), so mirroring
 * flips the whole layout and a viewport change keeps the corner distances. The first edit of a cluster button stores
 * all four cluster placements (the cluster then stays where the player sees it); spacing then re-spreads the three
 * small buttons around the big one. A size, spacing or mirror change that would overlap something moves the
 * offending control to the nearest valid spot.
 *
 * Touch: drag any control (pointer capture; a cancelled drag puts it back); a tap selects it for the size slider.
 * Controller: focus moves between the controls and the panel with the D-pad / stick; Confirm on a control picks it up
 * (ember ring), the D-pad nudges it by EDITOR_TUNING.nudgePt, L1 / R1 shrink / grow it, Confirm drops it, Back puts it
 * back. Back otherwise leaves the screen (everything is already saved).
 */

import type { AppContext, FocusNavigator, Screen, ScreenParams } from '../../contracts/app';
import { MenuAction, UiSound } from '../../contracts/app';
import { AutoSwitch, SkillMove } from '../../contracts/enums';
import { createDefaultSettings, type ControlPlacement, type TouchSettings } from '../../contracts/settings';
import { ClusterSlot, TouchButtonId } from '../../contracts/touch';
import { T_TOUCH_EDITOR, T_TOUCHUI } from '../../contracts/tuning';
import {
  createBackButton, createButton, createSegmented, createSelector, createSlider, createTabs, createToggle, h, injectStyle,
} from '../../ui/components';
import {
  computeClusterLayout, createClusterLayout, LOCAL_TUNING as ATTACK_TUNING, SLOT_LAYOUT_KEYS, type SafeInsets,
} from './attack';
import { GESTURE_RULE_LABEL, GESTURE_RULES } from './gestures';
import { circleClearOfRect, hudRegions, type Rect } from './overlay';
import { computeStickConfig, createStickConfig, LOCAL_TUNING as STICK_TUNING, STICK_LAYOUT_KEY } from './stick';

const LOCAL_TUNING = T_TOUCH_EDITOR; // [TUN-2] controls editor (menu feel): contracts/tuning.ts T_TOUCH_EDITOR

/** The LOCAL_TUNING block (read-only; tests). */
export const EDITOR_TUNING = LOCAL_TUNING;

// ============================================================ model (pure)

/** Editable controls: the stick, then the cluster slots BIG, LOW, MID, HIGH (by their attack button's layout key). */
export const EDITOR_KEYS: readonly string[] = [
  STICK_LAYOUT_KEY,
  String(TouchButtonId.SPRINT_SKILL),
  String(TouchButtonId.PASS),
  String(TouchButtonId.THROUGH),
  String(TouchButtonId.SHOOT),
];

/** ClusterSlot of an editor key (-1 for the stick). */
export function keySlot(key: string): ClusterSlot | -1 {
  const i = EDITOR_KEYS.indexOf(key);
  return i <= 0 ? -1 : ((i - 1) as ClusterSlot);
}

/** Plain-word names (attack meaning, defence meaning). */
export const EDITOR_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  [STICK_LAYOUT_KEY]: ['STICK', 'Move'],
  [String(TouchButtonId.SPRINT_SKILL)]: ['SPRINT', 'Skill / Tackle'],
  [String(TouchButtonId.PASS)]: ['PASS', 'Switch'],
  [String(TouchButtonId.THROUGH)]: ['THROUGH', '2nd def'],
  [String(TouchButtonId.SHOOT)]: ['SHOOT', 'Slide'],
};

/** The eight section 6 skill moves for the skill slots. */
export const SKILL_CHOICES: readonly { value: SkillMove; label: string }[] = [
  { value: SkillMove.BALL_ROLL, label: 'Ball roll' },
  { value: SkillMove.STEP_OVER, label: 'Step-over' },
  { value: SkillMove.BODY_FEINT, label: 'Body feint' },
  { value: SkillMove.DRAG_BACK, label: 'Drag-back' },
  { value: SkillMove.FAKE_SHOT, label: 'Fake shot' },
  { value: SkillMove.ROULETTE, label: 'Roulette' },
  { value: SkillMove.HEEL_FLICK, label: 'Heel flick' },
  { value: SkillMove.KNOCK_ON, label: 'Knock-on' },
];

export const AUTO_SWITCH_CHOICES: readonly { value: AutoSwitch; label: string }[] = [
  { value: AutoSwitch.OFF, label: 'Off' },
  { value: AutoSwitch.AIR_AND_LOOSE, label: 'Air and loose' },
  { value: AutoSwitch.AUTO, label: 'Auto' },
];

/** Viewport the editor lays out for (CSS px) and its safe-area insets. */
export interface EditorEnv {
  w: number;
  h: number;
  safe: SafeInsets;
}

/** A control's circle on screen, CSS px. */
export interface EditorCircle {
  key: string;
  x: number;
  y: number;
  r: number;
}

type TouchLayoutPart = Pick<TouchSettings, 'layout' | 'spacing' | 'mirror' | 'floatingStick'>;

const fin = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => (lo > hi ? (lo + hi) / 2 : v < lo ? lo : v > hi ? hi : v);
const insets = (e: EditorEnv): SafeInsets => ({
  top: Math.max(0, fin(e.safe.top)), right: Math.max(0, fin(e.safe.right)),
  bottom: Math.max(0, fin(e.safe.bottom)), left: Math.max(0, fin(e.safe.left)),
});

/** Circles of every editor control as the match would place them (EDITOR_KEYS order). Pure. */
export function editorCircles(env: EditorEnv, touch: Readonly<TouchLayoutPart>): EditorCircle[] {
  const safe = insets(env);
  const l = computeClusterLayout(env.w, env.h, safe, { spacing: touch.spacing, mirror: touch.mirror, placements: touch.layout }, createClusterLayout());
  const cfg = computeStickConfig(env.w, env.h, safe, { floatingStick: false, mirror: touch.mirror, layout: touch.layout }, createStickConfig());
  const out: EditorCircle[] = [{ key: EDITOR_KEYS[0]!, x: cfg.fixedX, y: cfg.fixedY, r: cfg.radius }];
  for (let s = 0; s < 4; s++) {
    const g = l.slots[s]!;
    out.push({ key: EDITOR_KEYS[s + 1]!, x: g.cx, y: g.cy, r: g.r });
  }
  return out;
}

/** Where the pause button sits (TCH-03 layout) and the HUD regions: the fixed obstacles. Pure. */
export function editorObstacles(env: EditorEnv, mirror: boolean): { rects: Rect[]; pause: { x: number; y: number; r: number } } {
  const safe = insets(env);
  const l = computeClusterLayout(env.w, env.h, safe, { mirror }, createClusterLayout());
  return { rects: hudRegions(env.w, env.h, safe), pause: { x: l.pause.cx, y: l.pause.cy, r: l.pause.r } };
}

/** Allowed centre range of a control of radius r (safe area, 24 pt margins, the stick's half). Pure. */
export function editorBounds(key: string, r: number, env: EditorEnv, mirror: boolean): { minX: number; maxX: number; minY: number; maxY: number } {
  const s = insets(env);
  const m = T_TOUCHUI.systemEdgeMargin;
  let minX = s.left + m + r;
  let maxX = env.w - s.right - m - r;
  if (key === STICK_LAYOUT_KEY) {
    if (mirror) minX = Math.max(minX, env.w / 2 + r);
    else maxX = Math.min(maxX, env.w / 2 - r);
  }
  return { minX, maxX, minY: s.top + m + r, maxY: env.h - s.bottom - m - r };
}

/** Clamp a centre into the control's bounds. Pure. */
export function clampSpot(key: string, x: number, y: number, r: number, env: EditorEnv, mirror: boolean): { x: number; y: number } {
  const b = editorBounds(key, r, env, mirror);
  return { x: clamp(fin(x, b.minX), b.minX, b.maxX), y: clamp(fin(y, b.minY), b.minY, b.maxY) };
}

/**
 * Is (x, y) a valid centre for circles[i] (radius circles[i].r) given the other circles, the pause button and the HUD
 * regions? Bounds, >= buttonGap to every other control, the pause and each HUD region. Pure.
 */
export function isValidSpot(circles: readonly EditorCircle[], i: number, x: number, y: number, env: EditorEnv, mirror: boolean): boolean {
  const c = circles[i]!;
  const r = c.r;
  const b = editorBounds(c.key, r, env, mirror);
  const eps = 1e-6;
  if (x < b.minX - eps || x > b.maxX + eps || y < b.minY - eps || y > b.maxY + eps) return false;
  const gap = T_TOUCHUI.buttonGap;
  for (let j = 0; j < circles.length; j++) {
    if (j === i) continue;
    const o = circles[j]!;
    const dx = x - o.x, dy = y - o.y;
    const need = r + o.r + gap;
    if (dx * dx + dy * dy < need * need - eps) return false;
  }
  const obs = editorObstacles(env, mirror);
  const px = x - obs.pause.x, py = y - obs.pause.y, pn = r + obs.pause.r + gap;
  if (px * px + py * py < pn * pn - eps) return false;
  for (const rc of obs.rects) if (!circleClearOfRect(x, y, r, rc, gap - eps)) return false;
  return true;
}

/** The valid centre nearest to (x, y) for circles[i] (rings of candidates around the clamped spot), or null. Pure. */
export function nearestValidSpot(circles: readonly EditorCircle[], i: number, x: number, y: number, env: EditorEnv, mirror: boolean): { x: number; y: number } | null {
  const c = circles[i]!;
  const p = clampSpot(c.key, x, y, c.r, env, mirror);
  if (isValidSpot(circles, i, p.x, p.y, env, mirror)) return p;
  const b = editorBounds(c.key, c.r, env, mirror);
  if (b.minX > b.maxX || b.minY > b.maxY) return null;
  const maxR = Math.hypot(env.w, env.h);
  const stepR = LOCAL_TUNING.searchStepPt;
  for (let rad = stepR; rad <= maxR; rad += stepR) {
    const n = Math.max(16, Math.min(360, Math.ceil((2 * Math.PI * rad) / LOCAL_TUNING.searchArcPt)));
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI;
      const cx = p.x + rad * Math.cos(a), cy = p.y + rad * Math.sin(a);
      if (cx < b.minX || cx > b.maxX || cy < b.minY || cy > b.maxY) continue;
      if (!isValidSpot(circles, i, cx, cy, env, mirror)) continue;
      const d = (cx - p.x) * (cx - p.x) + (cy - p.y) * (cy - p.y);
      if (d < bestD) { bestD = d; best = { x: cx, y: cy }; }
    }
    if (best) return best;
  }
  return null;
}

/** ControlPlacement for a centre (x, y): the inverse of computeClusterLayout / computeStickConfig. Pure. */
export function placementFor(key: string, x: number, y: number, scale: number, env: EditorEnv, mirror: boolean): ControlPlacement {
  const s = insets(env);
  const stick = key === STICK_LAYOUT_KEY;
  // Buttons are anchored to the right safe edge (left when mirrored); the stick the other way round.
  const fromLeft = stick ? !mirror : mirror;
  const dx = fromLeft ? x - s.left : env.w - s.right - x;
  return { dx, dy: env.h - s.bottom - y, scale: clampScale(scale) };
}

export function clampScale(v: number): number {
  return Math.round(clamp(fin(v, 1), ATTACK_TUNING.scaleMin, ATTACK_TUNING.scaleMax) * 100) / 100;
}

/** The stored placement of a key (null when it has none or it is unusable). */
export function storedPlacement(touch: Readonly<Pick<TouchSettings, 'layout'>>, key: string): ControlPlacement | null {
  const p = touch.layout ? touch.layout[key] : undefined;
  return p && Number.isFinite(p.dx) && Number.isFinite(p.dy) ? p : null;
}

/** Scale of a control (its placement's, else 1). */
export function controlScale(touch: Readonly<Pick<TouchSettings, 'layout'>>, key: string): number {
  const p = touch.layout ? touch.layout[key] : undefined;
  return p && Number.isFinite(p.scale) ? clampScale(p.scale) : 1;
}

function writePlacement(touch: TouchLayoutPart, key: string, x: number, y: number, scale: number, env: EditorEnv): void {
  if (!touch.layout || typeof touch.layout !== 'object') touch.layout = {};
  touch.layout[key] = placementFor(key, x, y, scale, env, touch.mirror === true);
  // A slot is placed by its attack key: drop defence keys of the same slot so they never shadow a later reset.
  const slot = keySlot(key);
  if (slot >= 0) {
    const keys = SLOT_LAYOUT_KEYS[slot]!;
    for (let k = 1; k < keys.length; k++) delete touch.layout[keys[k]!];
  }
}

/** Store explicit placements for all four cluster slots at their current spots (first edit of the cluster). */
export function materializeCluster(touch: TouchLayoutPart, env: EditorEnv): void {
  const circles = editorCircles(env, touch);
  for (let i = 1; i < EDITOR_KEYS.length; i++) {
    const key = EDITOR_KEYS[i]!;
    if (storedPlacement(touch, key)) continue;
    writePlacement(touch, key, circles[i]!.x, circles[i]!.y, controlScale(touch, key), env);
  }
}

function materialize(touch: TouchLayoutPart, key: string, env: EditorEnv): void {
  if (key === STICK_LAYOUT_KEY) {
    if (!storedPlacement(touch, key)) {
      const c = editorCircles(env, touch)[0]!;
      writePlacement(touch, key, c.x, c.y, controlScale(touch, key), env);
    }
  } else {
    materializeCluster(touch, env);
  }
}

/**
 * Move every control that breaks a rule (after a size, spacing, mirror or viewport change) to its nearest valid spot,
 * in EDITOR_KEYS order. Returns the number of controls moved. Mutates `touch.layout`.
 */
export function fixLayout(touch: TouchLayoutPart, env: EditorEnv): number {
  const mirror = touch.mirror === true;
  let moved = 0;
  for (let i = 0; i < EDITOR_KEYS.length; i++) {
    const circles = editorCircles(env, touch);
    const c = circles[i]!;
    if (isValidSpot(circles, i, c.x, c.y, env, mirror)) continue;
    const p = nearestValidSpot(circles, i, c.x, c.y, env, mirror);
    if (!p) continue;
    materialize(touch, c.key, env);
    writePlacement(touch, c.key, p.x, p.y, controlScale(touch, c.key), env);
    moved++;
  }
  return moved;
}

/** True when every control obeys the layout rules. Pure. */
export function layoutValid(touch: Readonly<TouchLayoutPart>, env: EditorEnv): boolean {
  const circles = editorCircles(env, touch);
  for (let i = 0; i < circles.length; i++) {
    if (!isValidSpot(circles, i, circles[i]!.x, circles[i]!.y, env, touch.mirror === true)) return false;
  }
  return true;
}

/**
 * Drop a control at (x, y): stored at the nearest valid spot (null and nothing changes when there is none). Returns the
 * spot used. Mutates `touch.layout`.
 */
export function moveControl(touch: TouchLayoutPart, key: string, x: number, y: number, env: EditorEnv): { x: number; y: number } | null {
  const i = EDITOR_KEYS.indexOf(key);
  if (i < 0) return null;
  const circles = editorCircles(env, touch);
  const p = nearestValidSpot(circles, i, x, y, env, touch.mirror === true);
  if (!p) return null;
  materialize(touch, key, env);
  writePlacement(touch, key, p.x, p.y, controlScale(touch, key), env);
  return p;
}

/** Resize a control (0.7..1.4); if the bigger size collides it moves to the nearest valid spot. Mutates. */
export function scaleControl(touch: TouchLayoutPart, key: string, scale: number, env: EditorEnv): void {
  const i = EDITOR_KEYS.indexOf(key);
  if (i < 0) return;
  materialize(touch, key, env);
  const c = editorCircles(env, touch)[i]!;
  writePlacement(touch, key, c.x, c.y, scale, env);
  const circles = editorCircles(env, touch);
  const me = circles[i]!;
  if (!isValidSpot(circles, i, me.x, me.y, env, touch.mirror === true)) {
    const p = nearestValidSpot(circles, i, me.x, me.y, env, touch.mirror === true);
    if (p) writePlacement(touch, key, p.x, p.y, scale, env);
  }
  fixLayout(touch, env);
}

/** Arc radius of the default cluster for a spacing (same formula as computeClusterLayout). Pure. */
export function arcRadius(bigR: number, smallMax: number, spacing: number): number {
  const gap = T_TOUCHUI.buttonGap * Math.max(1, fin(spacing, 1));
  return Math.max(bigR + smallMax + gap, (2 * smallMax + gap) / (2 * Math.sin(ATTACK_TUNING.arcStep / 2)));
}

/**
 * Spacing between the cluster buttons (1..2). On the default arc the touch layer applies it; with stored placements the
 * small buttons are re-spread around the big one by the ratio of the arc radii. Then fixLayout. Mutates.
 */
export function setSpacing(touch: TouchLayoutPart, spacing: number, env: EditorEnv): void {
  const sp = Math.round(clamp(fin(spacing, 1), LOCAL_TUNING.spacingMin, LOCAL_TUNING.spacingMax) * 100) / 100;
  const before = fin(touch.spacing, 1);
  const circles = editorCircles(env, touch);
  touch.spacing = sp;
  const big = circles[1]!;
  let smallMax = 0;
  for (let i = 2; i < circles.length; i++) smallMax = Math.max(smallMax, circles[i]!.r);
  const k = arcRadius(big.r, smallMax, sp) / arcRadius(big.r, smallMax, before);
  if (k !== 1) {
    for (let i = 2; i < EDITOR_KEYS.length; i++) {
      const key = EDITOR_KEYS[i]!;
      if (!storedPlacement(touch, key)) continue;
      const c = circles[i]!;
      const p = clampSpot(key, big.x + (c.x - big.x) * k, big.y + (c.y - big.y) * k, c.r, env, touch.mirror === true);
      writePlacement(touch, key, p.x, p.y, controlScale(touch, key), env);
    }
  }
  fixLayout(touch, env);
}

/** Mirror for left-handers: the anchored sides swap, so the whole layout flips; then fixLayout (the HUD is not symmetric). */
export function setMirror(touch: TouchLayoutPart, on: boolean, env: EditorEnv): void {
  touch.mirror = on === true;
  fixLayout(touch, env);
}

/** Section 9 / settings defaults for everything the editor edits (hint counters are kept). Mutates. */
export function resetTouchDefaults(touch: TouchSettings): void {
  const d = createDefaultSettings().controls.touch;
  const keepHints = touch.hintMatchesLeft;
  Object.assign(touch, d, { layout: {}, gestureEnabled: {}, hintMatchesLeft: keepHints });
}

/** Deep copy of touch settings (layout and gesture records copied). */
export function cloneTouch(t: Readonly<TouchSettings>): TouchSettings {
  const layout: Record<string, ControlPlacement> = {};
  if (t.layout) for (const k of Object.keys(t.layout)) { const p = t.layout[k]!; layout[k] = { dx: p.dx, dy: p.dy, scale: p.scale }; }
  return { ...t, layout, gestureEnabled: { ...(t.gestureEnabled ?? {}) } };
}

// ============================================================ DOM

const CSS = `
.dk-ce { position:absolute; inset:0; overflow:hidden; color: var(--text-1, #f2f2f5); font-family: var(--font-ui, system-ui);
  touch-action:none; user-select:none; -webkit-user-select:none; }
.dk-ce-pitch { position:absolute; inset:0; pointer-events:none;
  background: repeating-linear-gradient(90deg, #12391f 0 96px, #154324 96px 192px); }
.dk-ce-pitch::before { content:''; position:absolute; inset:0; background: rgba(7,7,13,.62); }
.dk-ce-pitch::after { content:''; position:absolute; left:50%; top:8%; bottom:8%; width:0; border-left:1px solid rgba(242,242,245,.18); }
.dk-ce-ring { position:absolute; left:50%; top:50%; width:180px; height:180px; margin:-90px 0 0 -90px; border-radius:50%;
  border:1px solid rgba(242,242,245,.18); pointer-events:none; }
.dk-ce-hud { position:absolute; left:0; top:0; box-sizing:border-box; border:1px dashed rgba(242,242,245,.28); border-radius:10px;
  display:flex; align-items:center; justify-content:center; font-size:11px; letter-spacing:.12em; color: rgba(242,242,245,.4);
  pointer-events:none; }
.dk-ce-stage { position:absolute; inset:0; }
.dk-ce-ctl { position:absolute; left:0; top:0; box-sizing:border-box; border-radius:50%; padding:0; margin:0;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; cursor:grab;
  color: var(--text-1, #f2f2f5); background: rgba(7,7,13,.55); border:1.5px solid rgba(242,242,245,.45);
  font: 600 12px/1 var(--font-ui, system-ui); letter-spacing:.08em; touch-action:none;
  opacity: var(--dk-ce-opacity, .85); will-change: transform; outline:none; }
.dk-ce-ctl--stick { border-style: dashed; }
.dk-ce-ctl__sub { font-size:9.5px; font-weight:500; opacity:.7; letter-spacing:.06em; }
.dk-ce-ctl.is-selected { border-color: var(--ember, #ff6b35); border-width:2px; }
.dk-ce-ctl.is-picked, .dk-ce-ctl.is-dragging { background: rgba(255,107,53,.28); border-color: var(--ember, #ff6b35);
  border-width:3px; opacity:1; cursor:grabbing; }
.dk-ce-ctl.is-invalid { border-color: var(--danger, #ff4d4d); background: rgba(255,77,77,.25); }
.dk-ce-ctl.dk-focused, .dk-ce-ctl[data-focused] { box-shadow: 0 0 0 3px var(--bg, #07070d), 0 0 0 6px var(--focus, #f2f2f5); }
.dk-ce-pause { position:absolute; left:0; top:0; box-sizing:border-box; border-radius:50%; border:1.5px solid rgba(242,242,245,.3);
  display:flex; align-items:center; justify-content:center; pointer-events:none; }
.dk-ce-pause::before { content:''; width:14px; height:16px; box-sizing:border-box; border-left:4px solid rgba(242,242,245,.5);
  border-right:4px solid rgba(242,242,245,.5); }
.dk-ce-panel { position:absolute; left:50%; top: calc(var(--safe-top, 0px) + 72px); transform: translateX(-50%);
  width: min(470px, calc(100% - 32px)); max-height: calc(100% - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 150px);
  min-height: 0; display:flex; flex-direction:column; gap: var(--space-3, 12px); box-sizing:border-box;
  padding: var(--space-4, 16px); background: rgba(14,14,22,.94); border:1px solid var(--hairline, rgba(242,242,245,.14));
  border-radius: var(--radius-lg, 18px); box-shadow: 0 18px 48px rgba(0,0,0,.4); touch-action: pan-y; }
.dk-ce-panel[hidden] { display:none; }
.dk-ce-panel__head { display:flex; align-items:center; justify-content:space-between; gap: var(--space-3, 12px); }
.dk-ce-panel__title { margin:0; font-size: var(--fs-lg, 22px); }
.dk-ce-panel__body { overflow-y:auto; overscroll-behavior: contain; touch-action: pan-y; display:flex; flex-direction:column; gap: var(--space-2, 8px);
  min-height:0; -webkit-overflow-scrolling: touch; }
.dk-ce-note { margin:0; font-size: var(--fs-sm, 14px); color: var(--text-2, #c9c9d1); }
.dk-ce-tip { position:absolute; left:50%; bottom: calc(var(--safe-bottom, 0px) + 24px); transform: translateX(-50%);
  max-width: min(520px, calc(100% - 32px)); margin:0; text-align:center; font-size: var(--fs-sm, 14px);
  color: var(--text-2, #c9c9d1); pointer-events:none; }
.dk-ce-show { position:absolute; right: calc(var(--safe-right, 0px) + 24px); top: calc(var(--safe-top, 0px) + 100px); }
.dk-ce-show[hidden] { display:none; }
`;

interface CtlView {
  key: string;
  el: HTMLButtonElement;
}

/** Controls editor screen (route 'controls-editor'). */
export function createControlsEditorScreen(): Screen {
  let cleanup: (() => void) | null = null;
  let backHook: (() => boolean) | null = null;

  return {
    id: 'controls-editor',
    mount(root: HTMLElement, ctx: AppContext, _params: ScreenParams) {
      injectStyle('controls-editor', CSS);
      const doc = root.ownerDocument;
      const win = doc.defaultView ?? window;
      const focus: FocusNavigator = ctx.focus;

      let draft: TouchSettings = cloneTouch(ctx.settings.get().controls.touch);
      let autoSwitch: AutoSwitch = ctx.settings.get().controls.autoSwitch;
      let selected: string = EDITOR_KEYS[1]!;
      let picked: string | null = null;
      let pickedFrom: ControlPlacement | null | undefined;
      let tab = 'layout';

      const env = (): EditorEnv => {
        let safe: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
        try {
          safe = ctx.platform.safeArea();
        } catch {
          /* no platform info: no insets */
        }
        return { w: win.innerWidth, h: win.innerHeight, safe };
      };

      function save(): void {
        const copy = cloneTouch(draft);
        const as = autoSwitch;
        try {
          ctx.settings.update((s) => {
            s.controls.touch = copy;
            s.controls.autoSwitch = as;
          });
        } catch {
          /* storage problems never break the editor; the draft stays on screen */
        }
      }

      // ---------------------------------------------------------------- stage
      const wrap = h('section', { class: 'dk-ce', testId: 'controls-editor', attrs: { 'data-screen-body': 'controls-editor' } });
      const pitch = h('div', { class: 'dk-ce-pitch', attrs: { 'aria-hidden': 'true' } }, h('div', { class: 'dk-ce-ring' }));
      const stage = h('div', { class: 'dk-ce-stage', testId: 'ce-stage' });
      const hudEls: HTMLElement[] = [
        h('div', { class: 'dk-ce-hud', text: 'SCORE', attrs: { 'aria-hidden': 'true' } }),
        h('div', { class: 'dk-ce-hud', text: 'HUD', attrs: { 'aria-hidden': 'true' } }),
        h('div', { class: 'dk-ce-hud', text: 'RADAR', attrs: { 'aria-hidden': 'true' } }),
      ];
      const pauseEl = h('div', { class: 'dk-ce-pause', attrs: { 'aria-hidden': 'true' } });
      stage.append(...hudEls, pauseEl);
      const ctls: CtlView[] = [];
      for (const key of EDITOR_KEYS) {
        const [main, sub] = EDITOR_LABELS[key]!;
        const b = h('button', {
          class: key === STICK_LAYOUT_KEY ? 'dk-ce-ctl dk-ce-ctl--stick' : 'dk-ce-ctl',
          testId: `ce-ctl-${key}`,
          attrs: { 'data-key': key, 'aria-label': `${main} control: drag to move, or press to pick up` },
        }, h('span', { class: 'dk-ce-ctl__label', text: main }), h('span', { class: 'dk-ce-ctl__sub', text: sub }));
        b.type = 'button';
        b.dataset.focus = '';
        if (key === EDITOR_KEYS[1]) b.dataset.focusDefault = '';
        stage.append(b);
        ctls.push({ key, el: b });
      }
      const tip = h('p', { class: 'dk-ce-tip', testId: 'ce-tip' });

      function setTip(): void {
        tip.textContent = picked
          ? 'D-pad: move it. L1 / R1: size. Confirm: drop it. Back: put it back.'
          : 'Drag a control to move it. With a controller, press Confirm on a control to pick it up.';
      }

      function renderStage(): void {
        const e = env();
        const circles = editorCircles(e, draft);
        const obs = editorObstacles(e, draft.mirror);
        for (let i = 0; i < ctls.length; i++) {
          const c = circles[i]!;
          const el = ctls[i]!.el;
          if (dragKey === c.key) continue;
          el.style.width = `${c.r * 2}px`;
          el.style.height = `${c.r * 2}px`;
          el.style.transform = `translate3d(${c.x - c.r}px, ${c.y - c.r}px, 0)`;
          el.classList.toggle('is-selected', selected === c.key);
          el.classList.toggle('is-picked', picked === c.key);
          el.classList.remove('is-invalid');
        }
        const stickSub = ctls[0]!.el.querySelector('.dk-ce-ctl__sub');
        if (stickSub) stickSub.textContent = draft.floatingStick ? 'Floating' : 'Fixed';
        pauseEl.style.width = `${obs.pause.r * 2}px`;
        pauseEl.style.height = `${obs.pause.r * 2}px`;
        pauseEl.style.transform = `translate3d(${obs.pause.x - obs.pause.r}px, ${obs.pause.y - obs.pause.r}px, 0)`;
        for (let i = 0; i < hudEls.length; i++) {
          const rc = obs.rects[i]!;
          const el = hudEls[i]!;
          el.style.width = `${rc.w}px`;
          el.style.height = `${rc.h}px`;
          el.style.transform = `translate3d(${rc.x}px, ${rc.y}px, 0)`;
        }
        stage.style.setProperty('--dk-ce-opacity', String(draft.opacity));
        wrap.dataset.mirror = draft.mirror ? '1' : '0';
        setTip();
      }

      // ---------------------------------------------------------------- dragging (touch / mouse)
      let dragKey: string | null = null;
      let dragId = -1;
      let grabDx = 0, grabDy = 0, startX = 0, startY = 0;
      let dragMoved = false;
      let suppressClick = false;

      function stageXY(e: PointerEvent): { x: number; y: number } {
        const r = stage.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      }

      function endDrag(e: PointerEvent, commit: boolean): void {
        if (e.pointerId !== dragId || !dragKey) return;
        const key = dragKey;
        const v = ctls[EDITOR_KEYS.indexOf(key)]!;
        dragKey = null;
        dragId = -1;
        v.el.classList.remove('is-dragging', 'is-invalid');
        try {
          if (v.el.hasPointerCapture?.(e.pointerId)) v.el.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        if (commit && dragMoved) {
          const p = stageXY(e);
          if (moveControl(draft, key, p.x - grabDx, p.y - grabDy, env())) {
            save();
            try { ctx.audio.playUi(UiSound.TOGGLE); } catch { /* no audio */ }
          }
        }
        if (dragMoved) suppressClick = true;
        renderStage();
        renderPanel();
      }

      for (const v of ctls) {
        v.el.addEventListener('pointerdown', (e: PointerEvent) => {
          if (dragId !== -1 || (e.pointerType === 'mouse' && e.button !== 0)) return;
          if (picked) dropPicked(false);
          const i = EDITOR_KEYS.indexOf(v.key);
          const c = editorCircles(env(), draft)[i]!;
          const p = stageXY(e);
          dragKey = v.key;
          dragId = e.pointerId;
          grabDx = p.x - c.x;
          grabDy = p.y - c.y;
          startX = p.x;
          startY = p.y;
          dragMoved = false;
          suppressClick = false;
          if (selected !== v.key) {
            selected = v.key;
            renderStage();
            renderPanel();
          }
          try {
            v.el.setPointerCapture(e.pointerId);
          } catch {
            /* capture is best effort */
          }
          e.preventDefault();
        });
        v.el.addEventListener('pointermove', (e: PointerEvent) => {
          if (e.pointerId !== dragId || dragKey !== v.key) return;
          const p = stageXY(e);
          if (!dragMoved && Math.hypot(p.x - startX, p.y - startY) < LOCAL_TUNING.dragSlopPt) return;
          if (!dragMoved) {
            dragMoved = true;
            v.el.classList.add('is-dragging');
          }
          const ev = env();
          const i = EDITOR_KEYS.indexOf(v.key);
          const circles = editorCircles(ev, draft);
          const c = circles[i]!;
          const q = clampSpot(v.key, p.x - grabDx, p.y - grabDy, c.r, ev, draft.mirror);
          v.el.style.transform = `translate3d(${q.x - c.r}px, ${q.y - c.r}px, 0)`;
          v.el.classList.toggle('is-invalid', !isValidSpot(circles, i, q.x, q.y, ev, draft.mirror));
        });
        v.el.addEventListener('pointerup', (e) => endDrag(e, true));
        v.el.addEventListener('pointercancel', (e) => endDrag(e, false));
        v.el.addEventListener('lostpointercapture', (e) => endDrag(e, false));
        // Confirm from a controller / keyboard (no pointer): pick up or drop. A tap only selects.
        v.el.addEventListener('click', (e) => {
          e.preventDefault();
          if (suppressClick || e.detail > 0) {
            suppressClick = false;
            return;
          }
          if (picked === v.key) dropPicked(false);
          else pickUp(v.key);
        });
      }

      // ---------------------------------------------------------------- controller pick-up mode
      function pickUp(key: string): void {
        if (picked) dropPicked(false);
        picked = key;
        selected = key;
        const p = draft.layout ? draft.layout[key] : undefined;
        pickedFrom = p ? { dx: p.dx, dy: p.dy, scale: p.scale } : undefined;
        try { ctx.audio.playUi(UiSound.CONFIRM); } catch { /* no audio */ }
        renderStage();
        renderPanel();
      }

      /** Drop the picked control (cancel = put it back where it was picked up). */
      function dropPicked(cancel: boolean): void {
        const key = picked;
        if (!key) return;
        picked = null;
        if (cancel) {
          // Restore the layout as it was before the pick-up (the cluster may have been materialised meanwhile).
          if (!draft.layout) draft.layout = {};
          if (pickedFrom) draft.layout[key] = pickedFrom;
          else if (keySlot(key) === -1) delete draft.layout[key];
          fixLayout(draft, env());
          save();
        }
        pickedFrom = undefined;
        try { ctx.audio.playUi(cancel ? UiSound.BACK : UiSound.TOGGLE); } catch { /* no audio */ }
        renderStage();
        renderPanel();
      }

      function nudge(dx: number, dy: number): void {
        if (!picked) return;
        const e = env();
        const i = EDITOR_KEYS.indexOf(picked);
        const circles = editorCircles(e, draft);
        const c = circles[i]!;
        const want = clampSpot(picked, c.x + dx, c.y + dy, c.r, e, draft.mirror);
        if (want.x === c.x && want.y === c.y) return;
        let p: { x: number; y: number } | null = isValidSpot(circles, i, want.x, want.y, e, draft.mirror) ? want : null;
        if (!p) {
          // Hop over an obstacle in the pressed direction: the nearest valid spot further along.
          for (let k = 2; k <= 40 && !p; k++) {
            const t = clampSpot(picked, c.x + dx * k, c.y + dy * k, c.r, e, draft.mirror);
            if (isValidSpot(circles, i, t.x, t.y, e, draft.mirror)) p = t;
          }
        }
        if (!p) return;
        moveControl(draft, picked, p.x, p.y, e);
        save();
        try { ctx.audio.playUi(UiSound.MOVE); } catch { /* no audio */ }
        renderStage();
      }

      function resize(delta: number): void {
        const key = picked ?? selected;
        scaleControl(draft, key, controlScale(draft, key) + delta, env());
        save();
        renderStage();
        renderPanel();
      }

      const offAction = focus.onAction((a: MenuAction) => {
        if (!picked) return false;
        const n = LOCAL_TUNING.nudgePt;
        switch (a) {
          case MenuAction.UP: nudge(0, -n); return true;
          case MenuAction.DOWN: nudge(0, n); return true;
          case MenuAction.LEFT: nudge(-n, 0); return true;
          case MenuAction.RIGHT: nudge(n, 0); return true;
          case MenuAction.TAB_PREV: resize(-LOCAL_TUNING.scaleStep); return true;
          case MenuAction.TAB_NEXT: resize(LOCAL_TUNING.scaleStep); return true;
          case MenuAction.CONFIRM: dropPicked(false); return true;
          case MenuAction.BACK: dropPicked(true); return true;
          default: return false;
        }
      });
      backHook = () => {
        if (!picked) return false;
        dropPicked(true);
        return true;
      };

      // ---------------------------------------------------------------- panel
      const panel = h('aside', { class: 'dk-ce-panel', testId: 'ce-panel', attrs: { 'aria-label': 'Touch control settings' } });
      const panelTitle = h('h1', { class: 'dk-ce-panel__title', text: 'Touch controls' });
      const hideBtn = createButton('Hide panel', () => setPanel(false), { testId: 'ce-hide', variant: 'ghost', ctx });
      const showBtn = createButton('Settings', () => setPanel(true), { testId: 'ce-show', variant: 'secondary', ctx, extraClass: 'dk-ce-show' });
      showBtn.hidden = true;
      const tabs = createTabs(
        [{ id: 'layout', label: 'Layout', testId: 'ce-tab-layout' }, { id: 'gestures', label: 'Gestures', testId: 'ce-tab-gestures' }, { id: 'play', label: 'Play', testId: 'ce-tab-play' }],
        tab, (id) => { tab = id; renderPanel(); }, { ctx, ariaLabel: 'Settings group' },
      );
      const body = h('div', { class: 'dk-ce-panel__body', testId: 'ce-panel-body' });
      panel.append(h('div', { class: 'dk-ce-panel__head' }, panelTitle, hideBtn), tabs.el, body);

      function setPanel(on: boolean): void {
        panel.hidden = !on;
        showBtn.hidden = on;
        try {
          focus.focus(on ? hideBtn : showBtn);
        } catch {
          /* focus engine not ready */
        }
      }

      /** A slider change: save and redraw the stage (the panel is not rebuilt under a dragging thumb). */
      function edit(fn: () => void): void {
        fn();
        save();
        renderStage();
      }

      /** A discrete change (toggle, choice): also refresh the panel (notes, dependent toggles). */
      function editD(fn: () => void): void {
        edit(fn);
        renderPanel();
      }

      let panelKey = '';
      function renderPanel(): void {
        const key = `${tab}|${selected}|${controlScale(draft, selected)}|${draft.gestures ? 1 : 0}|${JSON.stringify(draft.gestureEnabled)}|${draft.floatingStick ? 1 : 0}|${draft.mirror ? 1 : 0}|${draft.spacing}|${draft.opacity}|${draft.gesturesOnly ? 1 : 0}|${draft.fastPowerBar ? 1 : 0}|${autoSwitch}|${draft.skillTap},${draft.skillUp},${draft.skillRight}`;
        if (key === panelKey) return;
        panelKey = key;
        const keep = doc.activeElement instanceof HTMLElement && body.contains(doc.activeElement) ? doc.activeElement.dataset.testid : undefined;
        body.replaceChildren();
        if (tab === 'layout') renderLayoutTab();
        else if (tab === 'gestures') renderGesturesTab();
        else renderPlayTab();
        if (keep) {
          const again = body.querySelector<HTMLElement>(`[data-testid="${keep}"]`);
          if (again) {
            try { focus.focus(again); } catch { /* ignore */ }
          }
        }
      }

      function renderLayoutTab(): void {
        const [name] = EDITOR_LABELS[selected]!;
        body.append(
          h('p', { class: 'dk-ce-note', testId: 'ce-selected', text: `Selected: ${name}. Tap a control to choose it.` }),
          createSlider(`${name} size`, controlScale(draft, selected), (v) => edit(() => scaleControl(draft, selected, v, env())), {
            min: ATTACK_TUNING.scaleMin, max: ATTACK_TUNING.scaleMax, step: 0.05, testId: 'ce-size', ctx,
            format: (v) => `${Math.round(v * 100)}%`,
          }).el,
          createSlider('Spacing', fin(draft.spacing, 1), (v) => edit(() => setSpacing(draft, v, env())), {
            min: LOCAL_TUNING.spacingMin, max: LOCAL_TUNING.spacingMax, step: LOCAL_TUNING.spacingStep, testId: 'ce-spacing', ctx,
            format: (v) => `${Math.round(v * 100)}%`,
          }).el,
          createSlider('Opacity', fin(draft.opacity, 0.85), (v) => edit(() => { draft.opacity = Math.round(clamp(v, LOCAL_TUNING.opacityMin, LOCAL_TUNING.opacityMax) * 100) / 100; }), {
            min: LOCAL_TUNING.opacityMin, max: LOCAL_TUNING.opacityMax, step: LOCAL_TUNING.opacityStep, testId: 'ce-opacity', ctx,
            format: (v) => `${Math.round(v * 100)}%`,
          }).el,
          createToggle('Mirror for left-handers', draft.mirror, (v) => editD(() => setMirror(draft, v, env())), { testId: 'ce-mirror', ctx }).el,
          createSegmented('Stick', [
            { value: 1, label: 'Floating', testId: 'ce-stick-floating' },
            { value: 0, label: 'Fixed', testId: 'ce-stick-fixed' },
          ], draft.floatingStick ? 1 : 0, (v) => editD(() => { draft.floatingStick = v === 1; }), { testId: 'ce-stick', ctx }).el,
          h('p', { class: 'dk-ce-note', text: draft.floatingStick ? 'Floating: the stick appears where your thumb lands. Its spot here is used when Fixed.' : 'Fixed: the stick stays where you put it.' }),
          createButton('Reset to defaults', () => {
            if (picked) dropPicked(false);
            resetTouchDefaults(draft);
            autoSwitch = createDefaultSettings().controls.autoSwitch;
            save();
            renderStage();
            panelKey = '';
            renderPanel();
          }, { testId: 'ce-reset', variant: 'ghost', ctx }),
        );
      }

      function renderGesturesTab(): void {
        body.append(
          createToggle('Pitch gestures', draft.gestures, (v) => editD(() => { draft.gestures = v; }), { testId: 'ce-gestures', ctx, hint: 'Taps and swipes on the pitch' }).el,
          createToggle('Gestures only', draft.gesturesOnly, (v) => editD(() => { draft.gesturesOnly = v; }), { testId: 'ce-gestures-only', ctx, hint: 'Hides PASS, THROUGH and SHOOT' }).el,
        );
        for (const rule of GESTURE_RULES) {
          const on = draft.gestureEnabled[rule] !== false;
          body.append(createToggle(GESTURE_RULE_LABEL[rule], on, (v) => editD(() => {
            if (v) delete draft.gestureEnabled[rule];
            else draft.gestureEnabled[rule] = false;
          }), { testId: `ce-gesture-${rule}`, ctx, disabled: !draft.gestures }).el);
        }
      }

      function renderPlayTab(): void {
        const skills = SKILL_CHOICES.map((c) => ({ value: c.value, label: c.label }));
        body.append(
          createToggle('Fast power bar', draft.fastPowerBar, (v) => editD(() => { draft.fastPowerBar = v; }), { testId: 'ce-fast-power', ctx, hint: 'Power fills faster when you hold a button' }).el,
          createSegmented('Auto-switch', AUTO_SWITCH_CHOICES.map((c) => ({ value: c.value, label: c.label, testId: `ce-autoswitch-${c.value}` })), autoSwitch,
            (v) => editD(() => { autoSwitch = v; }), { testId: 'ce-autoswitch', ctx }).el,
          createSelector('Skill: tap', skills, draft.skillTap, (v) => editD(() => { draft.skillTap = v; }), { testId: 'ce-skill-tap', ctx }).el,
          createSelector('Skill: swipe up', skills, draft.skillUp, (v) => editD(() => { draft.skillUp = v; }), { testId: 'ce-skill-up', ctx }).el,
          createSelector('Skill: swipe right', skills, draft.skillRight, (v) => editD(() => { draft.skillRight = v; }), { testId: 'ce-skill-right', ctx }).el,
        );
      }

      // ---------------------------------------------------------------- mount
      wrap.append(pitch, stage, panel, showBtn, tip);
      root.append(wrap, createBackButton(ctx));
      // Settings may have been edited elsewhere: keep the stored layout valid for this viewport.
      if (fixLayout(draft, env()) > 0) save();
      renderStage();
      renderPanel();

      const onResize = (): void => {
        if (fixLayout(draft, env()) > 0) save();
        renderStage();
      };
      win.addEventListener('resize', onResize);
      win.addEventListener('orientationchange', onResize);
      const unsub = ctx.settings.subscribe((s) => {
        // A reset or change from elsewhere (another screen, storage repair): follow it while nothing is held.
        if (dragKey || picked) return;
        const t = s.controls.touch;
        if (JSON.stringify(t) === JSON.stringify(draft) && s.controls.autoSwitch === autoSwitch) return;
        draft = cloneTouch(t);
        autoSwitch = s.controls.autoSwitch;
        renderStage();
        renderPanel();
      });

      cleanup = () => {
        offAction();
        unsub();
        win.removeEventListener('resize', onResize);
        win.removeEventListener('orientationchange', onResize);
        wrap.remove();
      };
    },
    unmount() {
      cleanup?.();
      cleanup = null;
      backHook = null;
    },
    onBack() {
      return backHook ? backHook() : false;
    },
  };
}

// Keep the stick tuning reachable for tests that check the default fixed spot.
export const EDITOR_STICK_DEFAULT = { dx: STICK_TUNING.fixedDx, dy: STICK_TUNING.fixedDy } as const;
