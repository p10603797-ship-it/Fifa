/**
 * [PAD-08] Menu focus engine (section 12 "UI rules": every screen works with touch alone and with a controller
 * alone: a visible focus ring, a sensible focus order, and Back always works; section 10 menus: Confirm, Back, move,
 * switch tab).
 *
 *  - attach(root) / detach(root): a stack of focus roots (a modal panel attaches on top of its screen); only the
 *    top root's visible, enabled [data-focus] elements and buttons take part. Each root remembers its last focused
 *    element, so closing a modal returns focus to where it was. Initial focus: [data-focus-default], else the first
 *    candidate in document order.
 *  - Directions move focus spatially (pickSpatial: the nearest candidate in the pressed direction by geometry, pure
 *    and unit-tested). Groups: an element inside a container marked [data-focus-group] searches its group first; at
 *    the group's edge it wraps around inside the group (pickWrap) on the group's wrap axes, else it leaves the group
 *    for the nearest candidate outside (nested groups are tried innermost first). Attribute value = wrap axes:
 *    "" or "both" both axes, "x" / "row" left-right only, "y" / "column" up-down only, "none" no wrap.
 *  - Adjustable controls ([data-focus-adjust] on the focused element): LEFT / RIGHT change the value instead of moving
 *    focus: <input type="range" | "number"> steps down / up (input + change events); checkbox, role="switch" or
 *    [aria-pressed] / [aria-checked] go off on LEFT and on on RIGHT (by click()); an element containing
 *    [data-adjust="dec"] / [data-adjust="inc"] buttons clicks them; anything else receives a bubbling
 *    FOCUS_ADJUST_EVENT ('focusadjust') CustomEvent with detail { delta: -1 | 1 }. When there is nothing to change
 *    that way (a toggle already off on LEFT / on on RIGHT, a disabled stepper arrow) the direction moves the focus.
 *  - CONFIRM clicks the focused element (a text field is focused instead, which opens the on-screen keyboard).
 *  - TAB_PREV / TAB_NEXT switch tabs of the [data-tabs] container holding the focus (else the first visible one in
 *    the top root): tabs are its [role="tab"] / [data-tab] elements (else its focusable elements); the selected one is
 *    [aria-selected="true"], [data-selected] or [aria-current]; the previous / next tab (wrapping) is clicked, and
 *    focus follows it when focus was on the tab bar or got removed.
 *  - BACK: subscribers first; when none consumes it, opts.onBack (the router's back).
 *  - Subscribers (onAction) see every action first, latest subscriber first, and consume it by returning true.
 *  - Focus ring: the focused element carries [data-focused] and the FOCUS_CLASS class; <html> carries
 *    [data-focus-visible] and FOCUS_VISIBLE_CLASS while the ring is visible. The ring shows after controller or
 *    keyboard navigation and hides on the next pointer press (which also moves focus to the pressed control), so
 *    touch users never see it. The first direction press while the ring is hidden only reveals it.
 *  - Native focus that moves without the navigator (the Tab key, a screen calling el.focus()) onto a candidate of the
 *    top root takes the ring along, so the outline and CONFIRM always name the same control; keyboard focus
 *    (:focus-visible) also shows the ring. Moving the ring onto a text field (which keeps native focus off until
 *    CONFIRM) blurs the previous control so a later window focus cannot pull the ring back to it.
 *  - If the focused element is removed (a screen re-renders), the root's remembered element, its default or its first
 *    candidate takes over (MutationObserver on the top root, plus a check before every action).
 *
 * UI code (not sim): allocation per action is fine. Works without a DOM (Node) for the pure helpers.
 */

import { MenuAction, type FocusNavigator } from '../contracts/app';
import { isEditableTarget } from './keyboard';

