/**
 * [PLT-02] iPadOS / Safari hardening (brief section 3: viewport, browser gestures off, touch lifecycle, windowing,
 * Low Power Mode, full screen).
 *
 * Browser gestures (the CSS half lives in index.html critical CSS and platform/viewport.css):
 * - pinch: gesturestart / gesturechange / gestureend (WebKit, which ignores user-scalable=no), ctrl+wheel (desktop
 *   trackpad pinch) and multi-finger touchmove are cancelled; double-tap zoom: dblclick is cancelled, and a second
 *   single-finger touchend within DOUBLE_TAP_MS and DOUBLE_TAP_PX of the first is cancelled unless it lands on a
 *   control (buttons, inputs, [data-focus], [data-dbltap-ok]: their click must survive; CSS touch-action covers them);
 * - context menu, long-press callout, text selection and image / link dragging are cancelled outside editable fields;
 * - rubber-band scroll: touchmove is cancelled outside [data-scroll] containers; a page that scrolled anyway (focus,
 *   keyboard) is scrolled back to 0,0 so the fixed full-viewport layout never shifts.
 *
 * Viewport watcher: on resize, orientationchange, visualViewport resize / scroll and fullscreenchange:
 * - portrait (exactly the CSS `(orientation: portrait)` rule, square included) and windows below the minimum playable
 *   size (MIN_PLAY_WIDTH x MIN_PLAY_HEIGHT CSS px) toggle `is-portrait` / `too-small` on <body> (index.html shows the
 *   rotate / "make the window larger" card) and are reported through onPortraitChange / onTooSmallChange; the app
 *   pauses (session.setBlocked) and resumes only by the player (the pause menu stays after the card goes away);
 * - every viewport change calls onViewportChange (the app releases held inputs: a resize or rotation mid-hold must
 *   never leave a stuck stick or sprint);
 * - CSS variables on <html>: --app-width / --app-height (visual viewport, so the layout survives the Safari toolbar
 *   showing and hiding) and body[data-aspect] = narrow (< 4:3) | ok | wide (> 21:9) for layouts that adapt.
 *
 * Full screen: fullscreen* helpers (Fullscreen API with the webkit prefix) on the document element; offered only in a
 * Safari tab where the API exists, never in the standalone Home Screen app (already full screen).
 *
 * Low Power Mode: one hint path only. GFX-02's detector (render/quality.ts onLowPowerSuspected: steady ~33 ms frames
 * with idle work and the resolution already at its floor, once per page, never once settings.lowPowerHintShown is
 * set) drives it; this module shows the one-time toast and calls onLowPowerSuspected (the app logs it and sets
 * settings.lowPowerHintShown, so the hint never shows again). reportFrame() is kept for API compatibility and does
 * nothing (the earlier detector here was removed so there is exactly one).
 */
import { onLowPowerSuspected as gfxLowPowerSuspected } from '../render/quality';
import { showToast } from '../ui/components';

export const MIN_PLAY_WIDTH = 560;
export const MIN_PLAY_HEIGHT = 320;
/** Aspect range the layout and camera are designed for (brief section 3: 4:3 to 21:9). */
export const MIN_ASPECT = 4 / 3;
export const MAX_ASPECT = 21 / 9;
/** A second tap within this time and distance of the first is a double tap (zoom), ms / CSS px. */
export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 40;

export const LOW_POWER_HINT =
  'Low Power Mode seems to be on, so Safari runs the game at 30 fps. Turn it off in Settings > Battery for smoother play.';

export interface ViewportClass {
  portrait: boolean;
  tooSmall: boolean;
}

export type AspectBand = 'narrow' | 'ok' | 'wide';

/**
 * Pure viewport classification. Portrait follows CSS `(orientation: portrait)`: height >= width, so an exactly
 * square window (Stage Manager can make one) is portrait for both the CSS rotate card in index.html and the pause
 * logic. `portrait` may be passed in (the live media query result) so JS and CSS can never disagree.
 */
export function classifyViewport(
  width: number,
  height: number,
  minW = MIN_PLAY_WIDTH,
  minH = MIN_PLAY_HEIGHT,
  portrait: boolean = height >= width,
): ViewportClass {
  const tooSmall = !portrait && (width < minW || height < minH);
  return { portrait, tooSmall };
}

/** Aspect band of a landscape window (4:3 .. 21:9 is 'ok'). Pure. */
export function aspectBand(width: number, height: number): AspectBand {
  if (!(width > 0) || !(height > 0)) return 'ok';
  const a = width / height;
  if (a < MIN_ASPECT - 0.01) return 'narrow';
  if (a > MAX_ASPECT + 0.01) return 'wide';
  return 'ok';
}

export interface TapSample { t: number; x: number; y: number }

/**
 * Pure double-tap test for the touchend fallback: true when `curr` follows `prev` within DOUBLE_TAP_MS and
 * DOUBLE_TAP_PX.
 */
