/**
 * [PLT-02] iPadOS / Safari hardening (Wave 0 version by FND-04).
 *
 * - Blocks browser gestures on the game surface: pinch (gesturestart/change/end), double-tap zoom (dblclick),
 *   context menu and long-press callout, text selection, rubber-band scroll (touchmove outside [data-scroll]),
 *   ctrl+wheel zoom on desktop trackpads.
 * - Detects portrait orientation and windows below the minimum playable size, toggles `is-portrait` /
 *   `too-small` classes on <body> (index.html shows the rotate card) and reports changes through callbacks so the
 *   app pauses.
 * - Low Power Mode hint hook: reportFrame() detects a steady ~30 fps with idle frame time and fires
 *   onLowPowerSuspected once.
 */

export const MIN_PLAY_WIDTH = 560;
export const MIN_PLAY_HEIGHT = 320;

export interface ViewportClass {
  portrait: boolean;
  tooSmall: boolean;
}

/** Pure viewport classification. Portrait = taller than wide. */
export function classifyViewport(width: number, height: number, minW = MIN_PLAY_WIDTH, minH = MIN_PLAY_HEIGHT): ViewportClass {
  const portrait = height > width;
  const tooSmall = !portrait && (width < minW || height < minH);
  return { portrait, tooSmall };
}

export interface IpadHardeningOptions {
  minWidth?: number;
  minHeight?: number;
  onPortraitChange?(portrait: boolean): void;
  onTooSmallChange?(tooSmall: boolean): void;
  /** Steady 30 fps with idle frames seen (Low Power Mode likely). Fires at most once. */
  onLowPowerSuspected?(): void;
}

export interface IpadHardening {
  readonly portrait: boolean;
  readonly tooSmall: boolean;
  /** Re-evaluate orientation and size (call on resize / orientationchange). */
  check(): void;
  /** Feed per-frame timing during play: real frame interval and busy (sim + render) ms. Allocation-free. */
  reportFrame(frameMs: number, busyMs: number): void;
  dispose(): void;
}

/** Frames of steady 30 fps with idle time needed before the Low Power Mode hint (about 4 s). */
const LOW_POWER_FRAMES = 120;

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, [contenteditable="true"]') !== null;
}

function inScrollable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('[data-scroll]') !== null;
}

export function installIpadHardening(opts: IpadHardeningOptions = {}): IpadHardening {
  const minW = opts.minWidth ?? MIN_PLAY_WIDTH;
  const minH = opts.minHeight ?? MIN_PLAY_HEIGHT;
  let portrait = false;
  let tooSmall = false;
  let lowPowerRun = 0;
  let lowPowerFired = false;
  const disposers: (() => void)[] = [];

  const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';

  function on<K extends string>(target: EventTarget, type: K, fn: (e: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, options);
    disposers.push(() => target.removeEventListener(type, fn, options));
  }

  const prevent = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };

  function check(): void {
    if (!hasDom) return;
    const c = classifyViewport(window.innerWidth, window.innerHeight, minW, minH);
    document.body.classList.toggle('is-portrait', c.portrait);
    document.body.classList.toggle('too-small', c.tooSmall);
    if (c.portrait !== portrait) {
      portrait = c.portrait;
      opts.onPortraitChange?.(portrait);
    }
    if (c.tooSmall !== tooSmall) {
      tooSmall = c.tooSmall;
      opts.onTooSmallChange?.(tooSmall);
    }
  }

  if (hasDom) {
    for (const g of ['gesturestart', 'gesturechange', 'gestureend']) on(document, g, prevent, { passive: false });
    on(document, 'dblclick', prevent, { passive: false });
    on(document, 'contextmenu', (e) => { if (!isEditable(e.target)) prevent(e); }, { passive: false });
    on(document, 'selectstart', (e) => { if (!isEditable(e.target)) prevent(e); }, { passive: false });
    on(document, 'touchmove', (e) => { if (!inScrollable(e.target)) prevent(e); }, { passive: false });
    on(window, 'wheel', (e) => { if ((e as WheelEvent).ctrlKey) prevent(e); }, { passive: false });
    on(window, 'resize', check);
    on(window, 'orientationchange', check);
    check();
  }

  return {
    get portrait() { return portrait; },
    get tooSmall() { return tooSmall; },
    check,
    reportFrame(frameMs, busyMs) {
      if (lowPowerFired) return;
      if (frameMs > 30 && frameMs < 36 && busyMs < 8) {
        lowPowerRun++;
        if (lowPowerRun >= LOW_POWER_FRAMES) {
          lowPowerFired = true;
          opts.onLowPowerSuspected?.();
        }
      } else {
        lowPowerRun = 0;
      }
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
    },
  };
}
