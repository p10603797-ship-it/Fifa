/**
 * [PAD-08] Menu focus engine (section 12 "UI rules": every screen works with touch alone and with a controller
 * alone: a visible focus ring, a sensible focus order, and Back always works).
 *
 *  - attach(root) / detach(root): a stack of focus roots (a modal panel attaches on top of its screen); only the
 *    top root's visible [data-focus] elements and buttons take part.
 *  - Directional actions move focus spatially (pickSpatial: pure geometry, unit-tested). An element marked
 *    [data-focus-default] (or the first candidate) gets focus when a root is attached.
 *  - CONFIRM clicks the focused element. BACK, TAB_PREV / TAB_NEXT and START are delivered to subscribers
 *    (router: back; screens: tabs and sliders); subscribers also see every action first and may consume it by
 *    returning true (latest subscriber first).
 *  - The focus ring ([data-focused] while [data-focus-visible] is set on <html>) shows after controller or keyboard
 *    navigation and hides on the next pointer press, so touch users never see it.
 *
 * WAVE 0 BASELINE (FND-05). PAD-08 owns and refines it.
 */

import { MenuAction, type FocusNavigator } from '../contracts/app';

/** Axis-aligned rectangle in CSS px (DOMRect-compatible subset). */
export interface FocusRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Pick the best candidate in direction `dir` from `from`. Candidates whose span overlaps `from` on the cross axis
 * (in the "beam") win over others; among them the nearest edge gap, then the smallest centre offset. Returns the
 * index into rects, or -1 when nothing lies in that direction. Pure.
 */
export function pickSpatial(from: FocusRect, rects: readonly FocusRect[], dir: MenuAction): number {
  const fcx = (from.left + from.right) / 2, fcy = (from.top + from.bottom) / 2;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (r.left === from.left && r.top === from.top && r.right === from.right && r.bottom === from.bottom) continue;
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    let primary: number, cross: number, inBeam: boolean, gap: number;
    switch (dir) {
      case MenuAction.RIGHT:
        if (cx <= fcx + 1) continue;
        primary = cx - fcx; gap = Math.max(0, r.left - from.right);
        inBeam = r.bottom > from.top && r.top < from.bottom; cross = Math.abs(cy - fcy);
        break;
      case MenuAction.LEFT:
        if (cx >= fcx - 1) continue;
        primary = fcx - cx; gap = Math.max(0, from.left - r.right);
        inBeam = r.bottom > from.top && r.top < from.bottom; cross = Math.abs(cy - fcy);
        break;
      case MenuAction.DOWN:
        if (cy <= fcy + 1) continue;
        primary = cy - fcy; gap = Math.max(0, r.top - from.bottom);
        inBeam = r.right > from.left && r.left < from.right; cross = Math.abs(cx - fcx);
        break;
      case MenuAction.UP:
        if (cy >= fcy - 1) continue;
        primary = fcy - cy; gap = Math.max(0, from.top - r.bottom);
        inBeam = r.right > from.left && r.left < from.right; cross = Math.abs(cx - fcx);
        break;
      default:
        return -1;
    }
    const score = inBeam ? gap + cross * 0.25 + primary * 0.01 : 1e6 + primary + cross * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

const SELECTOR = '[data-focus], button';
const STYLE_ID = 'dk-focus-style';
const RING_CSS = `
[data-focus-visible] [data-focused] { outline: 3px solid var(--dk-ember, #ff6b35); outline-offset: 3px; }
[data-focused]:focus { outline: none; }
[data-focus-visible] [data-focused]:focus { outline: 3px solid var(--dk-ember, #ff6b35); }
`;

function isVisible(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest('[inert], [aria-hidden="true"], [data-focus-skip]')) return false;
  if (el.getClientRects().length === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none';
}

export interface DotkickFocusNavigator extends FocusNavigator {
  /** The focused element, or null. */
  readonly current: HTMLElement | null;
  /** Remove listeners and the ring. */
  dispose(): void;
}

export function createFocusNavigator(): DotkickFocusNavigator {
  const roots: HTMLElement[] = [];
  const subs: ((a: MenuAction) => boolean | void)[] = [];
  let current: HTMLElement | null = null;
  const hasDom = typeof document !== 'undefined';

  if (hasDom && !document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = RING_CSS;
    document.head.append(st);
  }
  const hideRing = (): void => { if (hasDom) document.documentElement.removeAttribute('data-focus-visible'); };
  const showRing = (): void => { if (hasDom) document.documentElement.setAttribute('data-focus-visible', ''); };
  if (hasDom) window.addEventListener('pointerdown', hideRing, true);

  function top(): HTMLElement | null {
    for (let i = roots.length - 1; i >= 0; i--) if (roots[i]!.isConnected) return roots[i]!;
    return null;
  }

  function candidates(root: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = [];
    const list = root.querySelectorAll<HTMLElement>(SELECTOR);
    for (let i = 0; i < list.length; i++) if (isVisible(list[i]!)) out.push(list[i]!);
    return out;
  }

  function setCurrent(el: HTMLElement | null): void {
    if (current === el) return;
    current?.removeAttribute('data-focused');
    current = el;
    if (el) {
      el.setAttribute('data-focused', '');
      try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
    }
  }

  function ensureCurrent(): HTMLElement | null {
    const root = top();
    if (!root) return null;
    if (current && current.isConnected && root.contains(current) && isVisible(current)) return current;
    const list = candidates(root);
    const def = list.find((e) => e.hasAttribute('data-focus-default')) ?? list[0] ?? null;
    setCurrent(def);
    return def;
  }

  const api: DotkickFocusNavigator = {
    get current() { return current; },
    attach(root: HTMLElement) {
      const i = roots.indexOf(root);
      if (i >= 0) roots.splice(i, 1);
      roots.push(root);
      setCurrent(null);
      ensureCurrent();
    },
    detach(root: HTMLElement) {
      const i = roots.indexOf(root);
      if (i >= 0) roots.splice(i, 1);
      if (current && root.contains(current)) setCurrent(null);
      ensureCurrent();
    },
    focus(el: HTMLElement) {
      setCurrent(el);
    },
    onAction(fn) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    handle(action: MenuAction) {
      for (let i = subs.length - 1; i >= 0; i--) if (subs[i]!(action) === true) return;
      if (action === MenuAction.UP || action === MenuAction.DOWN || action === MenuAction.LEFT || action === MenuAction.RIGHT) {
        const hadRing = hasDom && document.documentElement.hasAttribute('data-focus-visible');
        showRing();
        const cur = ensureCurrent();
        const root = top();
        if (!cur || !root || !hadRing) return; // first press only reveals the ring
        const list = candidates(root);
        const rects: FocusRect[] = list.map((e) => e.getBoundingClientRect());
        const idx = pickSpatial(cur.getBoundingClientRect(), rects, action);
        if (idx >= 0) setCurrent(list[idx]!);
      } else if (action === MenuAction.CONFIRM) {
        showRing();
        const cur = ensureCurrent();
        cur?.click();
      }
    },
    dispose() {
      if (hasDom) window.removeEventListener('pointerdown', hideRing, true);
      setCurrent(null);
      roots.length = 0;
      subs.length = 0;
      hideRing();
    },
  };
  return api;
}
