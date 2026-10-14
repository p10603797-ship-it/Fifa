/**
 * [TCH-07] Touch input source: wires the pointer manager (TCH-01), stick (TCH-02), attack cluster (TCH-03),
 * defence / keeper cluster and the attack-defence swap (TCH-04), pitch gestures (TCH-05), set-piece swipes (TCH-06),
 * the mapper (TCH-07) and the overlay (TCH-09) into one InputSource. Created by the DeviceRegistry when a match starts
 * (the overlay DOM lives inside the registry's touchRoot while this source exists) and disposed when the match ends.
 *
 * Pointer routing priority: PAUSE, attack buttons, defence buttons (only the live set claims), set-piece swipe, stick
 * zone (TCH-02 inStickZone: its half, safe area, system-gesture margins; a fixed stick only near its ring), pitch
 * gestures (everything else). A finger stays with the control that claimed it until it lifts.
 *
 * Timing: pollFrame(now) (every animation frame) and sample() (every tick) advance the buttons' hold / hint timers
 * (cluster.update) and the held-back pitch taps (gestures.update) with the pointer manager's clock, so HOLD and taps
 * reach the mapper on time; after each sample the cluster view applies a mode swap (cluster.sync). Layout, stick
 * config and opacity follow the viewport (resize, orientationchange) and the touch settings (subscribe).
 * PAUSE fires opts.onPause when the finger lifts on the button (immediately, even while no tick runs).
 * Lifecycle: releaseAll() cancels every pointer, releases every control and clears the mapper (no stuck sprint, stick
 * or power bar); dispose() also removes every listener and the overlay DOM.
 */

import type { PlatformInfo, SettingsStore } from '../../contracts/app';
import type { CameraProjector, InputFrame, InputSampleContext, InputSource } from '../../contracts/input';
import type { TouchSettings } from '../../contracts/settings';
import type { ReadonlySimState } from '../../contracts/state';
import {
  createTouchIntentState, TouchButtonId, type TouchControl, type TouchIntentState,
} from '../../contracts/touch';
import { computeClusterLayout, createAttackCluster, createClusterLayout, type ClusterLayout } from './attack';
import { createTouchButton } from './button';
import { createClusterController, createDefenceCluster, type ClusterController } from './cluster';
import { createPitchGestures } from './gestures';
import { createTouchMapper, type TouchMapper } from './mapper';
import { createTouchOverlay, type TouchOverlay } from './overlay';
import { createPointerManager, type PointerManager } from './pointers';
import { createSetPieceSwipe } from './setpiece';
import { computeStickConfig, createStick, createStickConfig, type StickConfig } from './stick';

export interface TouchInputOptions {
  /** Container for the overlay DOM (index.html <div id="touch">). */
  root: HTMLElement;
  getProjector(): CameraProjector | null;
  getState(): ReadonlySimState | null;
  settings: SettingsStore;
  platform: PlatformInfo;
  /** PAUSE button tapped. */
  onPause(): void;
  /** Clock in ms (default performance.now); the pointer manager, the controls' timers and the mapper share it. */
  now?(): number;
}

