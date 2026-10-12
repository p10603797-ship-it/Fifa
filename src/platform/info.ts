/**
 * [PLT-02] Platform detection (Wave 0 version by FND-04): iPad (including iPadOS 13+ which reports a desktop Mac
 * user agent with maxTouchPoints > 1), touch support, Home Screen standalone mode, Fullscreen API support and
 * safe-area insets read through a CSS env() probe element.
 */
import type { PlatformInfo } from '../contracts/app';

export interface SafeArea { top: number; right: number; bottom: number; left: number }

export interface PlatformInfoImpl extends PlatformInfo {
  /** Re-read the safe-area insets on the next safeArea() call (resize, orientation change). */
  refreshSafeArea(): void;
  readonly userAgent: string;
}

/** Pure iPad detection. iPadOS 13+ in desktop mode reports "Macintosh" + maxTouchPoints > 1. */
export function detectIpad(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPad/i.test(userAgent)) return true;
  const macLike = /Macintosh|MacIntel/i.test(userAgent) || platform === 'MacIntel';
  return macLike && maxTouchPoints > 1;
}

interface NavigatorExtras {
  standalone?: boolean;
  maxTouchPoints?: number;
  platform?: string;
  userAgent?: string;
}

function readInset(style: CSSStyleDeclaration, prop: string): number {
  const v = parseFloat(style.getPropertyValue(prop));
  return Number.isFinite(v) ? v : 0;
}

/** Build PlatformInfo from the current browser (safe to call in Node: everything defaults to false/0). */
export function createPlatformInfo(): PlatformInfoImpl {
  const w = typeof window !== 'undefined' ? window : undefined;
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as NavigatorExtras;
  const ua = nav.userAgent ?? '';
  const maxTouch = nav.maxTouchPoints ?? 0;
  const isIPad = detectIpad(ua, nav.platform ?? '', maxTouch);
  const isTouch = maxTouch > 0 || (w !== undefined && 'ontouchstart' in w);
  let isStandalone = nav.standalone === true;
  try {
    if (!isStandalone && w?.matchMedia) {
      isStandalone = w.matchMedia('(display-mode: standalone)').matches || w.matchMedia('(display-mode: fullscreen)').matches;
    }
  } catch {
    /* ignore */
  }
  const doc = typeof document !== 'undefined' ? (document as Document & { webkitFullscreenEnabled?: boolean }) : undefined;
  const supportsFullscreen = doc !== undefined && (doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true);

  let probeEl: HTMLDivElement | null = null;
  let cache: SafeArea | null = null;

  function measure(): SafeArea {
    if (doc === undefined || !doc.body || w === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
    if (probeEl === null) {
      probeEl = doc.createElement('div');
      probeEl.setAttribute('aria-hidden', 'true');
      probeEl.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);' +
        'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);';
      doc.body.appendChild(probeEl);
    }
    const cs = w.getComputedStyle(probeEl);
    return {
      top: readInset(cs, 'padding-top'),
      right: readInset(cs, 'padding-right'),
      bottom: readInset(cs, 'padding-bottom'),
      left: readInset(cs, 'padding-left'),
    };
  }

  return {
    isIPad,
    isTouch,
    isStandalone,
    supportsFullscreen,
    userAgent: ua,
    safeArea() {
      if (cache === null) cache = measure();
      return cache;
    },
    refreshSafeArea() {
      cache = null;
    },
  };
}
