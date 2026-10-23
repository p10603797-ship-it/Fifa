/**
 * [TCH-03] Attack cluster (section 9 "Layout" and "Attack buttons"): bottom right, one large SPRINT & SKILL button
 * (hold = sprint, tap = skill) with PASS, THROUGH and SHOOT fanned in an arc above and to its left. Large button
 * T_TOUCHUI.bigButton (96 pt), small T_TOUCHUI.smallButton (76 pt), at least T_TOUCHUI.buttonGap (12 pt) apart,
 * all inside the safe area and T_TOUCHUI.systemEdgeMargin (24 pt) clear of the bottom edge (system gestures).
 * Slots (contracts/touch.ts CLUSTER_SLOT): BIG bottom right; LOW left of BIG (PASS); MID diagonal up-left
 * (THROUGH); HIGH above BIG (SHOOT). PAUSE sits at the top right, 24 pt clear of the corner.
 * 1 CSS px = 1 pt on iPad Safari.
 *
 * Layout (computeClusterLayout, pure): the default arc, the size / spacing / mirror settings, and per-button
 * placements from the controls editor (TouchSettings.layout, ControlPlacement keyed by TouchButtonId as a string:
 * dx = button centre from the safe-area right edge (left edge when mirrored), dy = button centre from the safe-area
 * bottom edge, scale = size 0.7..1.4). Every button is kept inside the safe area and the system-gesture margins and
 * never smaller than T_TOUCHUI.minTarget.
 *
 * Buttons (createAttackCluster): the four section 9 attack buttons built on the generic recogniser (button.ts), so
 * every row of the attack table reaches the mapper as TouchButtonEvents (id, edge, swipe dir, mode at touch-down):
 *   | Button          | TAP / HOLD            | SWIPE up / down / left / right           | DOUBLE_TAP   |
 *   | PASS            | ground pass (+power)  | lob / pass and go / driven lob / driven  | dinked pass  |
 *   | THROUGH         | through ball (+power) | lobbed through / trigger a run / - / -   | dinked through |
 *   | SHOOT           | shot (+power)         | chip / finesse / fake shot / power shot  | - (TAP)      |
 *   | SPRINT & SKILL  | hold sprint, tap skill| skill / knock-on / hard stop / skill     | - (TAP)      |
 * The attack set is live (claims touches) in ATTACK, KEEPER (keeper throws / drop kick / drop: section 9 keeper row)
 * and SET_PIECE modes, unless the caller passes its own `enabled`. Gestures Only hides PASS, THROUGH and SHOOT except
 * at set pieces (SET_PIECE mode: the kick-off is taken with PASS and has no gesture).
 * Inside overlapping slop the nearest live button wins. Direction hints (arrows from ATTACK_SWIPE_HINTS) show on a
 * T_TOUCHUI.hintHoldMs hold while opts.hints() is true (TouchSettings.hintMatchesLeft > 0): hintMask.
 * Wiring (TCH-07, index.ts): pass `placements: t.layout` to computeClusterLayout; create the cluster with
 * `{ hints: () => t.hintMatchesLeft > 0, gesturesOnly: () => t.gesturesOnly }`; call `attack.update(now)` in pollFrame
 * (before overlay.sync) and before mapper.sample so HOLD and hints arrive on time (without it HOLD still arrives with
 * the next move or just before UP, and hints never show).
 */

import type { ControlPlacement } from '../../contracts/settings';
import {
  CLUSTER_SLOT, ClusterMode, ClusterSlot, SwipeDir, TouchButtonId, type TouchIntentState,
} from '../../contracts/touch';
import { T_TOUCH_ATTACK, T_TOUCHUI } from '../../contracts/tuning';
import { createTouchButton, type ButtonGeom, type TouchButtonControl } from './button';

/** Layout constants: contracts/tuning.ts T_TOUCH_ATTACK ([TUN-2]; the old name is kept for importers). */
export const LOCAL_TUNING = T_TOUCH_ATTACK;

