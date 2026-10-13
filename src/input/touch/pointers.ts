/**
 * [TCH-01] Pointer manager (section 3 "Touch lifecycle", section 9 "Layout" and "Touch quality bar"):
 *  - Pointer Events with pointer capture; each pointer is routed ONCE, on pointerdown, to the first TouchControl
 *    (contracts/touch.ts) whose hit() claims it (controls are given in priority order: buttons, stick zone (left
 *    half), pitch gestures (everywhere else)), and stays with that control until it lifts, so stick, buttons and
 *    gestures never steal each other's touches, a thumb that slides off a held button keeps the hold, and a swipe
 *    that starts on a button is never read as a pitch gesture. Up to MAX_POINTERS simultaneous pointers (five-finger
 *    play works); per-pointer bookkeeping lives in a fixed-size table (no allocation per event).
 *  - pointercancel and lostpointercapture release that pointer's control only (without an action). Window blur,
 *    visibilitychange to hidden, pagehide, orientation change and a viewport resize release EVERY control
 *    (control.releaseAll): iPadOS multitasking gestures cancel touches mid-hold, and a stuck sprint or stick
 *    afterwards is a bug. Safety net: when a touchend / touchcancel reports no finger left on the screen, any touch
 *    pointer still tracked after that event batch (its pointerup / pointercancel never arrived) is cancelled.
 *  - Mouse (and pen) buttons other than the primary one are ignored; a mouse whose primary button is released while
 *    another button is still down (no pointerup yet) is treated as lifted.
 *  - Default actions are prevented on the game surface: no scroll, rubber band, pinch / double-tap zoom, selection,
 *    drag, callout or long-press menu (touch-action: none in overlay.css is the first line; these are the second).
 *  - onChange() runs synchronously after every routed event so the overlay shows the pressed state within the
 *    same frame as the touch-down.
 * Coordinates are CSS px relative to the viewport (clientX / clientY).
 *
 * Two layers: createPointerRouter() is the pure routing core (no DOM; unit-tested in Node with synthetic pointer
 * sequences), createPointerManager() binds it to the DOM (listeners, capture, lifecycle, default prevention).
 * The controls array must keep its order for the manager's lifetime (owner indices refer to it); each pointer keeps
 * a direct reference to the control it was routed to.
 */

import type { TouchControl } from '../../contracts/touch';

/** Simultaneous pointers tracked (iPad reports up to 11 fingers; five-finger play needs 5). */
export const MAX_POINTERS = 10;

/** Pointer kind per table slot, from PointerEvent.pointerType. */
export const PointerKind = {
  TOUCH: 0,
  PEN: 1,
  MOUSE: 2,
} as const;
export type PointerKind = (typeof PointerKind)[keyof typeof PointerKind];

/** PointerEvent.pointerType -> PointerKind ('touch' and unknown / empty types count as touch). Pure. */
export function pointerKindOf(pointerType: string): PointerKind {
  if (pointerType === 'mouse') return PointerKind.MOUSE;
  if (pointerType === 'pen') return PointerKind.PEN;
  return PointerKind.TOUCH;
}

// ============================================================ pure routing core

/**
 * Pure routing core: a fixed table of MAX_POINTERS slots mapping pointer ids to the control that claimed them at
 * down. No DOM, no clock (times are passed in), no allocation per call. Every method that frees a slot does so
 * BEFORE calling into the control, so a control that re-entrantly calls releaseAll() (e.g. PAUSE on up) never sees
 * a pointer twice.
 */
export interface PointerRouter {
  /** Controls in priority order (the array given at creation). */
  readonly controls: readonly TouchControl[];
  /** Pointers currently owned by a control. */
  readonly active: number;
  /** Sequence number of the most recent routed down (increments per routed pointer, starts at 0). */
  readonly seq: number;
  /**
   * New pointer: the first control whose hit(x, y) is true owns it until up / cancel / releaseAll. A pointer id
   * that is still tracked (its up was lost and the browser reused the id) cancels the stale entry first.
   * Returns the owner's index in `controls`, or -1 (no control claimed it, or the table is full).
   */
  down(id: number, x: number, y: number, tMs: number, kind?: PointerKind): number;
  /** Forward a move to the pointer's owner. False when the pointer is not tracked. */
  move(id: number, x: number, y: number, tMs: number): boolean;
  /** Lift: frees the slot, then calls owner.up. False when the pointer is not tracked. */
  up(id: number, x: number, y: number, tMs: number): boolean;
  /** Cancel (release without action): frees the slot, then calls owner.cancel. False when not tracked. */
  cancel(id: number, tMs: number): boolean;
  /** Cancel every tracked pointer of `kind` whose down sequence is <= maxSeq. Returns how many were cancelled. */
  cancelKind(kind: PointerKind, tMs: number, maxSeq?: number): number;
  /**
   * Cancel every tracked pointer (owner.cancel), then call releaseAll(tMs) on EVERY control. The table is cleared
   * before any control runs; if a control throws, the others are still released and the first error is rethrown.
   * Returns how many pointers were tracked.
   */
  releaseAll(tMs: number): number;
  /** Index in `controls` of the pointer's owner, -1 when not tracked. */
  ownerOf(id: number): number;
  /** Slot inspection (0 <= slot < MAX_POINTERS). */
  usedAt(slot: number): boolean;
  idAt(slot: number): number;
  kindAt(slot: number): PointerKind;
  /** Tracked pointers of a kind. */
  countKind(kind: PointerKind): number;
}

