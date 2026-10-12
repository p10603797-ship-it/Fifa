/**
 * App boot: builds the AppContext and wires every global concern. [FND-04]
 *
 * Order: DOM roots -> platform info, settings, diagnostics, audio, focus -> router -> renderer (null renderer if it
 * cannot start) -> HUD -> device registry -> session -> AppContext -> recovery (global error handler) -> screens ->
 * menu input -> loop -> iPadOS hardening, visibility / blur / pagehide / resize / orientation, WebGL context loss
 * -> debug overlay -> splash -> bench hook -> service worker.
 *
 * Exposes window.__dotkick = { ctx, app } (tests read ctx.session.getState()) and window.__dotkickFrameStats.
 * Lifecycle rules (brief section 3): hidden page pauses the match, stops the loop and suspends audio; returning
 * shows the pause menu and never fast-forwards; blur releases every held input; portrait or a too-small window
 * pauses and shows the rotate card; any uncaught error pauses and shows the recovery screen.
 */
import { MenuAction, type AppContext, type GameRenderer } from '../contracts/app';
import { GAME_NAME, GAME_VERSION } from '../contracts/constants';
import { CLUBS } from '../data/clubs';
import { createAudioEngine, type AudioEngineImpl } from '../audio/engine';
import { createDeviceRegistry } from '../input/devices';
import { createFocusNavigator } from '../input/focus';
import { createMenuInput } from '../input/menuInput';
import { createDiagnostics } from '../platform/diagnostics';
import { createPlatformInfo } from '../platform/info';
import { installIpadHardening } from '../platform/ipados';
import { registerServiceWorker } from '../platform/pwa';
import { installRecovery, type Recovery } from '../platform/recovery';
import { createSettingsStore } from '../platform/settingsStore';
import { createGameRenderer } from '../render/index';
import { installDebugOverlay } from '../ui/debugOverlay';
import { createHud, type Hud } from '../ui/hud/index';
import { registerScreens } from '../ui/index';
import { createLoop, type GameLoop } from './loop';
import { createNullRenderer } from './nullRenderer';
import { createRouter } from './router';
import { createSession } from './session';
import type { AppRouter, AppSession, FrameStats } from './types';

export interface AppHandle {
  readonly ctx: AppContext;
  readonly loop: GameLoop;
  readonly session: AppSession;
  readonly router: AppRouter;
  readonly renderer: GameRenderer;
  readonly hud: Hud;
  readonly audio: AudioEngineImpl;
  readonly recovery: Recovery;
  dispose(): void;
}

declare global {
  interface Window {
    /** App handle for tests and debugging: ctx (AppContext) plus internals. */
    __dotkick?: { ctx: AppContext; app: AppHandle };
    /** Live frame statistics (debug overlay, benchmark). */
    __dotkickFrameStats?: FrameStats;
  }
}

type BenchHookModule = { maybeStartBench?: (ctx: AppContext) => unknown };