export function isDoubleTap(prev: TapSample | null, curr: TapSample, ms = DOUBLE_TAP_MS, px = DOUBLE_TAP_PX): boolean {
  if (!prev) return false;
  const dt = curr.t - prev.t;
  if (dt < 0 || dt > ms) return false;
  const dx = curr.x - prev.x;
  const dy = curr.y - prev.y;
  return dx * dx + dy * dy <= px * px;
}

export interface IpadHardeningOptions {
  minWidth?: number;
  minHeight?: number;
  onPortraitChange?(portrait: boolean): void;
  onTooSmallChange?(tooSmall: boolean): void;
  /** Any viewport change (resize, rotation, visual viewport, full screen): release held inputs. */
  onViewportChange?(): void;
  /** GFX-02's detector fired (Low Power Mode likely). Fires at most once; the toast is already shown. */
  onLowPowerSuspected?(): void;
  /** Subscribe to the Low Power Mode detector; default GFX-02's render/quality.ts onLowPowerSuspected. */
  lowPowerSource?: ((fn: () => void) => () => void) | null;
  /** Show the one-time toast (default true). */
  showLowPowerToast?: boolean;
}

export interface IpadHardening {
  readonly portrait: boolean;
  readonly tooSmall: boolean;
  /** Re-evaluate orientation and size (call on resize / orientationchange). */
  check(): void;
  /**
   * Kept for compatibility: the Low Power Mode detector is GFX-02's (render/quality.ts). Does nothing.
   * @deprecated
   */
  reportFrame(frameMs: number, busyMs: number): void;
  /** True once the Low Power Mode hint was shown in this page. */
  readonly lowPowerHinted: boolean;
  dispose(): void;
}

function closestOf(t: EventTarget | null, selector: string): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(selector) !== null;
}

const EDITABLE = 'input, textarea, select, [contenteditable="true"]';
const CONTROL = 'button, input, textarea, select, label, a[href], [role="button"], [data-focus], [data-dbltap-ok]';

// ============================================================ full screen

type FsDoc = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/** True in the Home Screen app (standalone / fullscreen display mode, or navigator.standalone). */
export function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false;
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  try {
    return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches;
  } catch {
    return false;
  }
}

/** True when a full-screen button should be offered: the API exists and this is a browser tab (not standalone). */
export function fullscreenAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  const d = document as FsDoc;
  const el = document.documentElement as FsEl;
  const api = (d.fullscreenEnabled === true && typeof el.requestFullscreen === 'function') ||
    (d.webkitFullscreenEnabled === true && typeof el.webkitRequestFullscreen === 'function');
  return api && !isStandaloneApp();
}

export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  const d = document as FsDoc;
  return (d.fullscreenElement ?? d.webkitFullscreenElement ?? null) !== null;
}

/** Enter full screen on the document element. Resolves true on success; never throws. Call from a user gesture. */
export async function enterFullscreen(el?: HTMLElement): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const target = (el ?? document.documentElement) as FsEl;
  try {
    if (typeof target.requestFullscreen === 'function') await target.requestFullscreen({ navigationUI: 'hide' });
    else if (typeof target.webkitRequestFullscreen === 'function') await target.webkitRequestFullscreen();
    else return false;
    return isFullscreen();
  } catch {
    return false;
  }
}

export async function exitFullscreen(): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const d = document as FsDoc;
  try {
    if (!isFullscreen()) return true;
    if (typeof d.exitFullscreen === 'function') await d.exitFullscreen();
    else if (typeof d.webkitExitFullscreen === 'function') await d.webkitExitFullscreen();
    return !isFullscreen();
  } catch {
    return false;
  }
}

/** Toggle full screen; resolves to the new state. */
export async function toggleFullscreen(): Promise<boolean> {
  if (isFullscreen()) {
    await exitFullscreen();
  } else {
    await enterFullscreen();
  }
  return isFullscreen();
}