export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Geometry of the right-hand cluster and the pause button (CSS px). */
export interface ClusterLayout {
  /** Indexed by ClusterSlot (BIG, LOW, MID, HIGH). */
  slots: [ButtonGeom, ButtonGeom, ButtonGeom, ButtonGeom];
  pause: ButtonGeom;
}

export interface ClusterLayoutOptions {
  /** Spacing multiplier between buttons (settings.controls.touch.spacing, 1 = default; never below 1). */
  spacing?: number;
  /** Size multiplier (0.7..1.4). */
  scale?: number;
  /** Mirror for left-handers (cluster bottom left; the pause button stays top right, clear of the scoreboard). */
  mirror?: boolean;
  /**
   * Per-button placements from the controls editor (TouchSettings.layout). A slot uses its attack button's key
   * (String(TouchButtonId)), else the key of a defence button in the same slot; slots without one keep the arc.
   */
  placements?: Readonly<Record<string, ControlPlacement | undefined>>;
}

export function createClusterLayout(): ClusterLayout {
  const g = (): ButtonGeom => ({ cx: 0, cy: 0, r: 0 });
  return { slots: [g(), g(), g(), g()], pause: g() };
}

/** Pause button diameter (minimum touch target). */
export const PAUSE_SIZE = T_TOUCHUI.minTarget;

/** Attack button in each ClusterSlot (BIG, LOW, MID, HIGH). */
export const SLOT_ATTACK_BUTTON: readonly TouchButtonId[] = [
  TouchButtonId.SPRINT_SKILL, TouchButtonId.PASS, TouchButtonId.THROUGH, TouchButtonId.SHOOT,
];

/** TouchSettings.layout keys that place each ClusterSlot, in lookup order: the attack button, then the defence one. */
export const SLOT_LAYOUT_KEYS: readonly (readonly string[])[] = [0, 1, 2, 3].map((slot) => {
  const keys = [String(SLOT_ATTACK_BUTTON[slot])];
  for (let id = 0; id < TouchButtonId.PAUSE; id++) {
    if (CLUSTER_SLOT[id as TouchButtonId] === slot && id !== SLOT_ATTACK_BUTTON[slot]) keys.push(String(id));
  }
  return keys;
});

const fin = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => (v > hi ? hi : v < lo ? lo : v);
const clampScale = (s: number | undefined): number => clamp(fin(s, 1), LOCAL_TUNING.scaleMin, LOCAL_TUNING.scaleMax);

/** The editor placement for a slot (SLOT_LAYOUT_KEYS order; entries without finite dx / dy are ignored), or null. */
export function slotPlacement(placements: ClusterLayoutOptions['placements'], slot: ClusterSlot): ControlPlacement | null {
  if (!placements) return null;
  const keys = SLOT_LAYOUT_KEYS[slot]!;
  for (let k = 0; k < keys.length; k++) {
    const p = placements[keys[k]!];
    if (p && typeof p === 'object' && Number.isFinite(p.dx) && Number.isFinite(p.dy)) return p;
  }
  return null;
}

/**
 * Compute the cluster layout for a viewport of w x h CSS px with safe-area insets. Pure; writes into `out`.
 * Arc radius is the larger of (big + small radius + gap) and the distance that keeps neighbouring small buttons
 * `gap` apart at 45 degree steps. Placements override single slots (clamped into the safe area).
 */
