/**
 * [TCH-01] Pointer manager (section 3 "Touch lifecycle", section 9 "Touch quality bar"):
 *  - Pointer Events with pointer capture; each pointer is routed ONCE, on pointerdown, to the first TouchControl
 *    (contracts/touch.ts) whose hit() claims it (controls are given in priority order: buttons, stick zone,
 *    gestures), and stays with that control until it lifts, so stick, buttons and gestures never steal each
 *    other's touches. Up to MAX_POINTERS simultaneous pointers (five-finger play works).
 *  - pointercancel, lostpointercapture, window blur and visibilitychange release every held input (iPadOS
 *    multitasking gestures cancel touches mid-hold; a stuck sprint or stick afterwards is a bug).
 *  - onChange() runs synchronously after every routed event so the overlay shows the pressed state within the
 *    same frame as the touch-down.
 * Coordinates are CSS px relative to the viewport (clientX / clientY).
 *
 * WAVE 0 BASELINE (FND-05). TCH-01 owns and refines it.
 */

import type { TouchControl } from '../../contracts/touch';

export const MAX_POINTERS = 10;

export interface PointerManagerOptions {
  /** Element that receives the pointer events (the full-screen touch layer). */
  el: HTMLElement;
  /** Controls in priority order; the first whose hit() returns true owns the pointer until it lifts. */
  controls: readonly TouchControl[];
  /** Called after any routed pointer event (overlay sync). */
  onChange?(): void;
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
}

export function createPointerManager(opts: PointerManagerOptions): PointerManager {
  const { el, controls } = opts;
  const now = opts.now ?? (() => performance.now());
  const win = opts.win ?? window;
  const doc = opts.doc ?? document;
  const ids = new Int32Array(MAX_POINTERS).fill(-1);
  const owner = new Int8Array(MAX_POINTERS).fill(-1);
  let active = 0;

  const slotOf = (pointerId: number): number => {
    for (let i = 0; i < MAX_POINTERS; i++) if (ids[i] === pointerId) return i;
    return -1;
  };
  const changed = (): void => { opts.onChange?.(); };

  function free(slot: number): void {
    ids[slot] = -1;
    owner[slot] = -1;
    active--;
  }

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (slotOf(e.pointerId) >= 0) return;
    let slot = -1;
    for (let i = 0; i < MAX_POINTERS; i++) if (ids[i] === -1) { slot = i; break; }
    if (slot < 0) return;
    const x = e.clientX, y = e.clientY;
    for (let c = 0; c < controls.length; c++) {
      if (!controls[c]!.hit(x, y)) continue;
      ids[slot] = e.pointerId;
      owner[slot] = c;
      active++;
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      controls[c]!.down(e.pointerId, x, y, now());
      changed();
      return;
    }
  };
  const onMove = (e: PointerEvent): void => {
    const slot = slotOf(e.pointerId);
    if (slot < 0) return;
    e.preventDefault();
    controls[owner[slot]!]!.move(e.pointerId, e.clientX, e.clientY, now());
    changed();
  };
  const onUp = (e: PointerEvent): void => {
    const slot = slotOf(e.pointerId);
    if (slot < 0) return;
    const c = owner[slot]!;
    free(slot);
    controls[c]!.up(e.pointerId, e.clientX, e.clientY, now());
    changed();
  };
  const onCancel = (e: PointerEvent): void => {
    const slot = slotOf(e.pointerId);
    if (slot < 0) return;
    const c = owner[slot]!;
    free(slot);
    controls[c]!.cancel(e.pointerId, now());
    changed();
  };
  const releaseAll = (): void => {
    const t = now();
    for (let i = 0; i < MAX_POINTERS; i++) {
      if (ids[i] === -1) continue;
      const pid = ids[i]!, c = owner[i]!;
      free(i);
      try { if (el.hasPointerCapture(pid)) el.releasePointerCapture(pid); } catch { /* ignore */ }
      controls[c]!.cancel(pid, t);
    }
    for (let c = 0; c < controls.length; c++) controls[c]!.releaseAll(t);
    active = 0;
    changed();
  };
  const onVisibility = (): void => { if (doc.visibilityState === 'hidden') releaseAll(); };
  const prevent = (e: Event): void => { e.preventDefault(); };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('lostpointercapture', onCancel);
  el.addEventListener('contextmenu', prevent);
  el.addEventListener('touchstart', prevent, { passive: false });
  win.addEventListener('blur', releaseAll);
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    get active() { return active; },
    releaseAll,
    dispose() {
      releaseAll();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('lostpointercapture', onCancel);
      el.removeEventListener('contextmenu', prevent);
      el.removeEventListener('touchstart', prevent);
      win.removeEventListener('blur', releaseAll);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
