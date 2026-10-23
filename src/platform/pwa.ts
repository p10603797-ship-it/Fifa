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
 * - [QF-5] The toast never shows during live play (RegisterOptions.isBusy, boot: the match screen while ticking): it
 *   waits for the pause menu or the menus, and steps aside when play resumes, so it never covers the scoreboard and a
 *   stray touch never reloads away a match.
 * - [QF-5] No mixed versions, no false prompts: index.html carries its build id (<meta name="dotkick-build">, written
 *   by tools/postbuild.mjs, the same id as sw.js BUILD). A waiting worker whose build is the page's own (the page came
 *   from the network while the old worker still controlled it) is activated quietly instead of offering the page as
 *   an update of itself; a worker that took control from elsewhere (another tab accepted) with a different build than
 *   the page offers a reload.
 * - [QF-5] Reload always does something: when the offered worker moved on while the toast waited (another tab
 *   activated it, so it already controls this page and no controllerchange will come; or a newer deploy replaced it),
 *   accepting reloads at once, or activates the worker that waits now and reloads on its controllerchange.
 */
import type { Diagnostics } from '../contracts/app';
import { showToast } from '../ui/components';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: platform, PWA)
  /** Shortest time between two update checks triggered by the page becoming visible, ms. */
  updateCheckMs: 60_000,
  /** The update toast stays this long unless accepted (it is also re-offered on the next check), ms. */
  updateToastMs: 10 * 60_000,
  /** A worker that does not answer the STATUS message within this time counts as a different build, ms. */
  statusTimeoutMs: 8000,
  /** How often a waiting update prompt checks whether play stopped (only while an update is pending), ms. */
  promptPollMs: 1000,
} as const;

export interface RegisterOptions {
  /** Script URL relative to the page. */
  url?: string;
  diagnostics?: Diagnostics;
  /** Called when an update is waiting; default shows the toast. `accept` activates it and reloads. */
  onUpdateAvailable?(accept: () => void): void;
  /**
   * [QF-5] True while a match is being played: the default toast waits (and steps aside when play resumes), so it never
   * covers the scoreboard or catches a touch meant for the game, and a stray tap never reloads away a live match.
   */
  isBusy?(): boolean;
}

/** Minimal worker / registration / container shapes (Node tests pass fakes). */
export interface WorkerLike extends EventTarget {
  readonly state: string;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
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
  /** Build id of the running page (index.html meta), or null when unknown (dev build): every new worker is offered. */
  pageBuild?: string | null;
  /** Build id of a worker (its STATUS reply), or null when it does not answer. */
  buildOf?(w: WorkerLike): Promise<string | null>;
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
  let disposed = false;
  const watched: WorkerLike[] = [];

  function on(target: EventTarget, type: string, fn: () => void): void {
    target.addEventListener(type, fn);
    disposers.push(() => target.removeEventListener(type, fn));
  }

  function skipWaiting(w: WorkerLike): void {
    try {
      w.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      /* the worker went away; the next launch picks the update up */
    }
  }

  function reloadOnce(why: string): void {
    if (reloaded) return;
    reloaded = true;
    deps.log?.(why);
    deps.reload();
  }

  function prompt(w: WorkerLike): void {
    offered = true;
    deps.log?.('update available');
    deps.onUpdateAvailable(() => {
      accepted = true;
      deps.log?.('update accepted');
      // [QF-5] The offered worker may have moved on while the prompt waited: another tab accepted it (or activated it
      // quietly as its own build), so it already controls this page and no controllerchange will come; or a newer
      // deploy replaced it (redundant) and its successor waits now. Never a Reload button that does nothing.
      const waiting = reg.waiting;
      const target = w.state === 'installed' ? w : waiting && waiting.state === 'installed' ? waiting : null;
      if (target && deps.container.controller !== target) {
        skipWaiting(target); // the controllerchange reloads
        return;
      }
      if (w.state === 'activating' && deps.container.controller !== w) return; // its claim brings the controllerchange
      reloadOnce('accepted update already active: reloading');
    });
  }