export function computeClusterLayout(w: number, h: number, safe: SafeInsets, opts: ClusterLayoutOptions = {}, out: ClusterLayout = createClusterLayout()): ClusterLayout {
  w = Math.max(0, fin(w, 0));
  h = Math.max(0, fin(h, 0));
  const sTop = Math.max(0, fin(safe.top, 0)), sRight = Math.max(0, fin(safe.right, 0));
  const sBottom = Math.max(0, fin(safe.bottom, 0)), sLeft = Math.max(0, fin(safe.left, 0));
  const mirror = !!opts.mirror;
  // Distances are measured from the anchored side (right edge, or left edge when mirrored).
  const sideInset = mirror ? sLeft : sRight;
  const farInset = mirror ? sRight : sLeft;
  const toX = (fromSide: number): number => (mirror ? fromSide : w - fromSide);
  const scale = clampScale(opts.scale);
  const gap = T_TOUCHUI.buttonGap * Math.max(1, fin(opts.spacing, 1));
  const margin = T_TOUCHUI.systemEdgeMargin;
  const minR = T_TOUCHUI.minTarget / 2;
  const radius = (base: number, s: number): number => Math.max(minR, (base / 2) * scale * s);

  // Radii: per-slot placement scale on top of the cluster scale.
  const place: (ControlPlacement | null)[] = [null, null, null, null];
  let smallMax = 0;
  for (let slot = 0; slot < 4; slot++) {
    const p = slotPlacement(opts.placements, slot as ClusterSlot);
    place[slot] = p;
    const r = radius(slot === ClusterSlot.BIG ? T_TOUCHUI.bigButton : T_TOUCHUI.smallButton, clampScale(p?.scale));
    out.slots[slot]!.r = r;
    if (slot !== ClusterSlot.BIG) smallMax = Math.max(smallMax, r);
  }
  const bigR = out.slots[ClusterSlot.BIG].r;
  // Default arc around the default BIG position (bottom corner of the safe area, margin clear of the edges).
  const bigSide = sideInset + margin + bigR;
  const bigCy = h - sBottom - margin - bigR;
  const step = LOCAL_TUNING.arcStep;
  const arcR = Math.max(bigR + smallMax + gap, (2 * smallMax + gap) / (2 * Math.sin(step / 2)));
  for (let slot = 0; slot < 4; slot++) {
    const g = out.slots[slot]!;
    const p = place[slot];
    let side: number, cy: number;
    if (p) {
      side = sideInset + p.dx;
      cy = h - sBottom - p.dy;
    } else if (slot === ClusterSlot.BIG) {
      side = bigSide; cy = bigCy;
    } else {
      // LOW at 180 deg (beside BIG), MID at 135 deg, HIGH at 90 deg (above BIG).
      const a = step * (slot - 1);
      side = bigSide + arcR * Math.cos(a);
      cy = bigCy - arcR * Math.sin(a);
    }
    // Inside the safe area, clear of the bottom and top system-gesture margins.
    side = clamp(side, sideInset + g.r, w - farInset - g.r);
    cy = clamp(cy, sTop + margin + g.r, h - sBottom - margin - g.r);
    g.cx = toX(side);
    g.cy = cy;
  }
  // The pause button stays top right in both layouts: mirrored, the top left belongs to the scoreboard (TCH-09 HUD
  // regions), so it never moves with the cluster.
  const pr = PAUSE_SIZE / 2;
  out.pause.r = pr;
  out.pause.cx = w - sRight - margin - pr;
  out.pause.cy = sTop + margin + pr;
  return out;
}

/**
 * Match layout guard (the touch source calls it after computeClusterLayout): editor placements keep their corner
 * distances on another viewport (Stage Manager / Split View window sizes), and the clamp into the safe area can then
 * land a button on the pause button, which wins every touch it covers (routing priority: a SHOOT tap paused the match).
 * Such a button is pushed straight down until it is T_TOUCHUI.buttonGap (x spacing) clear of PAUSE (QF-3 QA-23). The
 * default layout never comes near PAUSE. Pure; edits `out` in place.
 */
export function keepClearOfPause(out: ClusterLayout, h: number, safe: SafeInsets, spacing?: number): ClusterLayout {
  const gap = T_TOUCHUI.buttonGap * Math.max(1, fin(spacing, 1));
  const bottom = Math.max(0, fin(h, 0)) - Math.max(0, fin(safe.bottom, 0)) - T_TOUCHUI.systemEdgeMargin;
  const pz = out.pause;
  for (let slot = 0; slot < 4; slot++) {
    const g = out.slots[slot]!;
    const dx = g.cx - pz.cx;
    const dy = g.cy - pz.cy;
    const need = g.r + pz.r + gap;
    if (dx * dx + dy * dy >= need * need) continue;
    const down = pz.cy + Math.sqrt(Math.max(0, need * need - dx * dx));
    g.cy = Math.min(down, bottom - g.r);
  }
  return out;
}

