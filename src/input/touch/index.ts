/**
 * [TCH-07] Touch input source: wires the pointer manager (TCH-01), stick (TCH-02), attack cluster (TCH-03),
 * defence/keeper cluster (TCH-04), pitch gestures (TCH-05), set-piece swipes (TCH-06), the mapper (TCH-07) and the
 * overlay (TCH-09) into one InputSource. Created by the DeviceRegistry when a match starts (the overlay DOM lives
 * inside the registry's touchRoot while this source exists) and disposed when the match ends.
 *
 * Pointer routing priority: PAUSE, attack buttons, defence buttons, set-piece swipe, stick zone (left half),
 * pitch gestures (everything else).
 *
 * WAVE 0 BASELINE (FND-05). TCH-07 owns and refines it.
 */

import type { PlatformInfo, SettingsStore } from '../../contracts/app';
import type { CameraProjector, InputFrame, InputSampleContext, InputSource } from '../../contracts/input';
import type { ReadonlySimState } from '../../contracts/state';
import {
  createTouchIntentState, TouchButtonId, type TouchControl, type TouchIntentState,
} from '../../contracts/touch';
import { computeClusterLayout, createAttackCluster, createClusterLayout, type ClusterLayout } from './attack';
import { createTouchButton } from './button';
import { createDefenceCluster } from './cluster';
import { createPitchGestures } from './gestures';
import { createTouchMapper } from './mapper';
import { createTouchOverlay, type TouchOverlay } from './overlay';
import { createPointerManager, type PointerManager } from './pointers';
import { createSetPieceSwipe } from './setpiece';
import { createStick } from './stick';

export interface TouchInputOptions {
  /** Container for the overlay DOM (index.html <div id="touch">). */
  root: HTMLElement;
  getProjector(): CameraProjector | null;
  getState(): ReadonlySimState | null;
  settings: SettingsStore;
  platform: PlatformInfo;
  /** PAUSE button tapped. */
  onPause(): void;
}

export interface TouchInputSource extends InputSource {
  readonly state: TouchIntentState;
  readonly overlay: TouchOverlay;
  readonly layout: Readonly<ClusterLayout>;
  /** Recompute the layout (viewport, safe area or settings changed). Called automatically on resize. */
  relayout(): void;
}

export function createTouchInput(opts: TouchInputOptions): TouchInputSource {
  const state = createTouchIntentState();
  const win = opts.root.ownerDocument.defaultView ?? window;
  const layout = createClusterLayout();
  const overlay = createTouchOverlay(opts.root, state);

  const computeLayout = (): void => {
    const t = opts.settings.get().controls.touch;
    computeClusterLayout(win.innerWidth, win.innerHeight, opts.platform.safeArea(), { spacing: t.spacing, mirror: t.mirror }, layout);
  };
  computeLayout();

  const attack = createAttackCluster(state, layout);
  const defence = createDefenceCluster(state, layout);
  let pausePending = false;
  const pauseBtn = createTouchButton({ state, id: TouchButtonId.PAUSE, geom: { cx: layout.pause.cx, cy: layout.pause.cy, r: layout.pause.r } });
  const pauseCtl: TouchControl = {
    hit: (x, y) => pauseBtn.hit(x, y),
    down: (id, x, y, t) => { pauseBtn.down(id, x, y, t); pausePending = true; },
    move: (id, x, y, t) => pauseBtn.move(id, x, y, t),
    up: (id, x, y, t) => {
      pauseBtn.up(id, x, y, t);
      if (pausePending && pauseBtn.hit(x, y)) opts.onPause();
      pausePending = false;
    },
    cancel: (id, t) => { pauseBtn.cancel(id, t); pausePending = false; },
    releaseAll: (t) => { pauseBtn.releaseAll(t); pausePending = false; },
  };
  const setPiece = createSetPieceSwipe({ state });
  const stick = createStick({
    state,
    zone: (x) => {
      const t = opts.settings.get().controls.touch;
      return t.mirror ? x >= win.innerWidth / 2 : x < win.innerWidth / 2;
    },
  });
  const gestures = createPitchGestures({ state, zone: () => true });
  const controls: TouchControl[] = [pauseCtl, ...attack.controls, ...defence.controls, setPiece, stick, gestures];

  const mapper = createTouchMapper(state);
  const pointers: PointerManager = createPointerManager({ el: overlay.el, controls, onChange: () => overlay.sync() });

  const relayout = (): void => {
    computeLayout();
    attack.relayout(layout);
    defence.relayout(layout);
    pauseBtn.geom.cx = layout.pause.cx; pauseBtn.geom.cy = layout.pause.cy; pauseBtn.geom.r = layout.pause.r;
    overlay.layout(layout);
  };
  relayout();
  overlay.setOpacity(opts.settings.get().controls.touch.opacity);
  overlay.sync();
  const onResize = (): void => relayout();
  win.addEventListener('resize', onResize);
  win.addEventListener('orientationchange', onResize);
  const unsubSettings = opts.settings.subscribe((s) => {
    overlay.setOpacity(s.controls.touch.opacity);
    relayout();
  });

  let disposed = false;
  return {
    id: 'touch',
    kind: 'touch',
    state,
    overlay,
    layout,
    relayout,
    pollFrame() {
      if (!disposed) overlay.sync();
    },
    sample(out: InputFrame, ctx: InputSampleContext) {
      mapper.sample(out, ctx);
    },
    releaseAll() {
      pointers.releaseAll();
      state.held = 0;
      state.stickActive = false;
      state.stickX = 0;
      state.stickY = 0;
      state.buttonEventCount = 0;
      state.gestureEventCount = 0;
      overlay.sync();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      win.removeEventListener('resize', onResize);
      win.removeEventListener('orientationchange', onResize);
      unsubSettings();
      pointers.dispose();
      overlay.dispose();
    },
  };
}