export function createPointerRouter(controls: readonly TouchControl[]): PointerRouter {
  const used = new Uint8Array(MAX_POINTERS);
  const ids = new Float64Array(MAX_POINTERS);
  const kinds = new Uint8Array(MAX_POINTERS);
  const seqs = new Float64Array(MAX_POINTERS);
  const ownerIdx = new Int32Array(MAX_POINTERS).fill(-1);
  const ownerCtl = new Array<TouchControl | null>(MAX_POINTERS).fill(null);
  // releaseAll scratch (the table is cleared before any control is called).
  const relIds = new Float64Array(MAX_POINTERS);
  const relCtl = new Array<TouchControl | null>(MAX_POINTERS).fill(null);
  let active = 0;
  let seq = 0;
  let releasing = false;

  function slotOf(id: number): number {
    for (let i = 0; i < MAX_POINTERS; i++) if (used[i] === 1 && ids[i] === id) return i;
    return -1;
  }
  function freeSlot(): number {
    for (let i = 0; i < MAX_POINTERS; i++) if (used[i] === 0) return i;
    return -1;
  }
  /** Clear a slot; returns its owner. */
  function release(slot: number): TouchControl {
    const c = ownerCtl[slot]!;
    used[slot] = 0;
    ownerCtl[slot] = null;
    ownerIdx[slot] = -1;
    active--;
    return c;
  }

  return {
    controls,
    get active() { return active; },
    get seq() { return seq; },
    down(id, x, y, tMs, kind = PointerKind.TOUCH) {
      const stale = slotOf(id);
      if (stale >= 0) release(stale).cancel(id, tMs);
      const slot = freeSlot();
      if (slot < 0) return -1;
      for (let c = 0; c < controls.length; c++) {
        const ctl = controls[c]!;
        if (!ctl.hit(x, y)) continue;
        used[slot] = 1;
        ids[slot] = id;
        kinds[slot] = kind;
        seqs[slot] = ++seq;
        ownerIdx[slot] = c;
        ownerCtl[slot] = ctl;
        active++;
        ctl.down(id, x, y, tMs);
        return c;
      }
      return -1;
    },
    move(id, x, y, tMs) {
      const slot = slotOf(id);
      if (slot < 0) return false;
      ownerCtl[slot]!.move(id, x, y, tMs);
      return true;
    },
    up(id, x, y, tMs) {
      const slot = slotOf(id);
      if (slot < 0) return false;
      release(slot).up(id, x, y, tMs);
      return true;
    },
    cancel(id, tMs) {
      const slot = slotOf(id);
      if (slot < 0) return false;
      release(slot).cancel(id, tMs);
      return true;
    },
    cancelKind(kind, tMs, maxSeq = Infinity) {
      let n = 0;
      for (let i = 0; i < MAX_POINTERS; i++) {
        if (used[i] === 0 || kinds[i] !== kind || seqs[i]! > maxSeq) continue;
        const id = ids[i]!;
        n++;
        release(i).cancel(id, tMs);
      }
      return n;
    },
    releaseAll(tMs) {
      if (releasing) return 0;
      releasing = true;
      let n = 0;
      let failed = false;
      let err: unknown = null;
      try {
        for (let i = 0; i < MAX_POINTERS; i++) {
          if (used[i] === 0) continue;
          relIds[n] = ids[i]!;
          relCtl[n] = release(i);
          n++;
        }
        for (let k = 0; k < n; k++) {
          const c = relCtl[k]!;
          relCtl[k] = null;
          try { c.cancel(relIds[k]!, tMs); } catch (e) { if (!failed) { failed = true; err = e; } }
        }
        for (let c = 0; c < controls.length; c++) {
          try { controls[c]!.releaseAll(tMs); } catch (e) { if (!failed) { failed = true; err = e; } }
        }
      } finally {
        releasing = false;
      }
      if (failed) throw err;
      return n;
    },
    ownerOf(id) {
      const slot = slotOf(id);
      return slot < 0 ? -1 : ownerIdx[slot]!;
    },
    usedAt: (slot) => used[slot] === 1,
    idAt: (slot) => ids[slot]!,
    kindAt: (slot) => kinds[slot]! as PointerKind,
    countKind(kind) {
      let n = 0;
      for (let i = 0; i < MAX_POINTERS; i++) if (used[i] === 1 && kinds[i] === kind) n++;
      return n;
    },
  };
}