/** Attack buttons in slot order with their TouchButtonId and overlay label. */
export const ATTACK_BUTTONS: readonly (readonly [ClusterSlot, TouchButtonId, string])[] = [
  [ClusterSlot.BIG, TouchButtonId.SPRINT_SKILL, 'SPRINT'],
  [ClusterSlot.LOW, TouchButtonId.PASS, 'PASS'],
  [ClusterSlot.MID, TouchButtonId.THROUGH, 'THROUGH'],
  [ClusterSlot.HIGH, TouchButtonId.SHOOT, 'SHOOT'],
];

/** Swipe labels per direction, indexed by SwipeDir (NONE, UP, DOWN, LEFT, RIGHT); '' = the swipe does nothing. */
export type SwipeLabels = readonly [string, string, string, string, string];

/**
 * Section 9 attack table, swipe columns, as plain-word hint labels for the overlay arrows (crossing-zone variants in
 * brackets are what the sim does in the crossing zone). Indexed by TouchButtonId; null = no swipes.
 */
export const ATTACK_SWIPE_HINTS: readonly (SwipeLabels | null)[] = [
  /* PASS */ ['', 'Lob', 'Pass and go', 'Driven lob', 'Driven pass'],
  /* THROUGH */ ['', 'Lobbed through', 'Call a run', '', ''],
  /* SHOOT */ ['', 'Chip', 'Finesse', 'Fake shot', 'Power shot'],
  /* SPRINT_SKILL */ ['', 'Skill', 'Knock-on', 'Hard stop', 'Skill'],
  null, null, null, null, null,
];

/** Attack buttons with a double tap (section 9: PASS dinked pass, THROUGH dinked through ball), as a mask. */
export const ATTACK_DOUBLE_TAP_MASK = (1 << TouchButtonId.PASS) | (1 << TouchButtonId.THROUGH);

/** Modes in which the attack set is live by default (keeper row and set pieces use the same buttons). Pure. */
export function attackSetActive(mode: ClusterMode): boolean {
  return mode === ClusterMode.ATTACK || mode === ClusterMode.KEEPER || mode === ClusterMode.SET_PIECE;
}

/**
 * Directions with a meaning for a press of `id` that went down in `mode`, as a mask of (1 << SwipeDir). Only the
 * open-play attack table has swipes (the keeper row is tap only). Pure.
 */
export function swipeHintMask(id: TouchButtonId, mode: ClusterMode): number {
  if (mode !== ClusterMode.ATTACK) return 0;
  const row = ATTACK_SWIPE_HINTS[id];
  if (!row) return 0;
  let m = 0;
  for (let d = SwipeDir.UP; d <= SwipeDir.RIGHT; d++) if (row[d] !== '') m |= 1 << d;
  return m;
}

/** Whether a second quick tap of `id` in `mode` is a DOUBLE_TAP (else a TAP). Pure. */
export function attackDoubleTap(id: TouchButtonId, mode: ClusterMode): boolean {
  return mode === ClusterMode.ATTACK && (ATTACK_DOUBLE_TAP_MASK & (1 << id)) !== 0;
}

export interface AttackClusterOptions {
  /** Direction hints on a 250 ms hold (index.ts: () => settings.controls.touch.hintMatchesLeft > 0). Default off. */
  hints?(): boolean;
  /** Gestures Only (TouchSettings.gesturesOnly): PASS, THROUGH and SHOOT are hidden and claim nothing. */
  gesturesOnly?(): boolean;
}

