/**
 * [PLT-01] Service worker registration and the update flow (brief section 3: install, offline, secure context).
 *
 * - Registers ./sw.js (scope ./, updateViaCache 'none') only in a secure context (HTTPS or localhost), never in the
 *   Vite dev server and never as a requirement: sw.js is fetched first (swScriptAvailable) and, when it is missing
 *   (index.html deployed alone) or offline, registration is skipped quietly (no browser console error), logged to
 *   diagnostics, and the game runs on. An already installed worker keeps serving offline either way.
 * - Update flow: when a new worker has installed while an older one controls the page (a new build was deployed),
 *   a toast "Update available" with a Reload button appears. Accepting posts SKIP_WAITING to the waiting worker;
 *   when it takes control (controllerchange) the page reloads once. Declining keeps the old version until the next
 *   launch. The very first install (no controller yet) shows nothing.
 * - The page checks for a new sw.js when it becomes visible again (iPad apps stay open for days), at most once per
 *   LOCAL_TUNING.updateCheckMs.
 * - window.__dotkickPwa (tests, diagnostics): the registration, update state and checkForUpdate().
 */
import type { Diagnostics } from '../contracts/app';
import { showToast } from '../ui/components';

const LOCAL_TUNING = { // TUNING-CR (platform, not gameplay)
  /** Shortest time between two update checks triggered by the page becoming visible, ms. */
  updateCheckMs: 60_000,
  /** The update toast stays this long unless accepted (it is also re-offered on the next check), ms. */
  updateToastMs: 10 * 60_000,
} as const;

export interface RegisterOptions {
  /** Script URL relative to the page. */
  url?: string;
  diagnostics?: Diagnostics;
  /** Called when an update is waiting; default shows the toast. `accept` activates it and reloads. */
  onUpdateAvailable?(accept: () => void): void;
}

/** Minimal worker / registration / container shapes (Node tests pass fakes). */
export interface WorkerLike extends EventTarget {
  readonly state: string;
  postMessage(msg: unknown): void;
}
export interface RegistrationLike extends EventTarget {
  readonly installing: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  readonly active: WorkerLike | null;
  update(): Promise<unknown>;
}
export interface ContainerLike extends EventTarget {
  readonly controller: WorkerLike | null;
}

export interface UpdateWatcherDeps {
  container: ContainerLike;
  /** Reload the page (default location.reload). */
  reload(): void;
  /** An update is waiting: show the prompt; call accept to activate it. */
  onUpdateAvailable(accept: () => void): void;
  log?(message: string): void;
}

export interface UpdateWatcher {
  /** True once an update was offered. */
  readonly offered: boolean;
  /** True once the player accepted (SKIP_WAITING sent). */
  readonly accepted: boolean;
  /** Re-check the registration for a waiting worker (after update()). */
  scan(): void;
  dispose(): void;
}

/**
 * Watch a registration for a new worker that finished installing while another controls the page, offer it once per
 * worker, and reload once after the player accepted and the new worker took control.
 */
export function watchForUpdates(reg: RegistrationLike, deps: UpdateWatcherDeps): UpdateWatcher {
  const disposers: (() => void)[] = [];
  const offeredTo: WorkerLike[] = [];
  let offered = false;
  let accepted = false;
  let reloaded = false;
  const watched: WorkerLike[] = [];

  function on(target: EventTarget, type: string, fn: () => void): void {
    target.addEventListener(type, fn);
    disposers.push(() => target.removeEventListener(type, fn));
  }

  function offer(w: WorkerLike): void {
    if (!deps.container.controller) return; // first install: nothing to update
    if (offeredTo.includes(w)) return;
    offeredTo.push(w);
    offered = true;
    deps.log?.('update available');
    deps.onUpdateAvailable(() => {
      accepted = true;
      deps.log?.('update accepted');
      try {
        w.postMessage({ type: 'SKIP_WAITING' });
      } catch {
        /* the worker went away; the next launch picks the update up */
      }
    });
  }

  function watchInstalling(w: WorkerLike | null): void {
    if (!w || watched.includes(w)) return;
    watched.push(w);
    const onState = (): void => {
      if (w.state === 'installed') offer(w);
    };
    on(w, 'statechange', onState);
    if (w.state === 'installed') offer(w);
  }

  function scan(): void {
    if (reg.waiting) offer(reg.waiting);
    watchInstalling(reg.installing);
  }

  on(reg, 'updatefound', () => watchInstalling(reg.installing));
  on(deps.container, 'controllerchange', () => {
    if (!accepted || reloaded) return;
    reloaded = true;
    deps.log?.('new version active: reloading');
    deps.reload();
  });
  scan();

  return {
    get offered() { return offered; },
    get accepted() { return accepted; },
    scan,
    dispose() {
      for (const d of disposers.splice(0)) d();
    },
  };
}

