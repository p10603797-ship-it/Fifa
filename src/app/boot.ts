/**
 * App boot: builds the AppContext and wires every global concern. [FND-04]
 *
 * Order: DOM roots -> platform info, settings, diagnostics, audio, focus -> router -> renderer (null renderer if it
 * cannot start) -> HUD -> device registry -> session -> AppContext -> recovery (global error handler) -> screens ->
 * menu input -> loop -> iPadOS hardening, visibility / blur / pagehide / resize / orientation, WebGL context loss
 * -> debug overlay -> splash -> bench hook -> service worker.
 *
 * [INT-B] Also: the app replay recorder fed by SessionDeps.onTick (recovery installed with attach: false), the PAD-03
 * reconnect flow + card (installReconnectFlow), PAD-07 rumble (loop rumble consumer; stopped on pause and at match
 * end), the router's input-Back sound, the renderer camera x for sfx panning each frame, and a viewport change
 * (resize, rotation, toolbar) releasing every held input. GFX-02's detector is the only Low Power Mode path.
 *
 * Exposes window.__dotkick = { ctx, app } (tests read ctx.session.getState()) and window.__dotkickFrameStats.
 * Lifecycle rules (brief section 3): hidden page pauses the match, stops the loop and suspends audio; returning
 * shows the pause menu and never fast-forwards; blur releases every held input; portrait or a too-small window
 * pauses and shows the rotate card; any uncaught error pauses and shows the recovery screen. [QF-5] A lost WebGL
 * context pauses and blocks Resume (app/blockers.ts) until the restored context is rebuilt; the update toast waits
 * while a match loads or is played (blockers.ts isPlayBusy).
 */