export interface AttackCluster {
  /** Controls in hit-test order (small buttons first so overlapping slop favours them, then BIG). */
  readonly controls: readonly TouchButtonControl[];
  /** Copy a new layout into the buttons' geometry. */
  relayout(layout: ClusterLayout): void;
  /** Advance hold / hint timers of every button (call once per animation frame and before each sample). */
  update(tMs: number): void;
  /** Buttons showing direction hints now, as a mask over TouchButtonId (arrows: swipeHintMask of the press). */
  readonly hintMask: number;
  /** The control in a slot. */
  slot(slot: ClusterSlot): TouchButtonControl;
  /** Whether a button would claim touches now (live set, not hidden by Gestures Only). */
  live(id: TouchButtonId): boolean;
}

/** Hit-test order: HIGH, MID, LOW, BIG. */
const ORDER: readonly ClusterSlot[] = [ClusterSlot.HIGH, ClusterSlot.MID, ClusterSlot.LOW, ClusterSlot.BIG];

/**
 * Build the four attack buttons. `enabled`, when given, decides when the attack set is live (it replaces the default
 * mode rule attackSetActive(state.mode)); Gestures Only still hides PASS, THROUGH and SHOOT on top of it.
 */
export function createAttackCluster(state: TouchIntentState, layout: ClusterLayout, enabled?: () => boolean, opts: AttackClusterOptions = {}): AttackCluster {
  const controls: TouchButtonControl[] = [];
  const bySlot: TouchButtonControl[] = [];
  const setLive = (): boolean => (enabled ? enabled() : attackSetActive(state.mode));
  const live = (id: TouchButtonId): boolean => {
    if (!setLive()) return false;
    // Gestures Only hides PASS, THROUGH and SHOOT in play; at set pieces they stay (section 9 "Kick-off: PASS" has no
    // gesture, "PASS plays it short", "or use the buttons"), else a touch player could not kick off (QF-3 FIX-06).
    if (id !== TouchButtonId.SPRINT_SKILL && state.mode !== ClusterMode.SET_PIECE && opts.gesturesOnly && opts.gesturesOnly()) return false;
    return true;
  };
  /** Distance from (x, y) to a button's rim (negative inside). */
  const rim = (b: TouchButtonControl, x: number, y: number): number => {
    const dx = x - b.geom.cx, dy = y - b.geom.cy;
    return Math.sqrt(dx * dx + dy * dy) - b.geom.r;
  };
  const hint = (id: TouchButtonId, mode: ClusterMode): boolean => !!opts.hints && opts.hints() && swipeHintMask(id, mode) !== 0;

  for (let k = 0; k < ORDER.length; k++) {
    const slot = ORDER[k]!;
    const id = SLOT_ATTACK_BUTTON[slot]!;
    const src = layout.slots[slot];
    let self: TouchButtonControl | null = null;
    const btn = createTouchButton({
      state,
      id,
      geom: { cx: src.cx, cy: src.cy, r: src.r },
      enabled: () => live(id),
      // Inside overlapping slop the nearest live button (by distance to its rim) wins.
      claim: (x, y) => {
        const mine = rim(self!, x, y);
        if (mine <= 0) return true;
        for (let j = 0; j < controls.length; j++) {
          const o = controls[j]!;
          if (o === self || !live(o.id)) continue;
          if (rim(o, x, y) < mine) return false;
        }
        return true;
      },
      doubleTap: attackDoubleTap,
      hint,
    });
    self = btn;
    controls.push(btn);
    bySlot[slot] = btn;
  }
  return {
    controls,
    relayout(l) {
      for (let i = 0; i < controls.length; i++) {
        const src = l.slots[ORDER[i]!];
        const g = controls[i]!.geom;
        g.cx = src.cx; g.cy = src.cy; g.r = src.r;
      }
    },
    update(t) {
      for (let i = 0; i < controls.length; i++) controls[i]!.update(t);
    },
    get hintMask() {
      let m = 0;
      for (let i = 0; i < controls.length; i++) {
        const c = controls[i]!;
        if (c.hint && c.pressId !== -1) m |= 1 << c.pressId;
      }
      return m;
    },
    slot: (s) => bySlot[s]!,
    live,
  };
}