  /** Build of `w` (null: unknown), never rejecting. */
  function buildOf(w: WorkerLike): Promise<string | null> {
    if (!deps.buildOf) return Promise.resolve(null);
    try {
      return deps.buildOf(w).then((b) => (typeof b === 'string' && b ? b : null), () => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function offer(w: WorkerLike): void {
    if (!deps.container.controller) return; // first install: nothing to update
    if (offeredTo.includes(w)) return;
    offeredTo.push(w);
    const page = deps.pageBuild ?? null;
    if (!page || !deps.buildOf) {
      prompt(w);
      return;
    }
    void buildOf(w).then((b) => {
      if (disposed) return;
      if (b === page) {
        // The page already runs this build (it came from the network while the old worker controlled it): let the
        // matching worker take over quietly. No prompt, no reload.
        deps.log?.(`waiting worker is this page's build ${b}: activated without a prompt`);
        skipWaiting(w);
      } else {
        prompt(w);
      }
    });
  }

  /** A worker took control without this page accepting (first install claim, another tab's Reload). */
  function onForeignController(): void {
    const c = deps.container.controller;
    const page = deps.pageBuild ?? null;
    if (!c || !page || !deps.buildOf || offeredTo.includes(c)) return;
    offeredTo.push(c);
    void buildOf(c).then((b) => {
      if (disposed || b === null || b === page) return;
      offered = true;
      deps.log?.(`a newer build ${b} took control: offering a reload`);
      deps.onUpdateAvailable(() => {
        accepted = true;
        reloadOnce('reload accepted: the newer build already controls this page');
      });
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
    if (!accepted) {
      onForeignController();
      return;
    }
    reloadOnce('new version active: reloading');
  });
  scan();

  return {
    get offered() { return offered; },
    get accepted() { return accepted; },
    scan,
    dispose() {
      disposed = true;
      for (const d of disposers.splice(0)) d();
    },
  };
}

/** Build id of the running page: <meta name="dotkick-build"> written by tools/postbuild.mjs, or null (dev build). */
export function pageBuildId(doc: Document | null = typeof document !== 'undefined' ? document : null): string | null {
  try {
    const v = doc?.querySelector('meta[name="dotkick-build"]')?.getAttribute('content') ?? '';
    return v ? v : null;
  } catch {
    return null;
  }
}

/** Ask a worker for its build (sw.js answers { type: 'STATUS', build } on the message port); null on no answer. */
export function askWorkerBuild(w: WorkerLike, timeoutMs: number = LOCAL_TUNING.statusTimeoutMs): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (b: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(b);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e: MessageEvent) => {
        const d = e.data as { type?: unknown; build?: unknown } | null;
        finish(d && d.type === 'STATUS' && typeof d.build === 'string' ? d.build : null);
        ch.port1.close();
      };
      w.postMessage({ type: 'STATUS' }, [ch.port2]);
    } catch {
      finish(null);
    }
  });
}

/** True when a service worker may be registered in this context. */
export function canRegisterServiceWorker(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (import.meta.env?.DEV) return false;
  if (!window.isSecureContext) return false;
  if (!('serviceWorker' in navigator)) return false;
  return location.protocol === 'https:' || location.protocol === 'http:';
}

export interface PromptGateDeps {
  /** Show the prompt; returns its element (removed to hide it; it may also remove itself when its life ends). */
  show(accept: () => void): HTMLElement;
  isBusy(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/**
 * Show the update prompt only while nobody is playing: shown at once when idle, hidden as soon as play (re)starts and
 * shown again when it stops, until the player accepts or the toast's own life ends. Polls every
 * LOCAL_TUNING.promptPollMs only while the prompt is pending. Returns a disposer.
 */
export function gateUpdatePrompt(accept: () => void, deps: PromptGateDeps): () => void {
  let toast: HTMLElement | null = null;
  let done = false;
  let timer: unknown = null;
  const stop = (): void => {
    done = true;
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
  };
  const acceptOnce = (): void => {
    if (done) return;
    stop();
    accept();
  };
  const step = (): void => {
    timer = null;
    if (done) return;
    if (toast && !toast.isConnected) {
      // Its life ended (or it was dismissed): the next launch picks the update up.
      stop();
      return;
    }
    let busy: boolean;
    try {
      busy = deps.isBusy();
    } catch {
      busy = false;
    }
    if (busy && toast) {
      toast.remove();
      toast = null;
    } else if (!busy && !toast) {
      toast = deps.show(acceptOnce);
    }
    timer = deps.setTimeout(step, LOCAL_TUNING.promptPollMs);
  };
  step();
  return () => {
    stop();
    toast?.remove();
    toast = null;
  };
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
      onUpdateAvailable: opts.onUpdateAvailable ?? ((accept) => {
        const isBusy = opts.isBusy;
        if (!isBusy) {
          showUpdateToast(accept);
          return;
        }
        gateUpdatePrompt(accept, {
          show: showUpdateToast, isBusy,
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        });
      }),
      log: (m) => log(m),
      pageBuild: pageBuildId(),
      buildOf: (w) => askWorkerBuild(w),
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