import { MenuAction, UiSound, type AppContext, type GameRenderer } from '../contracts/app';
import { GAME_NAME, GAME_VERSION } from '../contracts/constants';
import { CLUBS } from '../data/clubs';
import { createAudioEngine, type AudioEngineImpl } from '../audio/engine';
import { createDeviceRegistry } from '../input/devices';
import { createFocusNavigator } from '../input/focus';
import { createMenuInput } from '../input/menuInput';
import { installReconnectFlow, type ReconnectHandle } from '../input/pad/reconnect';
import { createRumbleListener, type RumbleListener } from '../input/pad/rumble';
import { createDiagnostics } from '../platform/diagnostics';
import { createPlatformInfo } from '../platform/info';
import { installIpadHardening } from '../platform/ipados';
import { registerServiceWorker } from '../platform/pwa';
import { installRecovery, type Recovery } from '../platform/recovery';
import { createLiveReplayRecorder, setAppReplayRecorder, type LiveReplayRecorder } from '../platform/replayRecorder';
import { createSettingsStore } from '../platform/settingsStore';
import { createGameRenderer } from '../render/index';
import { installDebugOverlay } from '../ui/debugOverlay';
import { createHud, type Hud } from '../ui/hud/index';
import { registerScreens, SCREEN_OVERLAYS } from '../ui/index';
import { createBlockers, isPlayBusy } from './blockers';
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
  /** PAD-03 reconnect flow and card. */
  readonly reconnect: ReconnectHandle;
  /** PAD-07 rumble consumer. */
  readonly rumble: RumbleListener;
  /** App-wide replay recorder (fed after every tick). */
  readonly replay: LiveReplayRecorder;
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
  const focus = createFocusNavigator({ onMove: () => audio.playUi(UiSound.MOVE) });

  // ctx is assigned before the first navigation; the router reads it lazily.
  let ctx: AppContext | null = null;
  let recovery: Recovery | null = null;
  const reportError = (err: unknown, where: string): void => {
    if (recovery) recovery.reportError(err, where);
    else diagnostics.log('error', `${where}: ${String(err)}`, err instanceof Error ? err : undefined);
  };
  const router = createRouter(uiRoot, () => ctx!, {
    onError: reportError, onUserBack: () => audio.playUi(UiSound.BACK), overlays: SCREEN_OVERLAYS,
  });

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
  disposers.push(() => devices.dispose());
  const rumble = createRumbleListener(devices, settings);
  disposers.push(() => rumble.dispose());
  // Replay recorder: fed by the session's per-tick hook (recovery no longer wraps afterTick).
  const replay = createLiveReplayRecorder();
  setAppReplayRecorder(replay);
  let replayFailed = false;
  const sess = createSession({
    router, renderer, hud, audio, devices, diagnostics, clubs: CLUBS, getProjector,
    setMatchLayer: (on) => document.body.classList.toggle('match-active', on),
    onError: reportError,
    onTick: (rt) => {
      if (replayFailed) return;
      try {
        replay.onTick(rt.frames, rt.curr);
      } catch (err) {
        replayFailed = true; // never let the recorder break play; log once
        diagnostics.log('error', `replay recorder stopped: ${String(err)}`, err instanceof Error ? err : undefined);
      }
    },
    onPause: () => rumble.stopAll(),
    onMatchEnd: () => rumble.stopAll(),
  });
  session = sess;
  const appCtx: AppContext = { router, settings, audio, focus, devices, session: sess, platform, diagnostics, clubs: CLUBS };
  ctx = appCtx;
  const rec = installRecovery(appCtx, { recorder: replay, attach: false });
  recovery = rec;
  hud.mount(hudRoot, appCtx);
  registerScreens(router);

  // Menu navigation: pads + keyboard -> FocusNavigator. During live play the devices drive the game, so menu
  // actions are swallowed (pad B is SHOOT, not Back). START (Options / P) toggles the pause through the debounce.
  const menuInput = createMenuInput({ focus, onPause: () => sess.requestPause(sess.uiHuman()) });
  disposers.push(() => menuInput.dispose());
  // PAD-03: a bound pad lost mid-match pauses with the reconnect card (any pad button resumes; hand to touch / CPU).
  // Installed before the screen-level focus handlers below so its guard sees menu actions first while a card is up.
  const reconnect = installReconnectFlow({
    session: sess, devices, platform, root: uiRoot, focus, onError: (err, where) => reportError(err, `reconnect.${where}`),
  });
  disposers.push(() => reconnect.dispose());
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

  // Portrait, a too-small window and a lost WebGL context all block the match (system pause, no resume until clear).
  const blockers = createBlockers((b) => sess.setBlocked(b));
  const ipad = installIpadHardening({
    onPortraitChange: (p) => blockers.set('portrait', p),
    onTooSmallChange: (s) => blockers.set('tooSmall', s),
    onLowPowerSuspected: () => {
      diagnostics.log('platform', 'steady 30 fps with idle frames: Low Power Mode likely');
      if (!settings.get().lowPowerHintShown) settings.update((s) => { s.lowPowerHintShown = true; });
    },
    // A resize, rotation or toolbar change mid-hold never leaves a stuck stick or sprint.
    onViewportChange: () => sess.releaseInputs(),
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

  // Broadcast camera x for sfx panning (INT-C adds GameRenderer cameraX(); read defensively until then).
  const camRenderer = renderer as { cameraX?: () => number };
  const loop = createLoop({
    session: sess, renderer, hud, audio, router, menuInput, getProjector, rumble,
    onError: reportError,
    beforeFrame: () => {
      if (resizePending) {
        resizePending = false;
        applyResize();
      }
    },
    afterFrame: (frame) => {
      debugOverlay.update(frame);
      if (sess.loaded && typeof camRenderer.cameraX === 'function') audio.setCameraX(camRenderer.cameraX());
      else audio.setCameraX(Number.NaN);
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

  // WebGL context loss (GFX-01 rebuilds GPU resources; the match resumes from the pause menu). [QF-5] The match stays
  // blocked (paused, Resume refused) from the loss until the restored context is rebuilt: a Resume in between would
  // run the match with nothing drawn.
  const r = renderer as Partial<{ onContextLost(fn: () => void): () => void; onContextRestored(fn: () => void): () => void }>;
  if (typeof r.onContextLost === 'function') {
    disposers.push(r.onContextLost(() => {
      sess.pause(-1);
      blockers.set('gpu', true);
    }));
  }
  if (typeof r.onContextRestored === 'function') {
    disposers.push(r.onContextRestored(() => {
      blockers.set('gpu', false);
      loop.invalidate();
    }));
  }

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
    reconnect,
    rumble,
    replay,
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

  // [QF-5] The update toast waits while a match is being played or loading (it would cover the scoreboard and catch
  // touches).
  const swOptions = { diagnostics, isBusy: () => isPlayBusy(sess, router) };
  if (document.readyState === 'complete') void registerServiceWorker(swOptions);
  else listen(window, 'load', () => void registerServiceWorker(swOptions), { once: true });

  return app;
}
