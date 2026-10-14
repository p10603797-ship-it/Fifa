/**
 * TCH-07 e2e harness page entry (not a spec): the real touch input source (src/input/touch/index.ts createTouchInput:
 * pointer manager, stick, attack + defence clusters, gestures, mapper, overlay) on a blank page, driven by real
 * browser touch input. tests/e2e/tch-07-touch-input.spec.ts bundles this file with esbuild and injects it. A rAF loop
 * calls pollFrame like the app loop; the spec calls sample() for each tick it wants.
 */
import { MatchPhase } from '../../src/contracts/enums';
import type { PlatformInfo, SettingsStore } from '../../src/contracts/app';
import { createInputFrame, type CameraProjector, type InputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createDefaultSettings } from '../../src/contracts/settings';
import type { SimState } from '../../src/contracts/state';
import type { ClusterSlot } from '../../src/contracts/touch';
import { createTouchInput } from '../../src/input/touch/index';
import { makeScenario } from '../harness/scenario';

export interface Tch07Harness {
  /** Sample one tick; returns a copy of the frame. */
  sample(): InputFrame;
  held(): number;
  stickActive(): boolean;
  mode(): number;
  gestureEvents(): number;
  pauses(): number;
  /** Centre of a cluster slot / the pause button (CSS px). */
  slot(slot: ClusterSlot): { x: number; y: number };
  pause(): { x: number; y: number };
  /** Switch the sim context: 'attack' (P1 on the ball) or 'cutscene' (a goal celebration). */
  setContext(c: 'attack' | 'cutscene'): void;
  releaseAll(): void;
}

declare global {
  interface Window { __tch07?: Tch07Harness }
}

document.body.style.margin = '0';
const root = document.createElement('div');
root.id = 'touch';
document.body.append(root);

const settings = createDefaultSettings();
const store: SettingsStore = {
  get: () => settings,
  update: (mut) => mut(settings),
  subscribe: () => () => { /* static */ },
  reset: () => { /* static */ },
  persistent: false,
  loadProgress: () => null,
  saveProgress: () => { /* none */ },
  clearProgress: () => { /* none */ },
};
const platform: PlatformInfo = {
  isIPad: true, isTouch: true, isStandalone: false, supportsFullscreen: false,
  safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
};
const projector: CameraProjector = {
  screenToPitch(sx, sy, out) { out.x = (sx - 590) / 10; out.z = (sy - 410) / 10; return true; },
  pitchToScreen(x, y, z, out) { out.x = 590 + x * 10; out.y = 410 + z * 10 - y * 10; return true; },
  stickRotation: () => 0,
};

let state: SimState = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], players: [{ slot: 9, x: 10, z: 0 }], ball: { owner: 9, x: 10.4, z: 0 } });
let pauses = 0;
const src = createTouchInput({
  root, settings: store, platform, onPause: () => { pauses++; },
  getProjector: () => projector, getState: () => state,
});
const out = createInputFrame();
let tick = 0;

function frame(t: number): void {
  src.pollFrame?.(t);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__tch07 = {
  sample() {
    const ctx: InputSampleContext = { tick: ++tick, human: 0, side: 0, state, projector };
    src.sample(out, ctx);
    return { ...out };
  },
  held: () => src.state.held,
  stickActive: () => src.state.stickActive,
  mode: () => src.state.mode,
  gestureEvents: () => src.state.gestureEventCount,
  pauses: () => pauses,
  slot: (s) => ({ x: src.layout.slots[s].cx, y: src.layout.slots[s].cy }),
  pause: () => ({ x: src.layout.pause.cx, y: src.layout.pause.cy }),
  setContext(c) {
    state = c === 'attack'
      ? makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], players: [{ slot: 9, x: 10, z: 0 }], ball: { owner: 9, x: 10.4, z: 0 } })
      : makeScenario({ phase: MatchPhase.CELEBRATION, humans: [{ side: 0, slot: 9 }] });
  },
  releaseAll: () => src.releaseAll(),
};