// ============================================================ DOM binding

export interface PointerManagerOptions {
  /** Element that receives the pointer events (the full-screen touch layer). */
  el: HTMLElement;
  /** Controls in priority order; the first whose hit() returns true owns the pointer until it lifts. */
  controls: readonly TouchControl[];
  /** Called after any routed pointer event (overlay sync). */
  onChange?(): void;
  /**
   * Called after every primary pointerdown on the surface, routed or not, with the owning control's index (-1 =
   * none). Lets the touch source react to "the next screen touch" (e.g. show controls hidden while a pad drove).
   */
  onDown?(x: number, y: number, owner: number): void;
  /** Clock (ms), default performance.now. */
  now?: () => number;
  /** Window / document for blur and visibility (defaults to the globals). */
  win?: Window;
  doc?: Document;
}

export interface PointerManager {
  /** Number of pointers currently owned by a control. */
  readonly active: number;
  /** Cancel every pointer and release every control (pause, possession swap, lifecycle). */
  releaseAll(): void;
  dispose(): void;
  /** Index (in the controls array) of the control that owns a pointer, -1 when the pointer is not tracked. */
  ownerOf(pointerId: number): number;
}

function defaultNow(): number {
  return performance.now();
}

const PASSIVE_FALSE: AddEventListenerOptions = { passive: false };

