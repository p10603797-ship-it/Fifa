/**
 * TCH-09 e2e harness page entry (not a spec): the real touch input source (createTouchInput) with the overlay bound to
 * the cluster controller and the stick config exactly as the TCH-09 CR asks index.ts to do, plus the pad-drive watcher
 * over a real pad manager reading a mocked navigator.getGamepads (window.__tch09pad). A rAF loop calls pollFrame and
 * the watcher like the app loop; the spec calls sample() for the ticks it wants. tests/e2e/tch-09-overlay.spec.ts
 * bundles this file with esbuild and injects it.
 */
import type { PlatformInfo, SettingsStore } from '../../src/contracts/app';
import { MatchPhase } from '../../src/contracts/enums';
import { createInputFrame, type CameraProjector } from '../../src/contracts/input';
import { createDefaultSettings } from '../../src/contracts/settings';
import type { SimState } from '../../src/contracts/state';
import { createPadManager } from '../../src/input/pad/manager';
import { createTouchInput } from '../../src/input/touch/index';
import { createPadDriveWatcher, hudRegions, type Rect } from '../../src/input/touch/overlay';
import { makeScenario } from '../harness/scenario';

export interface Tch09Harness {
  sample(): void;
  mode(): number;
  hidden(): boolean;
  setContext(c: 'attack' | 'defence'): void;
  setSafe(top: number, right: number, bottom: number, left: number): void;
  relayout(): void;
  hud(): Rect[];
  safe(): { top: number; right: number; bottom: number; left: number };
  slot(i: number): { x: number; y: number };
  domWrites(): number;
}

declare global {
  interface Window { __tch09?: Tch09Harness; __tch09pad?: { buttons: { pressed: boolean; touched: boolean; value: number }[]; axes: number[]; timestamp: number } }
}

document.body.style.margin = '0';
document.body.style.background = '#07070d';
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
let safe = { top: 0, right: 0, bottom: 0, left: 0 };
const platform: PlatformInfo = { isIPad: true, isTouch: true, isStandalone: false, supportsFullscreen: false, safeArea: () => safe };
const projector: CameraProjector = {
  screenToPitch(sx, sy, out) { out.x = (sx - 590) / 10; out.z = (sy - 410) / 10; return true; },
  pitchToScreen(x, y, z, out) { out.x = 590 + x * 10; out.y = 410 + z * 10 - y * 10; return true; },
  stickRotation: () => 0,
};

const attackState = (): SimState => makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], players: [{ slot: 9, x: 10, z: 0 }], ball: { owner: 9, x: 10.4, z: 0 } });
const defenceState = (): SimState => makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 4 }], players: [{ slot: 19, x: -10, z: 0 }], ball: { owner: 19, x: -10.4, z: 0 } });
let state: SimState = attackState();

const src = createTouchInput({ root, settings: store, platform, onPause: () => { /* none */ }, getProjector: () => projector, getState: () => state });
// The TCH-09 CR wiring (index.ts): bind the cluster controller, the stick config and the touch settings.
src.overlay.bind({ cluster: src.cluster, stickConfig: src.stickConfig, touchSettings: () => settings.controls.touch });
src.overlay.sync();

// Pads: the real manager over the mocked list; pad:1 is bound to the same human as this touch overlay.
const pads = createPadManager(() => (window.__tch09pad ? [window.__tch09pad as unknown as Gamepad] : []), { eventTarget: null });
const drive = createPadDriveWatcher(src.state, pads, () => ['pad:1']);

const out = createInputFrame();
let tick = 0;
function frame(t: number): void {
  pads.poll(t);
  drive.update();
  src.pollFrame?.(t);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__tch09 = {
  sample() { src.sample(out, { tick: ++tick, human: 0, side: 0, state, projector }); src.overlay.sync(); },
  mode: () => src.state.mode,
  hidden: () => src.state.hiddenByPad,
  setContext(c) { state = c === 'attack' ? attackState() : defenceState(); },
  setSafe(top, right, bottom, left) { safe = { top, right, bottom, left }; },
  relayout() { src.relayout(); src.overlay.sync(); },
  hud: () => hudRegions(window.innerWidth, window.innerHeight, safe),
  safe: () => safe,
  slot: (i) => ({ x: src.layout.slots[i as 0 | 1 | 2 | 3].cx, y: src.layout.slots[i as 0 | 1 | 2 | 3].cy }),
  domWrites: () => src.overlay.domWrites,
};
