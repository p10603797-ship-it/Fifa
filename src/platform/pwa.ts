/**
 * [PLT-01] Service worker registration (Wave 0 version by FND-04).
 *
 * Registers ./sw.js only in a secure context (HTTPS or localhost), never in the Vite dev server and never as a
 * requirement: if sw.js is missing (index.html deployed alone) the failure is logged and the game runs on.
 * PLT-01 adds the offline cache and the update flow.
 */
import type { Diagnostics } from '../contracts/app';

export interface RegisterOptions {
  /** Script URL relative to the page. */
  url?: string;
  diagnostics?: Diagnostics;
}

/** True when a service worker may be registered in this context. */
export function canRegisterServiceWorker(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (import.meta.env?.DEV) return false;
  if (!window.isSecureContext) return false;
  if (!('serviceWorker' in navigator)) return false;
  return location.protocol === 'https:' || location.protocol === 'http:';
}

export async function registerServiceWorker(opts: RegisterOptions = {}): Promise<ServiceWorkerRegistration | null> {
  if (!canRegisterServiceWorker()) return null;
  try {
    const reg = await navigator.serviceWorker.register(opts.url ?? './sw.js', { scope: './' });
    opts.diagnostics?.log('pwa', 'service worker registered');
    return reg;
  } catch (err) {
    opts.diagnostics?.log('pwa', 'service worker not registered', String(err));
    return null;
  }
}