/** Axis-aligned rectangle in CSS px (DOMRect-compatible subset). */
export interface FocusRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Class on the focused element (styling hook; [data-focused] is set too). */
export const FOCUS_CLASS = 'dk-focused';
/** Class on <html> while the focus ring is visible ([data-focus-visible] is set too). */
export const FOCUS_VISIBLE_CLASS = 'dk-focus-visible';
/** Event dispatched on a focused [data-focus-adjust] element that is not a known control (detail: { delta }). */
export const FOCUS_ADJUST_EVENT = 'focusadjust';
/** Elements that take part in focus navigation. */
export const FOCUS_SELECTOR = '[data-focus], button';

function sameRect(a: FocusRect, b: FocusRect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/**
 * Pick the best candidate in direction `dir` from `from`. Candidates whose span overlaps `from` on the cross axis
 * (in the "beam") win over others; among them the nearest edge gap, then the smallest centre offset. Returns the
 * index into rects, or -1 when nothing lies in that direction. Ties keep the earlier (document order) candidate. Pure.
 */
export function pickSpatial(from: FocusRect, rects: readonly FocusRect[], dir: MenuAction): number {
  const fcx = (from.left + from.right) / 2, fcy = (from.top + from.bottom) / 2;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (sameRect(r, from)) continue;
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

/**
 * Wrap target for direction `dir` (used at a group's edge, when pickSpatial found nothing): among the candidates
 * lying the other way (DOWN: above `from`; RIGHT: left of it, ...), the furthest one (DOWN -> the top-most, RIGHT ->
 * the left-most), preferring candidates in the beam of `from`, then the smallest cross-axis offset. Returns the index
 * into rects, or -1 (nothing the other way: a single row never wraps vertically). Pure.
 */
export function pickWrap(from: FocusRect, rects: readonly FocusRect[], dir: MenuAction): number {
  const fcx = (from.left + from.right) / 2, fcy = (from.top + from.bottom) / 2;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (sameRect(r, from)) continue;
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    let extreme: number, cross: number, inBeam: boolean;
    switch (dir) {
      case MenuAction.DOWN:
        if (cy >= fcy - 1) continue;
        extreme = cy; cross = Math.abs(cx - fcx); inBeam = r.right > from.left && r.left < from.right;
        break;
      case MenuAction.UP:
        if (cy <= fcy + 1) continue;
        extreme = -cy; cross = Math.abs(cx - fcx); inBeam = r.right > from.left && r.left < from.right;
        break;
      case MenuAction.RIGHT:
        if (cx >= fcx - 1) continue;
        extreme = cx; cross = Math.abs(cy - fcy); inBeam = r.bottom > from.top && r.top < from.bottom;
        break;
      case MenuAction.LEFT:
        if (cx <= fcx + 1) continue;
        extreme = -cx; cross = Math.abs(cy - fcy); inBeam = r.bottom > from.top && r.top < from.bottom;
        break;
      default:
        return -1;
    }
    const score = (inBeam ? 0 : 1e6) + extreme + cross * (inBeam ? 0.25 : 2);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** Wrap axes of a [data-focus-group] value: bit 1 = horizontal (LEFT / RIGHT), bit 2 = vertical (UP / DOWN). Pure. */
export function groupWrapAxes(value: string | null | undefined): number {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'both' || v === 'xy' || v === 'true') return 3;
  if (v === 'x' || v === 'row' || v === 'horizontal') return 1;
  if (v === 'y' || v === 'column' || v === 'col' || v === 'vertical') return 2;
  return 0;
}

/** True when a group with wrap axes `axes` wraps for direction `dir`. Pure. */
export function wrapsFor(axes: number, dir: MenuAction): boolean {
  if (dir === MenuAction.LEFT || dir === MenuAction.RIGHT) return (axes & 1) !== 0;
  if (dir === MenuAction.UP || dir === MenuAction.DOWN) return (axes & 2) !== 0;
  return false;
}

/** Next index in a cyclic list of n from `cur` by `delta` (cur -1: delta > 0 -> 0, else n - 1). -1 when n is 0. Pure. */
export function cycleIndex(cur: number, n: number, delta: number): number {
  if (n <= 0) return -1;
  if (cur < 0 || cur >= n) return delta > 0 ? 0 : n - 1;
  return (((cur + delta) % n) + n) % n;
}

/** -1 for LEFT, +1 for RIGHT, else 0 (adjustable controls). Pure. */
export function adjustDelta(a: MenuAction): number {
  return a === MenuAction.LEFT ? -1 : a === MenuAction.RIGHT ? 1 : 0;
}

function isDirection(a: MenuAction): boolean {
  return a === MenuAction.UP || a === MenuAction.DOWN || a === MenuAction.LEFT || a === MenuAction.RIGHT;
}

const STYLE_ID = 'dk-focus-style';
const RING_CSS = `
[data-focus-visible] [data-focused], .${FOCUS_VISIBLE_CLASS} .${FOCUS_CLASS} { outline: 3px solid var(--ember, #ff6b35); outline-offset: 3px; }
[data-focused]:focus { outline: none; }
[data-focus-visible] [data-focused]:focus, .${FOCUS_VISIBLE_CLASS} .${FOCUS_CLASS}:focus { outline: 3px solid var(--ember, #ff6b35); }
`;

type StyleReader = (el: Element) => { visibility: string; display: string; pointerEvents: string } | null;

function styleReaderFor(el: HTMLElement): StyleReader | null {
  const view = el.ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined;
  if (view && typeof view.getComputedStyle === 'function') return (e) => view.getComputedStyle(e);
  return null;
}

function attrOn(v: string | null): boolean {
  return v !== null && v !== 'false';
}

/** True for an enabled, rendered, interactive element outside inert / hidden subtrees. */
function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if ((el as HTMLButtonElement).disabled === true) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  if (el.closest('[inert], [aria-hidden="true"], [data-focus-skip]')) return false;
  if (el.getClientRects().length === 0) return false;
  const read = styleReaderFor(el);
  const cs = read ? read(el) : null;
  return !cs || (cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none');
}

/** A text-entry element (keyboard.ts isEditableTarget): navigating onto it never opens the on-screen keyboard; CONFIRM focuses it. */
function isTextEntry(el: HTMLElement): boolean {
  return isEditableTarget(el);
}

/** True when the engine shows a keyboard focus indicator on el (:focus-visible); false where unsupported. */
function matchesFocusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

function fire(el: HTMLElement, type: string): void {
  const view = el.ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined;
  const Ctor = view?.Event ?? (typeof Event !== 'undefined' ? Event : null);
  if (Ctor) el.dispatchEvent(new Ctor(type, { bubbles: true }));
}

/**
 * Adjust a focused [data-focus-adjust] control by delta (-1 / +1). Returns true when the direction was used (the value
 * changed, a slider sat at its end, or a custom control got the event); false when a binary control (checkbox, switch,
 * pressed / checked) is already in that state or its stepper arrow is disabled: the direction then moves the focus
 * (QF-3: a right-column toggle in a two-column screen no longer traps LEFT).
 */
function adjustElement(el: HTMLElement, delta: number): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    const type = (input.type || '').toLowerCase();
    if (type === 'range' || type === 'number') {
      const before = input.value;
      try {
        if (delta > 0) input.stepUp(); else input.stepDown();
      } catch {
        return false;
      }
      if (input.value !== before) {
        fire(input, 'input');
        fire(input, 'change');
      }
      return true;
    }
    if (type === 'checkbox') {
      if (input.checked === delta > 0) return false;
      input.click();
      return true;
    }
  }
  const role = el.getAttribute('role');
  const checked = el.getAttribute('aria-checked');
  const pressed = el.getAttribute('aria-pressed');
  if (role === 'switch' || checked !== null || pressed !== null) {
    const on = (checked ?? pressed) === 'true';
    if (on === delta > 0) return false;
    el.click();
    return true;
  }
  const stepper = el.querySelector<HTMLElement>(delta > 0 ? '[data-adjust="inc"]' : '[data-adjust="dec"]');
  if (stepper) {
    // Steppers are usually [data-focus-skip] (the selector takes focus, not its arrows): a disabled one (the end of
    // the list) lets the direction move the focus instead.
    if ((stepper as HTMLButtonElement).disabled === true || stepper.getAttribute('aria-disabled') === 'true') return false;
    stepper.click();
    return true;
  }
  const view = el.ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined;
  const CE = view?.CustomEvent ?? (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
  if (CE) el.dispatchEvent(new CE(FOCUS_ADJUST_EVENT, { bubbles: true, detail: { delta } }));
  return true;
}

export interface FocusNavigatorOptions {
  /** BACK that no subscriber consumed (the router's back). */
  onBack?(): void;
  /** Focus moved by a direction, tab switch or adjust (UI sound hook: UiSound.MOVE). */
  onMove?(el: HTMLElement): void;
  /** Document to use (default: the global document when it exists). */
  doc?: Document | null;
}

export interface DotkickFocusNavigator extends FocusNavigator {
  /** The focused element, or null. */
  readonly current: HTMLElement | null;
  /** True while the focus ring is shown. */
  readonly ringVisible: boolean;
  /** Show / hide the ring (a screen opened by controller can reveal it at once). */
  showRing(): void;
  hideRing(): void;
  /** Re-check the focused element after a screen rebuilt its DOM (also done automatically). */
  refresh(): void;
  /** Replace opts.onBack. */
  setBackHandler(fn: (() => void) | null): void;
  /**
   * A held direction's auto-repeat (menu input, PAD-08): like handle(), except that it never moves the focus off an
   * adjustable control the hold is acting on (a toggle already switched, a slider at its end) and never starts
   * adjusting a control the same hold moved onto (QF-3: a held LEFT that switched a right-column toggle off no longer
   * runs on into the left column and steps its slider). A held UP / DOWN still walks the list.
   */
  handleRepeat(action: MenuAction): void;
  /** Remove listeners and the ring. */
  dispose(): void;
}

export function createFocusNavigator(opts: FocusNavigatorOptions = {}): DotkickFocusNavigator {
  const doc: Document | null = opts.doc !== undefined ? opts.doc : typeof document !== 'undefined' ? document : null;
  const roots: HTMLElement[] = [];
  /** Last focused element per root (parallel to roots). */
  const remembered: (HTMLElement | null)[] = [];
  const subs: ((a: MenuAction) => boolean | void)[] = [];
  let current: HTMLElement | null = null;
  let ring = false;
  let onBack: (() => void) | null = opts.onBack ?? null;
  let observer: MutationObserver | null = null;
  let observed: HTMLElement | null = null;
  let disposed = false;
  /** Direction of the last fresh press, and whether it adjusted the focused control (handleRepeat). */
  let holdDir = -1;
  let holdAdjusting = false;

  if (doc && doc.head && !doc.getElementById(STYLE_ID)) {
    const st = doc.createElement('style');
    st.id = STYLE_ID;
    st.textContent = RING_CSS;
    doc.head.append(st);
  }

  function setRing(on: boolean): void {
    ring = on;
    const html = doc?.documentElement;
    if (!html) return;
    if (on) {
      html.setAttribute('data-focus-visible', '');
      html.classList.add(FOCUS_VISIBLE_CLASS);
    } else {
      html.removeAttribute('data-focus-visible');
      html.classList.remove(FOCUS_VISIBLE_CLASS);
    }
  }

  function top(): HTMLElement | null {
    for (let i = roots.length - 1; i >= 0; i--) if (roots[i]!.isConnected) return roots[i]!;
    return null;
  }

  function rootIndexOf(el: HTMLElement): number {
    for (let i = roots.length - 1; i >= 0; i--) if (roots[i]!.contains(el)) return i;
    return -1;
  }

  function candidates(root: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = [];
    const list = root.querySelectorAll<HTMLElement>(FOCUS_SELECTOR);
    for (let i = 0; i < list.length; i++) if (isVisible(list[i]!)) out.push(list[i]!);
    return out;
  }

  function setCurrent(el: HTMLElement | null, nativeFocus = true): void {
    if (current === el) return;
    if (current) {
      current.removeAttribute('data-focused');
      current.classList.remove(FOCUS_CLASS);
    }
    current = el;
    if (!el) return;
    el.setAttribute('data-focused', '');
    el.classList.add(FOCUS_CLASS);
    const ri = rootIndexOf(el);
    if (ri >= 0) remembered[ri] = el;
    if (!nativeFocus) return;
    if (!isTextEntry(el)) {
      try {
        el.focus({ preventScroll: true });
      } catch {
        /* not focusable */
      }
      return;
    }
    // A text field takes the ring but not native focus (no on-screen keyboard until CONFIRM). Native focus must not
    // stay on the previous control: when the window regains focus its focusin would pull the ring back there.
    const active = doc ? (doc.activeElement as HTMLElement | null) : null;
    if (active && active !== el && active !== doc!.body && typeof active.blur === 'function') {
      try {
        active.blur();
      } catch {
        /* old engines */
      }
    }
  }

  function valid(el: HTMLElement | null, root: HTMLElement): el is HTMLElement {
    return el !== null && el.isConnected && root.contains(el) && isVisible(el);
  }

  /** Make sure the focused element is valid in the top root. Returns true when it had to pick a new one. */
  function ensureCurrent(): boolean {
    const root = top();
    if (!root) {
      if (current) setCurrent(null);
      return false;
    }
    if (valid(current, root)) return false;
    const ri = roots.indexOf(root);
    const mem = ri >= 0 ? remembered[ri]! : null;
    if (valid(mem, root)) {
      setCurrent(mem);
      return true;
    }
    const list = candidates(root);
    let def: HTMLElement | null = null;
    for (let i = 0; i < list.length; i++) if (list[i]!.hasAttribute('data-focus-default')) { def = list[i]!; break; }
    setCurrent(def ?? list[0] ?? null);
    return current !== null;
  }

  function observeTop(): void {
    const root = top();
    if (observed === root) return;
    observer?.disconnect();
    observed = root;
    if (!root) return;
    if (!observer) {
      if (typeof MutationObserver === 'undefined') return;
      observer = new MutationObserver(() => {
        if (disposed) return;
        if (current === null || !current.isConnected) ensureCurrent();
      });
    }
    observer.observe(root, { childList: true, subtree: true });
  }

  function reveal(el: HTMLElement): void {
    try {
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } catch {
      /* old engines */
    }
  }

  /** Nearest [data-focus-group] ancestor of el strictly inside root (or the root itself when it is marked), or null. */
  function groupOf(el: HTMLElement, root: HTMLElement): HTMLElement | null {
    let g = el.parentElement ? el.parentElement.closest<HTMLElement>('[data-focus-group]') : null;
    if (g && !root.contains(g)) g = null;
    return g;
  }

  function navigate(dir: MenuAction): void {
    const root = top();
    const cur = current;
    if (!root || !cur) return;
    const list = candidates(root);
    const rects: FocusRect[] = [];
    for (let i = 0; i < list.length; i++) rects.push(list[i]!.getBoundingClientRect());
    const from = cur.getBoundingClientRect();
    // Innermost group first: inside it, then wrap inside it, then the next group out; finally the whole root.
    for (let g = groupOf(cur, root); g; g = g === root ? null : groupOf(g, root)) {
      const idx: number[] = [];
      const sub: FocusRect[] = [];
      for (let i = 0; i < list.length; i++) {
        if (list[i] !== cur && g.contains(list[i]!)) { idx.push(i); sub.push(rects[i]!); }
      }
      let k = pickSpatial(from, sub, dir);
      if (k < 0 && wrapsFor(groupWrapAxes(g.getAttribute('data-focus-group')), dir)) k = pickWrap(from, sub, dir);
      if (k >= 0) {
        go(list[idx[k]!]!);
        return;
      }
    }
    const i = pickSpatial(from, rects, dir);
    if (i >= 0 && list[i] !== cur) go(list[i]!);
  }

  function go(el: HTMLElement): void {
    setCurrent(el);
    reveal(el);
    opts.onMove?.(el);
  }

  function switchTab(delta: number): void {
    const root = top();
    if (!root) return;
    let bar: HTMLElement | null = current ? current.closest<HTMLElement>('[data-tabs]') : null;
    if (bar && !root.contains(bar)) bar = null;
    if (!bar) {
      const bars = root.querySelectorAll<HTMLElement>('[data-tabs]');
      for (let i = 0; i < bars.length && !bar; i++) if (bars[i]!.getClientRects().length > 0) bar = bars[i]!;
      if (!bar && root.hasAttribute('data-tabs')) bar = root;
    }
    if (!bar) return;
    let tabs: HTMLElement[] = [];
    const marked = bar.querySelectorAll<HTMLElement>('[role="tab"], [data-tab]');
    for (let i = 0; i < marked.length; i++) if (isVisible(marked[i]!)) tabs.push(marked[i]!);
    if (tabs.length === 0) tabs = candidates(bar);
    if (tabs.length === 0) return;
    let sel = -1;
    for (let i = 0; i < tabs.length && sel < 0; i++) {
      const t = tabs[i]!;
      if (t.getAttribute('aria-selected') === 'true' || attrOn(t.getAttribute('data-selected')) || attrOn(t.getAttribute('aria-current'))) sel = i;
    }
    if (sel < 0 && current) sel = tabs.indexOf(current);
    const next = cycleIndex(sel, tabs.length, delta);
    if (next < 0 || next === sel) return;
    const tab = tabs[next]!;
    const focusOnBar = current !== null && bar.contains(current);
    tab.click();
    if (disposed) return;
    if (focusOnBar || current === null || !current.isConnected) {
      if (tab.isConnected && isVisible(tab) && root.contains(tab)) go(tab);
      else ensureCurrent();
    }
  }

  const onPointer = (e: Event): void => {
    setRing(false);
    const root = top();
    const t = e.target as HTMLElement | null;
    if (!root || !t || typeof t.closest !== 'function') return;
    const el = t.closest<HTMLElement>(FOCUS_SELECTOR);
    if (el && root.contains(el) && isVisible(el)) setCurrent(el, false);
  };
  /**
   * Native focus moved without the navigator (Tab key, a screen calling el.focus()): the ring follows it, so the
   * outline and CONFIRM always name the same control. Keyboard-driven focus (:focus-visible) also shows the ring.
   */
  const onFocusIn = (e: Event): void => {
    if (disposed) return;
    const t = e.target as HTMLElement | null;
    if (!t || t === current || typeof t.matches !== 'function') return;
    const root = top();
    if (!root || !root.contains(t) || !t.matches(FOCUS_SELECTOR) || !isVisible(t)) return;
    setCurrent(t, false);
    if (matchesFocusVisible(t)) setRing(true);
  };
  const win = doc?.defaultView ?? null;
  win?.addEventListener('pointerdown', onPointer, true);
  win?.addEventListener('focusin', onFocusIn, true);

  /**
   * A direction: reveal the ring first, else adjust a [data-focus-adjust] control (LEFT / RIGHT) or move the focus. A
   * fresh press whose adjust changes nothing (a toggle already in that state, a disabled stepper arrow) moves the focus
   * instead. A repeat of the same held direction keeps doing what its press did: it adjusts only a control that press
   * adjusted (a held slider ramps), stops on any other adjustable control (never falls through, never starts adjusting
   * one it moved onto), and otherwise keeps moving.
   */
  function direction(action: MenuAction, repeat: boolean): void {
    const hadRing = ring;
    setRing(true);
    const fresh = ensureCurrent();
    const cur = current;
    if (!cur || !hadRing || fresh) {
      if (cur) reveal(cur);
      holdDir = action;
      holdAdjusting = false;
      return; // the first press only reveals the ring (or lands on the new focus)
    }
    const delta = adjustDelta(action);
    const adjustable = delta !== 0 && cur.hasAttribute('data-focus-adjust');
    if (repeat && action === holdDir) {
      if (!adjustable) {
        navigate(action);
      } else if (holdAdjusting && adjustElement(cur, delta)) {
        opts.onMove?.(cur);
        if (!current || !current.isConnected) ensureCurrent();
      }
      return;
    }
    holdDir = action;
    holdAdjusting = false;
    if (adjustable) {
      if (adjustElement(cur, delta)) {
        holdAdjusting = true;
        opts.onMove?.(cur);
        if (!current || !current.isConnected) ensureCurrent();
        return;
      }
      // Nothing to change that way (a toggle already in that state, the end of a list): move instead.
    }
    navigate(action);
  }

  const api: DotkickFocusNavigator = {
    get current() { return current; },
    get ringVisible() { return ring; },
    showRing() { setRing(true); },
    hideRing() { setRing(false); },
    refresh() { ensureCurrent(); },
    setBackHandler(fn) { onBack = fn; },
    attach(root: HTMLElement) {
      if (disposed) return;
      const i = roots.indexOf(root);
      let mem: HTMLElement | null = null;
      if (i >= 0) {
        mem = remembered[i]!;
        roots.splice(i, 1);
        remembered.splice(i, 1);
      }
      roots.push(root);
      remembered.push(mem);
      setCurrent(null);
      ensureCurrent();
      observeTop();
    },
    detach(root: HTMLElement) {
      const i = roots.indexOf(root);
      if (i >= 0) {
        roots.splice(i, 1);
        remembered.splice(i, 1);
      }
      if (current && (root.contains(current) || !current.isConnected)) setCurrent(null);
      ensureCurrent();
      observeTop();
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
    handleRepeat(action: MenuAction) {
      if (disposed) return;
      const ls = subs.slice();
      for (let i = ls.length - 1; i >= 0; i--) if (ls[i]!(action) === true) return;
      if (isDirection(action)) direction(action, true);
      else api.handle(action);
    },
    handle(action: MenuAction) {
      if (disposed) return;
      const ls = subs.slice();
      for (let i = ls.length - 1; i >= 0; i--) if (ls[i]!(action) === true) return;
      if (isDirection(action)) {
        direction(action, false);
      } else if (action === MenuAction.CONFIRM) {
        setRing(true);
        ensureCurrent();
        const cur = current;
        if (!cur) return;
        if (isTextEntry(cur)) {
          try {
            cur.focus();
          } catch {
            /* not focusable */
          }
        } else {
          cur.click();
        }
      } else if (action === MenuAction.TAB_PREV || action === MenuAction.TAB_NEXT) {
        setRing(true);
        ensureCurrent();
        switchTab(action === MenuAction.TAB_NEXT ? 1 : -1);
      } else if (action === MenuAction.BACK) {
        onBack?.();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      holdDir = -1;
      win?.removeEventListener('pointerdown', onPointer, true);
      win?.removeEventListener('focusin', onFocusIn, true);
      observer?.disconnect();
      observer = null;
      observed = null;
      setCurrent(null);
      roots.length = 0;
      remembered.length = 0;
      subs.length = 0;
      setRing(false);
    },
  };
  return api;
}