function ensureRoot<T extends HTMLElement>(id: string, tag: string): T {
  let el = document.getElementById(id) as T | null;
  if (!el) {
    el = document.createElement(tag) as T;
    el.id = id;
    document.body.appendChild(el);
  }
  return el;
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

export function boot(): AppHandle {
  const canvas = ensureRoot<HTMLCanvasElement>('game', 'canvas');
  const hudRoot = ensureRoot<HTMLDivElement>('hud', 'div');
  const touchRoot = ensureRoot<HTMLDivElement>('touch', 'div');
  const uiRoot = ensureRoot<HTMLDivElement>('ui', 'div');
  const disposers: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions | boolean): void => {
    target.addEventListener(type, fn, opts);
    disposers.push(() => target.removeEventListener(type, fn, opts));
  };

  const platform = createPlatformInfo();
  const settings = createSettingsStore();
  const diagnostics = createDiagnostics(settings);
  diagnostics.log('boot', `${GAME_NAME} ${GAME_VERSION}`, { ipad: platform.isIPad, touch: platform.isTouch, standalone: platform.isStandalone });
  // A broken audio module is logged (first failure per module) but never interrupts play with the recovery screen.
  const audio = createAudioEngine(settings, {
    onModuleError: (err, where) => diagnostics.log('error', `${where}: ${String(err)}`, err instanceof Error ? err : undefined),
  });
  const focus = createFocusNavigator();

  // ctx is assigned before the first navigation; the router reads it lazily.
  let ctx: AppContext | null = null;
  let recovery: Recovery | null = null;
  const reportError = (err: unknown, where: string): void => {
    if (recovery) recovery.reportError(err, where);
    else diagnostics.log('error', `${where}: ${String(err)}`, err instanceof Error ? err : undefined);
  };
  const router = createRouter(uiRoot, () => ctx!, { onError: reportError });

  let renderer: GameRenderer;
  try {
    renderer = createGameRenderer();
    renderer.init(canvas, settings.get());
  } catch (err) {
    diagnostics.log('error', 'renderer init failed; matches cannot be drawn', err instanceof Error ? err : String(err));
    renderer = createNullRenderer();
  }

  const hud = createHud();
  let session: AppSession | null = null;
  const getProjector = (): GameRenderer['projector'] | null => (session && session.loaded ? renderer.projector : null);
  const devices = createDeviceRegistry({
    touchRoot,
    getProjector,
    getState: () => (session ? session.getState() : null),
    settings,
    platform,
    onPause: (human: number) => session?.requestPause(human),
  });
  const sess = createSession({
    router, renderer, hud, audio, devices, diagnostics, clubs: CLUBS, getProjector,
    setMatchLayer: (on) => document.body.classList.toggle('match-active', on),
    onError: reportError,
  });
  session = sess;
  const appCtx: AppContext = { router, settings, audio, focus, devices, session: sess, platform, diagnostics, clubs: CLUBS };
  ctx = appCtx;
  const rec = installRecovery(appCtx);
  recovery = rec;
  hud.mount(hudRoot, appCtx);
  registerScreens(router);

  // Menu navigation: pads + keyboard -> FocusNavigator. During live play the devices drive the game, so menu
  // actions are swallowed (pad B is SHOOT, not Back). START (Options / P) toggles the pause through the debounce.
  const menuInput = createMenuInput({ focus, onPause: () => sess.requestPause(sess.uiHuman()) });
  disposers.push(() => menuInput.dispose());
  disposers.push(
    focus.onAction((a) => {
      if (sess.ticking && router.current === 'match') return true;
      if (a === MenuAction.BACK) {
        router.backFromInput('menu');
        return true;
      }
      return false;
    }),
  );
  // Enter / Space reach buttons as menu CONFIRM only: block the browser's native activation of the focused
  // button so one press never activates twice (native click + CONFIRM).
  const blockNativeActivation = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (k.key !== 'Enter' && k.key !== ' ') return;
    if (isEditable(k.target)) return;
    const t = k.target as HTMLElement | null;
    if (t && typeof t.closest === 'function' && t.closest('button, [data-focus]') && k.cancelable) k.preventDefault();
  };
  listen(window, 'keydown', blockNativeActivation, true);
  listen(window, 'keyup', blockNativeActivation, true);

  let portrait = false;
  let tooSmall = false;
  const ipad = installIpadHardening({
    onPortraitChange: (p) => {
      portrait = p;
      sess.setBlocked(portrait || tooSmall);
    },
    onTooSmallChange: (s) => {
      tooSmall = s;
      sess.setBlocked(portrait || tooSmall);
    },
    onLowPowerSuspected: () => {
      diagnostics.log('platform', 'steady 30 fps with idle frames: Low Power Mode likely');
      if (!settings.get().lowPowerHintShown) settings.update((s) => { s.lowPowerHintShown = true; });
    },
  });
  disposers.push(() => ipad.dispose());

  const debugOverlay = installDebugOverlay(appCtx, {
    frameStats: () => loop.stats,
    rendererStats: () => renderer.stats(),
    state: () => sess.getState(),
  });
  disposers.push(() => debugOverlay.dispose());

  let resizePending = true;
  const applyResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    try {
      renderer.resize(w, h, dpr);
    } catch (err) {
      reportError(err, 'renderer.resize');
    }
    platform.refreshSafeArea();
    loop.invalidate();
  };

  const loop = createLoop({
    session: sess, renderer, hud, audio, router, menuInput, getProjector,
    onError: reportError,
    beforeFrame: () => {
      if (resizePending) {
        resizePending = false;
        applyResize();
      }
    },
    afterFrame: (frame, busyMs) => {
      debugOverlay.update(frame);
      if (sess.ticking) ipad.reportFrame(frame.dtMs, busyMs);
    },
  });
  window.__dotkickFrameStats = loop.stats;

  // Settings that the renderer follows live (audio volumes are followed by the engine itself). Applied only when
  // the camera, motion or quality values change, so unrelated settings never make the renderer rebuild.
  let appliedCamera = '';
  let appliedTier = -1;
  const applySettings = (): void => {
    const s = settings.get();
    const cameraKey = `${s.camera.type}|${s.camera.height}|${s.camera.zoom}|${s.accessibility.reducedCameraMotion ? 1 : 0}`;
    try {
      if (cameraKey !== appliedCamera) {
        appliedCamera = cameraKey;
        renderer.setCamera(s.camera, s.accessibility.reducedCameraMotion);
        loop.invalidate();
      }
      if (s.graphics.tier !== appliedTier) {
        appliedTier = s.graphics.tier;
        renderer.setQuality(s.graphics.tier);
        loop.invalidate();
      }
    } catch (err) {
      reportError(err, 'renderer settings');
    }
  };
  applySettings();
  // A renderer that can follow the store itself (FND-05 DotkickRenderer.bindSettings; CR: GameRenderer.setSettings)
  // gets every later change, including the fixed resolution scale and per-module settings; boot then only redraws.
  // Otherwise boot keeps forwarding camera and tier changes.
  const bindable = renderer as Partial<{ bindSettings(store: Pick<typeof settings, 'get' | 'subscribe'>): () => void }>;
  let bound = false;
  if (typeof bindable.bindSettings === 'function') {
    try {
      disposers.push(bindable.bindSettings(settings));
      bound = true;
    } catch (err) {
      reportError(err, 'renderer.bindSettings');
    }
  }
  disposers.push(settings.subscribe(bound ? () => loop.invalidate() : applySettings));

  // WebGL context loss (GFX-01 rebuilds GPU resources; the match resumes from the pause menu).
  const r = renderer as Partial<{ onContextLost(fn: () => void): () => void; onContextRestored(fn: () => void): () => void }>;
  if (typeof r.onContextLost === 'function') disposers.push(r.onContextLost(() => sess.pause(-1)));
  if (typeof r.onContextRestored === 'function') disposers.push(r.onContextRestored(() => loop.invalidate()));

  // Page lifecycle.
  let hidden = false;
  const setHidden = (h: boolean): void => {
    if (h === hidden) return;
    hidden = h;
    sess.setHidden(h);
    if (h) {
      loop.stop();
    } else {
      loop.start();
      loop.resetTiming();
      loop.invalidate();
    }
  };
  listen(document, 'visibilitychange', () => setHidden(document.visibilityState === 'hidden'));
  listen(window, 'pagehide', () => setHidden(true));
  listen(window, 'pageshow', () => setHidden(document.visibilityState === 'hidden'));
  listen(window, 'blur', () => sess.releaseInputs());
  const onResize = (): void => {
    resizePending = true;
  };
  listen(window, 'resize', onResize);
  listen(window, 'orientationchange', onResize);

  const app: AppHandle = {
    ctx: appCtx,
    loop,
    session: sess,
    router,
    renderer,
    hud,
    audio,
    recovery: rec,
    dispose() {
      loop.stop();
      for (const d of disposers.splice(0).reverse()) {
        try {
          d();
        } catch {
          /* keep disposing */
        }
      }
      sess.dispose();
      rec.dispose();
      router.dispose();
      hud.dispose();
      renderer.dispose();
      audio.dispose();
      (focus as Partial<{ dispose(): void }>).dispose?.();
      if (window.__dotkick?.app === app) delete window.__dotkick;
      if (window.__dotkickFrameStats === loop.stats) delete window.__dotkickFrameStats;
    },
  };
  window.__dotkick = { ctx: appCtx, app };

  applyResize();
  resizePending = false;
  router.go('splash');
  hidden = document.visibilityState === 'hidden';
  if (hidden) sess.setHidden(true);
  else loop.start();

  // Benchmark hook (FND-06): starts a bench match for ?bench=1. Tolerates the module being absent.
  const benchModules = import.meta.glob<BenchHookModule>('../platform/benchHook.ts', { eager: true });
  for (const m of Object.values(benchModules)) {
    try {
      m.maybeStartBench?.(appCtx);
    } catch (err) {
      reportError(err, 'bench');
    }
  }

  if (document.readyState === 'complete') void registerServiceWorker({ diagnostics });
  else listen(window, 'load', () => void registerServiceWorker({ diagnostics }), { once: true });

  return app;
}