/** Subscribe to full-screen changes (prefixed and unprefixed). Returns unsubscribe. */
export function onFullscreenChange(fn: (active: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const h = (): void => fn(isFullscreen());
  document.addEventListener('fullscreenchange', h);
  document.addEventListener('webkitfullscreenchange', h);
  return () => {
    document.removeEventListener('fullscreenchange', h);
    document.removeEventListener('webkitfullscreenchange', h);
  };
}

// ============================================================ install

let current: IpadHardening | null = null;

/** The installed hardening (screens read portrait / tooSmall), or null. */
export function currentIpadHardening(): IpadHardening | null {
  return current;
}

export function installIpadHardening(opts: IpadHardeningOptions = {}): IpadHardening {
  const minW = opts.minWidth ?? MIN_PLAY_WIDTH;
  const minH = opts.minHeight ?? MIN_PLAY_HEIGHT;
  let portrait = false;
  let tooSmall = false;
  let lowPowerHinted = false;
  let lastTap: TapSample | null = null;
  let lastW = -1;
  let lastH = -1;
  let lastVw = -1;
  let lastVh = -1;
  const disposers: (() => void)[] = [];

  const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';
  /** The same query index.html uses for the CSS-only rotate card; created once. */
  let portraitQuery: MediaQueryList | null = null;
  if (hasDom && typeof window.matchMedia === 'function') {
    try {
      portraitQuery = window.matchMedia('(orientation: portrait)');
    } catch {
      portraitQuery = null;
    }
  }

  function on(target: EventTarget, type: string, fn: (e: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, options);
    disposers.push(() => target.removeEventListener(type, fn, options));
  }

  const prevent = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };

  function check(): void {
    if (!hasDom) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const c = classifyViewport(w, h, minW, minH, portraitQuery ? portraitQuery.matches : h >= w);
    const body = document.body;
    if (body) {
      body.classList.toggle('is-portrait', c.portrait);
      body.classList.toggle('too-small', c.tooSmall);
      const band = aspectBand(w, h);
      if (body.dataset.aspect !== band) body.dataset.aspect = band;
    }
    const vv = window.visualViewport;
    const vw = Math.round(vv ? vv.width : w);
    const vh = Math.round(vv ? vv.height : h);
    if (vw !== lastVw || vh !== lastVh) {
      lastVw = vw;
      lastVh = vh;
      const root = document.documentElement.style;
      root.setProperty('--app-width', `${vw}px`);
      root.setProperty('--app-height', `${vh}px`);
    }
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    const sizeChanged = w !== lastW || h !== lastH;
    lastW = w;
    lastH = h;
    if (c.portrait !== portrait) {
      portrait = c.portrait;
      opts.onPortraitChange?.(portrait);
    }
    if (c.tooSmall !== tooSmall) {
      tooSmall = c.tooSmall;
      opts.onTooSmallChange?.(tooSmall);
    }
    if (sizeChanged) opts.onViewportChange?.();
  }

  if (hasDom) {
    const passiveFalse: AddEventListenerOptions = { passive: false };
    for (const g of ['gesturestart', 'gesturechange', 'gestureend']) on(document, g, prevent, passiveFalse);
    on(document, 'dblclick', prevent, passiveFalse);
    on(document, 'contextmenu', (e) => { if (!closestOf(e.target, EDITABLE)) prevent(e); }, passiveFalse);
    on(document, 'selectstart', (e) => { if (!closestOf(e.target, EDITABLE)) prevent(e); }, passiveFalse);
    on(document, 'dragstart', (e) => { if (!closestOf(e.target, EDITABLE)) prevent(e); }, passiveFalse);
    on(document, 'touchmove', (e) => {
      const te = e as TouchEvent;
      // Two fingers anywhere is a pinch; one finger outside a scroll container is a rubber-band scroll.
      if ((te.touches && te.touches.length > 1) || !closestOf(e.target, '[data-scroll]')) prevent(e);
    }, passiveFalse);
    on(document, 'touchend', (e) => {
      const te = e as TouchEvent;
      const t = te.changedTouches?.[0];
      if (!t || (te.touches && te.touches.length > 0)) {
        lastTap = null;
        return;
      }
      const sample: TapSample = { t: e.timeStamp, x: t.clientX, y: t.clientY };
      if (isDoubleTap(lastTap, sample) && !closestOf(e.target, CONTROL)) {
        prevent(e);
        lastTap = null;
        return;
      }
      lastTap = sample;
    }, passiveFalse);
    on(window, 'wheel', (e) => { if ((e as WheelEvent).ctrlKey) prevent(e); }, passiveFalse);
    on(window, 'resize', check);
    on(window, 'orientationchange', check);
    on(window, 'scroll', () => { if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0); });
    const vv = window.visualViewport;
    if (vv) {
      on(vv, 'resize', check);
      on(vv, 'scroll', check);
    }
    disposers.push(onFullscreenChange(() => check()));
    if (portraitQuery) {
      const mq = portraitQuery;
      const onMq = (): void => check();
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', onMq);
        disposers.push(() => mq.removeEventListener('change', onMq));
      }
    }
    check();
  }

  // Low Power Mode hint: GFX-02's detector is the one source.
  const source = opts.lowPowerSource === undefined ? gfxLowPowerSuspected : opts.lowPowerSource;
  if (source) {
    disposers.push(source(() => {
      if (lowPowerHinted) return;
      lowPowerHinted = true;
      if (opts.showLowPowerToast !== false && hasDom) {
        try {
          showToast(LOW_POWER_HINT, { kind: 'warning', testId: 'low-power-hint', lifeMs: 9000 });
        } catch {
          /* the hint is optional */
        }
      }
      opts.onLowPowerSuspected?.();
    }));
  }

  const api: IpadHardening = {
    get portrait() { return portrait; },
    get tooSmall() { return tooSmall; },
    get lowPowerHinted() { return lowPowerHinted; },
    check,
    reportFrame() {
      /* GFX-02 owns the Low Power Mode detector */
    },
    dispose() {
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch {
          /* keep disposing */
        }
      }
      if (current === api) current = null;
    },
  };
  current = api;
  return api;
}