/** True when a service worker may be registered in this context. */
export function canRegisterServiceWorker(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (import.meta.env?.DEV) return false;
  if (!window.isSecureContext) return false;
  if (!('serviceWorker' in navigator)) return false;
  return location.protocol === 'https:' || location.protocol === 'http:';
}

/** The default prompt: a toast with a Reload button (stays until accepted or LOCAL_TUNING.updateToastMs). */
export function showUpdateToast(accept: () => void): HTMLElement {
  const toast = showToast('Update available', { kind: 'info', testId: 'pwa-update', lifeMs: LOCAL_TUNING.updateToastMs });
  toast.style.pointerEvents = 'auto';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Reload';
  btn.setAttribute('data-testid', 'pwa-update-reload');
  btn.style.cssText = 'min-height:44px;min-width:96px;margin-left:8px;border-radius:999px;border:0;padding:0 18px;' +
    'background:var(--ember,#ff6b35);color:#12080a;font:600 15px var(--font-ui,system-ui);pointer-events:auto;';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Updating...';
    accept();
  });
  toast.append(btn);
  return toast;
}

declare global {
  interface Window {
    /** PWA state for tests and diagnostics. */
    __dotkickPwa?: { registration: ServiceWorkerRegistration; readonly updateOffered: boolean; checkForUpdate(): Promise<void> };
  }
}

/**
 * True when the worker script is really there: a 2xx JavaScript response. index.html deployed alone (or a host that
 * answers missing files with an HTML page) then skips registration quietly instead of making the browser log a
 * failed script fetch. Never throws.
 */
export async function swScriptAvailable(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(url, { cache: 'no-store', credentials: 'same-origin' });
    const type = res.headers.get('content-type') ?? '';
    return res.ok && /javascript|ecmascript/i.test(type);
  } catch {
    return false;
  }
}

export async function registerServiceWorker(opts: RegisterOptions = {}): Promise<ServiceWorkerRegistration | null> {
  if (!canRegisterServiceWorker()) return null;
  const log = (m: string, data?: unknown): void => opts.diagnostics?.log('pwa', m, data);
  const url = opts.url ?? './sw.js';
  if (!(await swScriptAvailable(url))) {
    log('service worker not registered: sw.js is not beside index.html (or offline); the game runs without it');
    return null;
  }
  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register(url, { scope: './', updateViaCache: 'none' });
    log('service worker registered');
  } catch (err) {
    log('service worker not registered', String(err));
    return null;
  }
  try {
    const watcher = watchForUpdates(reg as unknown as RegistrationLike, {
      container: navigator.serviceWorker as unknown as ContainerLike,
      reload: () => location.reload(),
      onUpdateAvailable: opts.onUpdateAvailable ?? ((accept) => { showUpdateToast(accept); }),
      log: (m) => log(m),
    });
    let lastCheck = typeof performance !== 'undefined' ? performance.now() : 0;
    const checkForUpdate = async (): Promise<void> => {
      lastCheck = performance.now();
      try {
        await reg.update();
      } catch (err) {
        log('update check failed', String(err));
      }
      watcher.scan();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (performance.now() - lastCheck < LOCAL_TUNING.updateCheckMs) return;
      void checkForUpdate();
    });
    window.__dotkickPwa = { registration: reg, get updateOffered() { return watcher.offered; }, checkForUpdate };
    void navigator.serviceWorker.ready.then(() => log('offline copy ready'), () => undefined);
  } catch (err) {
    log('update flow unavailable', String(err));
  }
  return reg;
}