export function createPointerManager(opts: PointerManagerOptions): PointerManager {
  const el = opts.el;
  const router = createPointerRouter(opts.controls);
  const now = opts.now ?? defaultNow;
  const win = opts.win ?? window;
  const doc = opts.doc ?? document;
  const onChange = opts.onChange;
  const onDownHook = opts.onDown;
  const capIds = new Float64Array(MAX_POINTERS);
  let lastW = win.innerWidth;
  let lastH = win.innerHeight;
  let disposed = false;
  let sweepPending = false;
  let sweepTimer: unknown = null;
  let sweepSeq = 0;

  function changed(): void {
    if (onChange) onChange();
  }
  function capture(id: number): void {
    try { el.setPointerCapture(id); } catch { /* pointer no longer active (or synthetic): routing still works */ }
  }
  function uncapture(id: number): void {
    try { if (el.hasPointerCapture(id)) el.releasePointerCapture(id); } catch { /* already gone */ }
  }
  function clearSweep(): void {
    if (!sweepPending) return;
    sweepPending = false;
    if (typeof win.clearTimeout === 'function') win.clearTimeout(sweepTimer as number);
    else globalThis.clearTimeout(sweepTimer as ReturnType<typeof globalThis.setTimeout>);
  }

  /** Release every held input: cancel each tracked pointer, releaseAll on every control, drop captures. */
  function releaseNow(): void {
    if (disposed) return;
    clearSweep();
    let n = 0;
    for (let i = 0; i < MAX_POINTERS; i++) if (router.usedAt(i)) capIds[n++] = router.idAt(i);
    try {
      router.releaseAll(now());
    } finally {
      for (let k = 0; k < n; k++) uncapture(capIds[k]!);
      changed();
    }
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (e.cancelable) e.preventDefault();
    const kind = pointerKindOf(e.pointerType);
    // Mouse / pen: only the primary button (left click, pen contact) plays.
    if (kind !== PointerKind.TOUCH && e.button !== 0) return;
    const id = e.pointerId, x = e.clientX, y = e.clientY;
    const hadStale = router.ownerOf(id) >= 0;
    const c = router.down(id, x, y, now(), kind);
    // Capture only if the pointer is still ours (a control may have released everything re-entrantly).
    if (c >= 0 && router.ownerOf(id) === c) capture(id);
    if (c >= 0 || hadStale) changed();
    if (onDownHook) onDownHook(x, y, c);
  };
  const onPointerMove = (e: PointerEvent): void => {
    const id = e.pointerId;
    if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
      // Primary released while another mouse button is still down: browsers send no pointerup until all buttons
      // are up, so treat it as the lift here (no hold may outlive the primary button).
      if (router.up(id, e.clientX, e.clientY, now())) {
        uncapture(id);
        changed();
      }
      return;
    }
    if (router.move(id, e.clientX, e.clientY, now())) {
      if (e.cancelable) e.preventDefault();
      changed();
    }
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (router.up(e.pointerId, e.clientX, e.clientY, now())) changed();
  };
  const onPointerCancel = (e: PointerEvent): void => {
    if (router.cancel(e.pointerId, now())) changed();
  };
  const onLostCapture = (e: PointerEvent): void => {
    // lostpointercapture bubbles: only a capture lost by the touch layer itself releases the pointer. After a normal
    // pointerup / pointercancel the slot is already free, so this is a no-op.
    if (e.target !== el) return;
    if (router.cancel(e.pointerId, now())) changed();
  };
  const sweep = (): void => {
    sweepPending = false;
    if (disposed) return;
    if (router.cancelKind(PointerKind.TOUCH, now(), sweepSeq) > 0) changed();
  };
  const onTouchStartMove = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };
  const onTouchEnd = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
    const touches = (e as TouchEvent).touches;
    if (!touches || touches.length !== 0 || router.countKind(PointerKind.TOUCH) === 0) return;
    // No finger is left on the screen. Pointer events for these touches are dispatched before this touch event,
    // so after this event batch every touch pointer that went down before now must be gone: cancel stragglers.
    sweepSeq = router.seq;
    if (sweepPending) return;
    sweepPending = true;
    sweepTimer = typeof win.setTimeout === 'function' ? win.setTimeout(sweep, 0) : globalThis.setTimeout(sweep, 0);
  };
  const prevent = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };
  const onBlur = (e: Event): void => {
    if (e.target === win || e.target === null) releaseNow();
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') releaseNow();
  };
  const onLifecycle = (): void => {
    releaseNow();
  };
  const onResize = (): void => {
    const w = win.innerWidth, h = win.innerHeight;
    // Only a real size change releases (some engines fire resize without one); no size info -> always release.
    if (typeof w === 'number' && w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    releaseNow();
  };
  const orientation = (win.screen as Screen | undefined)?.orientation as EventTarget | undefined;

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerCancel);
  el.addEventListener('lostpointercapture', onLostCapture);
  el.addEventListener('touchstart', onTouchStartMove, PASSIVE_FALSE);
  el.addEventListener('touchmove', onTouchStartMove, PASSIVE_FALSE);
  el.addEventListener('touchend', onTouchEnd, PASSIVE_FALSE);
  el.addEventListener('touchcancel', onTouchEnd, PASSIVE_FALSE);
  el.addEventListener('contextmenu', prevent);
  el.addEventListener('selectstart', prevent);
  el.addEventListener('dragstart', prevent);
  el.addEventListener('dblclick', prevent);
  el.addEventListener('wheel', prevent, PASSIVE_FALSE);
  // WebKit pinch-zoom gesture events (Safari ignores user-scalable=no).
  el.addEventListener('gesturestart', prevent);
  el.addEventListener('gesturechange', prevent);
  el.addEventListener('gestureend', prevent);
  win.addEventListener('blur', onBlur);
  win.addEventListener('pagehide', onLifecycle);
  win.addEventListener('orientationchange', onLifecycle);
  win.addEventListener('resize', onResize);
  orientation?.addEventListener('change', onLifecycle);
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    get active() { return router.active; },
    releaseAll: releaseNow,
    ownerOf: (pointerId) => router.ownerOf(pointerId),
    dispose() {
      if (disposed) return;
      try {
        releaseNow();
      } finally {
        disposed = true;
        clearSweep();
        el.removeEventListener('pointerdown', onPointerDown);
        el.removeEventListener('pointermove', onPointerMove);
        el.removeEventListener('pointerup', onPointerUp);
        el.removeEventListener('pointercancel', onPointerCancel);
        el.removeEventListener('lostpointercapture', onLostCapture);
        el.removeEventListener('touchstart', onTouchStartMove);
        el.removeEventListener('touchmove', onTouchStartMove);
        el.removeEventListener('touchend', onTouchEnd);
        el.removeEventListener('touchcancel', onTouchEnd);
        el.removeEventListener('contextmenu', prevent);
        el.removeEventListener('selectstart', prevent);
        el.removeEventListener('dragstart', prevent);
        el.removeEventListener('dblclick', prevent);
        el.removeEventListener('wheel', prevent);
        el.removeEventListener('gesturestart', prevent);
        el.removeEventListener('gesturechange', prevent);
        el.removeEventListener('gestureend', prevent);
        win.removeEventListener('blur', onBlur);
        win.removeEventListener('pagehide', onLifecycle);
        win.removeEventListener('orientationchange', onLifecycle);
        win.removeEventListener('resize', onResize);
        orientation?.removeEventListener('change', onLifecycle);
        doc.removeEventListener('visibilitychange', onVisibility);
      }
    },
  };
}