export interface TouchInputSource extends InputSource {
  readonly state: TouchIntentState;
  readonly overlay: TouchOverlay;
  readonly layout: Readonly<ClusterLayout>;
  /** Stick zone / fixed-stick geometry in use. */
  readonly stickConfig: Readonly<StickConfig>;
  /** The four cluster slots and their attack / defence button sets (overlay labels, swap view). */
  readonly cluster: ClusterController;
  readonly mapper: TouchMapper;
  /** Recompute the layout (viewport, safe area or settings changed). Called automatically on resize. */
  relayout(): void;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export function createTouchInput(opts: TouchInputOptions): TouchInputSource {
  const state = createTouchIntentState();
  const win = opts.root.ownerDocument.defaultView ?? window;
  const now = opts.now ?? defaultNow;
  const touch = (): Readonly<TouchSettings> => opts.settings.get().controls.touch;
  const layout = createClusterLayout();
  const stickCfg = createStickConfig();
  const overlay = createTouchOverlay(opts.root, state);

  const computeLayout = (): void => {
    const t = touch();
    const safe = opts.platform.safeArea();
    computeClusterLayout(win.innerWidth, win.innerHeight, safe, { spacing: t.spacing, mirror: t.mirror, placements: t.layout }, layout);
    computeStickConfig(win.innerWidth, win.innerHeight, safe, t, stickCfg);
  };
  computeLayout();

  const hints = (): boolean => touch().hintMatchesLeft > 0;
  const attack = createAttackCluster(state, layout, undefined, { hints, gesturesOnly: () => touch().gesturesOnly === true });
  const defence = createDefenceCluster(state, layout, undefined, { hints });
  const cluster = createClusterController({ state, attack, defence });

  let pausePending = false;
  const pauseBtn = createTouchButton({ state, id: TouchButtonId.PAUSE, geom: { cx: layout.pause.cx, cy: layout.pause.cy, r: layout.pause.r } });
  const pauseCtl: TouchControl = {
    hit: (x, y) => pauseBtn.hit(x, y),
    down: (id, x, y, t) => { pauseBtn.down(id, x, y, t); pausePending = pauseBtn.pointerId === id; },
    move: (id, x, y, t) => pauseBtn.move(id, x, y, t),
    up: (id, x, y, t) => {
      const mine = pauseBtn.pointerId === id;
      pauseBtn.up(id, x, y, t);
      if (mine && pausePending && pauseBtn.hit(x, y)) opts.onPause();
      if (mine) pausePending = false;
    },
    cancel: (id, t) => {
      if (pauseBtn.pointerId === id) pausePending = false;
      pauseBtn.cancel(id, t);
    },
    releaseAll: (t) => { pauseBtn.releaseAll(t); pausePending = false; },
  };

  /** Ball position on screen (set-piece swipes and "from the ball" gestures). */
  const ballScreen = (out: { x: number; y: number }): boolean => {
    const s = opts.getState();
    const p = opts.getProjector();
    if (!s || !p) return false;
    return p.pitchToScreen(s.ball.x, s.ball.y, s.ball.z, out);
  };
  const setPiece = createSetPieceSwipe({ state, ballScreen });
  const stick = createStick({ state, zone: () => true, config: () => stickCfg });
  const gestures = createPitchGestures({ state, zone: () => true, ballScreen, settings: () => touch() });
  const controls: TouchControl[] = [pauseCtl, ...cluster.controls, setPiece, stick, gestures];

  const mapper = createTouchMapper(state, {
    settings: () => touch(),
    now,
    swipeAim: (id) => defence.swipeAim(id),
  });
  const pointers: PointerManager = createPointerManager({
    el: overlay.el,
    controls,
    now,
    onChange: () => overlay.sync(),
    onDown: () => {
      // The next screen touch shows controls hidden while a pad drove this side, and skips a cut-scene.
      state.hiddenByPad = false;
      mapper.noteTouchDown();
    },
  });

  const relayout = (): void => {
    computeLayout();
    cluster.relayout(layout);
    pauseBtn.geom.cx = layout.pause.cx; pauseBtn.geom.cy = layout.pause.cy; pauseBtn.geom.r = layout.pause.r;
    overlay.layout(layout);
  };
  relayout();
  overlay.setOpacity(touch().opacity);
  overlay.sync();
  const onResize = (): void => relayout();
  win.addEventListener('resize', onResize);
  win.addEventListener('orientationchange', onResize);
  const unsubSettings = opts.settings.subscribe((s) => {
    overlay.setOpacity(s.controls.touch.opacity);
    relayout();
  });

  /** Advance the controls' timers to `t` (HOLD, hints, held-back pitch taps). */
  const tick = (t: number): void => {
    cluster.update(t);
    gestures.update(t);
  };

  let disposed = false;
  return {
    id: 'touch',
    kind: 'touch',
    state,
    overlay,
    layout,
    stickConfig: stickCfg,
    cluster,
    mapper,
    relayout,
    pollFrame() {
      if (disposed) return;
      tick(now());
      overlay.sync();
    },
    sample(out: InputFrame, ctx: InputSampleContext) {
      if (disposed) {
        mapper.sample(out, ctx);
        return;
      }
      const t = now();
      tick(t);
      mapper.sample(out, ctx);
      cluster.sync(t);
    },
    releaseAll() {
      pointers.releaseAll();
      state.held = 0;
      state.downAt.fill(0);
      state.stickActive = false;
      state.stickStrafe = false;
      state.stickX = 0;
      state.stickY = 0;
      state.buttonEventCount = 0;
      state.gestureEventCount = 0;
      state.previewCount = 0;
      mapper.reset();
      if (!disposed) overlay.sync();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      win.removeEventListener('resize', onResize);
      win.removeEventListener('orientationchange', onResize);
      unsubSettings();
      pointers.dispose();
      gestures.releaseAll(now());
      mapper.reset();
      overlay.dispose();
    },
  };
}
