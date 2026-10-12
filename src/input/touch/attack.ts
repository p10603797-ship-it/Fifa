/**
 * [TCH-03] Attack cluster (section 9 "Layout" and "Attack buttons"): bottom right, one large SPRINT & SKILL button
 * (hold = sprint, tap = skill) with PASS, THROUGH and SHOOT fanned in an arc above and to its left. Large button
 * T_TOUCHUI.bigButton (96 pt), small T_TOUCHUI.smallButton (76 pt), at least T_TOUCHUI.buttonGap (12 pt) apart,
 * all inside the safe area and T_TOUCHUI.systemEdgeMargin (24 pt) clear of the bottom edge (system gestures).
 * Slots (contracts/touch.ts CLUSTER_SLOT): BIG bottom right; LOW left of BIG (PASS); MID diagonal up-left
 * (THROUGH); HIGH above BIG (SHOOT). PAUSE sits at the top right, 24 pt clear of the corner.
 * 1 CSS px = 1 pt on iPad Safari.
 *
 * WAVE 0 BASELINE (FND-05): layout maths + the four buttons. TCH-03 adds the swipe/double-tap semantics per row;
 * TCH-08 applies the editor's per-button placement, size and mirror settings.
 */

import { ClusterSlot, TouchButtonId, type TouchIntentState } from '../../contracts/touch';
import { T_TOUCHUI } from '../../contracts/tuning';
import { createTouchButton, type ButtonGeom, type TouchButtonControl } from './button';

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
  /** Spacing multiplier between buttons (settings.controls.touch.spacing, 1 = default). */
  spacing?: number;
  /** Size multiplier (0.7..1.4). */
  scale?: number;
  /** Mirror for left-handers (cluster bottom left, pause top left). */
  mirror?: boolean;
}

export function createClusterLayout(): ClusterLayout {
  const g = (): ButtonGeom => ({ cx: 0, cy: 0, r: 0 });
  return { slots: [g(), g(), g(), g()], pause: g() };
}

/** Pause button diameter (minimum touch target). */
export const PAUSE_SIZE = T_TOUCHUI.minTarget;

/**
 * Compute the cluster layout for a viewport of w x h CSS px with safe-area insets. Pure; writes into `out`.
 * Arc radius is the larger of (big + small radius + gap) and the distance that keeps neighbouring small buttons
 * `gap` apart at 45 degree steps.
 */
export function computeClusterLayout(w: number, h: number, safe: SafeInsets, opts: ClusterLayoutOptions = {}, out: ClusterLayout = createClusterLayout()): ClusterLayout {
  const scale = Math.max(0.7, Math.min(1.4, opts.scale ?? 1));
  const gap = T_TOUCHUI.buttonGap * Math.max(1, opts.spacing ?? 1);
  const bigR = (T_TOUCHUI.bigButton / 2) * scale;
  const smallR = (T_TOUCHUI.smallButton / 2) * scale;
  const margin = T_TOUCHUI.systemEdgeMargin;
  const right = Math.max(0, safe.right) + margin;
  const bottom = Math.max(0, safe.bottom) + margin;
  const bigCx = w - right - bigR;
  const bigCy = h - bottom - bigR;
  const step = Math.PI / 4;
  const arcR = Math.max(bigR + smallR + gap, (2 * smallR + gap) / (2 * Math.sin(step / 2)));
  const set = (g: ButtonGeom, cx: number, cy: number, r: number): void => { g.cx = cx; g.cy = cy; g.r = r; };
  set(out.slots[ClusterSlot.BIG], bigCx, bigCy, bigR);
  set(out.slots[ClusterSlot.LOW], bigCx - arcR, bigCy, smallR); // 180 deg: left
  set(out.slots[ClusterSlot.MID], bigCx - arcR * Math.SQRT1_2, bigCy - arcR * Math.SQRT1_2, smallR); // 135 deg
  set(out.slots[ClusterSlot.HIGH], bigCx, bigCy - arcR, smallR); // 90 deg: above
  const pr = PAUSE_SIZE / 2;
  set(out.pause, w - Math.max(0, safe.right) - margin - pr, Math.max(0, safe.top) + margin + pr, pr);
  if (opts.mirror) {
    for (let i = 0; i < 4; i++) out.slots[i]!.cx = w - out.slots[i]!.cx;
    out.pause.cx = w - out.pause.cx;
  }
  return out;
}

/** Attack buttons in slot order with their TouchButtonId. */
export const ATTACK_BUTTONS: readonly (readonly [ClusterSlot, TouchButtonId, string])[] = [
  [ClusterSlot.BIG, TouchButtonId.SPRINT_SKILL, 'SPRINT'],
  [ClusterSlot.LOW, TouchButtonId.PASS, 'PASS'],
  [ClusterSlot.MID, TouchButtonId.THROUGH, 'THROUGH'],
  [ClusterSlot.HIGH, TouchButtonId.SHOOT, 'SHOOT'],
];

export interface AttackCluster {
  /** Controls in hit-test order (small buttons first so overlapping slop favours them, then BIG). */
  readonly controls: readonly TouchButtonControl[];
  /** Copy a new layout into the buttons' geometry. */
  relayout(layout: ClusterLayout): void;
}

export function createAttackCluster(state: TouchIntentState, layout: ClusterLayout, enabled?: () => boolean): AttackCluster {
  const controls: TouchButtonControl[] = [];
  const order = [ClusterSlot.HIGH, ClusterSlot.MID, ClusterSlot.LOW, ClusterSlot.BIG];
  for (const slot of order) {
    const entry = ATTACK_BUTTONS.find((e) => e[0] === slot)!;
    const src = layout.slots[slot];
    controls.push(createTouchButton({ state, id: entry[1], geom: { cx: src.cx, cy: src.cy, r: src.r }, enabled }));
  }
  return {
    controls,
    relayout(l) {
      for (let i = 0; i < controls.length; i++) {
        const src = l.slots[order[i]!];
        const g = controls[i]!.geom;
        g.cx = src.cx; g.cy = src.cy; g.r = src.r;
      }
    },
  };
}
